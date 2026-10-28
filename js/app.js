// 画面の操作。撮影 → 範囲の調整 → 仕上げ → PDF の流れをまとめる
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const ICONS = {
    camera: '<path d="M4 8.5h3.2l1.8-2.8h6l1.8 2.8H20v10.8H4z"/><circle cx="12" cy="13.6" r="3.6"/>',
    image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5l-4.8-4.8-8.2 8.3"/>',
    download: '<path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14"/>',
    share: '<path d="M12 14.5V4m0 0L8 8m4-4l4 4"/><path d="M7.5 10.5H5.5v9.5h13v-9.5h-2"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    more: '<circle cx="5.5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18.5" cy="12" r="1"/>',
    torch: '<path d="M13 3L5.5 13.5h5.5L10 21l8-10.5h-5.5z"/>',
    trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.5h9.2L17.5 7M10 10.5v6M14 10.5v6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    wand: '<path d="M4 20l10.5-10.5M13 4.5V7M19.5 11H17M16.8 6.2l-1.7 1.7M9.5 4l.7 1.5M20 14.5l-1.5-.7"/>',
    expand: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
    'rot-left': '<path d="M3.5 4v6h6"/><path d="M5.6 15a8 8 0 1 0 1.9-8.3L3.5 10"/>',
    'rot-right': '<path d="M20.5 4v6h-6"/><path d="M18.4 15a8 8 0 1 1-1.9-8.3l3.9 3.3"/>',
    'chev-left': '<path d="M14.5 6l-6 6 6 6"/>',
    'chev-right': '<path d="M9.5 6l6 6-6 6"/>',
  };

  const FILTER_NAMES = { enhance: 'くっきり', color: 'カラー', gray: 'グレー', bw: '白黒' };
  const FILTER_HINT = {
    enhance: 'くっきり：影と色かぶりを取り、紙を白くします',
    color: 'カラー：撮ったときの色のままです',
    gray: 'グレー：影を取ってグレーにします',
    bw: '白黒：文字がくっきりして、PDF も軽くなります',
  };
  // 撮った写真より細かくはしない（拡大はしない）ので、実際の細かさは写真の大きさで決まる
  const QUALITY = {
    light: { dpi: 120, jpeg: 0.72 },
    standard: { dpi: 200, jpeg: 0.86 },
    high: { dpi: 300, jpeg: 0.92 },
  };
  const SIZE_NOTE = {
    auto: '撮った書類の縦横比のまま',
    a4: 'A4 の用紙に収めて配置',
    b5: 'B5 の用紙に収めて配置',
    letter: 'レターの用紙に収めて配置',
  };
  const A4_LONG_IN = 297 / 25.4;
  const ORIGINAL_MAX = 3200;
  const THUMB_LONG = 420;
  const PREVIEW_LONG = 1600;
  const CORNER_NAMES = ['左上の角', '右上の角', '右下の角', '左下の角'];
  const DETECT_LONG = 480;
  const REFINE_LONG = 1600; // 写真から探すときは、最後にこの解像度で辺を合わせ直す
  // 撮影中の検出の解像度。ふだんは 384、1 回の検出に時間がかかる端末では 320 に下げる（ワーカーで動くので画面は止まらない）
  const LIVE_LONG = 384, LIVE_LONG_SLOW = 320;
  // 撮影中に枠を出す点数の下限。正しく見つけたときはほぼ 0.45 を超え、周りの書類などを誤って囲んだときは下回りやすい
  const SHOW_SCORE = 0.45;
  const LIVE_GAP = 80; // 撮影中の検出は 1 秒に約 12 回まで。端末が熱で遅くならないようにする（枠は描画側でなめらかに動かす）
  const PREVIEW_SIZE = { w: 1920, h: 1440 }; // 撮影画面の映像の大きさ
  const LARGE_SIZE = { w: 4096, h: 3072 }; // 写真として撮れない端末で、撮る瞬間だけ頼む映像の大きさ

  // 書類の形（長辺 / 短辺）。選ぶと、その比の四角形を見つけやすくなり、仕上がりもその比にそろう
  const SHAPES = {
    free: { label: '自由', aspect: null },
    iso: { label: 'A判・B判', aspect: Math.SQRT2 },
    letter: { label: 'レター', aspect: 11 / 8.5 },
    card: { label: '名刺・カード', aspect: 1.62 },
  };

  const LINKS = {
    web: 'https://taniuchi0707.github.io/hyper-scanner/',
    apk: 'https://github.com/taniuchi0707/hyper-scanner/releases/latest/download/hyper-scanner.apk',
  };

  const state = {
    pages: [],
    title: '',
    editor: null,
    camera: null,
    liveCamera: null,
    queue: Promise.resolve(),
    pending: 0,
    exporting: false,
    pdf: null,
    settings: { shape: 'free', autoCapture: false, captureMode: 'live' },
  };

  // claude.ai の Artifact として開いたときは、保存を downloads の仕組みに任せる
  const inViewer = !!(window.claude && typeof window.claude.use === 'function');
  const downloadsCap = inViewer ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);

  // Android アプリ（APK）の中で動いているときは、保存・共有・戻るボタンをアプリに任せる
  const native = (() => {
    try {
      const n = window.HyperScannerNative;
      return n && n.isApp && n.isApp() ? n : null;
    } catch (e) {
      return null;
    }
  })();

  const shapeAspect = () => (SHAPES[state.settings.shape] || SHAPES.free).aspect;

  let BEAM = '#3CC8D4';
  const WARN = '#F0AA3C'; // 書類がはみ出しているときの枠の色
  let overlay = null;

  // ---------- 小さな道具 ----------

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const pad2 = (n) => String(n).padStart(2, '0');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const clamp01 = (v) => clamp(v, 0, 1);
  const fullQuad = () => [[0, 0], [1, 0], [1, 1], [0, 1]];
  const insetQuad = () => { const m = 0.05; return [[m, m], [1 - m, m], [1 - m, 1 - m], [m, 1 - m]]; };
  const byId = (id) => state.pages.find((p) => p.id === id);
  const indexOf = (id) => state.pages.findIndex((p) => p.id === id);
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  const checked = (name) => (document.querySelector(`input[name="${name}"]:checked`) || {}).value;
  const renumber = () => state.pages.forEach((p, i) => { p.order = i; });

  function defaultTitle() {
    const d = new Date();
    return `スキャン ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function formatBytes(n) {
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function safeFileName(s) {
    const t = String(s || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\.pdf$/i, '');
    return t || 'scan';
  }

  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
  }

  // ---------- トースト ----------

  let toastTimer = 0;
  function toast(text, action) {
    const btn = $('toast-action');
    $('toast-text').textContent = text;
    btn.hidden = !action;
    btn.onclick = null;
    if (action) {
      btn.textContent = action.label;
      btn.onclick = () => { hideToast(); action.run(); };
    }
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 6500 : 3200);
  }
  const hideToast = () => { $('toast').hidden = true; };

  // ---------- 一覧 ----------

  function renderPages() {
    // 撮影画面を開いている間は、裏に隠れた一覧を作り直さない（閉じたときにまとめて作る）
    if (state.camera) { state.pagesDirty = true; return; }
    state.pagesDirty = false;
    const frag = document.createDocumentFragment();
    state.pages.forEach((p, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'card-btn';
      btn.dataset.id = p.id;
      btn.setAttribute('aria-label', `${i + 1}ページ目を編集`);
      const frame = document.createElement('span');
      frame.className = 'frame';
      if (p.thumbUrl) {
        const img = document.createElement('img');
        img.src = p.thumbUrl;
        img.alt = '';
        frame.append(img);
      } else {
        const ph = document.createElement('span');
        ph.className = 'pending';
        frame.append(ph);
      }
      if (p.sample) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'サンプル';
        frame.append(badge);
      }
      const meta = document.createElement('span');
      meta.className = 'card-meta';
      meta.innerHTML = `<span class="pno">P.${pad2(i + 1)}</span><span class="ftag">${FILTER_NAMES[p.filter] || ''}</span>`;
      btn.append(frame, meta);
      li.append(btn);
      frag.append(li);
    });
    for (let k = 0; k < state.pending; k++) {
      const li = document.createElement('li');
      li.innerHTML = '<div class="card-btn" aria-hidden="true"><span class="frame"><span class="pending"></span></span><span class="card-meta"><span class="pno">…</span><span class="ftag">補正中</span></span></div>';
      frag.append(li);
    }
    $('page-grid').replaceChildren(frag);

    const n = state.pages.length;
    $('empty').hidden = n + state.pending > 0;
    $('btn-export').disabled = n === 0;
    $('sample-notice').hidden = !state.pages.some((p) => p.sample);
    $('doc-meta').textContent = n ? `${n} ページ` : 'ページなし';
    if (state.camera) updateCamThumb();
  }

  // ---------- ページの追加・置き換え ----------

  function enqueue(task, placeholder = true) {
    if (placeholder) { state.pending++; renderPages(); }
    const run = state.queue
      .then(task)
      .catch((err) => {
        console.error(err);
        toast(err && err.message ? err.message : '画像を処理できませんでした');
        return null;
      })
      .finally(() => {
        if (placeholder) state.pending--;
        renderPages();
      });
    state.queue = run;
    return run;
  }

  // ワーカーが元画像を使い回すための目印（撮り直すと変わる）
  const pageKey = (page) => `${page.id}:${page.rev || 0}`;
  const pageLook = (page) => ({ quad: page.quad, aspect: page.aspect || null, filter: page.filter, rotation: page.rotation || 0 });

  function setThumb(page, blob) {
    page.thumb = blob;
    if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
    page.thumbUrl = URL.createObjectURL(blob);
  }

  async function refreshThumb(page) {
    setThumb(page, await Engine.thumb({ key: pageKey(page), blob: page.original, page: pageLook(page), long: THUMB_LONG }));
  }

  /**
   * 写真をページにする。重い処理（縮小・四隅の検出・サムネイル）はワーカーで行う
   * source: Blob（写真）か ImageBitmap（映像の1コマ）
   * ref: 写真の向きをそろえる手本（映像の1コマを縮めたもの）
   * hint: 撮影画面で見つけていた四隅（同じ縦横比の写真のときだけ、見つからなかった場合の代わりに使う）
   */
  async function addImage(source, { sample = false, replaceId = null, hint = null, ref = null } = {}) {
    const aspect = sample ? Math.SQRT2 : shapeAspect();
    const target = replaceId ? byId(replaceId) : null;
    const r = await Engine.ingest({
      source, ref, hint, aspect,
      maxLong: ORIGINAL_MAX, detectLong: DETECT_LONG, refineLong: REFINE_LONG, thumbLong: THUMB_LONG,
      filter: target ? target.filter : 'enhance', rotation: 0,
    });
    state.pdf = null;

    if (replaceId) {
      const page = byId(replaceId);
      if (!page) return null;
      Object.assign(page, { original: r.original, width: r.width, height: r.height, quad: r.quad, aspect, detected: r.detected, filter: r.filter || page.filter, rotation: 0, rev: (page.rev || 0) + 1 });
      setThumb(page, r.thumb);
      await Store.putPage(page);
      return page;
    }

    if (!sample) await removeSamples();
    const page = {
      id: uid(),
      order: state.pages.length,
      original: r.original,
      width: r.width,
      height: r.height,
      quad: r.quad,
      aspect,
      detected: r.detected,
      filter: r.filter || 'enhance',
      rotation: 0,
      sample,
      createdAt: Date.now(),
    };
    setThumb(page, r.thumb);
    state.pages.push(page);
    renumber();
    await Store.putPage(page);
    return page;
  }

  async function removeSamples() {
    const samples = state.pages.filter((p) => p.sample);
    if (!samples.length) return;
    samples.forEach((p) => p.thumbUrl && URL.revokeObjectURL(p.thumbUrl));
    state.pages = state.pages.filter((p) => !p.sample);
    renumber();
    await Store.deletePages(samples.map((p) => p.id));
    await Store.putPages(state.pages);
    state.pdf = null;
    renderPages();
  }

  function loadSample() {
    return enqueue(async () => addImage(await Sample.create(), { sample: true }));
  }

  function importFiles(files, { fromCamera = false, replaceId = null } = {}) {
    const list = [...files].filter((f) => (f.type || '').startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(f.name || ''));
    if (!list.length) { toast('画像のファイルを選んでください'); return; }
    if (replaceId) { replaceFrom(list[0], replaceId); return; }
    let last = null;
    list.forEach((f) => { last = enqueue(() => addImage(f)); });
    last.then((page) => {
      if (!page) return;
      if (fromCamera && list.length === 1 && !state.editor && !state.camera) {
        openEditor(page.id, 'crop'); // 端末のカメラで撮った直後は、範囲を確かめてもらう
      } else {
        toast(list.length > 1 ? `${list.length}枚の画像を追加しました` : `${indexOf(page.id) + 1}ページ目を追加しました`);
      }
    });
  }

  async function replaceFrom(source, id, hint = null, ref = null) {
    const page = await enqueue(() => addImage(source, { replaceId: id, hint, ref }), false);
    if (page) openEditor(page.id, 'crop');
  }

  // ---------- カメラ ----------

  function liveCameraPossible() {
    if (inViewer) return false;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
    const policy = document.permissionsPolicy || document.featurePolicy;
    if (policy && typeof policy.allowsFeature === 'function' && !policy.allowsFeature('camera')) return false;
    return true;
  }

  // カメラのないパソコンなどでは、最初から端末のファイル選択にする。
  // 一覧が空のとき（許可前の Safari など）は判断せず、押されたときに試す
  async function probeCamera() {
    if (!liveCameraPossible()) { state.liveCamera = false; return; }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (devices.length && !devices.some((d) => d.kind === 'videoinput')) state.liveCamera = false;
    } catch (e) { /* 押されたときに試す */ }
  }

  // 撮影ボタンには透明なファイル選択欄が重ねてあり、押すと端末のカメラアプリが開く。
  // ブラウザの中でカメラが使えるときだけ、その動きを止めて撮影画面を開く
  // 設定で「カメラアプリ」を選んでいるときも、端末のカメラアプリに任せる（いちばん高画質）
  function interceptForLiveCamera(e, replaceId = null) {
    if (state.settings.captureMode === 'app') return;
    if (state.liveCamera === null) state.liveCamera = liveCameraPossible();
    if (!state.liveCamera) return;
    e.preventDefault();
    startLiveCamera(replaceId);
  }

  async function startLiveCamera(replaceId = null) {
    let stream;
    try {
      // 見るための映像は、画面にくっきり映る 4:3 の大きさにとどめる。画質は写真として撮る（capture）。
      // 4096×3072 などの最大の映像は、端末がコマを運ぶだけで重くなり、映像もカクつく
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: PREVIEW_SIZE.w }, height: { ideal: PREVIEW_SIZE.h }, frameRate: { ideal: 30 } },
      });
    } catch (err) {
      state.liveCamera = false;
      toast(err && err.name === 'NotAllowedError'
        ? 'カメラが許可されていません。もう一度押すと、端末のカメラアプリで撮影できます'
        : 'カメラを開けませんでした。もう一度押すと、端末のカメラアプリか画像から追加できます');
      return;
    }
    if (replaceId && state.editor) closeEditor();
    openCamera(stream, replaceId);
  }

  function openCamera(stream, replaceId) {
    const video = $('cam-video');
    const track = stream.getVideoTracks()[0];
    state.camera = {
      stream, track, replaceId,
      quad: null, display: null, score: 0, lastSeen: 0, raf: 0, busy: false, torch: false, added: 0, imageCapture: null, hint: '',
      stableSince: 0, autoLock: null, caps: {}, drawn: '',
    };
    video.srcObject = stream;
    video.play().catch(() => {});
    let caps = {};
    try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch (e) { caps = {}; }
    $('cam-torch').hidden = !caps.torch;
    $('cam-torch').setAttribute('aria-pressed', 'false');
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
      track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
    const cam = state.camera;
    cam.caps = caps;
    if (typeof ImageCapture === 'function') {
      try {
        cam.imageCapture = new ImageCapture(track);
        // 写真として撮るサイズ。動画の1コマよりずっと細かいが、5000 万画素などの巨大な写真は
        // 読み込むだけで重いので、保存する大きさ（長辺 3200）に余裕を持たせた長辺 4096 までにする
        cam.imageCapture.getPhotoCapabilities()
          .then((pc) => {
            if (pc && pc.imageWidth && pc.imageWidth.max) {
              const w = Math.min(pc.imageWidth.max, 4096);
              cam.photoSize = { w, h: Math.round((w * pc.imageHeight.max) / pc.imageWidth.max) };
            }
            // フラッシュは使わない（書類に白い照り返しが出る。光を測るための予備の発光も待たずに済む）
            cam.flashOff = !!(pc && Array.isArray(pc.fillLightMode) && pc.fillLightMode.includes('off'));
            updateCamRes();
          })
          .catch(() => {});
      } catch (e) {
        cam.imageCapture = null;
      }
    }
    video.addEventListener('loadedmetadata', updateCamRes, { once: true });
    video.onresize = () => {
      // 撮る瞬間だけ映像を大きくしたあとも、表示を今の大きさに合わせる
      updateCamRes();
      // 端末を回して縦横が入れ替わったら、前の向きで見つけた枠は捨てて探し直す
      const landscape = video.videoWidth > video.videoHeight;
      if (cam.landscape !== undefined && cam.landscape !== landscape) {
        cam.quad = null; cam.display = null; cam.jump = null; cam.stableSince = 0;
      }
      cam.landscape = landscape;
    };
    $('cam-gallery').hidden = !!replaceId;
    $('cam-shutter').disabled = false;
    $('cam-shutter').classList.remove('busy');
    $('cam-auto').setAttribute('aria-pressed', String(state.settings.autoCapture));
    setShutterProgress(0);
    $('camera').hidden = false;
    // 裏に隠れたページ一覧は描かない（アニメーションや描き直しで撮影を重くしない）
    $('app').classList.add('under-camera');
    updateBars();
    updateCamThumb();
    Engine.warm('live');
    camLoop(cam);
    animateOverlay();
  }

  function closeCamera() {
    const cam = state.camera;
    if (!cam) return;
    cancelAnimationFrame(cam.raf);
    cam.stream.getTracks().forEach((t) => t.stop());
    $('cam-video').srcObject = null;
    state.camera = null;
    $('camera').hidden = true;
    $('app').classList.remove('under-camera');
    if (state.pagesDirty) renderPages();
    updateBars();
    if (cam.added) toast(`${cam.added}ページを追加しました`);
  }

  const quadMove = (a, b) => Math.max(...a.map((p, i) => Math.abs(p[0] - b[i][0]) + Math.abs(p[1] - b[i][1])));

  let shutterP = -1;
  function setShutterProgress(p) {
    const v = Math.round(Math.max(0, Math.min(1, p)) * 100) / 100;
    if (v === shutterP) return;
    shutterP = v;
    $('cam-shutter').style.setProperty('--p', String(v));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 映像の1コマを、長辺 long の大きさに縮めて取り出す（縮めるのは端末の画像処理に任せる）
  async function grabFrame(video, long) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.min(1, long / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * s)), h = Math.max(1, Math.round(vh * s));
    try {
      return s < 1
        ? await createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' })
        : await createImageBitmap(video);
    } catch (e) {
      const c = Imaging.makeCanvas(w, h);
      c.getContext('2d').drawImage(video, 0, 0, w, h);
      try { return await createImageBitmap(c); } catch (e2) { return null; }
    }
  }

  // 撮影中の検出に渡す映像のコマ。VideoFrame は今のコマを指すだけで複製しないので、画面側はほぼ止まらない
  // （縮めるのはワーカーの中）。createImageBitmap で縮めると、元の大きさのまま色に直す処理が画面側で走って重い
  function liveFrame(video, direct, long) {
    if (direct) {
      try { return new VideoFrame(video); } catch (e) { /* 下で取り出す */ }
    }
    return grabFrame(video, long);
  }

  // 書類の検出を続ける。検出はワーカーで行うので、映像や操作は止まらない。
  // 自動撮影がオンなら、枠が止まってから少し待ってシャッターを切る
  async function camLoop(cam) {
    const video = $('cam-video');
    const useWorker = await Engine.available();
    let direct = useWorker && typeof VideoFrame === 'function';
    let directFails = 0;
    while (state.camera === cam) {
      // 撮影中（写真の処理でカメラが止まっている間）は調べない
      if (document.hidden || cam.busy || video.readyState < 2 || !video.videoWidth) { await sleep(100); continue; }
      const started = performance.now();
      const long = cam.slow ? LIVE_LONG_SLOW : LIVE_LONG;
      // 書類を見つけ続けている間は、4 回に 3 回は直前の位置を確かめるだけにして軽くする（4 回に 1 回は画面全体を探す）。
      // 別の場所の候補が出ているときは、それを確かめるため画面全体を探す
      cam.frames = (cam.frames || 0) + 1;
      const track = !!cam.quad && !cam.jump && cam.frames % 4 !== 0;
      const frame = await liveFrame(video, direct, long);
      let found = null;
      if (frame) {
        try {
          found = await Engine.detectLive(frame, { long, aspect: shapeAspect(), prior: cam.quad, quick: true, track });
          directFails = 0;
        } catch (e) {
          found = null;
          // VideoFrame をワーカーに渡せない環境では、映像のコマを縮めて渡す方法に切り替える
          if (direct && ++directFails >= 2) direct = false;
        } finally {
          frame.close(); // ワーカーに渡したあとなら何もしない
        }
      }
      if (state.camera !== cam) return;
      onDetected(cam, found);
      // 遅い端末では、かかった時間の半分は休ませて、ワーカーが CPU を使い切らないようにする。
      // 枠が止まっている間は間隔を倍にする（構えて待つ間の電池と発熱を抑える）
      const spent = performance.now() - started;
      // かかった時間をならして見て、遅い端末では解像度を下げる（速くなれば戻す）
      cam.spent = cam.spent ? cam.spent * 0.8 + spent * 0.2 : spent;
      if (!cam.slow && cam.spent > 140) cam.slow = true;
      else if (cam.slow && cam.spent < 70) cam.slow = false;
      // 撮った写真を取り込んでいる間も倍にする（取り込みのワーカーと CPU を取り合って、映像がカクつかないように）
      const gap = LIVE_GAP * (cam.stableSince ? 2 : 1) * (state.pending > 0 ? 2 : 1);
      await sleep(useWorker ? Math.max(gap - spent, spent * 0.5, 10) : Math.max(120, spent * 2));
    }
  }

  function onDetected(cam, found) {
    const now = performance.now();
    if (found && found.score >= SHOW_SCORE && cam.quad && quadMove(cam.quad, found.quad) >= 0.08 && now - cam.lastSeen < 900) {
      // 別の場所へ大きく飛んだときは、続けて同じあたりに見つかるまで前の枠を残す（枠が行き来してちらつかないように）
      const same = cam.jump && quadMove(cam.jump, found.quad) < 0.05;
      cam.jump = found.quad;
      if (!same) { found = null; cam.stableSince = 0; }
    } else {
      cam.jump = null;
    }
    if (found && found.score >= SHOW_SCORE) {
      const q = found.quad;
      const prev = cam.quad;
      const moved = prev ? quadMove(prev, q) : 1;
      // 枠の描画でもなめらかにするので、ここでは軽くならすだけにする
      cam.quad = prev && moved < 0.08 ? prev.map((p, i) => [p[0] * 0.4 + q[i][0] * 0.6, p[1] * 0.4 + q[i][1] * 0.6]) : q;
      cam.score = found.score;
      cam.lastSeen = now;
      if (moved < 0.015 && found.score >= 0.6) {
        if (!cam.stableSince) cam.stableSince = now;
      } else {
        cam.stableSince = 0;
      }
      // 撮ったあとは、書類を動かすか入れ替えるまで次の自動撮影をしない
      if (cam.autoLock && quadMove(cam.autoLock, cam.quad) > 0.1) cam.autoLock = null;
    } else if (now - cam.lastSeen > 900) {
      cam.quad = null;
      cam.stableSince = 0;
      cam.autoLock = null;
    }
    // 書類のふちが画面の外に出ているときは知らせ、自動では撮らない（切れたまま撮らないように）
    cam.clipped = !!cam.quad && cam.quad.some(([x, y]) => x < 0.012 || y < 0.012 || x > 0.988 || y > 0.988);
    cam.small = !!cam.quad && Geo.area(cam.quad) < 0.1;

    const AUTO_WAIT = 1100;
    if (state.settings.autoCapture && cam.quad && cam.stableSince && !cam.autoLock && !cam.busy && !cam.clipped) {
      const p = (now - cam.stableSince) / AUTO_WAIT;
      setShutterProgress(p);
      if (p >= 1) {
        cam.autoLock = cam.quad.map((pt) => pt.slice());
        cam.stableSince = 0;
        setShutterProgress(0);
        capture();
      }
    } else {
      setShutterProgress(0);
    }
  }

  // 枠は画面の書き換えごとに、検出した位置へなめらかに近づけて描く（検出の回数より滑らかに見える）
  function animateOverlay() {
    const cam = state.camera;
    if (!cam) return;
    if (cam.quad) {
      cam.display = cam.display
        ? cam.display.map((p, i) => [p[0] + (cam.quad[i][0] - p[0]) * 0.35, p[1] + (cam.quad[i][1] - p[1]) * 0.35])
        : cam.quad.map((p) => p.slice());
    } else {
      cam.display = null;
    }
    drawCamOverlay();
    cam.raf = requestAnimationFrame(animateOverlay);
  }

  function setCamHint(text, found) {
    const cam = state.camera;
    if (cam.hint === text) return;
    cam.hint = text;
    $('cam-hint').textContent = text;
    $('cam-hint').classList.toggle('found', found);
  }

  function drawCamOverlay() {
    const cam = state.camera;
    const canvas = $('cam-overlay');
    const video = $('cam-video');
    const r = { width: canvas.clientWidth, height: canvas.clientHeight };
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = vw && vh ? Math.min(r.width / vw, r.height / vh) : 0;
    const dw = vw * s, dh = vh * s, ox = (r.width - dw) / 2, oy = (r.height - dh) / 2;
    const pts = cam.display ? cam.display.map(([x, y]) => [ox + x * dw, oy + y * dh]) : null;
    // 前と同じ絵になるときは描き直さない（枠が止まっている間は何もしない）
    const key = [W, H, dw, dh, ox, oy, state.settings.autoCapture, !!cam.autoLock, !!cam.clipped, !!cam.small, pts ? pts.flat().map((v) => Math.round(v * 4)) : '']
      .map((v) => (typeof v === 'number' ? Math.round(v) : String(v))).join('|');
    if (key === cam.drawn) return;
    cam.drawn = key;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    if (!s) return;

    if (pts) {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      const color = cam.clipped ? WARN : BEAM;
      ctx.fillStyle = cam.clipped ? 'rgba(240, 170, 60, .16)' : 'rgba(60, 200, 212, .16)';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.fillStyle = color;
      pts.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); });
      if (cam.clipped) setCamHint('書類のふちが画面からはみ出しています。少し離してください', false);
      else if (cam.small) setCamHint('もう少し近づくと、文字がくっきり撮れます', true);
      else setCamHint(state.settings.autoCapture && !cam.autoLock ? '書類を見つけました。そのまま動かさずに待つと撮影します' : '書類を見つけました。そのまま撮影できます', true);
    } else {
      // 書類を探している間はトンボの枠を出す
      const m = 0.07;
      const x0 = ox + dw * m, y0 = oy + dh * m, x1 = ox + dw * (1 - m), y1 = oy + dh * (1 - m);
      const L = Math.min(dw, dh) * 0.08;
      ctx.strokeStyle = 'rgba(232, 238, 240, .8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      [[x0, y0, 1, 1], [x1, y0, -1, 1], [x1, y1, -1, -1], [x0, y1, 1, -1]].forEach(([x, y, sx, sy]) => {
        ctx.moveTo(x + sx * L, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + sy * L);
      });
      ctx.stroke();
      setCamHint(cam.replaceId ? '撮り直すページを枠に収めてください' : '書類の四隅が入るように構えてください', false);
    }
  }

  async function capture() {
    const cam = state.camera;
    const video = $('cam-video');
    if (!cam || cam.busy || !video.videoWidth) return;
    cam.busy = true;
    $('cam-shutter').classList.add('busy'); // 写真の処理中はシャッターの周りを回す（映像が一瞬止まっても、撮影中だとわかるように）
    $('cam-shutter').disabled = true;
    const flash = $('cam-flash');
    flash.classList.remove('on');
    void flash.offsetWidth;
    flash.classList.add('on');

    // まず映像の1コマを確保し、撮影 API が使えればより高解像度の写真に差し替える。
    // 縮小・向きの補正・四隅の検出などの重い処理は、ワーカーにまとめて任せる
    const hint = cam.quad ? { quad: cam.quad.map((p) => p.slice()), ratio: video.videoWidth / video.videoHeight } : null;
    const frame = await grabFrame(video, Infinity);
    let source = frame, ref = null;
    let photo = null;
    if (cam.imageCapture && !cam.torch && !cam.photoFailed) {
      try {
        const settings = cam.photoSize ? { imageWidth: cam.photoSize.w, imageHeight: cam.photoSize.h } : {};
        if (cam.flashOff) settings.fillLightMode = 'off';
        photo = await withTimeout(cam.imageCapture.takePhoto(settings), 4000);
      } catch (e) {
        cam.photoFailed = true; // 次からは待たずに、撮る瞬間だけ大きくした映像で撮る
        updateCamRes();
      }
    }
    if (photo) {
      // 端末によっては写真が横倒しで返るので、映像の向きを手本にしてワーカーで回す（手本を縮めるのもワーカーで）
      ref = frame;
      source = photo;
    } else {
      const large = await grabLarge(cam, video);
      if (large) {
        if (frame) frame.close();
        source = large;
      }
    }
    cam.busy = false;
    $('cam-shutter').classList.remove('busy');
    if (state.camera === cam) $('cam-shutter').disabled = false;
    if (!source) { toast('撮影できませんでした。もう一度押してください'); return; }

    if (cam.replaceId) {
      cam.added = 0;
      closeCamera();
      replaceFrom(source, cam.replaceId, hint, ref);
      return;
    }
    cam.added++;
    enqueue(() => addImage(source, { hint, ref }));
    updateCamThumb();
  }

  // 写真として撮れない端末（iPhone など）やライトを点けているときは、撮る瞬間だけ映像を大きくして1コマを撮る。
  // ふだんの映像は軽い大きさのままにしておける。大きくできなければ null（今の映像の1コマを使う）
  async function grabLarge(cam, video) {
    const track = cam.track;
    const caps = cam.caps || {};
    const cur = Math.max(video.videoWidth, video.videoHeight);
    const most = Math.max((caps.width && caps.width.max) || 0, (caps.height && caps.height.max) || 0);
    if (most < cur * 1.25 || typeof track.applyConstraints !== 'function') return null;
    // 元の頼み方に戻すため。取れない端末では、撮影画面の映像の大きさを頼み直す（空のまま戻すと 640×480 になる）
    let base = track.getConstraints ? track.getConstraints() : {};
    if (!base || !base.width) base = { ...(base || {}), width: { ideal: PREVIEW_SIZE.w }, height: { ideal: PREVIEW_SIZE.h } };
    try {
      await track.applyConstraints({ ...base, width: { ideal: LARGE_SIZE.w }, height: { ideal: LARGE_SIZE.h } });
      if (!(await videoGrows(video, cur, 2500))) return null;
      await sleep(300); // 明るさとピントが落ち着くのを待つ
      cam.largeSize = { w: video.videoWidth, h: video.videoHeight };
      return await grabFrame(video, Infinity);
    } catch (e) {
      return null;
    } finally {
      try { await track.applyConstraints(base); } catch (e) { /* 大きいまま続ける */ }
      if (cam.torch) track.applyConstraints({ advanced: [{ torch: true }] }).catch(() => {});
      updateCamRes();
    }
  }

  // 映像が cur より大きくなるのを待つ
  function videoGrows(video, cur, ms) {
    const grown = () => Math.max(video.videoWidth, video.videoHeight) > cur;
    if (grown()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); video.removeEventListener('resize', check); resolve(grown()); };
      const check = () => { if (grown()) done(); };
      const timer = setTimeout(done, ms);
      video.addEventListener('resize', check);
    });
  }

  // 撮影画面の上に、映像と写真の大きさを小さく出す（画質の目安）
  function updateCamRes() {
    const cam = state.camera;
    if (!cam) return;
    const video = $('cam-video');
    const parts = [];
    if (video.videoWidth) parts.push(`映像 ${video.videoWidth}×${video.videoHeight}`);
    if (cam.photoSize && !cam.photoFailed) parts.push(`写真 ${cam.photoSize.w}×${cam.photoSize.h}`);
    else if (cam.largeSize) parts.push(`撮影 ${cam.largeSize.w}×${cam.largeSize.h}`);
    $('cam-res').textContent = parts.join(' ・ ');
  }

  function toggleAutoCapture() {
    state.settings.autoCapture = !state.settings.autoCapture;
    $('cam-auto').setAttribute('aria-pressed', String(state.settings.autoCapture));
    $('set-auto').checked = state.settings.autoCapture;
    if (state.camera) { state.camera.autoLock = null; state.camera.hint = ''; }
    saveSettings();
    toast(state.settings.autoCapture ? '自動撮影をオンにしました' : '自動撮影をオフにしました');
  }

  function updateCamThumb() {
    const cam = state.camera;
    if (!cam) return;
    const last = state.pages[state.pages.length - 1];
    $('cam-thumb').style.backgroundImage = cam.added && last && last.thumbUrl ? `url("${last.thumbUrl}")` : 'none';
    $('cam-count').textContent = cam.added ? `完了（${cam.added}）` : '完了';
  }

  async function toggleTorch() {
    const cam = state.camera;
    if (!cam) return;
    const on = !cam.torch;
    try {
      await cam.track.applyConstraints({ advanced: [{ torch: on }] });
      cam.torch = on;
      $('cam-torch').setAttribute('aria-pressed', String(on));
    } catch (e) {
      toast('ライトを切り替えられませんでした');
    }
  }

  // ---------- ページの編集 ----------

  const SVGNS = 'http://www.w3.org/2000/svg';

  function buildOverlay() {
    const svg = $('ed-overlay');
    const el = (tag, attrs) => {
      const e = document.createElementNS(SVGNS, tag);
      Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
      return e;
    };
    const shade = el('path', { class: 'shade' });
    const edge = el('polygon', { class: 'edge' });
    svg.replaceChildren(shade, edge);
    const handles = CORNER_NAMES.map((name, i) => {
      const g = el('g', { class: 'handle', tabindex: '0', role: 'button', 'aria-label': `${name}（矢印キーで動かせます）`, 'data-i': String(i) });
      g.append(el('circle', { class: 'hit', r: '24' }), el('circle', { class: 'ring', r: '11' }), el('circle', { class: 'dot', r: '2.5' }));
      svg.append(g);
      return g;
    });
    return { shade, edge, handles };
  }

  function showEdBusy(on) { $('ed-busy').hidden = !on; }

  async function openEditor(id, mode = 'crop') {
    const page = byId(id);
    if (!page || state.editor) return;
    $('editor').hidden = false;
    showEdBusy(true);
    let bmp;
    try {
      bmp = await Imaging.decode(page.original);
    } catch (err) {
      $('editor').hidden = true;
      showEdBusy(false);
      toast('このページの画像を読み込めませんでした');
      return;
    }
    state.editor = {
      id,
      bmp,
      key: pageKey(page),
      blob: page.original,
      quad: page.quad.map((p) => p.slice()),
      filter: page.filter,
      rotation: page.rotation || 0,
      aspect: page.aspect || null,
      detected: page.detected !== false,
      mode,
      drag: null,
      token: 0,
      view: null,
    };
    showEdBusy(false);
    updateBars();
    updateEditorHeader();
    setEditorMode(mode);
    if (mode === 'crop' && !state.editor.detected) toast('四隅を見つけられませんでした。角の丸を書類の角に合わせてください');
  }

  function closeEditor() {
    const ed = state.editor;
    if (!ed) return;
    if (ed.bmp && typeof ed.bmp.close === 'function') ed.bmp.close();
    state.editor = null;
    $('editor').hidden = true;
    $('ed-loupe').hidden = true;
    showEdBusy(false);
    updateBars();
  }

  function updateEditorHeader() {
    const ed = state.editor;
    const i = indexOf(ed.id), n = state.pages.length;
    $('ed-pno').textContent = `P.${pad2(i + 1)}`;
    $('ed-of').textContent = `/ ${pad2(n)}`;
    $('ed-prev').disabled = i <= 0;
    $('ed-next').disabled = i >= n - 1;
  }

  function setEditorMode(mode) {
    const ed = state.editor;
    if (mode === 'finish' && !quadUsable(ed.quad)) {
      toast('四隅の位置を確かめてください');
      mode = 'crop';
    }
    ed.mode = mode;
    $('ed-tab-crop').setAttribute('aria-selected', String(mode === 'crop'));
    $('ed-tab-finish').setAttribute('aria-selected', String(mode === 'finish'));
    $('ed-tools-crop').hidden = mode !== 'crop';
    $('ed-tools-finish').hidden = mode !== 'finish';
    $('ed-overlay').toggleAttribute('hidden', mode !== 'crop');
    updateFilterChips();
    if (mode === 'crop') {
      ed.token++; // 作りかけの仕上がりは捨てる
      showEdBusy(false);
      layoutCrop();
    } else {
      renderFinish();
    }
  }

  function quadUsable(quad) {
    const q = Geo.orderQuad(quad);
    return Geo.isConvex(q) && Geo.area(q) > 0.01;
  }

  function fitRect(iw, ih, pad = 22) {
    const st = $('ed-stage');
    const w = st.clientWidth, h = st.clientHeight;
    const s = Math.max(0.01, Math.min((w - pad * 2) / iw, (h - pad * 2) / ih));
    const dw = iw * s, dh = ih * s;
    return { left: (w - dw) / 2, top: (h - dh) / 2, dw, dh, s };
  }

  function place(el, r) {
    el.style.left = `${r.left}px`;
    el.style.top = `${r.top}px`;
    el.style.width = `${r.dw}px`;
    el.style.height = `${r.dh}px`;
  }

  function layoutCrop() {
    const ed = state.editor;
    const { w: iw, h: ih } = Imaging.sizeOf(ed.bmp);
    const r = fitRect(iw, ih);
    ed.view = r;
    const c = $('ed-canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(r.dw * dpr));
    c.height = Math.max(1, Math.round(r.dh * dpr));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(ed.bmp, 0, 0, c.width, c.height);
    place(c, r);
    const svg = $('ed-overlay');
    place(svg, r);
    svg.setAttribute('viewBox', `0 0 ${r.dw} ${r.dh}`);
    drawQuad();
    updateCropInfo();
  }

  function drawQuad() {
    const ed = state.editor;
    if (!ed || !ed.view) return;
    const { dw, dh } = ed.view;
    const pts = ed.quad.map(([x, y]) => [x * dw, y * dh]);
    overlay.edge.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
    overlay.shade.setAttribute('d', `M0 0H${dw}V${dh}H0Z M${pts.map((p) => p.join(' ')).join(' L')} Z`);
    overlay.handles.forEach((g, i) => {
      g.setAttribute('transform', `translate(${pts[i][0]} ${pts[i][1]})`);
      g.classList.toggle('active', !!ed.drag && ed.drag.i === i);
    });
  }

  // 仕上がりの大きさと縦横比、A4 に印刷したときの細かさ
  function updateCropInfo() {
    const ed = state.editor;
    if (!quadUsable(ed.quad)) { $('ed-info').textContent = '四隅の位置を確かめてください'; return; }
    const { w, h, ratio } = Imaging.outputSize(ed.bmp, Geo.orderQuad(ed.quad), ORIGINAL_MAX, ed.aspect);
    const long = Math.max(ratio, 1 / ratio);
    const named = Object.values(SHAPES).find((s) => s.aspect && Math.abs(Math.log(long / s.aspect)) < 0.01);
    const dpi = Math.round(Math.max(w, h) / A4_LONG_IN);
    $('ed-info').textContent = `${w}×${h} px ・ 1:${long.toFixed(2)}${named ? ` ${named.label}` : ''} ・ A4換算 ${dpi} dpi`;
  }

  function localPoint(e) {
    const r = $('ed-overlay').getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onStageDown(e) {
    const ed = state.editor;
    if (!ed || ed.mode !== 'crop' || !ed.view) return;
    const p = localPoint(e);
    let best = -1, bestD = 44;
    ed.quad.forEach(([x, y], i) => {
      const d = Math.hypot(x * ed.view.dw - p.x, y * ed.view.dh - p.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0) return;
    e.preventDefault();
    $('ed-stage').setPointerCapture(e.pointerId);
    ed.drag = { i: best, id: e.pointerId, ox: ed.quad[best][0] * ed.view.dw - p.x, oy: ed.quad[best][1] * ed.view.dh - p.y };
    drawQuad();
    drawLoupe(e);
  }

  function onStageMove(e) {
    const ed = state.editor;
    if (!ed || !ed.drag || e.pointerId !== ed.drag.id) return;
    const p = localPoint(e);
    ed.quad[ed.drag.i] = [clamp01((p.x + ed.drag.ox) / ed.view.dw), clamp01((p.y + ed.drag.oy) / ed.view.dh)];
    drawQuad();
    drawLoupe(e);
  }

  function onStageUp(e) {
    const ed = state.editor;
    if (!ed || !ed.drag || e.pointerId !== ed.drag.id) return;
    ed.drag = null;
    $('ed-loupe').hidden = true;
    drawQuad();
    updateCropInfo();
  }

  // 指で隠れる角を、指の上に拡大して見せる
  function drawLoupe(e) {
    const ed = state.editor;
    const loupe = $('ed-loupe');
    const size = 120;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (loupe.width !== size * dpr) { loupe.width = size * dpr; loupe.height = size * dpr; }
    const { w: iw, h: ih } = Imaging.sizeOf(ed.bmp);
    const i = ed.drag.i;
    const [qx, qy] = ed.quad[i];
    const span = size / (ed.view.s * 3);
    const sx = qx * iw - span / 2, sy = qy * ih - span / 2;
    const k = size / span;
    const ctx = loupe.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#0C1114';
    ctx.fillRect(0, 0, size, size);
    const x0 = Math.max(0, sx), y0 = Math.max(0, sy);
    const x1 = Math.min(iw, sx + span), y1 = Math.min(ih, sy + span);
    if (x1 > x0 && y1 > y0) ctx.drawImage(ed.bmp, x0, y0, x1 - x0, y1 - y0, (x0 - sx) * k, (y0 - sy) * k, (x1 - x0) * k, (y1 - y0) * k);
    // となりの角へ向かう辺
    ctx.strokeStyle = BEAM;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    [ed.quad[(i + 3) % 4], ed.quad[(i + 1) % 4]].forEach(([nx, ny]) => {
      ctx.moveTo(size / 2, size / 2);
      ctx.lineTo((nx * iw - sx) * k, (ny * ih - sy) * k);
    });
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.beginPath();
    ctx.moveTo(size / 2 - 10, size / 2); ctx.lineTo(size / 2 + 10, size / 2);
    ctx.moveTo(size / 2, size / 2 - 10); ctx.lineTo(size / 2, size / 2 + 10);
    ctx.stroke();
    ctx.restore();

    const st = $('ed-stage').getBoundingClientRect();
    let left = e.clientX - st.left - size / 2;
    let top = e.clientY - st.top - size - 56;
    if (top < 8) top = e.clientY - st.top + 56;
    left = clamp(left, 8, st.width - size - 8);
    loupe.style.left = `${left}px`;
    loupe.style.top = `${top}px`;
    loupe.hidden = false;
  }

  function onHandleKey(e) {
    const g = e.target.closest && e.target.closest('.handle');
    const ed = state.editor;
    if (!g || !ed) return;
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    const i = Number(g.dataset.i);
    const step = e.shiftKey ? 0.02 : 0.004;
    ed.quad[i] = [clamp01(ed.quad[i][0] + d[0] * step), clamp01(ed.quad[i][1] + d[1] * step)];
    drawQuad();
    updateCropInfo();
  }

  async function renderFinish() {
    const ed = state.editor;
    ed.quad = Geo.orderQuad(ed.quad);
    const token = ++ed.token;
    const stale = () => state.editor !== ed || ed.token !== token || ed.mode !== 'finish';
    showEdBusy(true);
    // 補正とフィルターはワーカーで作る（四隅が同じなら、補正はワーカーが使い回す）
    let out;
    try {
      out = await Engine.preview({
        key: ed.key, blob: ed.blob, quad: ed.quad, aspect: ed.aspect,
        filter: ed.filter, rotation: ed.rotation, maxLong: PREVIEW_LONG,
      });
    } catch (err) {
      if (!stale()) { showEdBusy(false); toast('仕上がりを作れませんでした'); }
      return;
    }
    if (stale()) { out.close(); return; }
    showEdBusy(false);
    const c = $('ed-canvas');
    c.width = out.width;
    c.height = out.height;
    c.getContext('2d').drawImage(out, 0, 0);
    place(c, fitRect(out.width, out.height));
    out.close();
    $('ed-info').textContent = FILTER_HINT[ed.filter] || '';
  }

  function relayoutEditor() {
    const ed = state.editor;
    if (!ed) return;
    if (ed.mode === 'crop') layoutCrop();
    else {
      const c = $('ed-canvas');
      place(c, fitRect(c.width, c.height));
    }
  }

  function updateFilterChips() {
    const ed = state.editor;
    document.querySelectorAll('#ed-filters [data-filter]').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.filter === ed.filter));
    });
  }

  async function commitEditor() {
    const ed = state.editor;
    if (!ed || ed.committing) return;
    const page = byId(ed.id);
    if (!page) { closeEditor(); return; }
    if (!quadUsable(ed.quad)) {
      if (ed.mode !== 'crop') setEditorMode('crop');
      toast('四隅の位置を確かめてください');
      return;
    }
    ed.quad = Geo.orderQuad(ed.quad);
    const changed = JSON.stringify(ed.quad) !== JSON.stringify(page.quad)
      || ed.filter !== page.filter
      || ed.rotation !== (page.rotation || 0);
    if (changed) {
      ed.committing = true;
      showEdBusy(true);
      await nextFrame();
      Object.assign(page, { quad: ed.quad, filter: ed.filter, rotation: ed.rotation, detected: true });
      await refreshThumb(page);
      await Store.putPage(page);
      state.pdf = null;
    }
    closeEditor();
    renderPages();
  }

  async function deletePage(id) {
    const idx = indexOf(id);
    if (idx < 0) return;
    const [page] = state.pages.splice(idx, 1);
    renumber();
    await Store.deletePages([id]);
    await Store.putPages(state.pages);
    state.pdf = null;
    renderPages();
    toast(`${idx + 1}ページ目を削除しました`, {
      label: '元に戻す',
      run: async () => {
        state.pages.splice(Math.min(idx, state.pages.length), 0, page);
        renumber();
        await Store.putPages(state.pages);
        state.pdf = null;
        renderPages();
      },
    });
  }

  async function movePage(id, delta) {
    const i = indexOf(id), j = i + delta;
    if (i < 0 || j < 0 || j >= state.pages.length) return;
    [state.pages[i], state.pages[j]] = [state.pages[j], state.pages[i]];
    renumber();
    await Store.putPages([state.pages[i], state.pages[j]]);
    state.pdf = null;
    renderPages();
    if (state.editor) updateEditorHeader();
  }

  // ---------- シート（PDF・メニュー） ----------

  function openSheet(id) {
    closeSheets();
    $('backdrop').hidden = false;
    $(id).hidden = false;
  }

  function closeSheets() {
    if (state.exporting) return;
    $('backdrop').hidden = true;
    $('sheet-export').hidden = true;
    $('sheet-menu').hidden = true;
  }

  function canShareFiles() {
    if (native) return true;
    if (inViewer || !navigator.share || !navigator.canShare) return false;
    try {
      return navigator.canShare({ files: [new File([new Uint8Array(1)], 'scan.pdf', { type: 'application/pdf' })] });
    } catch (e) {
      return false;
    }
  }

  function updateExportNote() {
    const q = QUALITY[checked('exp-quality')] || QUALITY.standard;
    const n = state.pages.length;
    $('exp-note').textContent = `${n} ページ ・ ${SIZE_NOTE[checked('exp-size')] || ''} ・ A4換算 ${q.dpi} dpi`;
  }

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem('hyper-scanner:export') || '{}');
      const size = document.querySelector(`input[name="exp-size"][value="${p.size}"]`);
      const quality = document.querySelector(`input[name="exp-quality"][value="${p.quality}"]`);
      if (size) size.checked = true;
      if (quality) quality.checked = true;
    } catch (e) { /* 既定のまま */ }
  }

  function savePrefs() {
    try {
      localStorage.setItem('hyper-scanner:export', JSON.stringify({ size: checked('exp-size'), quality: checked('exp-quality') }));
    } catch (e) { /* 保存できなくても使える */ }
  }

  function openExport() {
    if (!state.pages.length) return;
    $('exp-name').value = safeFileName(state.title);
    $('exp-progress').hidden = true;
    $('exp-share').hidden = !canShareFiles();
    updateExportNote();
    openSheet('sheet-export');
  }

  function setExportBusy(on) {
    document.querySelectorAll('#sheet-export input, #sheet-export button').forEach((el) => { el.disabled = on; });
    if (on) $('exp-progress').hidden = false;
  }

  function exportProgress(done, total, text) {
    $('exp-bar').style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
    $('exp-status').textContent = text;
  }

  function exportKey() {
    return JSON.stringify([checked('exp-size'), checked('exp-quality'), state.title, state.pages.map((p) => [p.id, p.quad, p.filter, p.rotation, p.aspect, p.original.size])]);
  }

  async function makePdf() {
    const name = `${safeFileName($('exp-name').value)}.pdf`;
    const key = exportKey();
    if (state.pdf && state.pdf.key === key) return { blob: state.pdf.blob, name };
    const size = checked('exp-size');
    const Q = QUALITY[checked('exp-quality')] || QUALITY.standard;
    const maxLong = Math.round(Q.dpi * A4_LONG_IN);
    const pages = state.pages.slice();
    const n = pages.length;
    state.exporting = true;
    setExportBusy(true);
    try {
      const out = [];
      for (let i = 0; i < n; i++) {
        exportProgress(i, n, `${i + 1} / ${n} ページを補正しています`);
        const p = pages[i];
        // 補正・フィルター・画像の圧縮はワーカーで行う（画面は固まらない）
        const img = await Engine.render({ blob: p.original, page: pageLook(p), maxLong, bitonal: p.filter === 'bw', quality: Q.jpeg });
        out.push({ ...img, ...Pdf.layout(img.width, img.height, size) });
      }
      exportProgress(n, n, 'PDF を組み立てています');
      const blob = Pdf.build(out, { title: state.title });
      state.pdf = { key, blob };
      exportProgress(n, n, `PDF ができました（${formatBytes(blob.size)}）`);
      return { blob, name };
    } finally {
      state.exporting = false;
      setExportBusy(false);
    }
  }

  async function savePdf() {
    savePrefs();
    let result;
    try {
      result = await makePdf();
    } catch (err) {
      console.error(err);
      toast('PDF を作れませんでした。画質を下げるか、ページを減らして試してください');
      return;
    }
    const { blob, name } = result;
    if (native) {
      const status = await sendToNative(blob, name, 'save');
      if (status === 'saved') {
        closeSheets();
        toast(`ダウンロード/Hyper Scanner に保存しました（${formatBytes(blob.size)}）`, { label: '開く', run: () => native.openSaved() });
      } else {
        toast('保存できませんでした。端末の空き容量を確かめてください');
      }
      return;
    }
    const dl = await downloadsCap;
    if (dl) {
      try {
        await dl.save({ filename: name, data: blob });
        closeSheets();
        toast(`${name}（${formatBytes(blob.size)}）を保存しました`);
      } catch (err) {
        const code = err && err.code;
        if (code === 'declined') toast('保存を取りやめました');
        else if (code === 'rate_limited') toast('保存の確認がまだ開いています。少し待ってからもう一度押してください');
        else toast('この画面ではファイルを保存できませんでした');
      }
      return;
    }
    if (inViewer) { toast('この画面ではファイルを保存できませんでした'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    closeSheets();
    toast(`${name}（${formatBytes(blob.size)}）を保存しました`);
  }

  // Android アプリへ PDF を渡す。大きなファイルでも詰まらないよう、base64 の切れ端に分けて送る
  async function sendToNative(blob, name, action) {
    try {
      if (!native.beginFile()) return 'error';
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const CHUNK = 3 * 131072; // 3 の倍数にすると、切れ端ごとに base64 を戻せる
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const part = bytes.subarray(i, i + CHUNK);
        let bin = '';
        for (let j = 0; j < part.length; j += 0x8000) bin += String.fromCharCode.apply(null, part.subarray(j, j + 0x8000));
        if (!native.appendChunk(btoa(bin))) return 'error';
        await sleep(0); // 画面が裏に回っても止まらないよう、描画ではなくタイマーで区切る
      }
      return native.finishFile(name, action);
    } catch (err) {
      console.error(err);
      return 'error';
    }
  }

  async function sharePdf() {
    savePrefs();
    const wasReady = !!(state.pdf && state.pdf.key === exportKey());
    let result;
    try {
      result = await makePdf();
    } catch (err) {
      console.error(err);
      toast('PDF を作れませんでした。画質を下げるか、ページを減らして試してください');
      return;
    }
    if (native) {
      const status = await sendToNative(result.blob, result.name, 'share');
      if (status === 'shared') closeSheets();
      else toast('共有できませんでした。「PDFを保存」をお使いください');
      return;
    }
    // 作るのに時間がかかると共有の許可が切れるので、もう一度押してもらう
    const activation = navigator.userActivation;
    if (!wasReady && activation && !activation.isActive) {
      $('exp-status').textContent = 'PDF ができました。もう一度「共有」を押してください';
      return;
    }
    try {
      const file = new File([result.blob], result.name, { type: 'application/pdf' });
      await navigator.share({ files: [file], title: state.title });
      closeSheets();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      toast('共有できませんでした。「PDFを保存」をお使いください');
    }
  }

  async function newDocument() {
    const old = state.pages.slice();
    const oldTitle = state.title;
    state.pages = [];
    state.title = defaultTitle();
    $('doc-title').value = state.title;
    state.pdf = null;
    await Store.deletePages(old.map((p) => p.id));
    await Store.setMeta('title', state.title);
    closeSheets();
    renderPages();
    if (!old.length) return;
    toast('新しい書類にしました', {
      label: '元に戻す',
      run: async () => {
        state.pages = old.concat(state.pages);
        renumber();
        state.title = oldTitle;
        $('doc-title').value = oldTitle;
        await Store.putPages(state.pages);
        await Store.setMeta('title', oldTitle);
        state.pdf = null;
        renderPages();
      },
    });
  }

  // ---------- 設定 ----------

  async function loadSettings() {
    const s = await Store.getMeta('settings');
    if (s && typeof s === 'object') {
      if (SHAPES[s.shape]) state.settings.shape = s.shape;
      state.settings.autoCapture = !!s.autoCapture;
      if (s.captureMode === 'app' || s.captureMode === 'live') state.settings.captureMode = s.captureMode;
    }
    const radio = document.querySelector(`input[name="set-shape"][value="${state.settings.shape}"]`);
    if (radio) radio.checked = true;
    const mode = document.querySelector(`input[name="set-capture"][value="${state.settings.captureMode}"]`);
    if (mode) mode.checked = true;
    $('set-auto').checked = state.settings.autoCapture;
  }

  function saveSettings() {
    Store.setMeta('settings', { ...state.settings });
  }

  // ---------- Android アプリとのやりとり ----------

  // ステータスバーの色を画面に合わせる（撮影・編集中は暗く）
  function updateBars() {
    if (!native || !native.setBars) return;
    const stage = !!(state.camera || state.editor);
    const css = getComputedStyle(document.documentElement);
    const color = css.getPropertyValue(stage ? '--stage' : '--paper').trim();
    const dark = stage || window.matchMedia('(prefers-color-scheme: dark)').matches;
    try { native.setBars(color, !dark); } catch (e) { /* 古いアプリでは何もしない */ }
  }

  // 戻るボタン（と Esc キー）。開いているものを閉じたら true
  function handleBack() {
    if (!$('sheet-export').hidden || !$('sheet-menu').hidden) { closeSheets(); return true; }
    if (state.editor) { commitEditor(); return true; }
    if (state.camera) { closeCamera(); return true; }
    return false;
  }

  // ギャラリーなどの「共有」から送られた写真を取り込む
  async function checkShared() {
    if (!native || !native.takeShared) return;
    let urls = [];
    try { urls = JSON.parse(native.takeShared() || '[]'); } catch (e) { urls = []; }
    if (!urls.length) return;
    const files = [];
    for (const url of urls) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const blob = await res.blob();
        files.push(new File([blob], 'shared.jpg', { type: blob.type || 'image/jpeg' }));
      } catch (e) { /* 読めない写真はとばす */ }
    }
    if (files.length) importFiles(files);
    else toast('共有された写真を読み込めませんでした');
  }

  // ---------- 操作の割り当て ----------

  function bind() {
    $('btn-export').addEventListener('click', openExport);
    $('btn-menu').addEventListener('click', () => openSheet('sheet-menu'));
    $('btn-sample').addEventListener('click', loadSample);
    $('btn-clear-sample').addEventListener('click', removeSamples);
    $('menu-new').addEventListener('click', newDocument);
    $('menu-sample').addEventListener('click', () => { closeSheets(); loadSample(); });

    $('page-grid').addEventListener('click', (e) => {
      const b = e.target.closest('.card-btn[data-id]');
      if (b) openEditor(b.dataset.id, 'finish');
    });

    const title = $('doc-title');
    title.addEventListener('change', () => {
      state.title = title.value.trim() || defaultTitle();
      title.value = state.title;
      Store.setMeta('title', state.title);
    });
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') title.blur(); });

    const onFiles = (id, handle) => {
      const input = $(id);
      input.addEventListener('change', () => {
        const files = [...(input.files || [])];
        input.value = ''; // 同じ写真をもう一度選んでも反応するように
        if (files.length) handle(files);
      });
    };
    $('file-camera').addEventListener('click', (e) => interceptForLiveCamera(e));
    onFiles('file-camera', (files) => importFiles(files, { fromCamera: true }));
    onFiles('file-gallery', (files) => importFiles(files));
    onFiles('file-cam-gallery', (files) => importFiles(files));

    let retakeId = null;
    $('file-retake').addEventListener('click', (e) => {
      const ed = state.editor;
      if (!ed) { e.preventDefault(); return; }
      const page = byId(ed.id);
      if (page) page.filter = ed.filter;
      retakeId = ed.id;
      interceptForLiveCamera(e, ed.id);
    });
    onFiles('file-retake', (files) => {
      const id = retakeId;
      retakeId = null;
      if (!id) return;
      closeEditor();
      importFiles(files, { replaceId: id });
    });

    $('cam-close').addEventListener('click', closeCamera);
    $('cam-done').addEventListener('click', closeCamera);
    $('cam-shutter').addEventListener('click', capture);
    $('cam-torch').addEventListener('click', toggleTorch);

    const stage = $('ed-stage');
    stage.addEventListener('pointerdown', onStageDown);
    stage.addEventListener('pointermove', onStageMove);
    stage.addEventListener('pointerup', onStageUp);
    stage.addEventListener('pointercancel', onStageUp);
    $('ed-overlay').addEventListener('keydown', onHandleKey);
    $('ed-back').addEventListener('click', commitEditor);
    $('ed-done').addEventListener('click', commitEditor);
    $('ed-tab-crop').addEventListener('click', () => state.editor && setEditorMode('crop'));
    $('ed-tab-finish').addEventListener('click', () => state.editor && setEditorMode('finish'));
    $('ed-auto').addEventListener('click', async () => {
      const ed = state.editor;
      if (!ed) return;
      showEdBusy(true);
      let found = null;
      try {
        found = await Engine.detectPage({ key: ed.key, blob: ed.blob, opts: { long: DETECT_LONG, aspect: ed.aspect, refineLong: REFINE_LONG } });
      } catch (e) {
        found = null;
      }
      if (state.editor !== ed) return;
      showEdBusy(false);
      if (!found) { toast('書類の四隅を見つけられませんでした。角の丸を指で合わせてください'); return; }
      ed.quad = found.quad;
      drawQuad();
      updateCropInfo();
      toast('四隅を検出しました');
    });
    $('ed-full').addEventListener('click', () => {
      const ed = state.editor;
      if (!ed) return;
      ed.quad = fullQuad();
      drawQuad();
      updateCropInfo();
    });
    $('ed-filters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      const ed = state.editor;
      if (!b || !ed || ed.filter === b.dataset.filter) return;
      ed.filter = b.dataset.filter;
      updateFilterChips();
      renderFinish();
    });
    $('ed-rot-left').addEventListener('click', () => { const ed = state.editor; ed.rotation = (ed.rotation + 270) % 360; renderFinish(); });
    $('ed-rot-right').addEventListener('click', () => { const ed = state.editor; ed.rotation = (ed.rotation + 90) % 360; renderFinish(); });
    $('ed-prev').addEventListener('click', () => state.editor && movePage(state.editor.id, -1));
    $('ed-next').addEventListener('click', () => state.editor && movePage(state.editor.id, 1));
    $('ed-delete').addEventListener('click', () => {
      const ed = state.editor;
      if (!ed) return;
      const id = ed.id;
      closeEditor();
      deletePage(id);
    });
    $('backdrop').addEventListener('click', closeSheets);
    $('exp-save').addEventListener('click', savePdf);
    $('exp-share').addEventListener('click', sharePdf);
    document.querySelectorAll('#sheet-export input[type="radio"]').forEach((r) => r.addEventListener('change', updateExportNote));

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') handleBack(); });

    document.querySelectorAll('input[name="set-shape"]').forEach((r) => r.addEventListener('change', () => {
      state.settings.shape = r.value;
      saveSettings();
      toast(`書類の形を「${SHAPES[r.value].label}」にしました。これから撮るページに使います`);
    }));
    document.querySelectorAll('input[name="set-capture"]').forEach((r) => r.addEventListener('change', () => {
      state.settings.captureMode = r.value;
      saveSettings();
      toast(r.value === 'app'
        ? '撮影ボタンで端末のカメラアプリを開きます（1枚ずつ、いちばん高画質）'
        : '撮影ボタンでアプリ内のカメラを開きます（四隅を見ながら続けて撮れます）');
    }));
    $('set-auto').addEventListener('change', () => {
      state.settings.autoCapture = $('set-auto').checked;
      saveSettings();
    });
    $('cam-auto').addEventListener('click', toggleAutoCapture);
    $('link-apk').hidden = !!native;
    $('link-web').hidden = !inViewer;
    $('viewer-notice').hidden = !inViewer;

    window.addEventListener('resize', () => { if (state.editor) relayoutEditor(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && state.camera) closeCamera(); });

    // パソコンでは、画像のドラッグ＆ドロップと貼り付けでも追加できる
    let dragDepth = 0;
    const hasFiles = (e) => !!(e.dataTransfer && [...e.dataTransfer.types].includes('Files'));
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      $('dropzone').hidden = false;
    });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $('dropzone').hidden = true;
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      $('dropzone').hidden = true;
      importFiles(e.dataTransfer.files);
    });
    window.addEventListener('paste', (e) => {
      const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      importFiles(files);
    });
  }

  function registerServiceWorker() {
    if (inViewer || native || !('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  async function init() {
    document.querySelectorAll('[data-icon]').forEach((el) => {
      el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[el.dataset.icon] || ''}</svg>`;
    });
    BEAM = getComputedStyle(document.documentElement).getPropertyValue('--beam').trim() || BEAM;
    overlay = buildOverlay();
    loadPrefs();
    bind();
    probeCamera();

    window.HyperScanner = { back: handleBack, checkShared };

    await Store.open();
    await loadSettings();
    state.title = (await Store.getMeta('title')) || defaultTitle();
    $('doc-title').value = state.title;
    const pages = (await Store.getPages()).sort((a, b) => a.order - b.order);
    pages.forEach((p) => { p.thumbUrl = p.thumb ? URL.createObjectURL(p.thumb) : ''; });
    state.pages = pages;
    renderPages();

    pages.filter((p) => !p.thumbUrl).forEach((p) => enqueue(async () => {
      await refreshThumb(p);
      await Store.putPage(p);
    }, false));

    // 初めて開いたときだけ、サンプルを1枚入れておく
    if (!(await Store.getMeta('seen'))) {
      await Store.setMeta('seen', true);
      if (!pages.length) loadSample();
    }
    updateBars();
    checkShared();
    registerServiceWorker();
  }

  init();
})();
