// icons/icon.svg と同じ絵柄の PNG アイコンを作る（依存パッケージなし）
// 使い方: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'icons');

const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function inRoundRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function inPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 512 単位の座標で描く絵柄（icon.svg と同じ）
const content = [
  { color: rgb('#F4F7F8'), test: (x, y) => inPolygon(x, y, [[150, 96], [308, 96], [366, 154], [366, 416], [150, 416]]) },
  { color: rgb('#BFC9CE'), test: (x, y) => inPolygon(x, y, [[308, 96], [366, 154], [308, 154]]) },
  ...[[186, 170, 104], [186, 206, 140], [186, 242, 124], [186, 318, 140], [186, 354, 96]].map(([x, y, w]) => ({
    color: rgb('#9AA7AE'),
    test: (px, py) => inRoundRect(px, py, x, y, w, 14, 7),
  })),
  { color: rgb('#3CC8D4'), test: (x, y) => inRoundRect(x, y, 118, 276, 276, 20, 10) },
];
const background = rgb('#142027');

// rounded: 角を丸めた背景 / scale: 絵柄の大きさ / transparent: 背景なし（Android のアダプティブアイコンの前景）
function render(size, { rounded, scale, transparent = false }) {
  const px = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = ((x + (sx + 0.5) / ss) / size) * 512;
          const v = ((y + (sy + 0.5) / ss) / size) * 512;
          const inBg = rounded ? inRoundRect(u, v, 0, 0, 512, 512, 112) : true;
          if (!inBg) continue;
          const cu = (u - 256) / scale + 256;
          const cv = (v - 256) / scale + 256;
          let c = transparent ? null : background;
          for (const s of content) if (s.test(cu, cv)) c = s.color;
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const i = (y * size + x) * 4;
      const n = ss * ss;
      px[i] = a ? Math.round(r / a) : 0;
      px[i + 1] = a ? Math.round(g / a) : 0;
      px[i + 2] = a ? Math.round(b / a) : 0;
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePng(size, size, px);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // ビット深度
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
const targets = [
  ['icon-192.png', 192, { rounded: true, scale: 1 }],
  ['icon-512.png', 512, { rounded: true, scale: 1 }],
  ['icon-maskable-512.png', 512, { rounded: false, scale: 0.78 }],
  ['apple-touch-icon.png', 180, { rounded: false, scale: 0.9 }],
];
for (const [name, size, opts] of targets) {
  writeFileSync(join(outDir, name), render(size, opts));
  console.log(`icons/${name} (${size}px)`);
}

// Android のアダプティブアイコンの前景（108dp。丸く切り抜かれても欠けないよう小さめに描く）
const densities = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
for (const [density, size] of Object.entries(densities)) {
  const dir = join(root, 'android', 'app', 'src', 'main', 'res', `mipmap-${density}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ic_launcher_foreground.png'), render(size, { rounded: false, scale: 0.72, transparent: true }));
  console.log(`android/.../mipmap-${density}/ic_launcher_foreground.png (${size}px)`);
}
