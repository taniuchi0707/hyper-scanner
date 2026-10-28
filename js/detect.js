// 書類の四隅を見つける。
// 1. 縮小した画像に「閉じ処理」をかけて文字や細い線を消し、紙と背景の境目だけを残す
// 2. 四角形の候補を 2 通りで集める
//    a) 直線検出（ハフ変換）で見つけた直線を 4 本組み合わせた四角形
//    b) 明るい紙の領域の凸包をまとめた四角形
// 3. 直線ごとに「境目の強さ」と「両側の明るさ」の累積和を先に作り、すべての組み合わせを引き算だけで手早く採点する
// 4. 上位の候補は、内側が紙らしく均一か・縦横比なども含めて採点し直し、辺を境目に合わせ直してから選ぶ
// 5. 写真から探すときは、最後に高い解像度で辺の位置を細かく合わせる
// 画面（メインスレッド）と Web Worker の両方で動く
function DetectModule(Geo, Imaging) {
  'use strict';

  // 縮小した画素を取り出す作業用のキャンバス（大きさごとに使い回す）
  const canvases = new Map();
  function pixelsOf(source, long) {
    const { w: sw, h: sh } = Imaging.sizeOf(source);
    if (!sw || !sh) return null;
    const s = Math.min(1, long / Math.max(sw, sh));
    const w = Math.max(32, Math.round(sw * s));
    const h = Math.max(32, Math.round(sh * s));
    const key = `${w}x${h}`;
    let entry = canvases.get(key);
    if (!entry) {
      if (canvases.size >= 4) canvases.clear();
      const c = Imaging.makeCanvas(w, h);
      const x = c.getContext('2d', { willReadFrequently: true });
      x.imageSmoothingQuality = 'high';
      entry = { x };
      canvases.set(key, entry);
    }
    entry.x.drawImage(source, 0, 0, w, h);
    return { data: entry.x.getImageData(0, 0, w, h).data, w, h };
  }

  const TH = 180;
  const COS = new Float32Array(TH), SIN = new Float32Array(TH);
  for (let t = 0; t < TH; t++) { COS[t] = Math.cos((t * Math.PI) / 180); SIN[t] = Math.sin((t * Math.PI) / 180); }

  // ---------- 画像処理の部品 ----------

  // 正方形の窓での最大値（膨張）／最小値（収縮）。行と列に分けて求める。
  // van Herk / Gil-Werman の方法で、窓の幅によらず 1 画素あたり数回の比較で済む。
  // 最小値は、符号を反転して最大値として求める
  function rankFilter(src, w, h, r, isMax) {
    const sign = isMax ? 1 : -1;
    const k = 2 * r + 1;
    const n = Math.max(w, h), m = n + 2 * r;
    const pad = new Float32Array(m), g = new Float32Array(m), hb = new Float32Array(m), res = new Float32Array(n);
    const tmp = new Float32Array(w * h); // 符号を反転したまま持つ
    const out = new Float32Array(w * h);
    const core = (len) => {
      const mm = len + 2 * r;
      for (let i = 0; i < r; i++) { pad[i] = -Infinity; pad[len + r + i] = -Infinity; }
      for (let s = 0; s < mm; s += k) {
        const e = s + k < mm ? s + k : mm;
        let acc = -Infinity;
        for (let i = s; i < e; i++) { const v = pad[i]; if (v > acc) acc = v; g[i] = acc; }
        acc = -Infinity;
        for (let i = e - 1; i >= s; i--) { const v = pad[i]; if (v > acc) acc = v; hb[i] = acc; }
      }
      for (let x = 0; x < len; x++) { const a = hb[x], b = g[x + k - 1]; res[x] = a > b ? a : b; }
    };
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) pad[r + x] = sign * src[row + x];
      core(w);
      for (let x = 0; x < w; x++) tmp[row + x] = res[x];
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) pad[r + y] = tmp[y * w + x];
      core(h);
      for (let y = 0; y < h; y++) out[y * w + x] = sign * res[y];
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

  // 3×3 の収縮（erode）／膨張。行と列に分けて求める（画像の外は端の値と同じとみなす）
  function binaryMorph(mask, w, h, erode) {
    const tmp = new Uint8Array(w * h);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x, c = mask[i];
        const l = x > 0 ? mask[i - 1] : c, r = x < w - 1 ? mask[i + 1] : c;
        tmp[i] = erode ? (l & c & r) : (l | c | r);
      }
    }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x, c = tmp[i];
        const u = y > 0 ? tmp[i - w] : c, d = y < h - 1 ? tmp[i + w] : c;
        out[i] = erode ? (u & c & d) : (u | c | d);
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
        const y = (p / w) | 0, x = p - y * w;
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

    // 選んだ塊ごとに、行の左端と右端（画素の中心）を 1 回の走査で集める
    const slot = new Int8Array(next);
    picked.forEach((c, i) => { slot[c.label] = i + 1; });
    const minX = picked.map(() => new Int32Array(h).fill(-1));
    const maxX = picked.map(() => new Int32Array(h).fill(-1));
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const k = slot[labels[row + x]];
        if (!k) continue;
        if (minX[k - 1][y] < 0) minX[k - 1][y] = x;
        maxX[k - 1][y] = x;
      }
    }
    const quads = [];
    for (let i = 0; i < picked.length; i++) {
      const pts = [];
      for (let y = 0; y < h; y++) {
        if (minX[i][y] >= 0) pts.push([minX[i][y] + 0.5, y + 0.5], [maxX[i][y] + 0.5, y + 0.5]);
      }
      const hull = Geo.convexHull(pts);
      if (hull.length < 4) continue;
      const q = Geo.hullToQuad(hull);
      if (q) quads.push(Geo.orderQuad(q));
    }
    return quads;
  }

  // ---------- 点数づけ ----------

  function makeContext({ data: px, w, h }) {
    const n = w * h;
    const lum = new Float32Array(n);
    const sat = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = px[j], g = px[j + 1], b = px[j + 2];
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      sat[i] = mx - mn;
    }
    const r = Math.max(2, Math.round(Math.max(w, h) / 160));
    const L = boxBlur(boxBlur(closing(lum, w, h, r), w, h, 1), w, h, 1);
    // 紙らしさ = 明るさ − 彩度。文字を消した明るさから、ぼかした彩度を引く（木の机や色の付いた背景と紙を分けやすい）
    const satB = boxBlur(sat, w, h, 1);
    const P = new Float32Array(n);
    for (let i = 0; i < n; i++) P[i] = L[i] - 0.6 * satB[i];
    const { gx, gy, mag } = sobel(L, w, h);
    const gscale = Math.max(40, percentile(mag, 0.99));
    return { w, h, L, P, gx, gy, mag, gscale, long: Math.max(w, h) };
  }

  // 法線 (nx, ny) の向きの勾配の大きさ。画像の外は -1
  function gradSampler({ w, h, gx, gy }) {
    return (x, y, nx, ny) => {
      const xi = Math.round(x - 0.5), yi = Math.round(y - 0.5);
      if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) return -1;
      const i = yi * w + xi;
      return Math.abs(gx[i] * nx + gy[i] * ny);
    };
  }

  function lumSampler({ w, h, L }) {
    return (x, y) => {
      const xi = Math.round(x - 0.5), yi = Math.round(y - 0.5);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) return -1;
      return L[yi * w + xi];
    };
  }

  // 書類の形の指定（長辺 / 短辺）にどれだけ合うか
  function aspectFactor(q, w, h, aspect) {
    if (!aspect) return 1;
    const est = Geo.estimateAspect(q, w, h);
    if (!est) return 1;
    const ls = est >= 1 ? est : 1 / est;
    // 指定と違う形でも、ふちがはっきりしていれば見つけられるよう、下げすぎない
    const off = Math.log(ls / aspect);
    return Math.max(0.5, Math.exp(-((off / 0.15) ** 2) / 2));
  }

  // 撮影中は、直前に見つけた位置の近くを少しだけ選びやすくする（枠のぶれを抑える）
  function priorFactor(q, prior, long) {
    if (!prior) return 1;
    let d = 0;
    for (let i = 0; i < 4; i++) d = Math.max(d, Math.hypot(q[i][0] - prior[i][0], q[i][1] - prior[i][1]));
    return 1 + 0.2 * Math.exp(-((d / long / 0.04) ** 2));
  }

  function makeScorer(ctx, aspect, prior) {
    const { w, h, gscale } = ctx;
    const strong = 0.4 * gscale;
    const grad = gradSampler(ctx);
    const lumAt = lumSampler(ctx);
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
      s *= aspectFactor(q, w, h, aspect);
      s *= priorFactor(q, prior, ctx.long);
      return s;
    };
  }

  // ---------- 直線ごとの累積和で、組み合わせを手早く採点する ----------

  // 直線のうち画像の中を通る区間を 1 画素ずつたどり、
  // 「境目の強さ」と「法線の両側（±4 画素）の明るさ」の累積和を作る
  function profileLine(l, ctx, strong, grad, lumAt) {
    const { w, h } = ctx;
    const px = l.c * l.rho, py = l.s * l.rho, dx = -l.s, dy = l.c;
    let t0 = -Infinity, t1 = Infinity;
    const clip = (p, d, hi) => {
      if (Math.abs(d) < 1e-9) { if (p < 0 || p > hi) t0 = Infinity; return; }
      const a = -p / d, b = (hi - p) / d;
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    };
    clip(px, dx, w);
    clip(py, dy, h);
    if (!(t1 - t0 > 3)) return null;
    const n = Math.floor(t1 - t0);
    const sup = new Float32Array(n + 1), plus = new Float32Array(n + 1), minus = new Float32Array(n + 1);
    for (let k = 0; k < n; k++) {
      const t = t0 + k + 0.5;
      const x = px + t * dx, y = py + t * dy;
      let best = -1;
      for (let d = -2; d <= 2; d++) {
        const g = grad(x + d * l.c, y + d * l.s, l.c, l.s);
        if (g > best) best = g;
      }
      sup[k + 1] = sup[k] + (best < 0 ? 0.4 : Math.min(1, best / strong));
      const a = lumAt(x + 4 * l.c, y + 4 * l.s), b = lumAt(x - 4 * l.c, y - 4 * l.s);
      plus[k + 1] = plus[k] + (a >= 0 ? a : b >= 0 ? b : 0);
      minus[k + 1] = minus[k] + (b >= 0 ? b : a >= 0 ? a : 0);
    }
    return { px, py, dx, dy, t0, n, sup, plus, minus };
  }

  // 直線の上の A から B まで（両端の 7% を除く）の境目の強さと、両側の明るさの平均
  function segment(prof, A, B, out) {
    let ta = (A[0] - prof.px) * prof.dx + (A[1] - prof.py) * prof.dy - prof.t0;
    let tb = (B[0] - prof.px) * prof.dx + (B[1] - prof.py) * prof.dy - prof.t0;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    const len = tb - ta;
    if (len < 6) return false;
    const u0 = ta + 0.07 * len, u1 = tb - 0.07 * len;
    const i0 = Math.floor(Math.min(prof.n, Math.max(0, u0)));
    const i1 = Math.floor(Math.min(prof.n, Math.max(0, u1)));
    const inside = i1 - i0;
    const span = u1 - u0;
    out.sup = ((inside > 0 ? prof.sup[i1] - prof.sup[i0] : 0) + 0.4 * Math.max(0, span - inside)) / span;
    out.valid = inside >= 2;
    out.plus = out.valid ? (prof.plus[i1] - prof.plus[i0]) / inside : 0;
    out.minus = out.valid ? (prof.minus[i1] - prof.minus[i0]) / inside : 0;
    return true;
  }

  // 4 本の直線（a1, a2 が向かい合い、b1, b2 が向かい合う）の四角形を、累積和だけで採点する。
  // 内側の均一さは見ないので、上位の候補だけを makeScorer で採点し直す
  function makeFastScorer(ctx, aspect, prior) {
    const { w, h } = ctx;
    const seg = { sup: 0, valid: false, plus: 0, minus: 0 };
    const sides = [null, null, null, null];
    const pts = [null, null, null, null];
    return function fastScore(a1, a2, b1, b2) {
      const p0 = intersect(a1, b1), p1 = intersect(a1, b2), p2 = intersect(a2, b2), p3 = intersect(a2, b1);
      if (!p0 || !p1 || !p2 || !p3) return null;
      pts[0] = p0; pts[1] = p1; pts[2] = p2; pts[3] = p3;
      for (let i = 0; i < 4; i++) {
        const [x, y] = pts[i];
        if (x < -0.08 * w || y < -0.08 * h || x > 1.08 * w || y > 1.08 * h) return null;
      }
      if (!Geo.isConvex(pts)) return null;
      const area = Geo.area(pts) / (w * h);
      if (area < 0.05) return null;
      let dev = 0;
      for (let i = 0; i < 4; i++) {
        const a = pts[(i + 3) % 4], p = pts[i], c = pts[(i + 1) % 4];
        const v1x = a[0] - p[0], v1y = a[1] - p[1], v2x = c[0] - p[0], v2y = c[1] - p[1];
        const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1);
        dev = Math.max(dev, Math.abs((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI - 90));
      }
      if (dev > 55) return null;
      const cx = (p0[0] + p1[0] + p2[0] + p3[0]) / 4, cy = (p0[1] + p1[1] + p2[1] + p3[1]) / 4;
      sides[0] = a1; sides[1] = b2; sides[2] = a2; sides[3] = b1;
      let sum = 0, min = Infinity, con = 0, conN = 0;
      for (let i = 0; i < 4; i++) {
        const l = sides[i], A = pts[i], B = pts[(i + 1) % 4];
        let sup;
        if (l.border) {
          sup = 0.4;
        } else {
          if (!segment(l.prof, A, B, seg)) return null;
          sup = seg.sup;
          if (seg.valid) {
            const inward = (cx - (A[0] + B[0]) / 2) * l.c + (cy - (A[1] + B[1]) / 2) * l.s > 0;
            con += ((inward ? seg.plus - seg.minus : seg.minus - seg.plus) / 255);
            conN++;
          }
        }
        sum += sup;
        if (sup < min) min = sup;
      }
      con = conN ? con / conN : 0;
      let s = 0.55 * (sum / 4) + 0.45 * min;
      s *= con >= 0 ? 0.65 + 0.35 * Math.min(1, con / 0.12) : 0.65 - 0.25 * Math.min(1, -con / 0.12);
      s *= Math.min(1, Math.sqrt(area / 0.12)) * (0.9 + 0.1 * Math.min(1, area / 0.6));
      s *= 1 - 0.35 * (dev / 55) ** 2;
      if (aspect || prior) {
        const oq = Geo.orderQuad(pts);
        s *= aspectFactor(oq, w, h, aspect) * priorFactor(oq, prior, ctx.long);
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

  // 各辺の近く（法線方向に ±r 画素）で勾配がいちばん強い位置を集め、直線を当てはめ直す。
  // grad: 勾配の大きさを返す関数 / absMin: 境目とみなす勾配の下限 / maxShift: 角が動いてよい距離
  function refineWith(q, grad, r, absMin, maxShift) {
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const P = q[i], Q = q[(i + 1) % 4];
      const dx = Q[0] - P[0], dy = Q[1] - P[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const n = Math.max(16, Math.min(200, Math.round(len / 2)));
      const found = [];
      const vals = new Float32Array(2 * r + 1);
      for (let k = 0; k < n; k++) {
        const t = 0.08 + (0.84 * (k + 0.5)) / n;
        const x0 = P[0] + dx * t, y0 = P[1] + dy * t;
        let best = 0, bd = 0;
        for (let d = -r; d <= r; d++) {
          const v = grad(x0 + d * nx, y0 + d * ny, nx, ny);
          vals[d + r] = v;
          if (v > best) { best = v; bd = d; }
        }
        if (best <= 0) continue;
        const j = bd + r;
        let off = 0;
        if (j > 0 && j < vals.length - 1 && vals[j - 1] >= 0 && vals[j + 1] >= 0) {
          const den = vals[j - 1] - 2 * vals[j] + vals[j + 1];
          if (den < 0) off = Math.max(-0.5, Math.min(0.5, (0.5 * (vals[j - 1] - vals[j + 1])) / den));
        }
        found.push([x0 + (bd + off) * nx, y0 + (bd + off) * ny, best]);
      }
      // その辺の強い点（上位 2 割の強さの 35% 以上）だけで当てはめる
      const strengths = found.map((p) => p[2]).sort((a, b) => a - b);
      const top = strengths.length ? strengths[Math.floor(strengths.length * 0.8)] : 0;
      const thr = Math.max(absMin, 0.35 * top);
      const pts = found.filter((p) => p[2] >= thr);
      let line = null;
      if (pts.length >= Math.max(6, n * 0.35)) {
        const fit = fitLine(pts);
        // 元の辺から 4° 以上傾くなら、ほかの線に引っぱられたとみなして使わない
        if (Math.abs(fit.c * nx + fit.s * ny) > 0.9975) line = fit;
      }
      lines.push(line || { c: nx, s: ny, rho: nx * P[0] + ny * P[1] });
    }
    return q.map((p, i) => {
      const c = intersect(lines[(i + 3) % 4], lines[i]);
      return c && Geo.dist(c, p) < maxShift ? c : p;
    });
  }

  function refine(q, ctx, r) {
    return refineWith(q, gradSampler(ctx), r, 0.25 * ctx.gscale, 0.04 * ctx.long);
  }

  // 高い解像度（long）の画像で、辺の位置をもう一度細かく合わせる（写真から探すとき）。
  // 文字の線に引っぱられないよう、辺とほぼ同じ向きの境目だけを使う
  function refineFine(source, quadN, long) {
    const px = pixelsOf(source, long);
    if (!px) return null;
    const { data, w, h } = px;
    // 必要な画素の明るさだけをその場で求める（画像全体は計算しない）
    const B = (i) => { const j = i << 2; return 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]; };
    const grad = (x, y, nx, ny) => {
      const xi = Math.round(x - 0.5), yi = Math.round(y - 0.5);
      if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) return -1;
      const i = yi * w + xi;
      const a = B(i - w - 1), b = B(i - w), c = B(i - w + 1), d = B(i - 1), f = B(i + 1), g = B(i + w - 1), k = B(i + w), m = B(i + w + 1);
      const sx = c + 2 * f + m - (a + 2 * d + g);
      const sy = g + 2 * k + m - (a + 2 * b + c);
      const proj = Math.abs(sx * nx + sy * ny);
      const mag = Math.sqrt(sx * sx + sy * sy);
      return mag > 0 && proj / mag > 0.85 ? proj : 0;
    };
    const L = Math.max(w, h);
    let q = quadN.map(([x, y]) => [x * w, y * h]);
    q = Geo.orderQuad(refineWith(q, grad, Math.max(4, Math.round(L / 160)), 24, 0.015 * L));
    q = Geo.orderQuad(refineWith(q, grad, Math.max(2, Math.round(L / 480)), 24, 0.015 * L));
    if (!Geo.isConvex(q)) return null;
    return q.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
  }

  // ---------- まとめ ----------

  /**
   * source: 描画できるもの（video / img / canvas / ImageBitmap）
   * opts.long: 検出に使う解像度（長辺の画素数）
   * opts.aspect: 書類の縦横比（長辺 / 短辺）。わかっていれば、その形の四角形を選びやすくする
   * opts.prior: 直前に見つけた四隅（正規化座標）。撮影中に枠をぶれにくくする
   * opts.refineLong: 0 より大きければ、最後にこの解像度で辺の位置を細かく合わせる
   * opts.quick: 撮影中のように何度も呼ぶとき、合わせ直しを減らして軽くする
   * 戻り値: { quad: 正規化座標（0〜1）の四隅 [左上, 右上, 右下, 左下], score } か null
   */
  function find(source, { long = 480, aspect = null, refine: doRefine = true, refineLong = 0, prior = null, quick = false, debug = false, timing = null } = {}) {
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const mark = (name) => { if (timing) { const t = now(); timing[name] = (timing[name] || 0) + t - (timing._t || t); timing._t = t; } };
    mark('start');
    const px = pixelsOf(source, long);
    if (!px) return null;
    mark('pixels');
    const ctx = makeContext(px);
    mark('prepare');
    const { w, h, gx, gy, mag, gscale } = ctx;
    const priorPx = prior ? Geo.orderQuad(prior.map(([x, y]) => [x * w, y * h])) : null;
    const score = makeScorer(ctx, aspect, priorPx);
    const candidates = [];
    const add = (q, from) => {
      if (!q || q.some((p) => !p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return;
      if (q.some(([x, y]) => x < -0.08 * w || y < -0.08 * h || x > 1.08 * w || y > 1.08 * h)) return;
      const oq = Geo.orderQuad(q.map(([x, y]) => [Math.min(w, Math.max(0, x)), Math.min(h, Math.max(0, y))]));
      const s = score(oq);
      if (s > 0) candidates.push({ q: oq, s, from });
    };

    // a) 直線の組み合わせ。まず累積和で全部を手早く採点し、上位だけを詳しく採点する
    const strong = 0.4 * gscale;
    const grad = gradSampler(ctx);
    const lumAt = lumSampler(ctx);
    const edges = thinEdges(gx, gy, mag, w, h, 0.15 * gscale);
    const lines = houghLines(edges, gx, gy, w, h, quick ? 22 : 36, Math.max(12, Math.round(0.1 * ctx.long)))
      .map((l) => ({ ...l, prof: profileLine(l, ctx, strong, grad, lumAt) }))
      .filter((l) => l.prof);
    mark('lines');
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
    const fast = makeFastScorer(ctx, aspect, priorPx);
    const KEEP = 24;
    const shortlist = []; // { s, a1, a2, b1, b2 }（点の高い順に KEEP 件）
    let tried = 0;
    for (let i = 0; i < pairs.length && tried < 40000; i++) {
      for (let j = i + 1; j < pairs.length && tried < 40000; j++) {
        const [a1, a2] = pairs[i];
        const [b1, b2] = pairs[j];
        if (a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2) continue;
        if (angleGap(a1.t, b1.t) < 40) continue;
        tried++;
        const s = fast(a1, a2, b1, b2);
        if (s === null || s <= 0) continue;
        if (shortlist.length === KEEP && s <= shortlist[KEEP - 1].s) continue;
        shortlist.push({ s, a1, a2, b1, b2 });
        shortlist.sort((p, q) => q.s - p.s);
        if (shortlist.length > KEEP) shortlist.pop();
      }
    }
    mark('combos');
    for (const c of shortlist) {
      add([intersect(c.a1, c.b1), intersect(c.a1, c.b2), intersect(c.a2, c.b2), intersect(c.a2, c.b1)], 'lines');
    }

    // b) 明るい紙の領域
    for (const q of regionQuads(ctx.P, w, h)) add(q, 'region');
    if (!quick) for (const q of regionQuads(ctx.L, w, h)) add(q, 'region');

    mark('region');
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.s - a.s);

    // 上位の候補は、辺を境目に合わせ直してから比べ直す
    // （撮影中の quick では、上位 3 件を 1 回だけ合わせて軽くする）
    const top = candidates.slice(0, doRefine ? (quick ? 3 : 8) : 1).map((c) => {
      if (!doRefine) return c;
      // 広めに探して大きなずれを直し、狭く探して細かく合わせる
      const wide = Math.max(4, Math.round(ctx.long / 60));
      const narrow = Math.max(3, Math.round(ctx.long / 120));
      const rq = quick
        ? Geo.orderQuad(refine(c.q, ctx, wide))
        : Geo.orderQuad(refine(Geo.orderQuad(refine(c.q, ctx, wide)), ctx, narrow));
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

    const norm = (q) => q.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
    mark('refine');
    let quad = norm(best.q);
    if (refineLong > long) quad = refineFine(source, quad, refineLong) || quad;
    mark('fine');
    const result = { quad, score: best.s };
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
}

const Detect = DetectModule(Geo, Imaging);
