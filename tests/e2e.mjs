// アプリを画面なしの Chrome で一通り動かして確かめる（開発用）。先に `npm start` でサーバーを動かしておく。
//   node tests/e2e.mjs
// 代わりのカメラ（tests/camera-load.js）で撮影画面を開き、枠と案内、自動撮影、手動の撮影、
// 撮影画面を閉じたあとの一覧、PDF の書き出しまでを確かめる。どこかで失敗したら終了コード 1
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.APP_BASE || 'http://localhost:5173/';
const PORT = 9800 + Math.floor(Math.random() * 100);
const exe = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .filter(Boolean).find((p) => existsSync(p));
if (!exe) { console.error('Chrome が見つかりません（CHROME で場所を指定できます）'); process.exit(1); }

const profile = mkdtempSync(join(tmpdir(), 'hs-e2e-'));
const chrome = spawn(exe, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--window-size=420,860', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(path, method = 'GET') {
  for (let i = 0; i < 100; i++) {
    try { const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method }); if (res.ok) return await res.json(); } catch (e) { /* 起動待ち */ }
    await sleep(100);
  }
  throw new Error('Chrome に接続できません');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const waiting = new Map(), errors = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  };
  const ready = new Promise((r) => { ws.onopen = r; });
  const send = async (method, params = {}) => {
    await ready;
    const id = ++seq;
    return new Promise((resolve) => { waiting.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  };
  // ページの中で式を評価して値を返す（await できる）
  const run = async (expression) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  return { send, run, errors, close: () => ws.close() };
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? '○' : '×'} ${name}${detail ? `（${detail}）` : ''}`); };

try {
  await json('/json/version');
  const target = await json(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
  const page = connect(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Browser.grantPermissions', { permissions: ['videoCapture'] }).catch(() => {});
  // --throttle=4 で CPU を 4 分の 1 の速さにする（スマホの目安。画面側のスレッドが遅くなる）
  const thr = process.argv.find((x) => x.startsWith('--throttle='));
  if (thr) await page.send('Emulation.setCPUThrottlingRate', { rate: Number(thr.slice(11)) });
  await page.send('Page.navigate', { url: `${BASE}?e2e=${Date.now()}` });
  await sleep(2500);

  // 代わりのカメラを差し込み、撮影画面を開く
  await page.run(`
    await new Promise((r, j) => { const s = document.createElement('script'); s.src = new URL('tests/camera-load.js?' + Date.now(), location.href).href; s.onload = r; s.onerror = j; document.head.appendChild(s); });
    await __cameraLoad.install();
    window.__log = [];
    const orig = Engine.detectLive;
    Engine.detectLive = async (f, o) => { const r = await orig.call(Engine, f, o); __log.push({ track: !!o.track, tracked: !!(r && r.tracked), score: r ? r.score : 0 }); return r; };
    document.getElementById('file-camera').click();
  `);
  await sleep(3000);
  const cam = await page.run(`return { open: !document.getElementById('camera').hidden, res: document.getElementById('cam-res').textContent, hint: document.getElementById('cam-hint').textContent, found: document.getElementById('cam-hint').classList.contains('found'), log: __log.slice(0, 12) };`);
  check('撮影画面が開く', cam.open, cam.res);
  check('映像は 1920×1440 で頼む', /1920×1440/.test(cam.res), cam.res);
  check('書類を見つけて案内を出す', cam.found, cam.hint);
  check('見つけたあとは追いかけで確かめる', cam.log.some((l) => l.tracked), `${cam.log.filter((l) => l.tracked).length} / ${cam.log.length} 回`);

  // 撮影画面のなめらかさ（描画のコマ数と、画面側が止まった時間）
  const perf = await page.run(`Engine.detectLive = Engine.detectLive; return await __cameraLoad.run(4000);`);
  check('撮影画面がなめらかに動く', perf.fps >= 50 && perf.worstStallMs < 50, `${perf.fps} コマ/秒・最長の止まり ${perf.worstStallMs}ms・描画の最長間隔 ${perf.worstFrameMs}ms・検出 ${perf.detectPerSec} 回/秒`);

  // 自動撮影
  const auto = await page.run(`
    const btn = document.getElementById('cam-auto');
    if (btn.getAttribute('aria-pressed') !== 'true') btn.click();
    const t0 = performance.now();
    for (let i = 0; i < 40 && !/（1）/.test(document.getElementById('cam-count').textContent); i++) await new Promise((r) => setTimeout(r, 250));
    const ms = Math.round(performance.now() - t0);
    btn.click();
    return { count: document.getElementById('cam-count').textContent, ms };
  `);
  check('自動撮影で撮れる', /（1）/.test(auto.count), `${auto.ms}ms`);

  // 手動の撮影を 3 回
  const manual = await page.run(`
    for (let k = 2; k <= 4; k++) {
      for (let i = 0; i < 50 && document.getElementById('cam-shutter').disabled; i++) await new Promise((r) => setTimeout(r, 100));
      document.getElementById('cam-shutter').click();
      for (let i = 0; i < 50 && !new RegExp('（' + k + '）').test(document.getElementById('cam-count').textContent); i++) await new Promise((r) => setTimeout(r, 100));
    }
    return document.getElementById('cam-count').textContent;
  `);
  check('手動で続けて撮れる', /（4）/.test(manual), manual);

  // 撮った直後は「完了」の枠に撮った瞬間の映像、取り込みのあとは仕上がりのサムネイルが出る
  const thumb = await page.run(`
    const el = document.getElementById('cam-thumb');
    for (let i = 0; i < 50 && document.getElementById('cam-shutter').disabled; i++) await new Promise((r) => setTimeout(r, 100));
    document.getElementById('cam-shutter').click();
    let first = '';
    for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 50)); if (/data:/.test(el.style.backgroundImage)) { first = 'data'; break; } }
    let later = '';
    for (let i = 0; i < 50 && !/（5）/.test(document.getElementById('cam-count').textContent); i++) await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 80; i++) { await new Promise((r) => setTimeout(r, 100)); if (/blob:/.test(el.style.backgroundImage)) { later = 'blob'; break; } }
    return { first, later };
  `);
  check('撮った直後に、撮った瞬間の映像を出す', thumb.first === 'data');
  check('取り込みのあとは、仕上がりのサムネイルに替わる', thumb.later === 'blob');

  // 閉じて一覧を確かめる
  const list = await page.run(`
    document.getElementById('cam-close').click();
    for (let i = 0; i < 80 && document.querySelector('#pages .pending'); i++) await new Promise((r) => setTimeout(r, 250));
    await new Promise((r) => setTimeout(r, 300));
    return { cards: document.querySelectorAll('#pages .card-btn').length, toast: document.getElementById('toast-text').textContent };
  `);
  check('撮ったページが一覧に並ぶ', list.cards >= 5, `${list.cards} 枚・${list.toast}`);

  // PDF の書き出し
  const pdf = await page.run(`
    let blob = null;
    const create = URL.createObjectURL;
    URL.createObjectURL = (b) => { if (b && b.type === 'application/pdf') blob = b; return create.call(URL, b); };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) return; return click.call(this); };
    document.getElementById('btn-export').click();
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById('exp-save').click();
    for (let i = 0; i < 200 && !blob; i++) await new Promise((r) => setTimeout(r, 100));
    URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click;
    if (!blob) return null;
    const t = await blob.text();
    return { kb: Math.round(blob.size / 1024), pages: (t.match(/\\/Type \\/Page\\b/g) || []).length, ok: t.startsWith('%PDF') && t.trimEnd().endsWith('%%EOF') };
  `);
  check('PDF を書き出せる', !!(pdf && pdf.ok && pdf.pages >= 5), pdf ? `${pdf.pages} ページ・${pdf.kb}KB` : '書き出せない');
  // 編集画面: 自動検出、仕上げの切り替え、撮り直し（撮影画面で 1 枚撮ると、そのページが置き換わって編集画面に戻る）
  const edit = await page.run(`
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#pages .card-btn').click();
    await wait(1200);
    const opened = !document.getElementById('editor').hidden;
    document.getElementById('ed-auto').click();
    await wait(1500);
    const info = document.getElementById('ed-info').textContent;
    const finishTab = [...document.querySelectorAll('.seg button, [role=tab]')].find((b) => /仕上げ/.test(b.textContent));
    if (finishTab) finishTab.click();
    await wait(1200);
    document.querySelector('#ed-filters [data-filter="bw"]').click();
    await wait(1500);
    const bw = document.querySelector('#ed-filters [data-filter="bw"]').getAttribute('aria-checked');
    const cropTab = [...document.querySelectorAll('.seg button, [role=tab]')].find((b) => /範囲|切り抜き|四隅/.test(b.textContent));
    if (cropTab) cropTab.click();
    await wait(500);
    document.getElementById('file-retake').click();
    await wait(2500);
    const camOpen = !document.getElementById('camera').hidden;
    for (let i = 0; i < 50 && document.getElementById('cam-shutter').disabled; i++) await wait(100);
    document.getElementById('cam-shutter').click();
    for (let i = 0; i < 80 && (!document.getElementById('camera').hidden || document.getElementById('editor').hidden); i++) await wait(100);
    await wait(1500);
    const back = !document.getElementById('editor').hidden && document.getElementById('camera').hidden;
    document.getElementById('ed-done').click();
    await wait(800);
    return { opened, info, bw, camOpen, back, cards: document.querySelectorAll('#pages .card-btn').length };
  `);
  check('編集画面が開き、自動検出できる', edit.opened && /px/.test(edit.info), edit.info);
  check('仕上げを白黒に切り替えられる', edit.bw === 'true');
  check('撮り直しで撮影画面が開き、撮ると編集画面に戻る', edit.camOpen && edit.back, `一覧 ${edit.cards} 枚`);

  // 撮影の途中で撮影画面を閉じても、その 1 枚は取り込まれる
  const midClose = await page.run(`
    document.getElementById('file-camera').click();
    await new Promise((r) => setTimeout(r, 1500));
    const before = document.querySelectorAll('#pages .card-btn').length;
    const el = document.getElementById('toast-text');
    let toast = '';
    const obs = new MutationObserver(() => { toast = el.textContent; });
    obs.observe(el, { childList: true, characterData: true, subtree: true });
    document.getElementById('cam-shutter').click();
    await new Promise((r) => setTimeout(r, 50));
    document.getElementById('cam-close').click();
    for (let i = 0; i < 80; i++) { await new Promise((r) => setTimeout(r, 100)); if (toast && !document.querySelector('#pages .pending')) break; }
    obs.disconnect();
    return { added: document.querySelectorAll('#pages .card-btn').length - before, toast };
  `);
  check('撮影の途中で閉じても、その 1 枚を取り込む', midClose.added === 1 && /1ページ/.test(midClose.toast), `${midClose.added} 枚・${midClose.toast}`);

  // 写真として撮れる端末（ImageCapture.takePhoto）。横倒しの 4096×3072 の写真が返っても、画面の向きにそろえて取り込む
  await page.send('Page.navigate', { url: `${BASE}?e2e=photo${Date.now()}` });
  await sleep(2000);
  const photo = await page.run(`
    await new Promise((r, j) => { const s = document.createElement('script'); s.src = new URL('tests/camera-load.js?' + Date.now(), location.href).href; s.onload = r; s.onerror = j; document.head.appendChild(s); });
    await __cameraLoad.install();
    const calls = [];
    window.ImageCapture = class {
      constructor(track) { this.track = track; }
      async getPhotoCapabilities() { return { imageWidth: { min: 640, max: 4096 }, imageHeight: { min: 480, max: 3072 }, fillLightMode: ['auto', 'off', 'flash'] }; }
      async takePhoto(settings) {
        calls.push(JSON.stringify(settings));
        const v = document.getElementById('cam-video');
        const bmp = await createImageBitmap(v);
        // 映像を 4096×3072 に広げてから 90° 回した写真（横倒しで返る端末のまね）
        const c = new OffscreenCanvas(3072, 4096);
        const x = c.getContext('2d');
        x.translate(3072, 0); x.rotate(Math.PI / 2);
        x.drawImage(bmp, 0, 0, 4096, 3072);
        return c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
      }
    };
    const before = document.querySelectorAll('#pages .card-btn').length;
    document.getElementById('file-camera').click();
    await new Promise((r) => setTimeout(r, 2500));
    const res = document.getElementById('cam-res').textContent;
    document.getElementById('cam-shutter').click();
    for (let i = 0; i < 50 && !/（1）/.test(document.getElementById('cam-count').textContent); i++) await new Promise((r) => setTimeout(r, 100));
    document.getElementById('cam-close').click();
    for (let i = 0; i < 80 && document.querySelector('#pages .pending'); i++) await new Promise((r) => setTimeout(r, 250));
    const pages = await Store.getPages();
    const last = pages.sort((p, q) => (q.createdAt || 0) - (p.createdAt || 0))[0];
    return { res, calls, w: last && last.width, h: last && last.height, detected: last && last.detected, added: document.querySelectorAll('#pages .card-btn').length - before };
  `);
  check('写真として撮る端末では写真の大きさを表示する', /写真 4096×3072/.test(photo.res), photo.res);
  check('写真はフラッシュなしで頼む', photo.calls.some((c) => /"fillLightMode":"off"/.test(c)), photo.calls[0] || '呼ばれていない');
  check('横倒しの写真を画面の向きにそろえて取り込む', photo.w > photo.h && photo.detected, `${photo.w}×${photo.h}・四隅 ${photo.detected ? 'あり' : 'なし'}`);

  // 映像のコマが少ない端末（1 秒に 10 コマ）では、見るための映像を 1280×960 に下げる
  await page.send('Page.navigate', { url: `${BASE}?e2e=slow${Date.now()}` });
  await sleep(2000);
  const slow = await page.run(`
    await new Promise((r, j) => { const s = document.createElement('script'); s.src = new URL('tests/camera-load.js?' + Date.now(), location.href).href; s.onload = r; s.onerror = j; document.head.appendChild(s); });
    await __cameraLoad.install({ fps: 10 });
    document.getElementById('file-camera').click();
    await new Promise((r) => setTimeout(r, 6000));
    const res = document.getElementById('cam-res').textContent;
    document.getElementById('cam-close').click();
    return res;
  `);
  check('映像のコマが少ない端末では映像を小さくする', /1280×960/.test(slow), slow);
  check('ページで例外が起きない', page.errors.length === 0, page.errors.slice(0, 3).join(' / '));
  page.close();
} catch (e) {
  check('最後まで動く', false, e.message);
} finally {
  chrome.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 残っても害はない */ }
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} 件が失敗しました` : '\nすべて通りました');
process.exit(failed ? 1 : 0);
