// 画像の読み込み・射影補正・仕上げフィルター。
// 画面（メインスレッド）と、重い処理を受け持つ Web Worker の両方で動くよう、DOM がなくても使える形にしてある
function ImagingModule(Geo) {
  'use strict';

  const hasDOM = typeof document !== 'undefined';

  function makeCanvas(w, h) {
    const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
    if (hasDOM) {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      return c;
    }
    return new OffscreenCanvas(W, H);
  }

  const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });

  function toBlob(canvas, type = 'image/jpeg', quality = 0.9) {
    if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を書き出せませんでした'))), type, quality);
    });
  }

  // <img> で読む（画面側だけ）。EXIF の向きはブラウザが反映してくれる
  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('この画像は読み込めませんでした')); };
      img.src = url;
    });
  }

  // JPEG の EXIF にある向き（1〜8）。ないときは 1
  function exifOrientation(buf) {
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
    let off = 2;
    while (off + 4 <= v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
      const size = v.getUint16(off + 2);
      if (marker === 0xffe1 && off + 18 <= v.byteLength && v.getUint32(off + 4) === 0x45786966) {
        const tiff = off + 10;
        const le = v.getUint16(tiff) === 0x4949;
        const ifd = tiff + v.getUint32(tiff + 4, le);
        if (ifd + 2 > v.byteLength) return 1;
        const count = v.getUint16(ifd, le);
        for (let i = 0; i < count; i++) {
          const e = ifd + 2 + i * 12;
          if (e + 12 > v.byteLength) break;
          if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le) || 1;
        }
        return 1;
      }
      off += 2 + size;
    }
    return 1;
  }

  // JPEG に記録された本来の幅と高さ（向きを直す前）
  function jpegSize(buf) {
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 9 <= v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xff00) !== 0xff00) return null;
      const m = marker & 0xff;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: v.getUint16(off + 5), w: v.getUint16(off + 7) };
      }
      off += 2 + v.getUint16(off + 2);
    }
    return null;
  }

  const sizeOf = (src) => ({
    w: src.naturalWidth || src.videoWidth || src.displayWidth || src.width,
    h: src.naturalHeight || src.videoHeight || src.displayHeight || src.height,
  });

  // EXIF の向き 5〜8（縦横が入れ替わる向き）に回して描く
  function orient(img, o) {
    const { w, h } = sizeOf(img);
    const c = makeCanvas(h, w);
    const x = c.getContext('2d');
    if (o === 5) x.setTransform(0, 1, 1, 0, 0, 0);
    else if (o === 6) x.setTransform(0, 1, -1, 0, h, 0);
    else if (o === 7) x.setTransform(0, -1, -1, 0, h, w);
    else x.setTransform(0, -1, 1, 0, 0, w);
    x.drawImage(img, 0, 0);
    return c;
  }

  // 画像を描画できる形にする。写真の向き（EXIF）が反映されていない環境では、自分で回す
  async function decode(blob) {
    if (typeof createImageBitmap === 'function') {
      let bmp = null;
      try {
        bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      } catch (e) {
        try { bmp = await createImageBitmap(blob); } catch (e2) { bmp = null; }
      }
      if (bmp) {
        if (!blob.type || blob.type === 'image/jpeg') {
          const buf = await blob.slice(0, 256 * 1024).arrayBuffer();
          const o = exifOrientation(buf);
          const raw = o >= 5 ? jpegSize(buf) : null;
          if (raw && raw.w === bmp.width && raw.h === bmp.height && raw.w !== raw.h) {
            const c = orient(bmp, o);
            bmp.close();
            return c;
          }
        }
        return bmp;
      }
    }
    if (hasDOM) return loadImage(blob);
    throw new Error('この画像は読み込めませんでした');
  }

  // 大きく縮めるときは半分ずつ縮めて、ギザギザを抑える
  function scaleTo(src, w, h) {
    let { w: cw, h: ch } = sizeOf(src);
    let cur = src;
    while (cw / 2 >= w && ch / 2 >= h) {
      const step = makeCanvas(cw / 2, ch / 2);
      const x = step.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(cur, 0, 0, step.width, step.height);
      cur = step; cw = step.width; ch = step.height;
    }
    const out = makeCanvas(w, h);
    const ctx = ctx2d(out);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, out.width, out.height);
    return out;
  }

  // 映像の1コマ（VideoFrame）を、長辺 long の RGBA に縮めて取り出す（撮影中の検出用。ワーカーの中で使う）。
  // 縮めるのはブラウザの画像処理（createImageBitmap）に任せる（JavaScript で縮めるより数倍速い）
  let frameCanvas = null;
  async function framePixels(frame, long) {
    const W = frame.displayWidth, H = frame.displayHeight;
    const s = Math.min(1, long / Math.max(W, H));
    const w = Math.max(32, Math.round(W * s)), h = Math.max(32, Math.round(H * s));
    let src = frame;
    try { src = await createImageBitmap(frame, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }); } catch (e) { src = frame; }
    if (!frameCanvas || frameCanvas.width !== w || frameCanvas.height !== h) frameCanvas = makeCanvas(w, h);
    const x = ctx2d(frameCanvas);
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, w, h);
    if (src !== frame) src.close();
    return { data: x.getImageData(0, 0, w, h).data, w, h };
  }

  // 撮影・取り込んだ画像を、向きをそろえた上限サイズの JPEG にする。
  // source は Blob（写真）か、映像の1コマ（ImageBitmap など）。ref があれば、その向きに回してそろえる
  async function normalize(source, maxLong = 3200, ref = null) {
    const decoded = typeof Blob !== 'undefined' && source instanceof Blob
      ? (hasDOM ? await loadImage(source) : await decode(source))
      : source;
    const img = ref ? alignTo(decoded, ref) : decoded;
    const { w, h } = sizeOf(img);
    const s = Math.min(1, maxLong / Math.max(w, h));
    const canvas = scaleTo(img, Math.round(w * s), Math.round(h * s));
    if (decoded.close) decoded.close();
    // JPEG への書き出しはブラウザが裏で進めるので、待たずに返す（その間に四隅の検出などを進められる）
    const blob = toBlob(canvas, 'image/jpeg', 0.92);
    return { blob, canvas, width: canvas.width, height: canvas.height };
  }

  // 出力画素 (u, v) → 元画像の位置 を射影変換で求め、双一次補間で色を取る
  function warp(src, quad, outW, outH) {
    const H = Geo.homography([[0, 0], [outW, 0], [outW, outH], [0, outH]], quad);
    const out = new ImageData(outW, outH);
    if (!H) return out;
    const sd = src.data, od = out.data, sw = src.width, sh = src.height;
    const maxX = sw - 1, maxY = sh - 1;
    const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = H;
    let o = 0;
    for (let v = 0; v < outH; v++) {
      const vy = v + 0.5;
      const nx0 = h1 * vy + h2, ny0 = h4 * vy + h5, d0 = h7 * vy + h8;
      for (let u = 0; u < outW; u++) {
        const ux = u + 0.5;
        const d = h6 * ux + d0;
        let x = (h0 * ux + nx0) / d - 0.5;
        let y = (h3 * ux + ny0) / d - 0.5;
        if (x < 0) x = 0; else if (x > maxX) x = maxX;
        if (y < 0) y = 0; else if (y > maxY) y = maxY;
        const x0 = x | 0, y0 = y | 0;
        const x1 = x0 < maxX ? x0 + 1 : x0;
        const y1 = y0 < maxY ? y0 + 1 : y0;
        const fx = x - x0, fy = y - y0;
        const i00 = (y0 * sw + x0) << 2, i10 = (y0 * sw + x1) << 2;
        const i01 = (y1 * sw + x0) << 2, i11 = (y1 * sw + x1) << 2;
        for (let c = 0; c < 3; c++) {
          const top = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * fx;
          const bot = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * fx;
          od[o + c] = top + (bot - top) * fy;
        }
        od[o + 3] = 255;
        o += 4;
      }
    }
    return out;
  }

  // 補正後の大きさ。縦横比は斜めの具合から見積もり、aspect（長辺 / 短辺）の指定に近ければそれにそろえる
  function outputSize(source, quadN, maxLong, aspect = null) {
    const { w: sw, h: sh } = sizeOf(source);
    const q = quadN.map(([x, y]) => [x * sw, y * sh]);
    const { w: qw, h: qh } = Geo.quadSize(q);
    const qLong = Math.max(qw, qh, 1);
    const outLong = Math.max(16, Math.min(maxLong, Math.round(qLong)));
    const ratio = Geo.outputAspect(q, sw, sh, aspect);
    const w = ratio >= 1 ? outLong : outLong * ratio;
    const h = ratio >= 1 ? outLong / ratio : outLong;
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), ratio, q, qLong };
  }

  // 正規化座標の四隅（0〜1）で切り出して、長辺 maxLong 以下の補正済み画像にする
  function warpFrom(source, quadN, maxLong, aspect = null) {
    const { w: sw, h: sh } = sizeOf(source);
    const { w: outW, h: outH, q, qLong } = outputSize(source, quadN, maxLong, aspect);
    // 出力に見合う解像度まで元画像を縮めてから変換する（縮小しすぎのギザギザを防ぐ）
    const scale = Math.min(1, (Math.max(outW, outH) * 1.25) / qLong);
    const srcCanvas = scale < 1 ? scaleTo(source, Math.round(sw * scale), Math.round(sh * scale)) : scaleTo(source, sw, sh);
    const sx = srcCanvas.width / sw, sy = srcCanvas.height / sh;
    const src = ctx2d(srcCanvas).getImageData(0, 0, srcCanvas.width, srcCanvas.height);
    return warp(src, q.map(([x, y]) => [x * sx, y * sy]), outW, outH);
  }

  function clone(img) {
    return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  }

  function otsu(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, threshold = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; threshold = t; }
    }
    return threshold;
  }

  // 紙の明るさ（照明のむら）をブロックごとに見積もる。
  // ブロックの平均より明るい画素の平均を「紙の色」とみなすので、文字に引っ張られにくい。
  // 区画は大きい（長辺の 1/40）ので、画素は縦横 1 つおき（step）に見れば十分。4 分の 1 の手間で済む
  function backgroundGrid(arr, stride, off, w, h, b, gw, gh, step = b >= 16 ? 2 : 1) {
    const size = gw * gh;
    const sum = new Float64Array(size), cnt = new Uint32Array(size);
    const col = new Uint16Array(w);
    for (let x = 0; x < w; x++) col[x] = (x / b) | 0;
    for (let y = 0; y < h; y += step) {
      const row = ((y / b) | 0) * gw;
      let idx = y * w * stride + off;
      for (let x = 0; x < w; x += step, idx += stride * step) { const k = row + col[x]; sum[k] += arr[idx]; cnt[k]++; }
    }
    const mean = new Float32Array(size);
    for (let k = 0; k < size; k++) mean[k] = cnt[k] ? sum[k] / cnt[k] : 255;
    sum.fill(0); cnt.fill(0);
    for (let y = 0; y < h; y += step) {
      const row = ((y / b) | 0) * gw;
      let idx = y * w * stride + off;
      for (let x = 0; x < w; x += step, idx += stride * step) {
        const k = row + col[x];
        const v = arr[idx];
        if (v >= mean[k]) { sum[k] += v; cnt[k]++; }
      }
    }
    let grid = new Float32Array(size);
    for (let k = 0; k < size; k++) grid[k] = cnt[k] ? sum[k] / cnt[k] : mean[k];
    // 太い文字や写真のブロックが暗く見積もられないよう、周りの明るい値で埋める
    grid = gridFilter(grid, gw, gh, 'max');
    grid = gridFilter(grid, gw, gh, 'mean');
    grid = gridFilter(grid, gw, gh, 'mean');
    for (let k = 0; k < size; k++) if (grid[k] < 48) grid[k] = 48;
    return grid;
  }

  function gridFilter(g, gw, gh, kind) {
    const out = new Float32Array(g.length);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let acc = kind === 'max' ? 0 : 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= gh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= gw) continue;
            const v = g[yy * gw + xx];
            if (kind === 'max') { if (v > acc) acc = v; } else { acc += v; n++; }
          }
        }
        out[y * gw + x] = kind === 'max' ? acc : acc / n;
      }
    }
    return out;
  }

  // ブロック格子を画素ごとに双一次補間するための表
  function interpTable(len, b, glen) {
    const i0 = new Uint16Array(len), i1 = new Uint16Array(len), f = new Float32Array(len);
    for (let p = 0; p < len; p++) {
      let g = (p + 0.5) / b - 0.5;
      if (g < 0) g = 0;
      if (g > glen - 1) g = glen - 1;
      const a = g | 0;
      i0[p] = a;
      i1[p] = Math.min(a + 1, glen - 1);
      f[p] = g - a;
    }
    return { i0, i1, f };
  }

  // 輪郭を少し強めて文字をくっきりさせる（3×3 の平均との差を足す）。
  // 差が小さいところ（紙の地のざらつき）は触らないので、ノイズは強めない
  function unsharp(arr, stride, w, h, amount, threshold = 4) {
    const src = new Uint8ClampedArray(arr);
    const row = w * stride;
    const ch = Math.min(stride, 3);
    // 横に並んだ 3 画素の和を先に求めておき、3×3 の和はその縦 3 行の和で出す（同じ結果で速い）
    const hs = new Uint16Array(arr.length);
    for (let y = 0; y < h; y++) {
      const o = y * row;
      for (let x = 1; x < w - 1; x++) {
        const b = o + x * stride;
        for (let c = 0; c < ch; c++) hs[b + c] = src[b + c - stride] + src[b + c] + src[b + c + stride];
      }
    }
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const base = y * row + x * stride;
        for (let c = 0; c < ch; c++) {
          const k = base + c;
          const mean = (hs[k - row] + hs[k] + hs[k + row]) / 9;
          const diff = src[k] - mean;
          if (diff > threshold || diff < -threshold) arr[k] = src[k] + amount * diff;
        }
      }
    }
    return arr;
  }

  const FILTERS = ['enhance', 'color', 'gray', 'bw'];

  // enhance: 影と色かぶりを取って紙を白く（カラーは残す）
  // gray: 同じ補正をした上でグレーに
  // bw: 影を取ってから二値化（文字くっきり、容量も小さい）
  function applyFilter(img, mode) {
    if (mode === 'color' || !FILTERS.includes(mode)) return img;
    const { width: w, height: h, data } = img;
    const b = Math.max(8, Math.round(Math.max(w, h) / 40));
    const gw = Math.ceil(w / b), gh = Math.ceil(h / b);
    const tx = interpTable(w, b, gw), ty = interpTable(h, b, gh);
    // 格子の 2 行（r0, r1）の q 列目を、縦方向に fy で補間する
    const rowLerp = (g, r0, r1, q, fy) => g[r0 + q] + (g[r1 + q] - g[r0 + q]) * fy;

    if (mode === 'enhance') {
      const gR = backgroundGrid(data, 4, 0, w, h, b, gw, gh);
      const gG = backgroundGrid(data, 4, 1, w, h, b, gw, gh);
      const gB = backgroundGrid(data, 4, 2, w, h, b, gw, gh);
      const lo = 40, hi = 236, k = 255 / (hi - lo), sat = 1.12;
      // 背景の明るさは、行ごとに縦方向の補間を先に済ませておく
      const rR = new Float64Array(gw), rG = new Float64Array(gw), rB = new Float64Array(gw);
      let j = 0;
      for (let y = 0; y < h; y++) {
        const r0 = ty.i0[y] * gw, r1 = ty.i1[y] * gw, fy = ty.f[y];
        for (let q = 0; q < gw; q++) {
          rR[q] = rowLerp(gR, r0, r1, q, fy); rG[q] = rowLerp(gG, r0, r1, q, fy); rB[q] = rowLerp(gB, r0, r1, q, fy);
        }
        for (let x = 0; x < w; x++, j += 4) {
          const a = tx.i0[x], c = tx.i1[x], fx = tx.f[x];
          let r = (data[j] * 255 / (rR[a] + (rR[c] - rR[a]) * fx) - lo) * k;
          let g = (data[j + 1] * 255 / (rG[a] + (rG[c] - rG[a]) * fx) - lo) * k;
          let bl = (data[j + 2] * 255 / (rB[a] + (rB[c] - rB[a]) * fx) - lo) * k;
          const l = 0.299 * r + 0.587 * g + 0.114 * bl;
          r = l + (r - l) * sat; g = l + (g - l) * sat; bl = l + (bl - l) * sat;
          data[j] = r; data[j + 1] = g; data[j + 2] = bl;
        }
      }
      unsharp(data, 4, w, h, 0.6);
      return img;
    }

    const n = w * h;
    const L = new Uint8ClampedArray(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = (77 * data[j] + 150 * data[j + 1] + 29 * data[j + 2]) >> 8;
    const gL = backgroundGrid(L, 1, 0, w, h, b, gw, gh);
    const N = new Uint8ClampedArray(n);
    const rL = new Float64Array(gw);
    let i = 0;
    for (let y = 0; y < h; y++) {
      const r0 = ty.i0[y] * gw, r1 = ty.i1[y] * gw, fy = ty.f[y];
      for (let q = 0; q < gw; q++) rL[q] = rowLerp(gL, r0, r1, q, fy);
      for (let x = 0; x < w; x++, i++) { const a = tx.i0[x], c = tx.i1[x]; N[i] = L[i] * 255 / (rL[a] + (rL[c] - rL[a]) * tx.f[x]); }
    }

    unsharp(N, 1, w, h, mode === 'bw' ? 0.8 : 0.6);

    if (mode === 'gray') {
      const lo = 38, hi = 238, k = 255 / (hi - lo);
      for (let p = 0, j = 0; p < n; p++, j += 4) { const v = (N[p] - lo) * k; data[j] = data[j + 1] = data[j + 2] = v; }
      return img;
    }

    const hist = new Uint32Array(256);
    for (let p = 0; p < n; p++) hist[N[p]]++;
    const t = Math.max(150, Math.min(215, otsu(hist, n)));
    const ramp = 10;
    for (let p = 0, j = 0; p < n; p++, j += 4) {
      const v = ((N[p] - (t - ramp)) * 255) / (2 * ramp);
      data[j] = data[j + 1] = data[j + 2] = v;
    }
    return img;
  }

  function rotatedCanvas(img, rotation) {
    const base = makeCanvas(img.width, img.height);
    ctx2d(base).putImageData(img, 0, 0);
    const rot = ((rotation % 360) + 360) % 360;
    if (!rot) return base;
    const swap = rot % 180 !== 0;
    const out = makeCanvas(swap ? img.height : img.width, swap ? img.width : img.height);
    const ctx = ctx2d(out);
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(base, -img.width / 2, -img.height / 2);
    return out;
  }

  // 撮った写真（img）を、画面に映っていた向き（ref: 映像の1コマ）にそろえる。回したときは新しいキャンバスを返す。
  // 端末によっては写真が横倒しで返るため、0・90・180・270 度に回した縮小画像を映像と比べ、いちばん似ている向きを選ぶ
  function alignTo(img, ref) {
    const { w, h } = sizeOf(img);
    const { w: fw, h: fh } = sizeOf(ref);
    // 比べるのは小さな画像なので、大きな写真は先に一度だけ縮めておく
    const k = Math.min(1, 256 / Math.max(w, h));
    const small = k < 1 ? scaleTo(img, Math.round(w * k), Math.round(h * k)) : img;
    const sw0 = Math.round(w * k), sh0 = Math.round(h * k);
    const S = 48;
    const fr = fw / fh;
    const thumb = (src, sw, sh, rot) => {
      const swap = rot % 180 !== 0;
      const rw = swap ? sh : sw, rh = swap ? sw : sh;
      // 写真のほうが広く写っていることがあるので、映像と同じ縦横比で中央を切り出して比べる
      let cw = rw, ch = rw / fr;
      if (ch > rh) { ch = rh; cw = rh * fr; }
      const c = makeCanvas(S, Math.round(S / fr));
      const x = ctx2d(c);
      x.translate(c.width / 2, c.height / 2);
      x.scale(c.width / cw, c.height / ch);
      x.rotate((rot * Math.PI) / 180);
      x.drawImage(src, -sw / 2, -sh / 2);
      const d = x.getImageData(0, 0, c.width, c.height).data;
      const g = new Float32Array(d.length / 4);
      let mean = 0;
      for (let i = 0, j = 0; i < g.length; i++, j += 4) { g[i] = d[j] + d[j + 1] + d[j + 2]; mean += g[i]; }
      mean /= g.length;
      for (let i = 0; i < g.length; i++) g[i] -= mean;
      return g;
    };
    const base = thumb(ref, fw, fh, 0);
    let best = 0, bestErr = Infinity;
    for (const rot of [0, 90, 180, 270]) {
      const t = thumb(small, k < 1 ? sw0 : w, k < 1 ? sh0 : h, rot);
      let err = 0;
      for (let i = 0; i < t.length; i++) err += Math.abs(t[i] - base[i]);
      if (err < bestErr) { bestErr = err; best = rot; }
    }
    if (!best) return img;
    const swap = best % 180 !== 0;
    const out = makeCanvas(swap ? h : w, swap ? w : h);
    const ctx = out.getContext('2d');
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate((best * Math.PI) / 180);
    ctx.drawImage(img, -w / 2, -h / 2);
    return out;
  }

  // 1ページ分の仕上がり画像を作る
  function render(source, page, maxLong) {
    const img = warpFrom(source, page.quad, maxLong, page.aspect || null);
    applyFilter(img, page.filter);
    return rotatedCanvas(img, page.rotation || 0);
  }

  return { makeCanvas, toBlob, loadImage, decode, sizeOf, scaleTo, framePixels, normalize, warp, outputSize, warpFrom, clone, otsu, applyFilter, rotatedCanvas, alignTo, render };
}

const Imaging = ImagingModule(Geo);
