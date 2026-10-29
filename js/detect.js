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
    // すでに縮めて取り出した画素（撮影中の映像のコマ）はそのまま使う
    if (source.data && source.w && source.h) return source;
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
    // 縦方向は行ごとにまとめて処理する（列ごとに飛び飛びに読むより、ずっと速い）。
    // 上下に r 行ずつ -∞ を足した (h + 2r) 行を k 行ずつの区切りに分け、区切りの中で前向き・後ろ向きの最大を取る
    const mRows = h + 2 * r;
    if (!vhgw || vhgw.G.length < mRows * w) vhgw = { G: new Float32Array(mRows * w), Hb: new Float32Array(mRows * w) };
    const { G, Hb } = vhgw;
    for (let s = 0; s < mRows; s += k) {
      const e = s + k < mRows ? s + k : mRows;
      for (let p = s; p < e; p++) {
        const o = p * w, sr = p - r;
        if (sr < 0 || sr >= h) {
          if (p === s) G.fill(-Infinity, o, o + w); else G.copyWithin(o, o - w, o);
        } else if (p === s) {
          for (let x = 0; x < w; x++) G[o + x] = tmp[sr * w + x];
        } else {
          for (let x = 0, q = sr * w, b = o - w; x < w; x++) { const v = tmp[q + x], a = G[b + x]; G[o + x] = v > a ? v : a; }
        }
      }
      for (let p = e - 1; p >= s; p--) {
        const o = p * w, sr = p - r;
        if (sr < 0 || sr >= h) {
          if (p === e - 1) Hb.fill(-Infinity, o, o + w); else Hb.copyWithin(o, o + w, o + 2 * w);
        } else if (p === e - 1) {
          for (let x = 0; x < w; x++) Hb[o + x] = tmp[sr * w + x];
        } else {
          for (let x = 0, q = sr * w, b = o + w; x < w; x++) { const v = tmp[q + x], a = Hb[b + x]; Hb[o + x] = v > a ? v : a; }
        }
      }
    }
    for (let y = 0; y < h; y++) {
      const a = y * w, b = (y + k - 1) * w;
      for (let x = 0; x < w; x++) { const u = Hb[a + x], v = G[b + x]; out[a + x] = sign * (u > v ? u : v); }
    }
    return out;
  }
  let vhgw = null; // 縦方向の作業用（使い回す）

  // 明るい紙の上の暗く細いもの（文字・罫線）を消す
  const closing = (src, w, h, r) => rankFilter(rankFilter(src, w, h, r, true), w, h, r, false);

  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    const win = 2 * r + 1;
    const inv = 1 / win;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
      // 端の近くだけ範囲の外を端の値で補い、中ほどは補わずに足し引きする
      const x0 = Math.min(w, r), x1 = Math.max(x0, w - r - 1);
      for (let x = 0; x < x0; x++) {
        tmp[row + x] = acc * inv;
        acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
      for (let x = x0; x < x1; x++) {
        tmp[row + x] = acc * inv;
        acc += src[row + x + r + 1] - src[row + x - r];
      }
      for (let x = x1; x < w; x++) {
        tmp[row + x] = acc * inv;
        acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    // 縦方向は、列ごとの合計を行単位でまとめて更新する
    const acc = new Float32Array(w);
    for (let y = -r; y <= r; y++) {
      const o = Math.min(h - 1, Math.max(0, y)) * w;
      for (let x = 0; x < w; x++) acc[x] += tmp[o + x];
    }
    for (let y = 0; y < h; y++) {
      const o = y * w, add = Math.min(h - 1, y + r + 1) * w, sub = Math.max(0, y - r) * w;
      for (let x = 0; x < w; x++) {
        out[o + x] = acc[x] * inv;
        acc[x] += tmp[add + x] - tmp[sub + x];
      }
    }
    return out;
  }
  // 半径 1 のぼかしを 2 回かけたのと同じ（重み 1,2,3,2,1）。2 回に分けるより速い（画像の外は端の値と同じとみなす）
  function blur2(src, w, h) {
    if (w < 5 || h < 5) return boxBlur(boxBlur(src, w, h, 1), w, h, 1);
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    const k = 1 / 9;
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        const a = src[o + (x > 1 ? x - 2 : 0)], b = src[o + (x > 0 ? x - 1 : 0)], c = src[o + x];
        const d = src[o + (x < w - 1 ? x + 1 : w - 1)], e = src[o + (x < w - 2 ? x + 2 : w - 1)];
        tmp[o + x] = (a + 2 * b + 3 * c + 2 * d + e) * k;
      }
      // 両端は 2 回ぼかしたときと同じ重みにそろえる
      tmp[o] = (5 * src[o] + 3 * src[o + 1] + src[o + 2]) * k;
      tmp[o + w - 1] = (5 * src[o + w - 1] + 3 * src[o + w - 2] + src[o + w - 3]) * k;
    }
    for (let y = 0; y < h; y++) {
      const a = (y > 1 ? y - 2 : 0) * w, b = (y > 0 ? y - 1 : 0) * w, c = y * w;
      const d = (y < h - 1 ? y + 1 : h - 1) * w, e = (y < h - 2 ? y + 2 : h - 1) * w;
      if (y === 0) for (let x = 0; x < w; x++) out[x] = (5 * tmp[x] + 3 * tmp[w + x] + tmp[2 * w + x]) * k;
      else if (y === h - 1) for (let x = 0; x < w; x++) out[c + x] = (5 * tmp[c + x] + 3 * tmp[c - w + x] + tmp[c - 2 * w + x]) * k;
      else for (let x = 0; x < w; x++) out[c + x] = (tmp[a + x] + 2 * tmp[b + x] + 3 * tmp[c + x] + 2 * tmp[d + x] + tmp[e + x]) * k;
    }
    return out;
  }

  // 縦横半分に縮める（2×2 の平均）。領域の切り出しは大まかな位置がわかればよいので、半分の大きさで行う
  function halve(src, w, h) {
    const w2 = w >> 1, h2 = h >> 1;
    const out = new Float32Array(w2 * h2);
    for (let y = 0; y < h2; y++) {
      const a = 2 * y * w, b = a + w, o = y * w2;
      for (let x = 0; x < w2; x++) out[o + x] = (src[a + 2 * x] + src[a + 2 * x + 1] + src[b + 2 * x] + src[b + 2 * x + 1]) * 0.25;
    }
    return { map: out, w: w2, h: h2 };
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
  function houghLines(edges, gx, gy, w, h, maxLines, minVotes, perDir = Math.ceil(maxLines / 4)) {
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
    // 同じ向きの線ばかり（布の格子柄、タイルの目地、罫線）で埋まらないよう、向きごとの本数に上限を設ける
    for (const p of peaks) {
      // 0° と 180° をまたぐ同じ直線を除く
      const dup = lines.some((l) => {
        const d = Math.abs(l.t - p.t);
        return (d <= 3 && Math.abs(l.rho - p.rho) <= 8) || (d >= TH - 3 && Math.abs(l.rho + p.rho) <= 8);
      });
      if (dup) continue;
      let same = 0;
      for (const l of lines) if (angleGap(l.t, p.t) <= 3) same++;
      if (same >= perDir) continue;
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

  // map が明るい（below なら thr より小さい）塊を四角形にする。thr を省くと大津の方法で決める
  function regionQuads(map, w, h, thr = null, below = false, unions = false) {
    const t = thr === null ? otsuOf(map) : thr;
    let mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = (below ? map[i] < t : map[i] > t) ? 1 : 0;
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
    const hullQuad = (list) => {
      const pts = [];
      for (const i of list) {
        for (let y = 0; y < h; y++) {
          if (minX[i][y] >= 0) pts.push([minX[i][y] + 0.5, y + 0.5], [maxX[i][y] + 0.5, y + 0.5]);
        }
      }
      const hull = Geo.convexHull(pts);
      if (hull.length < 4) return;
      const q = Geo.hullToQuad(hull);
      if (q) quads.push(Geo.orderQuad(q));
    };
    for (let i = 0; i < picked.length; i++) hullQuad([i]);
    // 書類の中の写真などで塊が切れたときのために、大きい塊どうしをまとめた四角形も出す
    if (unions && picked.length >= 2) { hullQuad([0, 1]); if (picked.length >= 3) hullQuad([0, 1, 2]); }
    return quads;
  }

  // ---------- 点数づけ ----------

  function makeContext({ data: px, w, h }, chroma = 0, chromaLite = false) {
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
    const L = blur2(closing(lum, w, h, r), w, h);
    // 紙らしさ = 明るさ − 彩度。文字を消した明るさから、ぼかした彩度を引く（木の机や色の付いた背景と紙を分けやすい）
    const satB = boxBlur(sat, w, h, 1);
    const P = new Float32Array(n);
    for (let i = 0; i < n; i++) P[i] = L[i] - 0.6 * satB[i];
    const { gx, gy, mag } = sobel(L, w, h);
    // 模様の多さ（境目の強さを広くぼかしたもの）。文字を消した紙の中は滑らかなので、布の柄や木目の上でも紙を見分けやすい。
    // 明るさの境目だけで、半分の大きさで求める（色の境目は、撮影中は文字も拾うので入れない）
    const m2 = halve(mag, w, h);
    const tr = Math.max(1, Math.round(Math.max(w, h) / 160));
    const T = { map: boxBlur(boxBlur(m2.map, m2.w, m2.h, tr), m2.w, m2.h, tr), w: m2.w, h: m2.h };
    const tThr = 0.1 * Math.max(40, percentile(mag, 0.99));
    if (chroma) {
      // 色の境目も境目に加える（明るさは同じでも色が違う紙の重なりや、淡い色の机）。文字は彩度が低いので閉じ処理で消える。
      // chromaLite のときは閉じ処理を省いて軽くする（撮影中）
      const C = chromaLite ? satB : blur2(closing(sat, w, h, r), w, h);
      const cg = sobel(C, w, h);
      for (let i = 0; i < n; i++) {
        const m = chroma * cg.mag[i];
        if (m > mag[i]) { mag[i] = m; gx[i] = chroma * cg.gx[i]; gy[i] = chroma * cg.gy[i]; }
      }
    }
    const gscale = Math.max(40, percentile(mag, 0.99));
    return { w, h, L, P, T, tThr, satB, gx, gy, mag, gscale, long: Math.max(w, h) };
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

  // 法線 (nx, ny) とほぼ同じ向き（±14° 以内）の境目だけの強さ。辺の延長に同じ線が続いているかを見るのに使う
  function alignedSampler({ w, h, gx, gy }) {
    return (x, y, nx, ny) => {
      const xi = Math.round(x - 0.5), yi = Math.round(y - 0.5);
      if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) return -1;
      const i = yi * w + xi;
      const p = Math.abs(gx[i] * nx + gy[i] * ny);
      return p * p >= 0.94 * (gx[i] * gx[i] + gy[i] * gy[i]) ? p : 0;
    };
  }

  // 角らしさ。本物の書類の角は、2 本の辺の境目が角のすぐ近くまで続き、角の先では途切れる。
  // 布の格子柄や机の線で作った四角形は、線が角の先まで続いたり、角の近くに境目がなかったりする。
  // sd[i] は角 i から角 i+1 への辺: endA / endB は両端の近く、extA / extB は両端の先の強さ（-1 は画像の外）
  function cornerFactor(sd, mix = 0) {
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const a = sd[(i + 3) % 4], b = sd[i]; // a は角 i で終わる辺、b は角 i から始まる辺
      let e = 0, en = 0, x = 0, xn = 0, eMin = 1, xMax = 0;
      if (!a.border) { if (a.endB >= 0) { e += a.endB; en++; eMin = Math.min(eMin, a.endB); } x += Math.max(0, a.extB); xMax = Math.max(xMax, a.extB); xn++; }
      if (!b.border) { if (b.endA >= 0) { e += b.endA; en++; eMin = Math.min(eMin, b.endA); } x += Math.max(0, b.extA); xMax = Math.max(xMax, b.extA); xn++; }
      e = en ? e / en : 0.8;
      x = xn ? x / xn : 0;
      // mix > 0 のとき、弱いほうの辺に寄せる（片方の辺だけが角で途切れる T 字を、角とみなさない）
      if (en) e = (1 - mix) * e + mix * eMin;
      if (xn) x = (1 - mix) * x + mix * xMax;
      sum += Math.min(1, Math.max(0, (e - 0.1) / 0.5)) * (1 - 0.85 * Math.min(1, Math.max(0, (x - 0.25) / 0.5)));
    }
    return 0.55 + 0.45 * (sum / 4);
  }

  // 辺から法線 (nx, ny) の向きに 3〜14 画素（長辺 480 のとき）離れた帯の明るさの平均。画像の外なら -1。
  // 細い線（布の格子柄や罫線）の両側は帯で平均すると同じ明るさになり、紙と背景の境目だけが差として残る
  function bandSampler(ctx) {
    const lumAt = lumSampler(ctx);
    const offs = [0.006, 0.0125, 0.021, 0.029].map((k) => Math.max(1.5, k * ctx.long));
    return (x, y, nx, ny) => {
      let s = 0, m = 0;
      for (const d of offs) {
        const v = lumAt(x + d * nx, y + d * ny);
        if (v >= 0) { s += v; m++; }
      }
      return m ? s / m : -1;
    };
  }

  // 画面の中ほどにある四角形を少し選びやすくする（撮りたい書類は真ん中に置くことが多く、周りの書類はふちにかかる）
  function centerFactor(cx, cy, w, h, k) {
    if (!k) return 1;
    const dx = cx / w - 0.5, dy = cy / h - 0.5;
    return 1 - k * Math.min(1, (dx * dx + dy * dy) / 0.5);
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
  // gain: 撮影中は 0.2。撮った写真では、撮影画面の枠が違っていたときに引っぱられないよう弱める
  function priorFactor(q, prior, long, gain = 0.2) {
    if (!prior) return 1;
    let d = 0;
    for (let i = 0; i < 4; i++) d = Math.max(d, Math.hypot(q[i][0] - prior[i][0], q[i][1] - prior[i][1]));
    return 1 + gain * Math.exp(-((d / long / 0.04) ** 2));
  }

  function makeScorer(ctx, aspect, prior, cornerMix = 0, borderSup = 0.4, center = 0, priorGain = 0.2) {
    const { w, h, gscale } = ctx;
    const strong = 0.4 * gscale;
    const grad = gradSampler(ctx);
    const aligned = alignedSampler(ctx);
    const lumAt = lumSampler(ctx);
    const band = bandSampler(ctx);
    const onBorder = (P, Q) => {
      const e = 2.5;
      return (P[0] < e && Q[0] < e) || (P[1] < e && Q[1] < e) || (P[0] > w - e && Q[0] > w - e) || (P[1] > h - e && Q[1] > h - e);
    };

    function side(P, Q, cx, cy) {
      const dx = Q[0] - P[0], dy = Q[1] - P[1];
      const len = Math.hypot(dx, dy);
      if (len < 6) return { sup: 0, con: 0, endA: 0, endB: 0, extA: 0, extB: 0 };
      if (onBorder(P, Q)) return { sup: borderSup, con: 0.04, border: true };
      let nx = -dy / len, ny = dx / len;
      if ((cx - (P[0] + Q[0]) / 2) * nx + (cy - (P[1] + Q[1]) / 2) * ny < 0) { nx = -nx; ny = -ny; }
      // 辺の上の t0〜t1（0 が P、1 が Q）の境目の強さの平均。画像の外なら -1
      const zone = (t0, t1, sampler) => {
        const k = Math.max(3, Math.round((Math.abs(t1 - t0) * len) / 2));
        let s = 0, m = 0;
        for (let j = 0; j < k; j++) {
          const t = t0 + ((t1 - t0) * (j + 0.5)) / k;
          const x = P[0] + dx * t, y = P[1] + dy * t;
          let best = -1;
          for (let d = -2; d <= 2; d++) {
            const g = sampler(x + d * nx, y + d * ny, nx, ny);
            if (g > best) best = g;
          }
          if (best >= 0) { s += Math.min(1, best / strong); m++; }
        }
        return m >= 2 ? s / m : -1;
      };
      const near = 2 / len;
      const ends = {
        endA: zone(near, 0.07, grad), endB: zone(0.93, 1 - near, grad),
        extA: zone(-0.15, -0.03, aligned), extB: zone(1.03, 1.15, aligned),
      };
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
        const li = band(x, y, nx, ny), lo = band(x, y, -nx, -ny);
        if (li >= 0 && lo >= 0) { cin += li; cout += lo; cc++; }
      }
      return { sup: sup / n, con: cc ? (cin - cout) / cc / 255 : 0, ...ends };
    }

    // 内側が紙らしいか。uni: ほぼ同じ明るさで埋まっている割合 / tex: 模様（布の柄や木目）が多い所の割合
    const texThr = ctx.tThr;
    function interior(q) {
      const H = Geo.homography([[0, 0], [1, 0], [1, 1], [0, 1]], q);
      if (!H) return { uni: 0, tex: 1 };
      const vals = [];
      let tex = 0, tn = 0;
      for (let i = 1; i <= 8; i++) {
        for (let j = 1; j <= 8; j++) {
          const [x, y] = Geo.project(H, (i - 0.5) / 8 * 0.86 + 0.07, (j - 0.5) / 8 * 0.86 + 0.07);
          const v = lumAt(x, y);
          if (v < 0) continue;
          vals.push(v);
          tn++;
          const T = ctx.T;
          if (T.map[Math.min(T.h - 1, Math.max(0, (y / 2) | 0)) * T.w + Math.min(T.w - 1, Math.max(0, (x / 2) | 0))] > texThr) tex++;
        }
      }
      if (vals.length < 10) return { uni: 0, tex: 1, margin: 1 };
      const sorted = vals.slice().sort((a, b) => a - b);
      const med = sorted[(sorted.length / 2) | 0];
      // 余白: 各辺のすぐ内側（3.5% と 6%）に境目がある割合。書類はふちの内側が無地の余白なので、
      // 布の格子柄や机の模様で作った四角形（内側のふちにも柄がある）と見分けられる
      const { mag } = ctx;
      const edgeThr = 0.3 * gscale;
      let mHit = 0, mN = 0;
      for (const inset of [0.035, 0.06]) {
        for (let k = 0; k < 12; k++) {
          const t = 0.1 + (0.8 * (k + 0.5)) / 12;
          for (const [u, v] of [[t, inset], [1 - inset, t], [t, 1 - inset], [inset, t]]) {
            const [x, y] = Geo.project(H, u, v);
            const xi = Math.round(x - 0.5), yi = Math.round(y - 0.5);
            if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) continue;
            const i = yi * w + xi;
            mN++;
            if (Math.max(mag[i], mag[i - 1], mag[i + 1], mag[i - w], mag[i + w]) > edgeThr) mHit++;
          }
        }
      }
      return { uni: vals.filter((v) => Math.abs(v - med) < 28).length / vals.length, tex: tex / tn, margin: mN ? mHit / mN : 0 };
    }

    // explain に入れ物を渡すと、点数の内訳を書き込む（調べるとき用）
    return function score(q, explain = null) {
      const area = Geo.area(q) / (w * h);
      if (area < 0.05 || !Geo.isConvex(q)) return 0;
      const dev = Math.max(...Geo.angles(q).map((a) => Math.abs(a - 90)));
      if (dev > 55) return 0;
      const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
      const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
      const sides = [0, 1, 2, 3].map((i) => side(q[i], q[(i + 1) % 4], cx, cy));
      // 3 辺以上が画面のふちなら、書類のふちは 1 本しか見えていないので、書類とはみなさない
      if (sides.filter((x) => x.border).length >= 3) return 0;
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
      const inside = interior(q);
      s *= 0.55 + 0.45 * Math.min(1, Math.max(0, (inside.uni - 0.35) / 0.35));
      s *= 1 - 0.45 * Math.min(1, Math.max(0, (inside.margin - 0.08) / 0.25));
      const corner = cornerFactor(sides, cornerMix);
      s *= corner;
      s *= aspectFactor(q, w, h, aspect);
      s *= priorFactor(q, prior, ctx.long, priorGain);
      s *= centerFactor(cx, cy, w, h, center);
      if (explain) {
        const r2 = (v) => Math.round(v * 100) / 100;
        Object.assign(explain, {
          sup: sups.map(r2), con: r2(con), area: r2(area), dev: Math.round(dev), uni: r2(inside.uni), tex: r2(inside.tex), margin: r2(inside.margin), corner: r2(corner),
          ends: sides.map((x) => (x.border ? 'border' : [x.endA, x.endB, x.extA, x.extB].map(r2).join('/'))), s: r2(s),
        });
      }
      return s;
    };
  }

  // ---------- 直線ごとの累積和で、組み合わせを手早く採点する ----------

  // 直線のうち画像の中を通る区間を 1 画素ずつたどり、
  // 「境目の強さ」と「法線の両側（±4 画素）の明るさ」の累積和を作る
  function profileLine(l, ctx, strong, grad, band, aligned) {
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
    const ali = new Float32Array(n + 1); // 同じ向きの境目だけの強さ（辺の先に線が続くかを見る）
    for (let k = 0; k < n; k++) {
      const t = t0 + k + 0.5;
      const x = px + t * dx, y = py + t * dy;
      let best = -1, bestA = 0;
      for (let d = -2; d <= 2; d++) {
        const g = grad(x + d * l.c, y + d * l.s, l.c, l.s);
        if (g > best) best = g;
        const a = aligned(x + d * l.c, y + d * l.s, l.c, l.s);
        if (a > bestA) bestA = a;
      }
      sup[k + 1] = sup[k] + (best < 0 ? 0.4 : Math.min(1, best / strong));
      ali[k + 1] = ali[k] + Math.min(1, bestA / strong);
      const a = band(x, y, l.c, l.s), b = band(x, y, -l.c, -l.s);
      plus[k + 1] = plus[k] + (a >= 0 ? a : b >= 0 ? b : 0);
      minus[k + 1] = minus[k] + (b >= 0 ? b : a >= 0 ? a : 0);
    }
    return { px, py, dx, dy, t0, n, sup, ali, plus, minus };
  }

  // 累積和 arr の、位置 a〜b（向きは問わない）の 1 画素あたりの平均。画像の外にはみ出す分は除き、2 画素未満なら -1
  function rangeAvg(arr, n, a, b) {
    const i0 = Math.max(0, Math.floor(Math.min(a, b))), i1 = Math.min(n, Math.floor(Math.max(a, b)));
    return i1 - i0 >= 2 ? (arr[i1] - arr[i0]) / (i1 - i0) : -1;
  }

  // 直線の上の A から B まで（両端の 7% を除く）の境目の強さと、両側の明るさの平均
  // あわせて、A と B それぞれの近く（端から 7% まで）と、その先（3〜15%）の強さも out に入れる
  function segment(prof, A, B, out) {
    let ta = (A[0] - prof.px) * prof.dx + (A[1] - prof.py) * prof.dy - prof.t0;
    let tb = (B[0] - prof.px) * prof.dx + (B[1] - prof.py) * prof.dy - prof.t0;
    const dir = tb >= ta ? 1 : -1;
    const span0 = Math.abs(tb - ta);
    out.endA = rangeAvg(prof.sup, prof.n, ta + dir * 2, ta + dir * 0.07 * span0);
    out.endB = rangeAvg(prof.sup, prof.n, tb - dir * 2, tb - dir * 0.07 * span0);
    out.extA = rangeAvg(prof.ali, prof.n, ta - dir * 0.03 * span0, ta - dir * 0.15 * span0);
    out.extB = rangeAvg(prof.ali, prof.n, tb + dir * 0.03 * span0, tb + dir * 0.15 * span0);
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
  function makeFastScorer(ctx, aspect, prior, cornerMix = 0, borderSup = 0.4, center = 0, priorGain = 0.2) {
    const { w, h } = ctx;
    const seg = { sup: 0, valid: false, plus: 0, minus: 0, endA: 0, endB: 0, extA: 0, extB: 0 };
    const sides = [null, null, null, null];
    const pts = [null, null, null, null];
    const sd = [0, 1, 2, 3].map(() => ({ border: false, endA: 0, endB: 0, extA: 0, extB: 0 }));
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
      if ((a1.border ? 1 : 0) + (a2.border ? 1 : 0) + (b1.border ? 1 : 0) + (b2.border ? 1 : 0) >= 3) return null;
      let sum = 0, min = Infinity, con = 0, conN = 0;
      for (let i = 0; i < 4; i++) {
        const l = sides[i], A = pts[i], B = pts[(i + 1) % 4];
        let sup;
        sd[i].border = !!l.border;
        if (l.border) {
          sup = borderSup;
        } else {
          if (!segment(l.prof, A, B, seg)) return null;
          sup = seg.sup;
          sd[i].endA = seg.endA; sd[i].endB = seg.endB; sd[i].extA = seg.extA; sd[i].extB = seg.extB;
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
      s *= cornerFactor(sd, cornerMix);
      s *= centerFactor(cx, cy, w, h, center);
      if (aspect || prior) {
        const oq = Geo.orderQuad(pts);
        s *= aspectFactor(oq, w, h, aspect) * priorFactor(oq, prior, ctx.long, priorGain);
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
  // local > 0 のときは、各辺の両端から local の範囲の点だけでも直線を当てはめ、角はその端の直線どうしで決める
  // （反った紙は辺が弓なりなので、辺全体の直線より角の近くの直線のほうが角の位置に合う）
  function refineWith(q, grad, r, absMin, maxShift, local = 0, localMin = 0) {
    const lines = [], ends = [];
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
        found.push([x0 + (bd + off) * nx, y0 + (bd + off) * ny, best, t]);
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
      line = line || { c: nx, s: ny, rho: nx * P[0] + ny * P[1] };
      lines.push(line);
      if (local) {
        // 端の近くの直線。点が足りないとき（指で隠れているなど）や、傾きすぎるときは辺全体の直線を使う
        const endLine = (sel) => {
          const sub = pts.filter(sel);
          if (sub.length < Math.max(6, n * local * 0.4)) return line;
          const fit = fitLine(sub);
          return Math.abs(fit.c * nx + fit.s * ny) > 0.99 ? fit : line;
        };
        ends.push({ a: endLine((p) => p[3] < 0.08 + local), b: endLine((p) => p[3] > 0.92 - local) });
      }
    }
    return q.map((p, i) => {
      let c = intersect(lines[(i + 3) % 4], lines[i]);
      if (local) {
        // 辺がまっすぐなら、点の多い辺全体の直線のほうが正確。端の直線で角が 0.15% 以上動くとき（弓なり）だけ使う
        const e = intersect(ends[(i + 3) % 4].b, ends[i].a);
        if (e && (!c || Geo.dist(e, c) > localMin)) c = e;
      }
      return c && Geo.dist(c, p) < maxShift ? c : p;
    });
  }

  // 領域から作った四角形の辺を、「内側の帯（紙）と外側の帯（背景）の差がいちばん大きい位置」に合わせ直す。
  // 境目の強さではなく広い帯の平均で比べるので、布の格子柄のような細かい線には引っぱられない
  function regionRefine(q, ctx) {
    const { w, h, L, satB } = ctx;
    const r = Math.max(4, Math.round(ctx.long * 0.035));
    const B = Math.max(4, Math.round(ctx.long * 0.05));
    const at = (arr, x, y) => {
      const xi = Math.round(x - 0.5), yi = Math.round(y - 0.5);
      return xi < 0 || yi < 0 || xi >= w || yi >= h ? NaN : arr[yi * w + xi];
    };
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    const lines = [];
    const span = r + B;
    const prof = new Float32Array(2 * span + 1);
    const ok = new Uint8Array(2 * span + 1);
    for (let i = 0; i < 4; i++) {
      const P = q[i], Q = q[(i + 1) % 4];
      const dx = Q[0] - P[0], dy = Q[1] - P[1];
      const len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len;
      if ((cx - (P[0] + Q[0]) / 2) * nx + (cy - (P[1] + Q[1]) / 2) * ny < 0) { nx = -nx; ny = -ny; } // 内向き
      const n = Math.max(12, Math.min(48, Math.round(len / 6)));
      const pts = [];
      for (let k = 0; k < n; k++) {
        const t = 0.1 + (0.8 * (k + 0.5)) / n;
        const x0 = P[0] + dx * t, y0 = P[1] + dy * t;
        // 法線に沿って「紙らしさ」（明るさ − 彩度）を並べる
        for (let d = -span; d <= span; d++) {
          const l = at(L, x0 + d * nx, y0 + d * ny), sv = at(satB, x0 + d * nx, y0 + d * ny);
          ok[d + span] = Number.isNaN(l) ? 0 : 1;
          prof[d + span] = ok[d + span] ? l - 1.5 * sv : 0;
        }
        let best = 0, bd = null;
        for (let d = -r; d <= r; d++) {
          let si = 0, ni = 0, so = 0, no = 0;
          for (let e = 2; e <= B; e++) {
            const a = d + e + span, b = d - e + span;
            if (ok[a]) { si += prof[a]; ni++; }
            if (ok[b]) { so += prof[b]; no++; }
          }
          if (ni < B / 2 || no < B / 2) continue;
          const diff = si / ni - so / no;
          if (diff > best) { best = diff; bd = d; }
        }
        if (bd !== null && best > 6) pts.push([x0 + bd * nx, y0 + bd * ny]);
      }
      let line = null;
      if (pts.length >= Math.max(6, n * 0.4)) {
        const fit = fitLine(pts);
        if (Math.abs(fit.c * nx + fit.s * ny) > 0.995) line = fit;
      }
      lines.push(line || { c: nx, s: ny, rho: nx * P[0] + ny * P[1] });
    }
    return q.map((p, i) => {
      const c = intersect(lines[(i + 3) % 4], lines[i]);
      return c && Geo.dist(c, p) < 0.08 * ctx.long ? c : p;
    });
  }

  function refine(q, ctx, r) {
    return refineWith(q, gradSampler(ctx), r, 0.25 * ctx.gscale, 0.04 * ctx.long);
  }

  // 高い解像度（long）の画像で、辺の位置をもう一度細かく合わせる（写真から探すとき）。
  // 文字の線に引っぱられないよう、辺とほぼ同じ向きの境目だけを使う
  function refineFine(source, quadN, long, localFrac = 0) {
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
    q = Geo.orderQuad(refineWith(q, grad, Math.max(2, Math.round(L / 480)), 24, 0.015 * L, localFrac, 0.0015 * L));
    if (!Geo.isConvex(q)) return null;
    return q.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
  }

  // 画面の中ほど（書類があることが多い）が、まわりより明らかに暗ければ、地の色が濃い書類とみなす
  // （文字や写真に引っぱられないよう、平均ではなく真ん中の値で比べる）
  // 暗い机の上の濃い書類のために、中ほどが暗く、画面でいちばん明るいあたり（上位 1%、明るい文字など）より
  // ずっと暗いときも疑う（暗い部屋の白い書類は、中ほどが画面でいちばん明るいので当てはまらない）
  // （撮影中は毎回呼ぶので、並べ替えではなく明るさの度数分布で求める）
  function darkDocument({ data, w, h }) {
    // 0.25 刻みの度数分布（並べ替えて求めた値とほぼ同じになる）
    const center = new Uint32Array(1024), outer = new Uint32Array(1024), all = new Uint32Array(1024);
    let cn = 0, on = 0, an = 0;
    const step = Math.max(1, Math.round(Math.max(w, h) / 120));
    for (let y = 0; y < h; y += step) {
      const ny = Math.abs(y / h - 0.5);
      for (let x = 0; x < w; x += step) {
        const nx = Math.abs(x / w - 0.5);
        const j = (y * w + x) * 4;
        const l = ((0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]) * 4) | 0;
        all[l]++; an++;
        if (nx < 0.22 && ny < 0.22) { center[l]++; cn++; } else if (nx > 0.4 || ny > 0.4) { outer[l]++; on++; }
      }
    }
    if (!cn || !on) return false;
    // 小さいほうから数えて k 番目（0 始まり）の値
    const at = (hist, k) => { let acc = 0; for (let b = 0; b < 1024; b++) { acc += hist[b]; if (acc > k) return b / 4; } return 255; };
    const c = at(center, cn >> 1);
    return c < at(outer, on >> 1) - 50 || (c < 90 && c < at(all, Math.floor(an * 0.99)) - 60);
  }

  function invertPixels({ data, w, h }) {
    const out = new Uint8ClampedArray(data.length);
    for (let j = 0; j < data.length; j += 4) { out[j] = 255 - data[j]; out[j + 1] = 255 - data[j + 1]; out[j + 2] = 255 - data[j + 2]; out[j + 3] = 255; }
    return { data: out, w, h };
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
  function find(source, opts = {}) {
    const { long = 480, aspect = null, refine: doRefine = true, refineLong = 0, prior = null, quick = false, debug = false, timing = null, exp = {}, invert } = opts;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const mark = (name) => { if (timing) { const t = now(); timing[name] = (timing[name] || 0) + t - (timing._t || t); timing._t = t; } };
    mark('start');
    let px = pixelsOf(source, long);
    if (!px) return null;
    mark('pixels');
    // 地の色が濃い書類（紺の名刺など、明るい文字）かもしれないときは、明るさを反転して「明るい紙に暗い文字」としても探し、
    // 点の高いほうを使う（白い机の上の写真入りの書類のように、真ん中が暗くても白い書類のことがあるので、両方を比べる）
    if (invert === undefined && !exp.nodark && darkDocument(px)) {
      const a = find(source, { ...opts, invert: false });
      const b = find(source, { ...opts, invert: true });
      const r = !a ? b : !b ? a : b.score > a.score ? b : a;
      if (r && r === b) r.dark = true; // 地の色が濃い書類（仕上げを「カラー」から始めるときの目印）
      return r;
    }
    if (invert) px = invertPixels(px);
    // 色の境目も使う（撮影中は軽さを優先して、彩度の閉じ処理を省く）
    const ctx = makeContext(px, 1, quick);
    mark('prepare');
    const { w, h, gx, gy, mag, gscale } = ctx;
    const priorPx = prior ? Geo.orderQuad(prior.map(([x, y]) => [x * w, y * h])) : null;
    // 角らしさは、2 本の辺の平均と弱いほうを半々に見る
    const cornerMix = 0.5;
    // 画面のふちを辺にするときの境目の強さ。上げると、はみ出した書類をふちまでの四角形として返しやすいが、
    // 周りに置いたほかの書類（ふちにかかる）を選びやすくなるので、0.4 にとどめる
    const borderSup = 0.4;
    const center = 0.25; // 画面の中ほどを選びやすくする強さ（四隅の近くで最大 25% 下げる）
    const priorGain = quick ? 0.2 : 0.08; // 撮った写真では、撮影画面の枠に引っぱられすぎないよう弱める
    const score = makeScorer(ctx, aspect, priorPx, cornerMix, borderSup, center, priorGain);

    // 追いかけ: 撮影中に書類を見つけ続けているときは、直前の位置だけを合わせ直して確かめる（画面全体は探さない）。
    // 点が十分に高ければそれを返し、低ければふつうに探す
    if (opts.track && priorPx) {
      const wide = Math.max(4, Math.round(ctx.long / 60)), narrow = Math.max(3, Math.round(ctx.long / 120));
      const tq = Geo.orderQuad(refine(Geo.orderQuad(refine(priorPx, ctx, wide)), ctx, narrow));
      const ts = Geo.isConvex(tq) ? score(tq) : 0;
      mark('track');
      if (ts >= (opts.trackMin || 0.55)) {
        return { quad: tq.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]), score: ts, tracked: true };
      }
    }

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
    const aligned = alignedSampler(ctx);
    const band = bandSampler(ctx);
    const edges = thinEdges(gx, gy, mag, w, h, 0.15 * gscale);
    // 短い辺（レシートや名刺）や、指で一部が隠れた辺も拾えるよう、票の下限は長辺の 6% にする
    const lines = houghLines(edges, gx, gy, w, h, quick ? 22 : 36, Math.max(12, Math.round(0.06 * ctx.long)))
      .map((l) => ({ ...l, prof: profileLine(l, ctx, strong, grad, band, aligned) }))
      .filter((l) => l.prof);
    mark('lines');

    // b) 領域から作る四角形。明るい紙の塊と、模様の少ない塊（布の柄や木目の上に置いた紙）。
    // 模様の塊のふちはぼかしの分ずれるので、帯の差で辺を合わせ直す
    const regional = [];
    const regionsOf = (half, thr, below, unions = false) => regionQuads(half.map, half.w, half.h, thr, below, unions)
      .map((q) => q.map(([x, y]) => [(x * w) / half.w, (y * h) / half.h]));
    for (const q of regionsOf(halve(ctx.P, w, h))) regional.push([q, 'region']);
    for (const q of regionsOf(ctx.T, ctx.tThr, true, true)) {
      regional.push([q, 'texture']);
      regional.push([Geo.orderQuad(regionRefine(q, ctx)), 'texture+']);
    }
    if (!quick) for (const q of regionsOf(halve(ctx.L, w, h))) regional.push([q, 'region']);
    for (const [q, from] of regional) add(q, from);
    mark('region');
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
    const fast = makeFastScorer(ctx, aspect, priorPx, cornerMix, borderSup, center, priorGain);
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

    mark('score');
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.s - a.s);

    // 上位の候補は、辺を境目に合わせ直してから比べ直す
    // （撮影中の quick は 10 件。合わせ直す前は点の低い、指で一部が隠れた書類も拾えるように）
    const top = candidates.slice(0, doRefine ? (quick ? 10 : 8) : 1).map((c) => {
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
    // 写真や表で区切られた書類は、上の部分・写真まで・全体のように何重にもなるので、外側へ順にたどる
    const floor = best.s * 0.85;
    for (let moved = true; moved;) {
      moved = false;
      const bestArea = Geo.area(best.q);
      for (const c of top) {
        if (c === best || c.s < floor || Geo.area(c.q) < bestArea * 1.15) continue;
        if (shared(best.q, c.q) >= 2) { best = c; moved = true; break; }
      }
    }

    const norm = (q) => q.map(([x, y]) => [Math.min(1, Math.max(0, x / w)), Math.min(1, Math.max(0, y / h))]);
    mark('refine');
    let quad = norm(best.q);
    // 最後の合わせ直しでは、反った紙のために角の近くの直線も見る（辺の両端 30%）
    if (refineLong > long) quad = refineFine(source, quad, refineLong, 0.3) || quad;
    mark('fine');
    const result = { quad, score: best.s };
    if (debug) {
      result.debug = {
        size: [w, h],
        lines: lines.filter((l) => !l.border).map((l) => ({ t: l.t, rho: l.rho, votes: l.votes })),
        unrefined: norm(best.raw || best.q),
        top: candidates.slice(0, 8).map((c) => ({ from: c.from, s: +c.s.toFixed(3), q: norm(c.q) })),
        refined: top.map((c) => ({ from: c.from, s: +c.s.toFixed(3), q: norm(c.q) })),
        regions: candidates.filter((c) => c.from !== 'lines').map((c) => ({ from: c.from, s: +c.s.toFixed(3), q: norm(c.q) })),
        scoreOf: (qn) => score(Geo.orderQuad(qn.map(([x, y]) => [x * w, y * h]))),
        // 正解の各辺にいちばん近い直線で、手早い採点をしたときの点数（直線の組み合わせで落ちていないかを見る）
        fastOf: (qn) => {
          const q = Geo.orderQuad(qn.map(([x, y]) => [x * w, y * h]));
          const pick = (A, B) => {
            let best = null, bd = Infinity;
            for (const l of lines) {
              const d = Math.max(Math.abs(l.c * A[0] + l.s * A[1] - l.rho), Math.abs(l.c * B[0] + l.s * B[1] - l.rho));
              if (d < bd) { bd = d; best = l; }
            }
            return { l: best, d: +bd.toFixed(1) };
          };
          const s0 = pick(q[0], q[1]), s1 = pick(q[1], q[2]), s2 = pick(q[2], q[3]), s3 = pick(q[3], q[0]);
          const f = fast(s0.l, s2.l, s3.l, s1.l);
          return { fast: f === null ? null : +f.toFixed(3), dist: [s0.d, s1.d, s2.d, s3.d], cut: shortlist.length ? +shortlist[shortlist.length - 1].s.toFixed(3) : null };
        },
        explain: (qn) => { const ex = {}; score(Geo.orderQuad(qn.map(([x, y]) => [x * w, y * h])), ex); return ex; },
      };
    }
    return result;
  }

  // 以前の呼び方との互換用
  function detect(source, long = 480) {
    const r = find(source, { long });
    return r ? r.quad : null;
  }

  // _parts は速さを測るとき用
  return { find, detect, _parts: { makeContext, halve, blur2, regionQuads, regionRefine, boxBlur, closing, sobel, percentile, thinEdges, houghLines } };
}

const Detect = DetectModule(Geo, Imaging);
