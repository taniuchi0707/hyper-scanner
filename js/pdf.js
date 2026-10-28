// 画像だけでできた PDF を組み立てる（外部ライブラリなし）
function PdfModule(Imaging) {
  'use strict';

  const te = new TextEncoder();
  const canDeflate = typeof CompressionStream === 'function';

  // 用紙サイズ（pt, 縦向き）
  const SIZES = {
    a4: [595.28, 841.89],
    b5: [515.91, 728.5],     // JIS B5 182×257mm
    letter: [612, 792],
  };

  // 画像の置き方。auto は画像の縦横比のまま、長辺を A4 の長辺にそろえる
  function layout(imgW, imgH, size) {
    if (!SIZES[size]) {
      const s = SIZES.a4[1] / Math.max(imgW, imgH);
      const pw = imgW * s, ph = imgH * s;
      return { pw, ph, x: 0, y: 0, dw: pw, dh: ph };
    }
    let [pw, ph] = SIZES[size];
    if (imgW > imgH) [pw, ph] = [ph, pw];
    const s = Math.min(pw / imgW, ph / imgH);
    const dw = imgW * s, dh = imgH * s;
    return { pw, ph, x: (pw - dw) / 2, y: (ph - dh) / 2, dw, dh };
  }

  async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function jpegImage(canvas, quality) {
    const blob = await Imaging.toBlob(canvas, 'image/jpeg', quality);
    return { kind: 'jpeg', bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
  }

  // 白黒ページは 1 ビット画像にして Flate 圧縮する（JPEG より小さく、文字のふちがにじまない）
  async function bitonalImage(canvas) {
    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const rowBytes = (w + 7) >> 3;
    const bits = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) << 2;
        if (d[j] + d[j + 1] + d[j + 2] >= 384) bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return { kind: 'bits', bytes: await deflate(bits), width: w, height: h };
  }

  function hexUtf16(str) {
    let s = 'FEFF';
    for (let i = 0; i < str.length; i++) s += str.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
    return s;
  }

  function pdfDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    const tz = -d.getTimezoneOffset();
    const sign = tz >= 0 ? '+' : '-';
    return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(tz) / 60))}'${p(Math.abs(tz) % 60)}'`;
  }

  const num = (v) => String(Math.round(v * 100) / 100);

  /**
   * pages: [{ kind: 'jpeg'|'bits', bytes, width, height, pw, ph, x, y, dw, dh }]
   * 戻り値: application/pdf の Blob
   */
  function build(pages, { title = '' } = {}) {
    const parts = [];
    const offsets = [];
    let offset = 0;
    const add = (x) => {
      const u = typeof x === 'string' ? te.encode(x) : x;
      parts.push(u);
      offset += u.length;
    };
    const begin = (id) => { offsets[id] = offset; add(`${id} 0 obj\n`); };
    const end = () => add('\nendobj\n');

    // "%PDF-1.4" と、バイナリを含むことを示す 4 バイト
    add(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    const total = 3 + pages.length * 3;
    begin(1); add('<< /Type /Catalog /Pages 2 0 R >>'); end();
    begin(2); add(`<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 3} 0 R`).join(' ')}] /Count ${pages.length} >>`); end();
    begin(3); add(`<< /Producer (Hyper Scanner) /Creator (Hyper Scanner) /Title <${hexUtf16(title)}> /CreationDate (${pdfDate(new Date())}) >>`); end();

    pages.forEach((p, i) => {
      const pageId = 4 + i * 3, contentId = pageId + 1, imageId = pageId + 2;
      begin(pageId);
      add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.pw)} ${num(p.ph)}] /Resources << /XObject << /Im${i} ${imageId} 0 R >> /ProcSet [/PDF /ImageB /ImageC] >> /Contents ${contentId} 0 R >>`);
      end();

      const content = `q\n${num(p.dw)} 0 0 ${num(p.dh)} ${num(p.x)} ${num(p.y)} cm\n/Im${i} Do\nQ\n`;
      begin(contentId);
      add(`<< /Length ${te.encode(content).length} >>\nstream\n${content}endstream`);
      end();

      const dict = p.kind === 'bits'
        ? '/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode'
        : '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode';
      begin(imageId);
      add(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} ${dict} /Length ${p.bytes.length} >>\nstream\n`);
      add(p.bytes);
      add('\nendstream');
      end();
    });

    const xref = offset;
    let table = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
    for (let id = 1; id <= total; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    add(table);
    add(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  return { SIZES, layout, canDeflate, jpegImage, bitonalImage, build };
}

const Pdf = PdfModule(Imaging);
