// 撮影画面の重さを測る（開発用）。ページで読み込んでから __cameraLoad.install() と run() を呼ぶ。
// 本物のカメラの代わりに、別スレッドで書類の映像を作って流す。スマホのカメラと同じく、
// 頼まれた大きさ（最大 4096×3072）の NV12 のコマを 1 秒に 30 枚出すので、画面側の負担はアプリの分だけになる。
// 画面側（メインスレッド）が止まった時間、描画のコマ数、検出の回数を数える
(() => {
  'use strict';
  const MAX_W = 4096, MAX_H = 3072;

  const workerSource = `
let size = null, buf = null, writer = null, t = 0;
function build(W, H) {
  const c = new OffscreenCanvas(W, H);
  const x = c.getContext('2d');
  x.fillStyle = '#5b4636'; x.fillRect(0, 0, W, H);
  const k = W / 4096;
  x.translate(W / 2, H / 2); x.scale(k, k); x.rotate(-0.06);
  x.fillStyle = '#f5f3ee'; x.fillRect(-900, -1250, 1800, 2500);
  x.fillStyle = '#20242a'; x.font = '64px sans-serif';
  for (let i = 0; i < 26; i++) x.fillText('見積書 請求書 納品書 領収書 契約書 申込書', -800, -1080 + i * 90);
  const d = x.getImageData(0, 0, W, H).data;
  const out = new Uint8Array(W * H * 3 / 2);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) out[i] = (16 + (65.481 * d[p] + 128.553 * d[p + 1] + 24.966 * d[p + 2]) / 255) | 0;
  for (let j = 0; j < H / 2; j++) for (let i = 0; i < W / 2; i++) {
    const p = (j * 2 * W + i * 2) * 4;
    out[W * H + j * W + i * 2] = (128 + (-37.797 * d[p] - 74.203 * d[p + 1] + 112 * d[p + 2]) / 255) | 0;
    out[W * H + j * W + i * 2 + 1] = (128 + (112 * d[p] - 93.786 * d[p + 1] - 18.214 * d[p + 2]) / 255) | 0;
  }
  return out;
}
onmessage = (e) => {
  if (e.data.writable) writer = e.data.writable.getWriter();
  if (e.data.size) { buf = build(e.data.size[0], e.data.size[1]); size = e.data.size; postMessage({ ready: size }); }
};
setInterval(() => {
  if (!writer || !buf) return;
  const f = new VideoFrame(buf, { format: 'NV12', codedWidth: size[0], codedHeight: size[1], timestamp: (t++) * 33333,
    colorSpace: { matrix: 'smpte170m', primaries: 'smpte170m', transfer: 'smpte170m', fullRange: false } });
  writer.write(f).catch(() => {});
}, 33);
`;

  function pick(c, k, d) {
    const v = c && c[k];
    if (typeof v === 'number') return v;
    return (v && (v.exact || v.ideal || v.max)) || d;
  }

  async function fakeCamera(video) {
    const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));
    const gen = new MediaStreamTrackGenerator({ kind: 'video' });
    worker.postMessage({ writable: gen.writable }, [gen.writable]);
    let constraints = video;
    const resize = (c) => new Promise((resolve) => {
      const w = Math.min(MAX_W, pick(c, 'width', 640)), h = Math.min(MAX_H, pick(c, 'height', 480));
      worker.onmessage = () => resolve();
      worker.postMessage({ size: [w & ~1, h & ~1] });
    });
    await resize(constraints);
    gen.applyConstraints = async (c) => { constraints = c || {}; await resize(constraints); };
    gen.getConstraints = () => constraints;
    gen.getCapabilities = () => ({ width: { min: 1, max: MAX_W }, height: { min: 1, max: MAX_H } });
    const stop = gen.stop.bind(gen);
    gen.stop = () => { worker.terminate(); stop(); };
    return new MediaStream([gen]);
  }

  async function install() {
    navigator.mediaDevices.getUserMedia = async (c) => fakeCamera((c && c.video) || {});
  }

  async function run(ms = 6000) {
    const video = document.getElementById('cam-video');
    await new Promise((r) => { if (video.videoWidth > 0) r(); else video.addEventListener('loadedmetadata', r, { once: true }); });
    await new Promise((r) => setTimeout(r, 1200)); // 立ち上がりを除く
    let detections = 0;
    const orig = Engine.detectLive;
    Engine.detectLive = (...a) => { detections++; return orig.apply(Engine, a); };
    let frames = 0, maxFrame = 0, lastFrame = performance.now(), running = true;
    const raf = () => { const n = performance.now(); maxFrame = Math.max(maxFrame, n - lastFrame); lastFrame = n; frames++; if (running) requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    let lastBeat = performance.now(), maxLate = 0, blocked = 0;
    const beat = () => {
      const n = performance.now();
      const late = n - lastBeat - 5;
      if (late > maxLate) maxLate = late;
      if (late > 10) blocked += late;
      lastBeat = n;
      if (running) setTimeout(beat, 5);
    };
    setTimeout(beat, 5);
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, ms));
    running = false;
    const sec = (performance.now() - t0) / 1000;
    Engine.detectLive = orig;
    return {
      video: `${video.videoWidth}×${video.videoHeight}`,
      fps: +(frames / sec).toFixed(1),
      worstFrameMs: Math.round(maxFrame),
      detectPerSec: +(detections / sec).toFixed(1),
      mainBlockedPerSec: Math.round(blocked / sec),
      worstStallMs: Math.round(maxLate),
    };
  }

  window.__cameraLoad = { install, run };
})();
