// 検出のベンチマークを、画面なしの Chrome で動かして結果を表示する（開発用）。
// 先に `npm start` でサーバーを動かしておく。
//   node tests/run-bench.mjs "long=320&quick=1" "long=480&refine=1600"
// 引数ごとに tests/detect-bench.html?<引数> を開き、まとめを 1 行ずつ出す。--rows を付けると場面ごとの結果も出す
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const showRows = args.includes('--rows');
// --shot=<フォルダ> で、場面の一覧（緑が正解、水色が検出）を PNG で保存する
const shotArg = args.find((a) => a.startsWith('--shot='));
const shotDir = shotArg ? shotArg.slice(7) : null;
const queries = args.filter((a) => !a.startsWith('--'));
if (!queries.length) queries.push('');
const BASE = process.env.BENCH_BASE || 'http://localhost:5173/tests/detect-bench.html';
const PORT = 9300 + Math.floor(Math.random() * 500);

const candidates = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const exe = candidates.find((p) => existsSync(p));
if (!exe) { console.error('Chrome が見つかりません（CHROME で場所を指定できます）'); process.exit(1); }

const profile = mkdtempSync(join(tmpdir(), 'hs-bench-'));
const chrome = spawn(exe, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(path, method = 'GET') {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
      if (res.ok) return await res.json();
    } catch (e) { /* 起動待ち */ }
    await sleep(100);
  }
  throw new Error('Chrome に接続できません');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const waiting = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push((d.exception && d.exception.description) || d.text);
    }
  };
  const ready = new Promise((r) => { ws.onopen = r; });
  const send = async (method, params = {}) => {
    await ready;
    const id = ++seq;
    return new Promise((resolve) => { waiting.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  };
  return { send, errors, close: () => ws.close() };
}

async function runOne(query) {
  const target = await json(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
  const page = connect(target.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: `${BASE}?${query}` });
  const t0 = Date.now();
  for (;;) {
    await sleep(1000);
    const r = await page.send('Runtime.evaluate', {
      expression: 'window.__bench ? JSON.stringify(window.__bench) : null',
      returnByValue: true,
    });
    const v = r.result && r.result.result && r.result.result.value;
    if (v) {
      if (shotDir) {
        await page.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
        const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        mkdirSync(shotDir, { recursive: true });
        writeFileSync(join(shotDir, `${query.replace(/[^\w=.-]+/g, '_') || 'default'}.png`), Buffer.from(shot.result.data, 'base64'));
      }
      page.close();
      return { query, secs: Math.round((Date.now() - t0) / 1000), ...JSON.parse(v) };
    }
    if (page.errors.length) { page.close(); return { query, error: page.errors.join('\n') }; }
    if (Date.now() - t0 > 20 * 60 * 1000) { page.close(); return { query, error: 'timeout' }; }
  }
}

try {
  await json('/json/version');
  const results = await Promise.all(queries.map(runOne));
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  for (const r of results) {
    if (r.error) { console.log(`${r.query}: ${r.error}`); continue; }
    if (r.profile) { console.log(`[${r.query}] ${JSON.stringify(r.profile)}`); continue; }
    const s = r.summary;
    const v = s.v2;
    console.log(`[${r.query || '既定'}] 場面 ${s.scenes} / 0.8%未満 ${pct(v.ok08)} / 0.3%未満 ${pct(v.ok03 || 0)} / 中央値 ${(v.median * 100).toFixed(3)}% / ${v.ms.toFixed(1)}ms`
      + `  大外れ(5%超) ${r.rows.filter((row) => row.inside && !(row.v2 < 0.05)).length}`
      + `  (前の版 ${pct(s.prev.ok08)} ${(s.prev.median * 100).toFixed(3)}% 大外れ ${r.rows.filter((row) => row.inside && !(row.prev < 0.05)).length})  ${r.secs}s`);
    if (args.includes('--scores')) {
      // 自動撮影のしきい値（0.6）と、枠を出すしきい値（0.35）に対する点数の分かれ方
      const inside = r.rows.filter((row) => row.inside);
      const ok = inside.filter((row) => row.v2 < 0.008), bad = inside.filter((row) => !(row.v2 < 0.008));
      const frac = (list, f) => list.length ? (list.filter(f).length / list.length * 100).toFixed(0) + '%' : '-';
      const q = (list) => { const s = list.map((row) => row.score).sort((a, b) => a - b); return s.length ? [0.1, 0.25, 0.5].map((p) => s[Math.floor(p * (s.length - 1))].toFixed(2)).join('/') : '-'; };
      console.log(`  点数: 正解 ${ok.length} 件のうち 0.6 以上 ${frac(ok, (row) => row.score >= 0.6)}、0.35 以上 ${frac(ok, (row) => row.score >= 0.35)}（10/25/50% 点 ${q(ok)}） / 外れ ${bad.length} 件のうち 0.6 以上 ${frac(bad, (row) => row.score >= 0.6)}`);
    }
    if (r.rows[0] && r.rows[0].timing) {
      const sum = {};
      for (const row of r.rows) for (const [k, v] of Object.entries(row.timing)) sum[k] = (sum[k] || 0) + v;
      console.log('  内訳(ms): ' + Object.entries(sum).map(([k, v]) => `${k} ${(v / r.rows.length).toFixed(1)}`).join(' / '));
    }
    if (args.includes('--dump')) {
      for (const row of r.rows) {
        const { name, bg, kind, v2, score, gtScore, gtLines, nLines, top, gtExplain, bestExplain, regions, refined } = row;
        console.log(JSON.stringify({ name, bg, kind, err: +(v2 * 100).toFixed(2), score: +score.toFixed(3), gtScore: gtScore && +gtScore.toFixed(3), gtLines, nLines, top: top && top.slice(0, 4) }));
        console.log('   票: ' + JSON.stringify(row.gtVotes) + ' / ' + row.voteTop);
        console.log('   領域: ' + JSON.stringify(regions));
        console.log('   精密化後: ' + JSON.stringify(refined));
        console.log('   正解: ' + JSON.stringify(gtExplain) + ' / 手早い採点: ' + JSON.stringify(row.gtFast));
        console.log('   選択: ' + JSON.stringify(bestExplain));
      }
    }
    if (showRows) {
      const bad = r.rows.filter((row) => row.inside && !(row.v2 < 0.008));
      console.log('  外れ: ' + bad.map((row) => `${row.name}(${row.bg}/${row.kind} ${Number.isFinite(row.v2) ? (row.v2 * 100).toFixed(1) + '%' : '×'})`).join(' '));
    }
  }
} finally {
  chrome.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 残っても害はない */ }
}
