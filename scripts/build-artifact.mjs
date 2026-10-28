// claude.ai の Artifact として公開するための 1 ファイル版を dist/ に作る。
// index.html の印（artifact:*-begin / -end）の間と、CSS・JS をすべて 1 つにまとめる。
// 使い方: node scripts/build-artifact.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

function between(name) {
  const m = html.match(new RegExp(`<!-- artifact:${name}-begin -->([\\s\\S]*?)<!-- artifact:${name}-end -->`));
  if (!m) throw new Error(`index.html に artifact:${name} の印がありません`);
  return m[1].trim();
}

const head = between('head');
const body = between('body');
const css = readFileSync(join(root, 'css', 'style.css'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const js = scripts.map((src) => `// ---- ${src} ----\n${readFileSync(join(root, src), 'utf8')}`).join('\n');
if (/<\/script/i.test(js)) throw new Error('スクリプトの中に </script が含まれています');

const out = `${head}
<style>
${css}
</style>
${body}
<script>
${js}
</script>
`;

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'hyper-scanner.html'), out);
console.log(`dist/hyper-scanner.html (${(Buffer.byteLength(out) / 1024).toFixed(1)} KB)`);
