// 撮影画面の自動撮影の判断。検出の結果を受けて枠の位置をならし、枠が止まったらシャッターを切る時を決める。
// 撮影画面（app.js）と、手ぶれを再現した試験（tests/bench.js の ?steady=1）の両方で使う
const AutoShot = (() => {
  // 枠を出す点数の下限。正しく見つけたときはほぼ 0.45 を超え、周りの書類などを誤って囲んだときは下回りやすい
  const SHOW_SCORE = 0.45;
  const config = {
    wait: 400, // 枠がほぼ止まってから、自動でシャッターを切るまで（ミリ秒）
    still: 0.025, // 「止まっている」とみなす揺れの幅（四隅の縦横のずれの和。画面の幅・高さに対する割合）
    minScore: 0.5, // 止まっている間の点数の平均の下限
    keep: 1500, // 覚えておく検出の長さ（ミリ秒）
    drop: 0.75, // 撮ったあと、構えていた間のいちばん低い点のこの倍を下回ったら、書類が乱れたとみなす
    upset: 300, // 撮ったあと、書類がこの時間（ミリ秒）続けて乱れたら（見失う・点数が大きく下がる・急に動く）、ページを入れ替えたとみなす
  };

  // 2 つの四角形のずれ（四隅の縦横のずれの和の、いちばん大きいもの。正規化座標）
  const move = (a, b) => Math.max(...a.map((p, i) => Math.abs(p[0] - b[i][0]) + Math.abs(p[1] - b[i][1])));

  // s は撮影画面の状態（quad, raw, jump, stableSince, lastSeen, autoLock, lockScore, upset, floor, dark, score, frames, clipped, small, hist を持つ）
  function create() {
    return {
      quad: null, raw: null, jump: null, stableSince: 0, lastSeen: 0, autoLock: null, lockScore: 0, upset: 0, floor: null,
      dark: false, score: 0, frames: 0, clipped: false, small: false, hist: [],
    };
  }

  // 次の検出のしかた。書類を見つけ続けている間は、4 回に 3 回は直前の位置を確かめるだけにして軽くする
  // （4 回に 1 回は画面全体を探す。枠が止まっている間は 8 回に 1 回）。別の場所の候補が出ているときは、それを確かめるため画面全体を探す。
  // slow は次の検出までの間隔の倍率。撮り終えて構えたまま（か自動撮影がオフで止まっている）の間は倍にして、電池と発熱を抑える
  function plan(s, auto = true) {
    s.frames = (s.frames || 0) + 1;
    return {
      track: !!s.quad && !s.jump && s.frames % (s.stableSince ? 8 : 4) !== 0,
      slow: s.stableSince && (!auto || s.autoLock) ? 2 : 1,
    };
  }

  // 検出の結果（found: { quad, score, dark } か null）を受ける。
  // 戻り値: progress は自動撮影までの進み（0〜1）、fire が true なら今シャッターを切る
  function update(s, found, now, { auto = true, busy = false } = {}) {
    if (!s.hist) s.hist = [];
    if (found && found.score >= SHOW_SCORE && s.quad && move(s.quad, found.quad) >= 0.08 && now - s.lastSeen < 900) {
      // 別の場所へ大きく飛んだときは、続けて同じあたりに見つかるまで前の枠を残す（枠が行き来してちらつかないように）。
      // 1 回だけの飛びは無視して、止まっている時間は取り消さない（画面全体を探した回に、書類の中の四角形を拾うことがある）
      const same = s.jump && move(s.jump, found.quad) < 0.05;
      s.jump = found.quad;
      if (!same) found = null;
    } else {
      s.jump = null;
    }
    const fresh = !!found && found.score >= SHOW_SCORE;
    if (fresh) {
      const q = found.quad;
      s.dark = !!found.dark;
      const prev = s.quad;
      const moved = prev ? move(prev, q) : 1;
      // 枠の描画でもなめらかにするので、ここでは軽くならすだけにする
      s.quad = prev && moved < 0.08 ? prev.map((p, i) => [p[0] * 0.4 + q[i][0] * 0.6, p[1] * 0.4 + q[i][1] * 0.6]) : q;
      if (moved >= 0.08) s.hist = [];
      s.hist.push({ t: now, q, score: found.score });
      s.score = found.score;
      s.lastSeen = now;
    } else if (now - s.lastSeen > 900) {
      s.quad = null;
      s.hist = [];
      s.autoLock = null;
    }
    // 撮ったあとは、書類を動かすか入れ替えるまで次の自動撮影をしない。
    // 同じ位置に次のページを重ねて置くと枠は動かないので、手が入るなどして書類がしばらく乱れ続けたら、入れ替えたとみなす。
    // 点数は、構えていた間のいちばん低い点を基準にする（点の揺れやすい書類で、二重に撮らないように）。
    // 動きは直前の検出からの急な動きで見る（構えたままゆっくりずれていくのは、乱れとみなさない）。
    // 1、2 回だけの乱れは、点の低い書類を見失ったり検出が揺れたりしただけのことが多いので、続いた時間で見る
    if (s.autoLock) {
      const upset = !fresh || found.score < s.lockScore * config.drop || (s.raw && move(found.quad, s.raw) > 0.04);
      if (!upset) s.upset = 0;
      else if (!s.upset) s.upset = now;
      if ((s.quad && move(s.autoLock, s.quad) > 0.1) || (s.upset && now - s.upset >= config.upset)) {
        s.autoLock = null;
        s.hist = fresh ? [s.hist[s.hist.length - 1]] : [];
        // 手がまだ書類にかかっている間（点数が下がっている）は、止まっていても撮らない
        s.floor = { score: s.lockScore * 0.7, until: now + 2000 };
      }
    }
    if (fresh) s.raw = found.quad;
    while (s.hist.length && s.hist[0].t < now - config.keep) s.hist.shift();
    const floor = s.floor && now < s.floor.until ? s.floor.score : 0;

    // 止まっている時間: 今の位置から揺れの幅に収まる検出が、どこまでさかのぼって続いているか。
    // 1 回ごとのずれではなく、続けて見たずれで決めるので、手ぶれや検出の細かな揺れで待ち直しにならない
    s.stableSince = 0;
    const h = s.hist;
    if (s.quad && h.length >= 2) {
      const last = h[h.length - 1].q;
      let k = h.length - 1, sum = 0;
      while (k >= 0 && move(h[k].q, last) <= config.still && h[k].score >= floor) { sum += h[k].score; k--; }
      const run = h.length - 1 - k;
      if (run >= 2 && sum / run >= config.minScore) s.stableSince = h[k + 1].t;
    }
    // 書類のふちが画面の外に出ているときは知らせ、自動では撮らない（切れたまま撮らないように）
    s.clipped = !!s.quad && s.quad.some(([x, y]) => x < 0.012 || y < 0.012 || x > 0.988 || y > 0.988);
    s.small = !!s.quad && Geo.area(s.quad) < 0.1;

    if (auto && s.quad && s.stableSince && !s.autoLock && !busy && !s.clipped) {
      const progress = (now - s.stableSince) / config.wait;
      // シャッターは、今の回に書類を見つけたときだけ切る（見失っている間に切らない）
      if (progress >= 1 && fresh) {
        s.autoLock = s.quad.map((pt) => pt.slice());
        s.lockScore = Math.min(...h.filter((e) => e.t >= s.stableSince).map((e) => e.score));
        s.upset = 0;
        s.floor = null;
        s.hist = [];
        s.stableSince = 0;
        return { progress: 0, fire: true };
      }
      return { progress, fire: false };
    }
    return { progress: 0, fire: false };
  }

  // 撮影画面を回したときなど、見つけた枠を捨てて探し直す
  function reset(s) {
    s.quad = null; s.raw = null; s.jump = null; s.stableSince = 0; s.hist = []; s.autoLock = null; s.floor = null;
  }

  return { create, plan, update, reset, move, config, SHOW_SCORE };
})();
