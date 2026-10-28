// 比較用: 作り直す前の四隅検出（明るい領域の凸包だけを使う方式）
// 「明るくて色の薄い領域 = 紙」とみなして二値化し、いちばん書類らしい塊の凸包を四角形にまとめる。
const DetectV1 = (() => {
  'use strict';

  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });

  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const win = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / win;
        acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / win;
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  function morph(mask, w, h, erode) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = erode ? 1 : 0;
        for (let dy = -1; dy <= 1 && v === (erode ? 1 : 0); dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const m = mask[yy * w + xx];
            if (erode && !m) { v = 0; break; }
            if (!erode && m) { v = 1; break; }
          }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  // 連結成分ごとに面積と、画像の端に接している長さを数える
  function components(mask, w, h) {
    const labels = new Int32Array(w * h);
    const queue = new Int32Array(w * h);
    const comps = [];
    let next = 1;
    for (let start = 0; start < w * h; start++) {
      if (!mask[start] || labels[start]) continue;
      const c = { label: next, area: 0, top: 0, bottom: 0, left: 0, right: 0 };
      let head = 0, tail = 0;
      queue[tail++] = start;
      labels[start] = next;
      while (head < tail) {
        const p = queue[head++];
        const x = p % w, y = (p / w) | 0;
        c.area++;
        if (y === 0) c.top++;
        if (y === h - 1) c.bottom++;
        if (x === 0) c.left++;
        if (x === w - 1) c.right++;
        if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = next; queue[tail++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = next; queue[tail++] = p + 1; }
        if (y > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = next; queue[tail++] = p - w; }
        if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = next; queue[tail++] = p + w; }
      }
      comps.push(c);
      next++;
    }
    return { labels, comps };
  }

  /**
   * source: 描画できるもの（video / img / canvas / ImageBitmap）
   * 戻り値: 正規化座標（0〜1）の四隅 [左上, 右上, 右下, 左下]。見つからなければ null
   */
  function detect(source, long = 360) {
    const { w: sw, h: sh } = Imaging.sizeOf(source);
    if (!sw || !sh) return null;
    const s = long / Math.max(sw, sh);
    const w = Math.max(16, Math.round(sw * s));
    const h = Math.max(16, Math.round(sh * s));
    if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
    wctx.drawImage(source, 0, 0, w, h);
    const px = wctx.getImageData(0, 0, w, h).data;
    const n = w * h;

    // 紙らしさ = 明るさ − 彩度。木の机や色の付いた背景と紙を分けやすくする
    let g = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = px[j], gg = px[j + 1], b = px[j + 2];
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      g[i] = 0.299 * r + 0.587 * gg + 0.114 * b - 0.6 * (mx - mn);
    }
    g = boxBlur(g, w, h, Math.max(1, Math.round(long / 160)));

    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[Math.max(0, Math.min(255, g[i] | 0))]++;
    const t = Imaging.otsu(hist, n);

    let mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = g[i] > t ? 1 : 0;
    // 紙と背景の明るい部分が細くつながっているのを切り離す
    mask = morph(morph(mask, w, h, true), w, h, false);

    const { labels, comps } = components(mask, w, h);
    let best = null;
    let bestScore = 0;
    for (const c of comps) {
      if (c.area < n * 0.06) continue;
      const sides = (c.top > w * 0.3) + (c.bottom > w * 0.3) + (c.left > h * 0.3) + (c.right > h * 0.3);
      if (sides >= 3) continue; // ほぼ画面いっぱいに広がる明るい塊は背景とみなす
      const score = c.area * (sides === 2 ? 0.55 : sides === 1 ? 0.85 : 1);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) return null;

    // 行ごとの左端と右端（画素の中心）だけを凸包の候補にする。
    // 画素の外側の角を使うと、斜めの辺で机が少し写り込む
    const pts = [];
    for (let y = 0; y < h; y++) {
      let minX = -1, maxX = -1;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (labels[row + x] === best.label) {
          if (minX < 0) minX = x;
          maxX = x;
        }
      }
      if (minX >= 0) pts.push([minX + 0.5, y + 0.5], [maxX + 0.5, y + 0.5]);
    }
    const hull = Geo.convexHull(pts);
    if (hull.length < 4) return null;
    let quad = Geo.hullToQuad(hull);
    if (!quad) return null;
    quad = Geo.orderQuad(quad.map(([x, y]) => [Math.min(w, Math.max(0, x)), Math.min(h, Math.max(0, y))]));

    if (!Geo.isConvex(quad)) return null;
    if (Geo.area(quad) < n * 0.08) return null;
    if (Geo.angles(quad).some((a) => a < 40 || a > 140)) return null;
    // 凸包に比べて四角形が大きすぎるなら、紙の形ではない
    if (Geo.area(quad) > Geo.area(hull) * 1.25) return null;

    return quad.map(([x, y]) => [x / w, y / h]);
  }

  return { detect };
})();
