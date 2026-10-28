// 重い画像処理（取り込み・検出・仕上がりの作成・PDF 用の画像）をまとめる。
// 使えるときは Web Worker（別のスレッド）で動かし、撮影中の映像や画面の操作を止めない。
// 使えない環境では、同じ処理をこの場（メインスレッド）で行う

// ---------- 処理の中身（ワーカーと画面の両方で使う） ----------
function JobsModule(Geo, Imaging, Detect, Pdf) {
  'use strict';

  const insetQuad = () => { const m = 0.05; return [[m, m], [1 - m, m], [1 - m, 1 - m], [m, 1 - m]]; };

  // 編集中のページの元画像は、毎回読み直さずに使い回す
  let cached = null; // { key, img }
  let warped = null; // { key, img }
  async function sourceOf(key, blob) {
    if (cached && cached.key === key) return cached.img;
    if (cached && cached.img.close) cached.img.close();
    cached = null;
    warped = null;
    const img = await Imaging.decode(blob);
    cached = { key, img };
    return img;
  }

  /**
   * 撮った写真・取り込んだ画像を、保存用の JPEG・四隅・サムネイルにする
   * source: Blob か ImageBitmap（映像の1コマ） / ref: 向きをそろえる手本（映像の1コマを縮めたもの）
   */
  async function ingest({ source, ref = null, hint = null, aspect = null, maxLong, detectLong, refineLong, thumbLong, filter = 'enhance', rotation = 0, timing = false }) {
    const t = timing ? {} : null;
    let last = Date.now();
    const mark = (k) => { if (t) { const now = Date.now(); t[k] = now - last; last = now; } };
    const img = await Imaging.normalize(source, maxLong, ref);
    if (ref && ref.close) ref.close();
    // 四隅の検出（最後の合わせ直しは refineLong）とサムネイルは、refineLong の大きさに一度だけ縮めたものから作る
    const k = Math.min(1, refineLong / Math.max(img.width, img.height));
    const mid = k < 1 ? Imaging.scaleTo(img.canvas, Math.round(img.width * k), Math.round(img.height * k)) : img.canvas;
    mark('normalize');
    const found = Detect.find(mid, { long: detectLong, aspect, refineLong });
    mark('detect');
    let quad = found && found.quad;
    if (!quad && hint && Math.abs(img.width / img.height - hint.ratio) < 0.02) quad = hint.quad;
    const detected = !!quad;
    if (!quad) quad = insetQuad();
    // 地の色が濃い書類は「くっきり」（紙を白くする）が合わないので、「カラー」から始める
    if (found && found.dark && filter === 'enhance') filter = 'color';
    const thumbCanvas = Imaging.render(mid, { quad, aspect, filter, rotation }, thumbLong);
    mark('thumb');
    const [original, thumb] = await Promise.all([img.blob, Imaging.toBlob(thumbCanvas, 'image/jpeg', 0.82)]);
    mark('encode');
    return { original, width: img.width, height: img.height, quad, detected, thumb, filter, score: found ? found.score : 0, timing: t };
  }

  async function detectPage({ key, blob, opts }) {
    const img = await sourceOf(key, blob);
    return Detect.find(img, opts);
  }

  // 編集画面の「仕上げ」の見本。補正（重い）はページと四隅が同じなら使い回し、フィルターだけかけ直す
  async function preview({ key, blob, quad, aspect, filter, rotation, maxLong }) {
    const img = await sourceOf(key, blob);
    const wkey = `${key}|${JSON.stringify(quad)}|${aspect}|${maxLong}`;
    if (!warped || warped.key !== wkey) warped = { key: wkey, img: Imaging.warpFrom(img, quad, maxLong, aspect) };
    const out = Imaging.applyFilter(Imaging.clone(warped.img), filter);
    return createImageBitmap(Imaging.rotatedCanvas(out, rotation));
  }

  async function thumb({ key, blob, page, long }) {
    const img = await sourceOf(key, blob);
    return Imaging.toBlob(Imaging.render(img, page, long), 'image/jpeg', 0.82);
  }

  // PDF に入れる 1 ページ分の画像（JPEG か、白黒なら 1 ビット）
  async function render({ blob, page, maxLong, bitonal, quality, timing = false }) {
    const t = timing ? {} : null;
    let last = Date.now();
    const mark = (k) => { if (t) { const now = Date.now(); t[k] = now - last; last = now; } };
    const img = await Imaging.decode(blob);
    mark('decode');
    const warped = Imaging.warpFrom(img, page.quad, maxLong, page.aspect || null);
    if (img.close) img.close();
    mark('warp');
    Imaging.applyFilter(warped, page.filter);
    mark('filter');
    const canvas = Imaging.rotatedCanvas(warped, page.rotation || 0);
    const out = await (bitonal && Pdf.canDeflate ? Pdf.bitonalImage(canvas) : Pdf.jpegImage(canvas, quality));
    mark('encode');
    if (t) out.timing = t;
    return out;
  }

  return { ingest, detectPage, preview, thumb, render };
}

// ---------- ワーカーの中で動く部分 ----------
function WorkerMain(Jobs, Detect, Imaging) {
  'use strict';
  self.onmessage = async (e) => {
    const { id, type, payload } = e.data;
    try {
      let result = null;
      const transfer = [];
      if (type === 'ping') {
        result = 'pong';
      } else if (type === 'detect') {
        // 映像のコマ（VideoFrame）は、縮めて取り出したらすぐ閉じる（カメラの受け皿をふさがない）
        let src = payload.bitmap;
        if (typeof VideoFrame === 'function' && src instanceof VideoFrame) {
          try { src = await Imaging.framePixels(src, payload.opts.long); } finally { payload.bitmap.close(); }
        }
        result = Detect.find(src, payload.opts);
        if (src.close) src.close();
      } else if (type === 'ingest') {
        result = await Jobs.ingest(payload);
      } else if (type === 'detectPage') {
        result = await Jobs.detectPage(payload);
      } else if (type === 'preview') {
        result = await Jobs.preview(payload);
        transfer.push(result);
      } else if (type === 'thumb') {
        result = await Jobs.thumb(payload);
      } else if (type === 'render') {
        result = await Jobs.render(payload);
        transfer.push(result.bytes.buffer);
      } else {
        throw new Error(`知らない処理です: ${type}`);
      }
      self.postMessage({ id, ok: true, result }, transfer);
    } catch (err) {
      self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
    }
  };
}

// ---------- 画面側の窓口 ----------
const Engine = (() => {
  'use strict';

  const local = JobsModule(Geo, Imaging, Detect, Pdf);
  const supported = typeof Worker === 'function' && typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function';
  let url = null;
  const lanes = {};

  // 部品の関数をそのまま文字列にして、ワーカーの中身を組み立てる（別ファイルを読まないので Artifact でも動く）
  function workerSource() {
    return [GeoModule, ImagingModule, DetectModule, PdfModule, JobsModule, WorkerMain].map(String).join('\n\n') + `
const Geo = GeoModule();
const Imaging = ImagingModule(Geo);
const Detect = DetectModule(Geo, Imaging);
const Pdf = PdfModule(Imaging);
WorkerMain(JobsModule(Geo, Imaging, Detect, Pdf), Detect, Imaging);
`;
  }

  function startLane() {
    if (!url) url = URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
    const worker = new Worker(url);
    const lane = { worker, seq: 0, waiting: new Map(), broken: false };
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = lane.waiting.get(id);
      if (!p) return;
      lane.waiting.delete(id);
      if (ok) p.resolve(result); else p.reject(new Error(error));
    };
    worker.onerror = () => {
      lane.broken = true;
      for (const p of lane.waiting.values()) p.reject(new Error('worker-broken'));
      lane.waiting.clear();
    };
    return lane;
  }

  // live: 撮影中の検出だけ / heavy: 取り込みや仕上げ。撮影直後の処理で検出が止まらないよう分けておく
  function lane(name) {
    if (!lanes[name] || lanes[name].broken) lanes[name] = startLane();
    return lanes[name];
  }

  function call(name, type, payload, transfer = []) {
    const l = lane(name);
    return new Promise((resolve, reject) => {
      const id = ++l.seq;
      l.waiting.set(id, { resolve, reject });
      l.worker.postMessage({ id, type, payload }, transfer);
    });
  }

  // 最初に一度だけ、ワーカーが本当に動くか確かめる（動かない環境ではこの場で処理する）
  let ready = null;
  function available() {
    if (!ready) {
      ready = (async () => {
        if (!supported) return false;
        try {
          const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000));
          return (await Promise.race([call('heavy', 'ping', null), timeout])) === 'pong';
        } catch (e) {
          return false;
        }
      })();
    }
    return ready;
  }

  const closable = (list) => list.filter((x) => x && typeof x.close === 'function');

  return {
    available,

    // 先にワーカーを起こしておく（撮影画面を開いたとき、最初の検出を待たせない）
    warm(name) {
      if (supported) available().then((ok) => { if (ok) call(name, 'ping', null).catch(() => {}); });
    },

    async detectLive(bitmap, opts) {
      if (await available()) return call('live', 'detect', { bitmap, opts }, [bitmap]);
      const r = Detect.find(bitmap, opts);
      if (bitmap.close) bitmap.close();
      return r;
    },

    async ingest(payload) {
      if (await available()) {
        try {
          return await call('heavy', 'ingest', payload, closable([payload.source, payload.ref]));
        } catch (err) {
          // ワーカーでは読めない形式（端末によっては HEIC など）は、画面側の読み込みで試し直す
          if (payload.source instanceof Blob) return local.ingest({ ...payload, ref: null });
          throw err;
        }
      }
      return local.ingest(payload);
    },

    async detectPage(payload) {
      return (await available()) ? call('heavy', 'detectPage', payload) : local.detectPage(payload);
    },

    async preview(payload) {
      return (await available()) ? call('heavy', 'preview', payload) : local.preview(payload);
    },

    async thumb(payload) {
      return (await available()) ? call('heavy', 'thumb', payload) : local.thumb(payload);
    },

    async render(payload) {
      return (await available()) ? call('heavy', 'render', payload) : local.render(payload);
    },
  };
})();
