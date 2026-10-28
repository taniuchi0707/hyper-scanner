// 撮影しなくても補正の流れを試せるよう、「机の上で斜めに撮った見積書」の写真を作る
const Sample = (() => {
  'use strict';

  const FONT = '"BIZ UDPGothic", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif';

  function drawDocument() {
    const W = 1000, H = 1414;
    const c = Imaging.makeCanvas(W, H);
    const x = c.getContext('2d');
    x.fillStyle = '#fbfaf6';
    x.fillRect(0, 0, W, H);
    x.fillStyle = '#1d232a';
    x.textBaseline = 'alphabetic';

    x.font = `700 64px ${FONT}`;
    x.textAlign = 'center';
    x.fillText('御 見 積 書', W / 2, 150);
    x.fillRect(330, 172, 340, 3);

    x.textAlign = 'left';
    x.font = `700 32px ${FONT}`;
    x.fillText('株式会社 サンプル商事 御中', 80, 270);
    x.fillRect(80, 284, 460, 2);
    x.font = `24px ${FONT}`;
    x.fillText('下記のとおりお見積り申し上げます。', 80, 340);

    x.textAlign = 'right';
    x.font = `22px ${FONT}`;
    x.fillText('No. 2026-1029', 920, 250);
    x.fillText('2026年10月29日', 920, 285);
    x.fillText('ハイパー文具店', 920, 340);
    x.fillText('東京都千代田区丸の内1-1', 920, 372);

    // 角印（色が残るかの確認用に朱色）
    x.save();
    x.strokeStyle = '#c8372d';
    x.fillStyle = '#c8372d';
    x.lineWidth = 5;
    x.strokeRect(760, 392, 110, 110);
    x.font = `700 40px ${FONT}`;
    x.textAlign = 'center';
    x.fillText('見', 815, 440);
    x.fillText('本', 815, 488);
    x.restore();

    x.fillStyle = '#1d232a';
    x.textAlign = 'left';
    x.font = `700 30px ${FONT}`;
    x.fillText('お見積金額', 80, 470);
    x.font = `700 46px ${FONT}`;
    x.fillText('¥ 12,980 −', 280, 474);
    x.font = `20px ${FONT}`;
    x.fillText('（税込）', 560, 472);
    x.fillRect(80, 492, 600, 3);

    const top = 560, rowH = 58;
    const cols = [80, 520, 640, 770, 920];
    const rows = [
      ['A4 コピー用紙（500枚）', '2', '1,280', '2,560'],
      ['クリアファイル（10枚入）', '3', '450', '1,350'],
      ['ゲルインクボールペン 黒', '10', '120', '1,200'],
      ['付箋 75×75mm', '5', '380', '1,900'],
      ['ファイルボックス A4', '4', '640', '2,560'],
      ['ステープラー針 No.10', '6', '95', '570'],
      ['', '', '小計', '10,140'],
      ['', '', '消費税', '1,014'],
      ['', '', '送料', '1,826'],
    ];
    x.fillStyle = '#e4e7ea';
    x.fillRect(cols[0], top, cols[4] - cols[0], rowH);
    x.fillStyle = '#1d232a';
    x.font = `700 22px ${FONT}`;
    const head = ['品名', '数量', '単価', '金額'];
    head.forEach((t, i) => {
      x.textAlign = i === 0 ? 'left' : 'right';
      x.fillText(t, i === 0 ? cols[0] + 16 : cols[i + 1] - 16, top + 37);
    });
    x.font = `22px ${FONT}`;
    rows.forEach((r, ri) => {
      const y = top + rowH * (ri + 1);
      r.forEach((t, i) => {
        x.textAlign = i === 0 ? 'left' : 'right';
        x.fillText(t, i === 0 ? cols[0] + 16 : cols[i + 1] - 16, y + 37);
      });
    });
    x.lineWidth = 2;
    x.strokeStyle = '#1d232a';
    const bottom = top + rowH * (rows.length + 1);
    for (let i = 0; i <= rows.length + 1; i++) {
      x.beginPath();
      const yy = top + rowH * i;
      x.moveTo(i > 6 ? cols[2] : cols[0], yy);
      x.lineTo(cols[4], yy);
      x.stroke();
    }
    cols.forEach((cx, i) => {
      x.beginPath();
      x.moveTo(cx, top);
      x.lineTo(cx, i >= 2 ? bottom : top + rowH * 7);
      x.stroke();
    });

    x.textAlign = 'left';
    x.font = `20px ${FONT}`;
    x.fillText('備考：有効期限はお見積日より30日間です。', 80, bottom + 70);
    x.fillText('納期：ご注文後 3 営業日以内に発送いたします。', 80, bottom + 104);
    x.fillStyle = '#6b737b';
    x.font = `18px ${FONT}`;
    x.fillText('※ この書類は Hyper Scanner のサンプルです。実在の会社・取引とは関係ありません。', 80, H - 70);
    return c;
  }

  function rand(seed) {
    let s = seed;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  async function create() {
    try {
      await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
    } catch (e) { /* フォントがなくても描ける */ }

    const doc = drawDocument();
    const dw = doc.width, dh = doc.height;
    const docData = doc.getContext('2d').getImageData(0, 0, dw, dh).data;

    const W = 1600, H = 1200;
    const photo = Imaging.makeCanvas(W, H);
    const ctx = photo.getContext('2d', { willReadFrequently: true });

    // 机（濃い木目）
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#4a3a30');
    grad.addColorStop(1, '#2b211b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    const rnd = rand(7);
    for (let i = 0; i < 70; i++) {
      ctx.strokeStyle = `rgba(${rnd() < 0.5 ? '20,12,8' : '110,85,66'},${0.08 + rnd() * 0.1})`;
      ctx.lineWidth = 1 + rnd() * 3;
      ctx.beginPath();
      const y0 = rnd() * H;
      ctx.moveTo(0, y0);
      for (let x = 0; x <= W; x += 80) ctx.lineTo(x, y0 + Math.sin(x / 260 + i) * 14 + (x / W) * 60);
      ctx.stroke();
    }

    const quad = [[488, 108], [1150, 168], [1212, 1098], [402, 1052]];
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = 36;
    ctx.shadowOffsetX = 10;
    ctx.shadowOffsetY = 16;
    ctx.fillStyle = '#ddd';
    ctx.beginPath();
    quad.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 写真の座標 → 書類の座標 の変換で、紙を斜めに貼り付ける
    const Hm = Geo.homography(quad, [[0, 0], [dw, 0], [dw, dh], [0, dh]]);
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const minX = Math.min(...quad.map((p) => p[0])) | 0, maxX = Math.max(...quad.map((p) => p[0])) | 0;
    const minY = Math.min(...quad.map((p) => p[1])) | 0, maxY = Math.max(...quad.map((p) => p[1])) | 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const [u, v] = Geo.project(Hm, x + 0.5, y + 0.5);
        if (u < 0 || v < 0 || u >= dw || v >= dh) continue;
        const k = ((v | 0) * dw + (u | 0)) << 2;
        // 左上から差す暖色の照明と、右下にかかるスマホの影
        const light = 1.02 - 0.2 * ((u / dw) * 0.4 + (v / dh) * 0.6);
        const sx = (u / dw - 0.78) / 0.32, sy = (v / dh - 0.82) / 0.24;
        const shade = light * (1 - 0.32 * Math.exp(-(sx * sx + sy * sy)));
        const j = (y * W + x) << 2;
        d[j] = docData[k] * shade;
        d[j + 1] = docData[k + 1] * shade * 0.965;
        d[j + 2] = docData[k + 2] * shade * 0.88;
      }
    }
    // センサーのノイズ
    const nz = rand(42);
    for (let j = 0; j < d.length; j += 4) {
      const e = (nz() - 0.5) * 10;
      d[j] += e; d[j + 1] += e; d[j + 2] += e;
    }
    ctx.putImageData(img, 0, 0);
    return Imaging.toBlob(photo, 'image/jpeg', 0.9);
  }

  return { create };
})();
