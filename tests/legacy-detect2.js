// 比較用: 直線と明るい領域から候補を集める方式（1つずつ点を調べて採点する版）
// 1. 縮小した画像に「閉じ処理」をかけて文字や細い線を消し、紙と背景の境目だけを残す
// 2. 四角形の候補を 2 通りで集める
//    a) 直線検出（ハフ変換）で見つけた直線を 4 本組み合わせた四角形
//    b) 明るい紙の領域の凸包をまとめた四角形
// 3. 四辺に沿って境目がどれだけ続いているか、内側が外側より明るいか、面積、角の形、縦横比で点数をつける
// 4. いちばん点の高い四角形の各辺を、境目の位置に合わせて細かく直す
const DetectV2 = (() => {
  'use strict';

  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { willReadFrequently: true });

  const TH = 180;
  const COS = new Float32Array(TH), SIN = new Float32Array(TH);
  for (let t = 0; t < TH; t++) { COS[t] = Math.cos((t * Math.PI) / 180); SIN[t] = Math.sin((t * Math.PI) / 180); }

  // ---------- 画像処理の部品 ----------

  // 正方形の窓での最大値（膨張）／最小値（収縮）。行と列に分けて求める
  function rankFilter(src, w, h, r, isMax) {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let v = src[row + x];
        const b = Math.min(w - 1, x + r);
        for (let k = Math.max(0, x - r); k <= b; k++) {
          const s = src[row + k];
          if (isMax ? s > v : s < v) v = s;
        }
        tmp[row + x] = v;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let v = tmp[y * w + x];
        const b = Math.min(h - 1, y + r);
        for (let k = Math.max(0, y - r); k <= b; k++) {
          const s = tmp[k * w + x];
          if (isMax ? s > v : s < v) v = s;
        }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  // 明るい紙の上の暗く細いもの（文字・罫線）を消す
  const closing = (src, w, h, r) => rankFilter(rankFilter(src, w, h, r, true), w, h, r, false);

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

  function sobel(src, w, h) {
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const a = src[i - w - 1], b = src[i - w], c = src[i - w + 1];
        const d = src[i - 1], f = src[i + 1];
        const g = src[i + w - 1], k = src[i + w], m = src[i + w + 1];
        const sx = c + 2 * f + m - (a + 2 * d + g);
        const sy = g + 2 * k + m - (a + 2 * b + c);
        gx[i] = sx; gy[i] = sy; mag[i] = Math.sqrt(sx * sx + sy * sy);
      }
    }
    return { gx, gy, mag };
  }

  function percentile(arr, p) {
    let max = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
    if (!max) return 0;
    const bins = 1024;
    const hist = new Uint32Array(bins);
    for (let i = 0; i < arr.length; i++) hist[Math.min(bins - 1, ((arr[i] / max) * (bins - 1)) | 0)]++;
    let acc = 0;
    const target = arr.length * p;
    for (let b = 0; b < bins; b++) { acc += hist[b]; if (acc >= target) return ((b + 0.5) / (bins - 1)) * max; }
    return max;
  }

  // 勾配の向きに沿って極大の点だけを残す（細い境目にする）
  function thinEdges(gx, gy, mag, w, h, thr) {
    const e = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const m = mag[i];
        if (m < thr) continue;
        const ax = Math.abs(gx[i]), ay = Math.abs(gy[i]);
        let m1, m2;
        if (ay * 2.414 < ax) { m1 = mag[i - 1]; m2 = mag[i + 1]; }
        else if (ax * 2.414 < ay) { m1 = mag[i - w]; m2 = mag[i + w]; }
        else if ((gx[i] > 0) === (gy[i] > 0)) { m1 = mag[i - w - 1]; m2 = mag[i + w + 1]; }
        else { m1 = mag[i - w + 1]; m2 = mag[i + w - 1]; }
        if (m >= m1 && m > m2) e[i] = 1;
      }
    }
    return e;
  }

  // ハフ変換。境目の点ごとに、勾配の向き ±5° の直線にだけ票を入れる
  function houghLines(edges, gx, gy, w, h, maxLines, minVotes) {
    const diag = Math.ceil(Math.hypot(w, h));
    const nr = 2 * diag + 1;
    const acc = new Int32Array(TH * nr);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!edges[i]) continue;
        let deg = (Math.atan2(gy[i], gx[i]) * 180) / Math.PI;
        deg = ((deg % 180) + 180) % 180;
        const t0 = Math.round(deg);
        const px = x + 0.5, py = y + 0.5;
        for (let dt = -5; dt <= 5; dt++) {
          const t = (t0 + dt + TH) % TH;
          const r = Math.round(px * COS[t] + py * SIN[t]) + diag;
          acc[t * nr + r]++;
        }
      }
    }
    const peaks = [];
    for (let t = 0; t < TH; t++) {
      for (let r = 0; r < nr; r++) {
        const v = acc[t * nr + r];
        if (v < minVotes) continue;
        let isPeak = true;
        for (let dt = -4; dt <= 4 && isPeak; dt++) {
          const tt = t + dt;
          if (tt < 0 || tt >= TH) continue;
          for (let dr = -6; dr <= 6; dr++) {
            const rr = r + dr;
            if (rr < 0 || rr >= nr || (!dt && !dr)) continue;
            const u = acc[tt * nr + rr];
            if (u > v || (u === v && (tt * nr + rr) < (t * nr + r))) { isPeak = false; break; }
          }
        }
        if (isPeak) peaks.push({ t, rho: r - diag, votes: v });
      }
    }
    peaks.sort((a, b) => b.votes - a.votes);
    const lines = [];
    for (const p of peaks) {
      // 0° と 180° をまたぐ同じ直線を除く
      const dup = lines.some((l) => {
        const d = Math.abs(l.t - p.t);
        return (d <= 3 && Math.abs(l.rho - p.rho) <= 8) || (d >= TH - 3 && Math.abs(l.rho + p.rho) <= 8);
      });
      if (dup) continue;
      lines.push({ c: COS[p.t], s: SIN[p.t], rho: p.rho, t: p.t, votes: p.votes });
      if (lines.length >= maxLines) break;
    }
    return lines;
  }

  function intersect(a, b) {
    const det = a.c * b.s - a.s * b.c;
    if (Math.abs(det) < 1e-6) return null;
    return [(a.rho * b.s - a.s * b.rho) / det, (a.c * b.rho - a.rho * b.c) / det];
  }

  const angleGap = (t1, t2) => { const d = Math.abs(t1 - t2) % 180; return Math.min(d, 180 - d); };

  // ---------- 明るい領域から作る候補 ----------

  function otsuOf(arr) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < arr.length; i++) hist[Math.max(0, Math.min(255, arr[i] | 0))]++;
    return Imaging.otsu(hist, arr.length);
  }

  function binaryMorph(mask, w, h, erode) {
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

  function regionQuads(map, w, h) {
    const t = otsuOf(map);
    let mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = map[i] > t ? 1 : 0;
    mask = binaryMorph(binaryMorph(mask, w, h, true), w, h, false);

    const n = w * h;
    const labels = new Int32Array(n);
    const queue = new Int32Array(n);
    const comps = [];
    let next = 1;
    for (let start = 0; start < n; start++) {
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
    const picked = comps
      .filter((c) => c.area >= n * 0.05)
      .filter((c) => (c.top > w * 0.3) + (c.bottom > w * 0.3) + (c.left > h * 0.3) + (c.right > h * 0.3) < 3)
      .sort((a, b) => b.area - a.area)
      .slice(0, 3);

    const quads = [];
    for (const comp of picked) {
      const pts = [];
      for (let y = 0; y < h; y++) {
        let minX = -1, maxX = -1;
        const row = y * w;
        for (let x = 0; x < w; x++) {
          if (labels[row + x] === comp.label) { if (minX < 0) minX = x; maxX = x; }
        }
        if (minX >= 0) pts.push([minX + 0.5, y + 0.5], [maxX + 0.5, y + 0.5]);
      }
      const hull = Geo.convexHull(pts);
      if (hull.length < 4) continue;
      const q = Geo.hullToQuad(hull);
      if (q) quads.push(Geo.orderQuad(q));
    }
    return quads;
  }

  // ---------- 点数づけ ----------

  function makeContext(source, long) {
    const { w: sw, h: sh } = Imaging.sizeOf(source);
    if (!sw || !sh) return null;
    const s = long / Math.max(sw, sh);
    const w = Math.max(32, Math.round(sw * s));
    const h = Math.max(32, Math.round(sh * s));
    if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
    wctx.drawImage(source, 0, 0, w, h);
    const px = wctx.getImageData(0, 0, w, h).data;
    const n = w * h;
    const lum = new Float32Array(n);
    const paper = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = px[j], g = px[j + 1], b = px[j + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      paper[i] = lum[i] - 0.6 * (mx - mn);
    }
    const r = Math.max(2, Math.round(Math.max(w, h) / 160));
    const L = boxBlur(boxBlur(closing(lum, w, h, r), w, h, 1), w, h, 1);
    const P = boxBlur(closing(paper, w, h, r), w, h, 1);
    const { gx, gy, mag } = sobel(L, w, h);
    const gscale = Math.max(40, percentile(mag, 0.99));
    return { w, h, L, P, gx, gy, mag, gscale, long: Math.max(w, h) };
  }

  function makeScorer(ctx, aspect) {
    const { w, h, gx, gy, L, gscale } = ctx;
    const strong = 0.4 * gscale;
    const grad = (x, y, nx, ny) => {
      const xi = Math.round(x - 0.5), yi = Math.round(y - 0.5);
      if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) return -1;
      const i = yi * w + xi;
      return Math.abs(gx[i] * nx + gy[i] * ny);
    };
    const lumAt = (x, y) => {
      const xi = Math.round(x - 0.5), yi = Math.round(y - 0.5);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) return -1;
      return L[yi * w + xi];
    };
    const onBorder = (P, Q) => {
      const e = 2.5;
      return (P[0] < e && Q[0] < e) || (P[1] < e && Q[1] < e) || (P[0] > w - e && Q[0] > w - e) || (P[1] > h - e && Q[1] > h - e);
    };

    function side(P, Q, cx, cy) {
      const dx = Q[0] - P[0], dy = Q[1] - P[1];
      const len = Math.hypot(dx, dy);
      if (len < 6) return { sup: 0, con: 0 };
      if (onBorder(P, Q)) return { sup: 0.4, con: 0.04, border: true };
      let nx = -dy / len, ny = dx / len;
      if ((cx - (P[0] + Q[0]) / 2) * nx + (cy - (P[1] + Q[1]) / 2) * ny < 0) { nx = -nx; ny = -ny; }
      const n = Math.max(12, Math.min(64, Math.round(len / 4)));
      let sup = 0, cin = 0, cout = 0, cc = 0;
      for (let k = 0; k < n; k++) {
        const t = 0.07 + (0.86 * (k + 0.5)) / n;
        const x = P[0] + dx * t, y = P[1] + dy * t;
        let best = -1;
        for (let d = -2; d <= 2; d++) {
          const g = grad(x + d * nx, y + d * ny, nx, ny);
          if (g > best) best = g;
        }
        sup += best < 0 ? 0.4 : Math.min(1, best / strong);
        const li = lumAt(x + 4 * nx, y + 4 * ny), lo = lumAt(x - 4 * nx, y - 4 * ny);
        if (li >= 0 && lo >= 0) { cin += li; cout += lo; cc++; }
      }
      return { sup: sup / n, con: cc ? (cin - cout) / cc / 255 : 0 };
    }

    // 内側が紙らしく、ほぼ同じ明るさで埋まっているか（柄の布や机の木目の四角を除く）
    function uniformity(q) {
      const H = Geo.homography([[0, 0], [1, 0], [1, 1], [0, 1]], q);
      if (!H) return 0;
      const vals = [];
      for (let i = 1; i <= 7; i++) {
        for (let j = 1; j <= 7; j++) {
          const [x, y] = Geo.project(H, (i - 0.5) / 7 * 0.9 + 0.05, (j - 0.5) / 7 * 0.9 + 0.05);
          const v = lumAt(x, y);
          if (v >= 0) vals.push(v);
        }
      }
      if (vals.length < 10) return 0;
      const sorted = vals.slice().sort((a, b) => a - b);
      const med = sorted[(sorted.length / 2) | 0];
      return vals.filter((v) => Math.abs(v - med) < 28).length / vals.length;
    }

    return function score(q) {
      const area = Geo.area(q) / (w * h);
      if (area < 0.05 || !Geo.isConvex(q)) return 0;
      const dev = Math.max(...Geo.angles(q).map((a) => Math.abs(a - 90)));
      if (dev > 55) return 0;
      const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
      const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
      const sides = [0, 1, 2, 3].map((i) => side(q[i], q[(i + 1) % 4], cx, cy));
      const sups = sides.map((s) => s.sup);
      const mean = sups.reduce((a, b) => a + b, 0) / 4;
      const min = Math.min(...sups);
      const inner = sides.filter((s) => !s.border);
      // 書類は背景より明るいことが多い。内側が暗い四角形（書類の中の写真など）は点を下げる
      const con = inner.length ? inner.reduce((a, s) => a + s.con, 0) / inner.length : 0;
      let s = 0.55 * mean + 0.45 * min;
      s *= con >= 0 ? 0.65 + 0.35 * Math.min(1, con / 0.12) : 0.65 - 0.25 * Math.min(1, -con / 0.12);
      s *= Math.min(1, Math.sqrt(area / 0.12)) * (0.9 + 0.1 * Math.min(1, area / 0.6));
      s *= 1 - 0.35 * (dev / 55) ** 2;
      s *= 0.55 + 0.45 * Math.min(1, Math.max(0, (uniformity(q) - 0.35) / 0.35));
      if (aspect) {
        const est = Geo.estimateAspect(q, w, h);
        if (est) {
          const ls = est >= 1 ? est : 1 / est;
          // 指定と違う形でも、ふちがはっきりしていれば見つけられるよう、下げすぎない
          const off = Math.log(ls / aspect);
          s *= Math.max(0.5, Math.exp(-((off / 0.15) ** 2) / 2));
        }
      }
      return s;
    };
  }

  // ---------- 辺の位置を細かく合わせる ----------

  function fitLine(pts) {
    const fit = (list) => {
      let mx = 0, my = 0;
      for (const [x, y] of list) { mx += x; my += y; }
      mx /= list.length; my /= list.length;
      let sxx = 0, sxy = 0, syy = 0;
      for (const [x, y] of list) { const dx = x - mx, dy = y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
      const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      const nx = -Math.sin(a), ny = Math.cos(a);
      return { c: nx, s: ny, rho: nx * mx + ny * my };
    };
    let line = fit(pts);
    const res = pts.map(([x, y]) => Math.abs(line.c * x + line.s * y - line.rho));
    const sorted = res.slice().sort((a, b) => a - b);
    const lim = Math.max(0.75, 2.5 * sorted[(sorted.length / 2) | 0]);
    const kept = pts.filter((_, i) => res[i] <= lim);
    if (kept.length >= 6) line = fit(kept);
    return line;
  }

  // r: 辺から法線方向に探す幅（画素）
  function refine(q, ctx, r) {
    const { w, h, gx, gy, gscale } = ctx;
    const grad = (x, y, nx, ny) => {
      const xi = Math.round(x - 0.5), yi = Math.round(y - 0.5);
      if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) return -1;
      const i = yi * w + xi;
      return Math.abs(gx[i] * nx + gy[i] * ny);
    };
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const P = q[i], Q = q[(i + 1) % 4];
      const dx = Q[0] - P[0], dy = Q[1] - P[1];
      const len = Math.hypot(dx, dy);
      const nx = -dy / len, ny = dx / len;
      const n = Math.max(16, Math.min(160, Math.round(len / 2)));
      const pts = [];
      for (let k = 0; k < n; k++) {
        const t = 0.08 + (0.84 * (k + 0.5)) / n;
        const x0 = P[0] + dx * t, y0 = P[1] + dy * t;
        const vals = [];
        let best = 0, bd = 0;
        for (let d = -r; d <= r; d++) {
          const v = grad(x0 + d * nx, y0 + d * ny, nx, ny);
          vals.push(v);
          if (v > best) { best = v; bd = d; }
        }
        if (best < 0.3 * gscale) continue;
        const j = bd + r;
        let off = 0;
        if (j > 0 && j < vals.length - 1 && vals[j - 1] >= 0 && vals[j + 1] >= 0) {
          const den = vals[j - 1] - 2 * vals[j] + vals[j + 1];
          if (den < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (vals[j - 1] - vals[j + 1])) / den));
        }
        pts.push([x0 + (bd + off) * nx, y0 + (bd + off) * ny]);
      }
      lines.push(pts.length >= Math.max(6, n * 0.35)
        ? fitLine(pts)
        : { c: nx, s: ny, rho: nx * P[0] + ny * P[1] });
    }
    const maxShift = 0.04 * ctx.long;
    return q.map((p, i) => {
      const c = intersect(lines[(i + 3) % 4], lines[i]);
      return c && Geo.dist(c, p) < maxShift ? c : p;
    });
  }

  // ---------- まとめ ----------

  /**
   * source: 描画できるもの（video / img / canvas / ImageBitmap）
   * opts.long: 検出に使う解像度（長辺の画素数）
   * opts.aspect: 書類の縦横比（長辺 / 短辺）。わかっていれば、その形の四角形を選びやすくする
   * 戻り値: { quad: 正規化座標（0〜1）の四隅 [左上, 右上, 右下, 左下], score } か null
   */
  function find(source, { long = 480, aspect = null, refine: doRefine = true, debug = false } = {}) {
    const ctx = makeContext(source, long);
    if (!ctx) return null;
    const { w, h, gx, gy, mag, gscale } = ctx;
    const score = makeScorer(ctx, aspect);
    const candidates = [];
    const add = (q, from) => {
      if (!q || q.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return;
      if (q.some(([x, y]) => x < -0.08 * w || y < -0.08 * h || x > 1.08 * w || y > 1.08 * h)) return;
      const oq = Geo.orderQuad(q.map(([x, y]) => [Math.min(w, Math.max(0, x)), Math.min(h, Math.max(0, y))]));
      const s = score(oq);
      if (s > 0) candidates.push({ q: oq, s, from });
    };

    // a) 直線の組み合わせ
    const edges = thinEdges(gx, gy, mag, w, h, 0.15 * gscale);
    const lines = houghLines(edges, gx, gy, w, h, long > 300 ? 30 : 18, Math.max(12, Math.round(0.1 * ctx.long)));
    lines.push(
      { c: 1, s: 0, rho: 0, t: 0, border: true },
      { c: 1, s: 0, rho: w, t: 0, border: true },
      { c: 0, s: 1, rho: 0, t: 90, border: true },
      { c: 0, s: 1, rho: h, t: 90, border: true },
    );
    const cx = w / 2, cy = h / 2;
    const foot = (l) => { const d = cx * l.c + cy * l.s - l.rho; return [cx - d * l.c, cy - d * l.s]; };
    const pairs = [];
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        if (angleGap(lines[i].t, lines[j].t) > 28) continue;
        if (Geo.dist(foot(lines[i]), foot(lines[j])) < 0.12 * ctx.long) continue;
        pairs.push([lines[i], lines[j]]);
      }
    }
    let tried = 0;
    for (let i = 0; i < pairs.length && tried < 6000; i++) {
      for (let j = i + 1; j < pairs.length && tried < 6000; j++) {
        const [a1, a2] = pairs[i];
        const [b1, b2] = pairs[j];
        if (a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2) continue;
        if (angleGap(a1.t, b1.t) < 40) continue;
        tried++;
        add([intersect(a1, b1), intersect(a1, b2), intersect(a2, b2), intersect(a2, b1)].map((p) => p || [NaN, NaN]), 'lines');
      }
    }

    // b) 明るい紙の領域
    for (const q of regionQuads(ctx.P, w, h)) add(q, 'region');
    for (const q of regionQuads(ctx.L, w, h)) add(q, 'region');

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.s - a.s);

    // 上位の候補は、辺を境目に合わせ直してから比べ直す
    const top = candidates.slice(0, doRefine ? 8 : 1).map((c) => {
      if (!doRefine) return c;
      // 広めに探して大きなずれを直し、狭く探して細かく合わせる
      const wide = Math.max(4, Math.round(ctx.long / 60));
      const narrow = Math.max(3, Math.round(ctx.long / 120));
      const rq = Geo.orderQuad(refine(Geo.orderQuad(refine(c.q, ctx, wide)), ctx, narrow));
      const rs = Geo.isConvex(rq) ? score(rq) : 0;
      // 合わせ直した位置のほうが正確なので、点数がほとんど落ちなければそちらを使う
      return rs >= c.s * 0.97 ? { q: rq, s: Math.max(rs, c.s), from: c.from, raw: c.q } : { ...c, raw: c.q };
    }).sort((a, b) => b.s - a.s);
    let best = top[0];
    if (best.s < 0.3) return null;

    // 書類の中の写真や表の線で切れた四角形より、辺を共有して外側を囲む四角形（書類全体）を選ぶ
    const tol = 0.025 * ctx.long;
    const onLine = (p, a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len < tol;
    };
    const shared = (inner, outer) => {
      let n = 0;
      for (let i = 0; i < 4; i++) {
        const a = inner[i], b = inner[(i + 1) % 4];
        for (let j = 0; j < 4; j++) {
          const c = outer[j], d = outer[(j + 1) % 4];
          if (onLine(a, c, d) && onLine(b, c, d)) { n++; break; }
        }
      }
      return n;
    };
    const bestArea = Geo.area(best.q);
    for (const c of top.slice(1)) {
      if (c.s < best.s * 0.85 || Geo.area(c.q) < bestArea * 1.15) continue;
      if (shared(best.q, c.q) >= 2) { best = c; break; }
    }

    const quad = best.q;
    const norm = (q) => q.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
    const result = { quad: norm(quad), score: best.s };
    if (debug) {
      result.debug = {
        size: [w, h],
        unrefined: norm(best.raw || best.q),
        top: candidates.slice(0, 8).map((c) => ({ from: c.from, s: +c.s.toFixed(3), q: norm(c.q) })),
        scoreOf: (qn) => score(Geo.orderQuad(qn.map(([x, y]) => [x * w, y * h]))),
      };
    }
    return result;
  }

  // 以前の呼び方との互換用
  function detect(source, long = 480) {
    const r = find(source, { long });
    return r ? r.quad : null;
  }

  return { find, detect };
})();
