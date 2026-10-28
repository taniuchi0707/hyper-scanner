// 四隅検出のベンチマーク。
// 机の上の書類を 3D で斜めから撮った合成写真を作り、本当の四隅と検出結果のずれを測る。
(async () => {
  'use strict';

  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const FONT = '"BIZ UDPGothic", "Yu Gothic", Meiryo, sans-serif';
  const WORDS = '御見積書請求納品領収契約申込確認報告議事録会社部長様御中金額合計数量単価備考日付住所電話番号担当者以下記載内容承認';

  function drawDoc(rnd, aspect, paper, kind) {
    const W = 900, H = Math.round(900 * aspect);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = paper; x.fillRect(0, 0, W, H);
    x.fillStyle = '#1b1f24';
    const word = (n) => Array.from({ length: n }, () => WORDS[(rnd() * WORDS.length) | 0]).join('');
    if (kind === 'receipt') {
      x.font = `700 44px ${FONT}`; x.textAlign = 'center'; x.fillText('領 収 書', W / 2, 90);
      x.font = `26px ${FONT}`; x.textAlign = 'left';
      for (let y = 160; y < H - 60; y += 44) { x.fillText(word(6 + ((rnd() * 6) | 0)), 50, y); x.textAlign = 'right'; x.fillText(`¥${((rnd() * 9000) | 0) + 100}`, W - 50, y); x.textAlign = 'left'; }
      return c;
    }
    x.font = `700 52px ${FONT}`; x.textAlign = 'center'; x.fillText(word(4), W / 2, 110);
    x.textAlign = 'left';
    const dense = kind === 'dense';
    x.font = `${dense ? 20 : 24}px ${FONT}`;
    let y = 190;
    const step = dense ? 30 : 40;
    while (y < H * 0.55) { x.fillText(word(dense ? 38 : 20 + ((rnd() * 12) | 0)), 70, y); y += step; }
    if (kind === 'table' || kind === 'dense') {
      const top = y + 10, rows = 7, rh = 46;
      x.lineWidth = 2; x.strokeStyle = '#1b1f24';
      for (let i = 0; i <= rows; i++) { x.beginPath(); x.moveTo(70, top + i * rh); x.lineTo(W - 70, top + i * rh); x.stroke(); }
      [70, 420, 560, 700, W - 70].forEach((cx) => { x.beginPath(); x.moveTo(cx, top); x.lineTo(cx, top + rows * rh); x.stroke(); });
      y = top + rows * rh + 50;
    }
    if (kind === 'photo') {
      const g = x.createLinearGradient(70, y, W - 70, y + 260);
      g.addColorStop(0, '#2f5d7c'); g.addColorStop(1, '#c7853a');
      x.fillStyle = g; x.fillRect(70, y, W - 140, 260);
      x.fillStyle = '#1b1f24';
      y += 310;
    }
    while (y < H - 80) { x.fillText(word(18 + ((rnd() * 14) | 0)), 70, y); y += step; }
    if (rnd() < 0.5) { x.strokeStyle = '#c8372d'; x.lineWidth = 5; x.strokeRect(W - 210, 150, 110, 110); }
    return c;
  }

  function drawBackground(rnd, type, W, H) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    const base = {
      woodDark: '#4a3a30', woodLight: '#c9a67c', gray: '#868b90', white: '#dcdcd7', black: '#1d1f22',
      cloth: '#e9edf2', mat: '#2f6b4f', blue: '#3d5a80', beige: '#d8cbb3',
    }[type];
    x.fillStyle = base; x.fillRect(0, 0, W, H);
    if (type === 'woodDark' || type === 'woodLight') {
      for (let i = 0; i < 90; i++) {
        x.strokeStyle = type === 'woodDark' ? `rgba(${rnd() < 0.5 ? '20,12,8' : '110,85,66'},${0.08 + rnd() * 0.12})` : `rgba(${rnd() < 0.5 ? '120,80,40' : '235,210,170'},${0.1 + rnd() * 0.15})`;
        x.lineWidth = 1 + rnd() * 4;
        x.beginPath();
        const y0 = rnd() * H;
        x.moveTo(0, y0);
        for (let xx = 0; xx <= W; xx += 60) x.lineTo(xx, y0 + Math.sin(xx / 240 + i) * 16);
        x.stroke();
      }
    } else if (type === 'cloth') {
      x.fillStyle = 'rgba(60,90,150,.35)';
      for (let i = 0; i < W; i += 80) x.fillRect(i, 0, 36, H);
      for (let j = 0; j < H; j += 80) x.fillRect(0, j, W, 36);
    } else if (type === 'mat') {
      x.strokeStyle = 'rgba(220,240,230,.35)'; x.lineWidth = 1.5;
      for (let i = 0; i < W; i += 40) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, H); x.stroke(); }
      for (let j = 0; j < H; j += 40) { x.beginPath(); x.moveTo(0, j); x.lineTo(W, j); x.stroke(); }
    }
    return c;
  }

  function rot(p, rx, ry, rz) {
    let [x, y, z] = p;
    [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
    [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
    [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
    return [x, y, z];
  }

  function project(cfg, W, H, Z, tx, ty) {
    const f = 0.8 * Math.max(W, H);
    const pw = 210, ph = 210 * cfg.aspect;
    return [[-pw / 2, -ph / 2, 0], [pw / 2, -ph / 2, 0], [pw / 2, ph / 2, 0], [-pw / 2, ph / 2, 0]].map((p) => {
      const [x, y, z] = rot(p, cfg.rx, cfg.ry, cfg.rz);
      return [f * (x + tx) / (z + Z) + W / 2, f * (y + ty) / (z + Z) + H / 2];
    });
  }

  async function renderScene(cfg, seed) {
    const rnd = mulberry32(seed);
    const W = cfg.landscape ? 1600 : 1200, H = cfg.landscape ? 1200 : 1600;
    // 書類が画面の fill 割を占める距離を探す
    let Z = 1000;
    for (let k = 0; k < 6; k++) {
      const q = project(cfg, W, H, Z, 0, 0);
      Z *= Math.sqrt(Geo.area(q) / (cfg.fill * W * H));
    }
    // 書類が画面からはみ出さない範囲でずらす
    let q = null;
    for (let k = 0, shift = 60; k < 8; k++, shift /= 2) {
      q = project(cfg, W, H, Z, cfg.shiftX * shift, cfg.shiftY * shift);
      if (q.every(([x, y]) => x > 12 && y > 12 && x < W - 12 && y < H - 12)) break;
      if (k >= 3) Z *= 1.08;
    }

    const bg = drawBackground(rnd, cfg.bg, W, H);
    const bx = bg.getContext('2d');
    if (cfg.under) {
      // 下に重なったもう1枚の紙（上の紙の影がこの上に落ちる）
      bx.fillStyle = '#ecebe6';
      bx.beginPath();
      q.forEach(([x, y], i) => (i ? bx.lineTo(x + 40, y - 30) : bx.moveTo(x + 40, y - 30)));
      bx.closePath(); bx.fill();
    }
    // 紙の落とす影
    bx.save();
    bx.filter = 'blur(14px)';
    bx.fillStyle = 'rgba(0,0,0,.45)';
    bx.beginPath();
    q.forEach(([x, y], i) => (i ? bx.lineTo(x + 8, y + 12) : bx.moveTo(x + 8, y + 12)));
    bx.closePath(); bx.fill();
    bx.restore();
    if (cfg.pen) {
      bx.save(); bx.translate(q[1][0] + 30, q[1][1] + 200); bx.rotate(1.2); bx.fillStyle = '#16233a'; bx.fillRect(0, -9, 360, 18); bx.restore();
    }

    const doc = drawDoc(rnd, cfg.aspect, cfg.paper, cfg.kind);
    const dw = doc.width, dh = doc.height;
    const dd = doc.getContext('2d').getImageData(0, 0, dw, dh).data;
    const img = bx.getImageData(0, 0, W, H);
    const d = img.data;
    const Hm = Geo.homography(q, [[0, 0], [dw, 0], [dw, dh], [0, dh]]);
    const lg = [Math.cos(cfg.lightDir), Math.sin(cfg.lightDir)];
    const sh = cfg.shadow;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const j = (y * W + x) << 2;
        const nx = x / W - 0.5, ny = y / H - 0.5;
        let light = 1 + cfg.gradient * (nx * lg[0] + ny * lg[1]) - cfg.vignette * (nx * nx + ny * ny) * 2;
        if (sh) {
          const sx = (x / W - sh.x) / sh.r, sy = (y / H - sh.y) / sh.r;
          light *= 1 - sh.k * Math.exp(-(sx * sx + sy * sy));
        }
        const [u, v] = Geo.project(Hm, x + 0.5, y + 0.5);
        if (u >= 0 && v >= 0 && u < dw && v < dh) {
          const k = (((v | 0) * dw) + (u | 0)) << 2;
          d[j] = dd[k]; d[j + 1] = dd[k + 1]; d[j + 2] = dd[k + 2];
        }
        d[j] *= light * cfg.tint[0];
        d[j + 1] *= light * cfg.tint[1];
        d[j + 2] *= light * cfg.tint[2];
      }
    }
    const nz = mulberry32(seed + 7);
    for (let j = 0; j < d.length; j += 4) {
      const e = (nz() + nz() - 1) * cfg.noise;
      d[j] += e; d[j + 1] += e; d[j + 2] += e;
    }
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const cx = c.getContext('2d');
    cx.putImageData(img, 0, 0);
    if (cfg.blur) {
      const c2 = document.createElement('canvas');
      c2.width = W; c2.height = H;
      const x2 = c2.getContext('2d');
      x2.filter = `blur(${cfg.blur}px)`;
      x2.drawImage(c, 0, 0);
      cx.drawImage(c2, 0, 0);
    }
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    const bmp = await createImageBitmap(blob);
    return { bmp, gt: Geo.orderQuad(q), W, H };
  }

  function configs() {
    const rnd = mulberry32(2026);
    const pick = (arr) => arr[(rnd() * arr.length) | 0];
    const between = (a, b) => a + rnd() * (b - a);
    const list = [];
    const bgs = ['woodDark', 'woodLight', 'gray', 'white', 'black', 'cloth', 'mat', 'blue', 'beige'];
    const kinds = ['text', 'table', 'dense', 'photo'];
    for (let i = 0; i < 54; i++) {
      const hard = i % 3 === 2;
      const aspect = i % 9 === 4 ? 2.6 : i % 9 === 7 ? 1.294 : 1.4142;
      list.push({
        name: `#${String(i + 1).padStart(2, '0')}`,
        bg: bgs[i % bgs.length],
        kind: aspect > 2 ? 'receipt' : pick(kinds),
        aspect,
        paper: pick(['#f7f7f3', '#f3eedc', '#ebe9e3']),
        landscape: rnd() < 0.2,
        rx: between(-0.55, 0.55) * (hard ? 1.2 : 0.7),
        ry: between(-0.35, 0.35) * (hard ? 1.2 : 0.7),
        rz: between(-0.6, 0.6) * (hard ? 1.3 : 0.6),
        fill: between(hard ? 0.2 : 0.3, 0.6),
        shiftX: between(-1, 1),
        shiftY: between(-1, 1),
        gradient: between(0, 0.35),
        vignette: between(0, 0.35),
        lightDir: between(0, Math.PI * 2),
        shadow: rnd() < 0.5 ? { x: between(0.3, 0.7), y: between(0.4, 0.9), r: between(0.12, 0.3), k: between(0.15, 0.4) } : null,
        tint: pick([[1, 1, 1], [1.02, 0.97, 0.88], [0.94, 0.98, 1.04]]),
        noise: between(3, 12),
        blur: rnd() < 0.3 ? 1.2 : 0,
        under: hard && rnd() < 0.35,
        pen: rnd() < 0.3,
      });
    }
    return list;
  }

  function evaluate(quadN, gt, W, H) {
    if (!quadN) return { found: false, err: Infinity };
    const q = Geo.orderQuad(quadN.map(([x, y]) => [x * W, y * H]));
    const err = Math.max(...q.map((p, i) => Geo.dist(p, gt[i]))) / Math.max(W, H);
    return { found: true, err, q };
  }

  const params = new URLSearchParams(location.search);
  const long = Number(params.get('long')) || 480;
  const only = params.get('only');
  // ?fill=0.7-0.92 で、書類が画面に占める割合を変える（スマホでは画面いっぱいに撮ることが多い）
  const fillRange = (params.get('fill') || '').split('-').map(Number);
  const list = configs()
    .filter((c) => !only || only.split(',').includes(c.name))
    .map((c, i) => (fillRange.length === 2 && fillRange.every(Number.isFinite)
      ? { ...c, fill: fillRange[0] + ((i * 0.618) % 1) * (fillRange[1] - fillRange[0]) }
      : c));
  const status = document.getElementById('status');
  const grid = document.getElementById('grid');
  const rows = [];
  for (let i = 0; i < list.length; i++) {
    const cfg = list[i];
    status.textContent = `${i + 1} / ${list.length}`;
    const scene = await renderScene(cfg, 100 + i);
    // 書類の一部が画面の外に出ている場面は対象外
    const inside = scene.gt.every(([x, y]) => x > 2 && y > 2 && x < scene.W - 2 && y < scene.H - 2);
    let t0 = performance.now();
    const v1 = evaluate(typeof DetectV1 !== 'undefined' ? DetectV1.detect(scene.bmp, long) : null, scene.gt, scene.W, scene.H);
    const t1 = performance.now() - t0;
    const aspectOpt = params.get('aspect') ? Number(params.get('aspect')) : null;
    t0 = performance.now();
    const prevFound = typeof DetectV2 !== 'undefined' ? DetectV2.find(scene.bmp, { long, aspect: aspectOpt }) : null;
    const tp = performance.now() - t0;
    const prev = evaluate(prevFound && prevFound.quad, scene.gt, scene.W, scene.H);
    t0 = performance.now();
    const found = Detect.find(scene.bmp, { long, aspect: aspectOpt, refineLong: Number(params.get('refine')) || 0, debug: !!only });
    const t2 = performance.now() - t0;
    const v2 = evaluate(found && found.quad, scene.gt, scene.W, scene.H);
    // 縦横比の見積もり: 正解の四隅から求めた幅/高さと、本当の 1/aspect を比べる（素朴な辺の長さの比とも比べる）
    const trueRatio = 1 / cfg.aspect;
    const est = Geo.estimateAspect(scene.gt, scene.W, scene.H);
    const out = Geo.outputAspect(scene.gt, scene.W, scene.H, null);
    const sz = Geo.quadSize(scene.gt);
    const row = {
      name: cfg.name, bg: cfg.bg, kind: cfg.kind, inside, v1: v1.err, prev: prev.err, v2: v2.err, score: found ? found.score : 0, t1, tp, t2,
      aspZhang: est ? Math.abs(est / trueRatio - 1) : 1,
      aspOut: Math.abs(out / trueRatio - 1),
      aspNaive: Math.abs(sz.w / sz.h / trueRatio - 1),
    };
    if (only && found) {
      // 調べるとき用: 正解の四角形の点数と、上位の候補
      const gtN = scene.gt.map(([x, y]) => [x / scene.W, y / scene.H]);
      row.gtScore = found.debug.scoreOf(gtN);
      row.unrefinedErr = evaluate(found.debug.unrefined, scene.gt, scene.W, scene.H).err;
      row.top = found.debug.top.map((c) => ({ from: c.from, s: c.s, err: +evaluate(c.q, scene.gt, scene.W, scene.H).err.toFixed(4) }));
      row.cornerErr = v2.q ? v2.q.map((p, k) => Math.round(Geo.dist(p, scene.gt[k]))) : null;
    }
    rows.push(row);

    const fig = document.createElement('figure');
    const c = document.createElement('canvas');
    const s = 240 / Math.max(scene.W, scene.H);
    c.width = scene.W * s; c.height = scene.H * s;
    const x = c.getContext('2d');
    x.drawImage(scene.bmp, 0, 0, c.width, c.height);
    const poly = (q, color, wdt) => { x.strokeStyle = color; x.lineWidth = wdt; x.beginPath(); q.forEach(([px, py], k) => (k ? x.lineTo(px * s, py * s) : x.moveTo(px * s, py * s))); x.closePath(); x.stroke(); };
    poly(scene.gt, '#22c55e', 3);
    if (v1.q) poly(v1.q, '#f97316', 1.5);
    if (v2.q) poly(v2.q, '#06b6d4', 1.5);
    const cap = document.createElement('figcaption');
    const fmt = (e) => (Number.isFinite(e) ? `${(e * 100).toFixed(1)}%` : '×');
    cap.textContent = `${cfg.name} ${cfg.bg}/${cfg.kind}  旧 ${fmt(v1.err)}  新 ${fmt(v2.err)}`;
    fig.append(c, cap);
    grid.append(fig);
    scene.bmp.close();
  }

  const valid = rows.filter((r) => r.inside);
  const rate = (key, lim) => valid.filter((r) => r[key] < lim).length / valid.length;
  const median = (arr) => { const a = arr.slice().sort((p, q) => p - q); return a[(a.length / 2) | 0]; };
  const summary = {
    scenes: valid.length,
    v1: { ok15: rate('v1', 0.015), ok08: rate('v1', 0.008), median: median(valid.map((r) => r.v1)), ms: median(valid.map((r) => r.t1)) },
    prev: { ok15: rate('prev', 0.015), ok08: rate('prev', 0.008), ok03: rate('prev', 0.003), median: median(valid.map((r) => r.prev)), ms: median(valid.map((r) => r.tp)) },
    v2: { ok15: rate('v2', 0.015), ok08: rate('v2', 0.008), ok03: rate('v2', 0.003), median: median(valid.map((r) => r.v2)), ms: median(valid.map((r) => r.t2)) },
    aspect: {
      naiveMedian: median(rows.map((r) => r.aspNaive)),
      naiveWithin3: rows.filter((r) => r.aspNaive < 0.03).length / rows.length,
      outMedian: median(rows.map((r) => r.aspOut)),
      outWithin3: rows.filter((r) => r.aspOut < 0.03).length / rows.length,
    },
  };
  status.textContent = JSON.stringify(summary);
  window.__bench = { summary, rows };
})();
