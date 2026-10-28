// Web 版のファイルを Android アプリの assets/www にコピーする（APK に入れるため）
// 使い方: node scripts/sync-android.mjs
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'android', 'app', 'src', 'main', 'assets', 'www');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const item of ['index.html', 'manifest.webmanifest', 'css', 'js', 'icons']) {
  cpSync(join(root, item), join(out, item), { recursive: true });
}
console.log('android/app/src/main/assets/www を更新しました');
