// 四隅検出のベンチマーク。
// 机の上の書類を 3D で斜めから撮った合成写真を作り、本当の四隅と検出結果のずれを測る。
(async () => {
  'use strict';

  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const FONT = '"BIZ UDPGothic", "Yu Gothic", Meiryo, sans-serif';
  const WORDS = '御見積書請求納品領収契約申込確認報告議事録会社部長様御中金額合計数量単価備考日付住所電話番号担当者以下記載内容承認';

  function drawDoc(rnd, aspect, paper, kind) {
    const W = 900, H = Math.round(900 * aspect);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = paper; x.fillRect(0, 0, W, H);
    x.fillStyle = '#1b1f24';
    const word = (n) => Array.from({ length: n }, () => WORDS[(rnd() * WORDS.length) | 0]).join('');
    if (kind === 'receipt') {
      x.font = `700 44px ${FONT}`; x.textAlign = 'center'; x.fillText('領 収 書', W / 2, 90);
      x.font = `26px ${FONT}`; x.textAlign = 'left';
      for (let y = 160; y < H - 60; y += 44) { x.fillText(word(6 + ((rnd() * 6) | 0)), 50, y); x.textAlign = 'right'; x.fillText(`¥${((rnd() * 9000) | 0) + 100}`, W - 50, y); x.textAlign = 'left'; }
      return c;
    }
    x.font = `700 52px ${FONT}`; x.textAlign = 'center'; x.fillText(word(4), W / 2, 110);
    x.textAlign = 'left';
    const dense = kind === 'dense';
    x.font = `${dense ? 20 : 24}px ${FONT}`;
    let y = 190;
    const step = dense ? 30 : 40;
    while (y < H * 0.55) { x.fillText(word(dense ? 38 : 20 + ((rnd() * 12) | 0)), 70, y); y += step; }
    if (kind === 'table' || kind === 'dense') {
      const top = y + 10, rows = 7, rh = 46;
      x.lineWidth = 2; x.strokeStyle = '#1b1f24';
      for (let i = 0; i <= rows; i++) { x.beginPath(); x.moveTo(70, top + i * rh); x.lineTo(W - 70, top + i * rh); x.stroke(); }
      [70, 420, 560, 700, W - 70].forEach((cx) => { x.beginPath(); x.moveTo(cx, top); x.lineTo(cx, top + rows * rh); x.stroke(); });
      y = top + rows * rh + 50;
    }
    if (kind === 'photo') {
      const g = x.createLinearGradient(70, y, W - 70, y + 260);
      g.addColorStop(0, '#2f5d7c'); g.addColorStop(1, '#c7853a');
      x.fillStyle = g; x.fillRect(70, y, W - 140, 260);
      x.fillStyle = '#1b1f24';
      y += 310;
    }
    while (y < H - 80) { x.fillText(word(18 + ((rnd() * 14) | 0)), 70, y); y += step; }
    if (rnd() < 0.5) { x.strokeStyle = '#c8372d'; x.lineWidth = 5; x.strokeRect(W - 210, 150, 110, 110); }
    return c;
  }

  function drawBackground(rnd, type, W, H) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    const base = {
      woodDark: '#4a3a30', woodLight: '#c9a67c', gray: '#868b90', white: '#dcdcd7', black: '#1d1f22',
      cloth: '#e9edf2', mat: '#2f6b4f', blue: '#3d5a80', beige: '#d8cbb3',
    }[type];
    x.fillStyle = base; x.fillRect(0, 0, W, H);
    if (type === 'woodDark' || type === 'woodLight') {
      for (let i = 0; i < 90; i++) {
        x.strokeStyle = type === 'woodDark' ? `rgba(${rnd() < 0.5 ? '20,12,8' : '110,85,66'},${0.08 + rnd() * 0.12})` : `rgba(${rnd() < 0.5 ? '120,80,40' : '235,210,170'},${0.1 + rnd() * 0.15})`;
        x.lineWidth = 1 + rnd() * 4;
        x.beginPath();
        const y0 = rnd() * H;
        x.moveTo(0, y0);
        for (let xx = 0; xx <= W; xx += 60) x.lineTo(xx, y0 + Math.sin(xx / 240 + i) * 16);
        x.stroke();
      }
    } else if (type === 'cloth') {
      x.fillStyle = 'rgba(60,90,150,.35)';
      for (let i = 0; i < W; i += 80) x.fillRect(i, 0, 36, H);
      for (let j = 0; j < H; j += 80) x.fillRect(0, j, W, 36);
    } else if (type === 'mat') {
      x.strokeStyle = 'rgba(220,240,230,.35)'; x.lineWidth = 1.5;
      for (let i = 0; i < W; i += 40) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, H); x.stroke(); }
      for (let j = 0; j < H; j += 40) { x.beginPath(); x.moveTo(0, j); x.lineTo(W, j); x.stroke(); }
    }
    return c;
  }

  function rot(p, rx, ry, rz) {
    let [x, y, z] = p;
    [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
    [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
    [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
    return [x, y, z];
  }

  function project(cfg, W, H, Z, tx, ty) {
    const f = 0.8 * Math.max(W, H);
    const pw = 210, ph = 210 * cfg.aspect;
    return [[-pw / 2, -ph / 2, 0], [pw / 2, -ph / 2, 0], [pw / 2, ph / 2, 0], [-pw / 2, ph / 2, 0]].map((p) => {
      const [x, y, z] = rot(p, cfg.rx, cfg.ry, cfg.rz);
      return [f * (x + tx) / (z + Z) + W / 2, f * (y + ty) / (z + Z) + H / 2];
    });
  }

  async function renderScene(cfg, seed) {
    const rnd = mulberry32(seed);
    const W = cfg.landscape ? 1600 : 1200, H = cfg.landscape ? 1200 : 1600;
    // 書類が画面の fill 割を占める距離を探す
    let Z = 1000;
    for (let k = 0; k < 6; k++) {
      const q = project(cfg, W, H, Z, 0, 0);
      Z *= Math.sqrt(Geo.area(q) / (cfg.fill * W * H));
    }
    // 書類が画面からはみ出さない範囲でずらす
    let q = null;
    for (let k = 0, shift = 60; k < 8; k++, shift /= 2) {
      q = project(cfg, W, H, Z, cfg.shiftX * shift, cfg.shiftY * shift);
      if (q.every(([x, y]) => x > 12 && y > 12 && x < W - 12 && y < H - 12)) break;
      if (k >= 3) Z *= 1.08;
    }
    if (params.get('out')) {
      // ?out=1: 書類の一部が画面の外に出るようにずらす（撮影画面で「はみ出し」を知らせられるかを見る）
      const xr = mulberry32(seed + 77);
      const ang = xr() * Math.PI * 2;
      const span = Math.max(...q.map((p) => p[0])) - Math.min(...q.map((p) => p[0]));
      const dx = Math.cos(ang) * span * (0.25 + xr() * 0.25), dy = Math.sin(ang) * span * (0.25 + xr() * 0.25);
      q = q.map(([x, y]) => [x + dx, y + dy]);
    }

    const bg = drawBackground(rnd, cfg.bg, W, H);
    const bx = bg.getContext('2d');
    if (params.get('clutter')) {
      // ?clutter=1: 机の上に、ほかの書類が 1〜3 枚、画面のふちにかかって置いてある
      const cr2 = mulberry32(seed + 44);
      const m = 1 + ((cr2() * 3) | 0);
      for (let k = 0; k < m; k++) {
        const side = (cr2() * 4) | 0;
        const cxp = side === 0 ? -0.05 : side === 1 ? 1.05 : cr2();
        const cyp = side === 2 ? -0.05 : side === 3 ? 1.05 : cr2();
        bx.save();
        bx.translate(cxp * W, cyp * H);
        bx.rotate((cr2() - 0.5) * 1.2);
        const pw = W * (0.35 + cr2() * 0.2), ph = pw * 1.414;
        bx.fillStyle = 'rgba(0,0,0,.3)'; bx.filter = 'blur(10px)'; bx.fillRect(-pw / 2 + 6, -ph / 2 + 9, pw, ph); bx.filter = 'none';
        bx.fillStyle = ['#f4f3ef', '#eef0f2', '#f6f1e2'][(cr2() * 3) | 0];
        bx.fillRect(-pw / 2, -ph / 2, pw, ph);
        bx.fillStyle = '#2a2d31'; bx.font = `${Math.round(pw / 30)}px sans-serif`;
        for (let y = -ph / 2 + pw * 0.12; y < ph / 2 - pw * 0.1; y += pw / 22) bx.fillText('会議資料 予定表 請求明細 打合せ記録 配布資料', -pw / 2 + pw * 0.08, y);
        bx.restore();
      }
    }
    if (cfg.under) {
      // 下に重なったもう1枚の紙（上の紙の影がこの上に落ちる）
      bx.fillStyle = '#ecebe6';
      bx.beginPath();
      q.forEach(([x, y], i) => (i ? bx.lineTo(x + 40, y - 30) : bx.moveTo(x + 40, y - 30)));
      bx.closePath(); bx.fill();
    }
    // 紙の落とす影
    bx.save();
    bx.filter = 'blur(14px)';
    bx.fillStyle = 'rgba(0,0,0,.45)';
    bx.beginPath();
    q.forEach(([x, y], i) => (i ? bx.lineTo(x + 8, y + 12) : bx.moveTo(x + 8, y + 12)));
    bx.closePath(); bx.fill();
    bx.restore();
    if (params.get('edge')) {
      // ?edge=1: 紙の厚みでできる、ふちのすぐ外の薄い影（実際の紙は、白い紙の上に置いてもふちがうっすら見える）
      bx.save();
      bx.filter = 'blur(1.5px)';
      bx.strokeStyle = 'rgba(0,0,0,.16)';
      bx.lineWidth = 3;
      bx.beginPath();
      q.forEach(([x, y], i) => (i ? bx.lineTo(x, y) : bx.moveTo(x, y)));
      bx.closePath(); bx.stroke();
      bx.restore();
    }
    if (cfg.pen) {
      bx.save(); bx.translate(q[1][0] + 30, q[1][1] + 200); bx.rotate(1.2); bx.fillStyle = '#16233a'; bx.fillRect(0, -9, 360, 18); bx.restore();
    }

    const doc = drawDoc(rnd, cfg.aspect, cfg.paper, cfg.kind);
    if (params.get('darkdoc')) {
      // ?darkdoc=1: 色の濃い書類（紺色の名刺やチラシのように、地が暗く文字が明るい）
      const dx = doc.getContext('2d');
      const id = dx.getImageData(0, 0, doc.width, doc.height), dd0 = id.data;
      for (let j = 0; j < dd0.length; j += 4) {
        dd0[j] = (40 + (255 - dd0[j]) * 0.7) * 0.85;
        dd0[j + 1] = (40 + (255 - dd0[j + 1]) * 0.7) * 0.95;
        dd0[j + 2] = (40 + (255 - dd0[j + 2]) * 0.7) * 1.3;
      }
      dx.putImageData(id, 0, 0);
    }
    const dw = doc.width, dh = doc.height;
    const dd = doc.getContext('2d').getImageData(0, 0, dw, dh).data;
    const img = bx.getImageData(0, 0, W, H);
    const d = img.data;
    const Hm = Geo.homography(q, [[0, 0], [dw, 0], [dw, dh], [0, dh]]);
    const lg = [Math.cos(cfg.lightDir), Math.sin(cfg.lightDir)];
    // ?real=1 のとき、約 3 割の紙は反っている（辺が弓なりになる。四隅の位置は変わらない）
    const cr = mulberry32(seed + 55);
    const curl = params.get('real') && cr() < 0.3 ? { ax: (cr() - 0.5) * 0.06, ay: (cr() - 0.5) * 0.06 } : null;
    const sh = cfg.shadow;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const j = (y * W + x) << 2;
        const nx = x / W - 0.5, ny = y / H - 0.5;
        let light = 1 + cfg.gradient * (nx * lg[0] + ny * lg[1]) - cfg.vignette * (nx * nx + ny * ny) * 2;
        if (sh) {
          const sx = (x / W - sh.x) / sh.r, sy = (y / H - sh.y) / sh.r;
          light *= 1 - sh.k * Math.exp(-(sx * sx + sy * sy));
        }
        let [u, v] = Geo.project(Hm, x + 0.5, y + 0.5);
        if (curl) {
          // 紙の座標を中ほどだけ伸び縮みさせて、辺を弓なりにする
          const su = 1 + curl.ax * Math.sin((Math.PI * v) / dh), sv = 1 + curl.ay * Math.sin((Math.PI * u) / dw);
          u = (u - dw / 2) * su + dw / 2;
          v = (v - dh / 2) * sv + dh / 2;
        }
        if (u >= 0 && v >= 0 && u < dw && v < dh) {
          const k = (((v | 0) * dw) + (u | 0)) << 2;
          d[j] = dd[k]; d[j + 1] = dd[k + 1]; d[j + 2] = dd[k + 2];
        }
        d[j] *= light * cfg.tint[0];
        d[j + 1] *= light * cfg.tint[1];
        d[j + 2] *= light * cfg.tint[2];
      }
    }
    const nz = mulberry32(seed + 7);
    for (let j = 0; j < d.length; j += 4) {
      const e = (nz() + nz() - 1) * cfg.noise;
      d[j] += e; d[j + 1] += e; d[j + 2] += e;
    }
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const cx = c.getContext('2d');
    cx.putImageData(img, 0, 0);
    if (params.get('real')) {
      // ?real=1: 実際の撮影でよくある邪魔を足す（場面の設定とは別の乱数で決める）
      const xr = mulberry32(seed + 99);
      // 書類を押さえる指。画面の外から書類のふちにかかる
      const nf = xr() < 0.6 ? 1 + (xr() < 0.35 ? 1 : 0) : 0;
      for (let f = 0; f < nf; f++) {
        const k = (xr() * 4) | 0;
        const t = 0.03 + xr() * 0.94;
        const P = q[k], Q = q[(k + 1) % 4];
        const ex = P[0] + (Q[0] - P[0]) * t, ey = P[1] + (Q[1] - P[1]) * t;
        const len = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
        let nx = -(Q[1] - P[1]) / len, ny = (Q[0] - P[0]) / len;
        const mx = (q[0][0] + q[2][0]) / 2, my = (q[0][1] + q[2][1]) / 2;
        if ((mx - ex) * nx + (my - ey) * ny < 0) { nx = -nx; ny = -ny; } // 内向き
        const fw = Math.max(W, H) * (0.035 + xr() * 0.02);
        const tipIn = fw * (0.6 + xr() * 1.2);
        const ang = (xr() - 0.5) * 0.8;
        const dxn = nx * Math.cos(ang) - ny * Math.sin(ang), dyn = nx * Math.sin(ang) + ny * Math.cos(ang);
        const ax = ex - dxn * Math.max(W, H), ay = ey - dyn * Math.max(W, H);
        const bx = ex + dxn * tipIn, by = ey + dyn * tipIn;
        const g = cx.createLinearGradient(bx - dyn * fw, by + dxn * fw, bx + dyn * fw, by - dxn * fw);
        const tone = [[224, 172, 140], [198, 140, 108], [240, 200, 170], [150, 100, 72]][(xr() * 4) | 0];
        g.addColorStop(0, `rgb(${tone.map((v) => v * 0.75 | 0)})`);
        g.addColorStop(0.5, `rgb(${tone})`);
        g.addColorStop(1, `rgb(${tone.map((v) => v * 0.8 | 0)})`);
        cx.save();
        cx.lineCap = 'round';
        cx.strokeStyle = 'rgba(0,0,0,.25)'; cx.lineWidth = fw * 2.1; cx.filter = 'blur(6px)';
        cx.beginPath(); cx.moveTo(ax + 6, ay + 8); cx.lineTo(bx + 6, by + 8); cx.stroke();
        cx.filter = 'none'; cx.strokeStyle = g; cx.lineWidth = fw * 2;
        cx.beginPath(); cx.moveTo(ax, ay); cx.lineTo(bx, by); cx.stroke();
        cx.restore();
      }
      // つやのある紙の照り返し
      if (xr() < 0.3) {
        const gx0 = q[0][0] + (q[2][0] - q[0][0]) * (0.2 + xr() * 0.6), gy0 = q[0][1] + (q[2][1] - q[0][1]) * (0.2 + xr() * 0.6);
        const rr = Math.max(W, H) * (0.06 + xr() * 0.1);
        const g = cx.createRadialGradient(gx0, gy0, 0, gx0, gy0, rr);
        g.addColorStop(0, 'rgba(255,255,255,.85)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        cx.fillStyle = g; cx.fillRect(gx0 - rr, gy0 - rr, rr * 2, rr * 2);
      }
    }
    if (cfg.blur) {
      const c2 = document.createElement('canvas');
      c2.width = W; c2.height = H;
      const x2 = c2.getContext('2d');
      x2.filter = `blur(${cfg.blur}px)`;
      x2.drawImage(c, 0, 0);
      cx.drawImage(c2, 0, 0);
    }
    if (params.get('real')) {
      // ?real=1: 暗い部屋（暗く、ざらつく）と、手ぶれ・ピンぼけ（強いぼかし）も 2 割ずつ混ぜる
      const er = mulberry32(seed + 33);
      if (er() < 0.2) {
        const c2 = document.createElement('canvas');
        c2.width = W; c2.height = H;
        const x2 = c2.getContext('2d');
        x2.filter = `blur(${(2.5 + er() * 2).toFixed(1)}px)`;
        x2.drawImage(c, 0, 0);
        cx.drawImage(c2, 0, 0);
      }
      if (er() < 0.2) {
        const id = cx.getImageData(0, 0, W, H), dd2 = id.data;
        const k = 0.35 + er() * 0.2, sigma = 12 + er() * 10;
        const nr = mulberry32(seed + 34);
        for (let j = 0; j < dd2.length; j += 4) {
          const e = (nr() + nr() + nr() - 1.5) * sigma;
          dd2[j] = dd2[j] * k + e; dd2[j + 1] = dd2[j + 1] * k + e * 0.9; dd2[j + 2] = dd2[j + 2] * k + e * 1.1;
        }
        cx.putImageData(id, 0, 0);
      }
    }
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    const bmp = await createImageBitmap(blob);
    return { bmp, gt: Geo.orderQuad(q), W, H };
  }

  // ?n=108 で場面を増やす（先頭の 54 場面は同じ）
  function configs(count = 54) {
    const rnd = mulberry32(2026);
    const pick = (arr) => arr[(rnd() * arr.length) | 0];
    const between = (a, b) => a + rnd() * (b - a);
    const list = [];
    const bgs = ['woodDark', 'woodLight', 'gray', 'white', 'black', 'cloth', 'mat', 'blue', 'beige'];
    const kinds = ['text', 'table', 'dense', 'photo'];
    for (let i = 0; i < count; i++) {
      const hard = i % 3 === 2;
      const aspect = i % 9 === 4 ? 2.6 : i % 9 === 7 ? 1.294 : 1.4142;
      list.push({
        name: `#${String(i + 1).padStart(2, '0')}`,
        seed: 100 + i,
        bg: bgs[i % bgs.length],
        kind: aspect > 2 ? 'receipt' : pick(kinds),
        aspect,
        paper: pick(['#f7f7f3', '#f3eedc', '#ebe9e3']),
        landscape: rnd() < 0.2,
        rx: between(-0.55, 0.55) * (hard ? 1.2 : 0.7),
        ry: between(-0.35, 0.35) * (hard ? 1.2 : 0.7),
        rz: between(-0.6, 0.6) * (hard ? 1.3 : 0.6),
        fill: between(hard ? 0.2 : 0.3, 0.6),
        shiftX: between(-1, 1),
        shiftY: between(-1, 1),
        gradient: between(0, 0.35),
        vignette: between(0, 0.35),
        lightDir: between(0, Math.PI * 2),
        shadow: rnd() < 0.5 ? { x: between(0.3, 0.7), y: between(0.4, 0.9), r: between(0.12, 0.3), k: between(0.15, 0.4) } : null,
        tint: pick([[1, 1, 1], [1.02, 0.97, 0.88], [0.94, 0.98, 1.04]]),
        noise: between(3, 12),
        blur: rnd() < 0.3 ? 1.2 : 0,
        under: hard && rnd() < 0.35,
        pen: rnd() < 0.3,
      });
    }
    return list;
  }

  function evaluate(quadN, gt, W, H) {
    if (!quadN) return { found: false, err: Infinity };
    const q = Geo.orderQuad(quadN.map(([x, y]) => [x * W, y * H]));
    const err = Math.max(...q.map((p, i) => Geo.dist(p, gt[i]))) / Math.max(W, H);
    return { found: true, err, q };
  }

  // 撮影中の映像と同じ形（NV12 の VideoFrame、BT.601 制限付き）にした場面。?yuv=1 で、検出に Imaging.framePixels を通す
  function toNV12Frame(bmp) {
    const W = bmp.width & ~1, H = bmp.height & ~1;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(bmp, 0, 0);
    const d = x.getImageData(0, 0, W, H).data;
    const buf = new Uint8Array((W * H * 3) / 2);
    for (let i = 0, p = 0; i < W * H; i++, p += 4) buf[i] = Math.round(16 + (65.481 * d[p] + 128.553 * d[p + 1] + 24.966 * d[p + 2]) / 255);
    for (let j = 0; j < H / 2; j++) {
      for (let i = 0; i < W / 2; i++) {
        let r = 0, g = 0, b = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const p = ((j * 2 + dy) * W + i * 2 + dx) * 4; r += d[p] / 4; g += d[p + 1] / 4; b += d[p + 2] / 4; }
        buf[W * H + j * W + i * 2] = Math.round(128 + (-37.797 * r - 74.203 * g + 112 * b) / 255);
        buf[W * H + j * W + i * 2 + 1] = Math.round(128 + (112 * r - 93.786 * g - 18.214 * b) / 255);
      }
    }
    return new VideoFrame(buf, { format: 'NV12', codedWidth: W, codedHeight: H, timestamp: 0, colorSpace: { matrix: 'smpte170m', primaries: 'smpte170m', transfer: 'smpte170m', fullRange: false } });
  }

  // ?steady=1: 自動撮影の試験。書類に向けて構え（はじめの 0.6 秒で 6% 動いて止まる）、そのあとは手ぶれ程度に揺れる映像で、
  // 撮影画面と同じ手順（AutoShot）で検出を続け、シャッターが切れるまでの時間を測る。
  // 撮れたあとは 2 秒構えたまま（同じページを二重に撮らないか）、1.2 秒手で書類を隠して同じ位置に次のページを置いたことにし、
  // 次のページが撮れるまでの時間も測る。
  // 1 回の検出にかかる時間は、スマホの目安として、追いかけ 36ms・画面全体 110ms とみなす（パソコンの混み具合で結果が変わらないように）。
  // ?shake=2 で手ぶれを 2 倍にする
  async function steadyRun(list) {
    const shake = params.has('shake') ? Number(params.get('shake')) : 1;
    const SETTLE = 600, LIMIT = 5000;
    // ?cfg={"wait":400} で、自動撮影の決まりごと（AutoShot.config）を変えて試す
    if (params.get('cfg')) Object.assign(AutoShot.config, JSON.parse(params.get('cfg')));
    const rows = [];
    const cv = document.createElement('canvas');
    const cx = cv.getContext('2d', { willReadFrequently: true });
    const errOf = (qn, gt) => {
      if (!qn) return Infinity;
      const a = Geo.orderQuad(qn), b = Geo.orderQuad(gt);
      const k = cv.width / Math.max(cv.width, cv.height), l = cv.height / Math.max(cv.width, cv.height);
      return Math.max(...a.map((p, i) => Math.hypot((p[0] - b[i][0]) * k, (p[1] - b[i][1]) * l)));
    };
    for (let i = 0; i < list.length; i++) {
      const cfg = list[i];
      status.textContent = `${i + 1} / ${list.length}`;
      const scene = await renderScene(cfg, cfg.seed);
      const { W, H } = scene;
      if (!scene.gt.every(([x, y]) => x > 2 && y > 2 && x < W - 2 && y < H - 2)) { scene.bmp.close(); continue; }
      const r = mulberry32(cfg.seed + 300);
      const L = Math.max(W, H);
      // 手の動き: ゆっくりした揺れ（0.3〜0.8 Hz）と細かな震え（8〜12 Hz）
      const wave = (amp, f0, f1) => { const f = f0 + r() * (f1 - f0), ph = r() * Math.PI * 2; return (t) => amp * Math.sin((2 * Math.PI * f * t) / 1000 + ph); };
      const both = (a, b) => (t) => a(t) + b(t);
      const dx = both(wave(0.004 * L * shake, 0.3, 0.8), wave(0.0012 * L * shake, 8, 12));
      const dy = both(wave(0.004 * L * shake, 0.3, 0.8), wave(0.0012 * L * shake, 8, 12));
      const da = both(wave(0.0026 * shake, 0.3, 0.8), wave(0.0007 * shake, 8, 12)); // 0.15° と 0.04°
      const ds = wave(0.002 * shake, 0.2, 0.6);
      const ang0 = r() * Math.PI * 2;
      const pose = (t) => {
        const k = t < SETTLE ? (1 - t / SETTLE) ** 2 : 0; // 構える間の動き（だんだん遅くなって止まる）
        return { x: dx(t) + Math.cos(ang0) * 0.06 * L * k, y: dy(t) + Math.sin(ang0) * 0.06 * L * k, a: da(t), s: 1 + ds(t) };
      };
      const nz = mulberry32(cfg.seed + 301);
      // ページを入れ替える手（腕ごと画面の外から書類の中ほどまで伸びて、戻る）
      const mid = [scene.gt.reduce((a, p) => a + p[0], 0) / 4, scene.gt.reduce((a, p) => a + p[1], 0) / 4];
      const docR = Geo.dist(scene.gt[0], scene.gt[2]) / 2;
      const handDir = r() * Math.PI * 2;
      let occFrom = Infinity, occTo = -Infinity;
      const hand = (t) => {
        if (t < occFrom || t > occTo) return null;
        const k = Math.sin((Math.PI * (t - occFrom)) / (occTo - occFrom));
        const far = docR * 2.2 * (1 - k) + docR * 0.1;
        return [mid[0] + Math.cos(handDir) * far, mid[1] + Math.sin(handDir) * far];
      };
      const frameAt = (t, lg) => {
        const sc = lg / L, w = Math.round(W * sc), h = Math.round(H * sc);
        if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
        cx.imageSmoothingQuality = 'high';
        // ずらして空いた画面のふちは、ずらす前の画像で埋める
        cx.setTransform(1, 0, 0, 1, 0, 0);
        cx.drawImage(scene.bmp, 0, 0, w, h);
        const p = pose(t);
        const c = Math.cos(p.a) * p.s, s = Math.sin(p.a) * p.s;
        // 画面の中心のまわりに回して拡大し、ずらす（元の画像の座標 → 縮めたコマの座標）
        const m = [c * sc, s * sc, -s * sc, c * sc, (W / 2 + p.x - (c * W) / 2 + (s * H) / 2) * sc, (H / 2 + p.y - (s * W) / 2 - (c * H) / 2) * sc];
        cx.setTransform(...m);
        cx.drawImage(scene.bmp, 0, 0);
        const hp = hand(t);
        if (hp) {
          cx.lineCap = 'round';
          cx.strokeStyle = 'rgb(214, 160, 128)';
          cx.lineWidth = docR * 0.9;
          cx.beginPath();
          cx.moveTo(mid[0] + Math.cos(handDir) * docR * 6, mid[1] + Math.sin(handDir) * docR * 6);
          cx.lineTo(hp[0], hp[1]);
          cx.stroke();
        }
        const id = cx.getImageData(0, 0, w, h), d = id.data;
        // 撮影ごとの明るさの揺れと、ざらつき
        const gain = 1 + (nz() - 0.5) * 0.03;
        for (let j = 0; j < d.length; j += 4) {
          const e = (nz() + nz() - 1) * 4;
          d[j] = d[j] * gain + e; d[j + 1] = d[j + 1] * gain + e; d[j + 2] = d[j + 2] * gain + e;
        }
        const gt = scene.gt.map(([x, y]) => [(m[0] * x + m[2] * y + m[4]) / w, (m[1] * x + m[3] * y + m[5]) / h]);
        return { px: { data: d, w, h }, gt };
      };
      // 止まったときの書類が画面のふちすれすれ（1.5% 以内）なら、はみ出しとして撮らないのが正しいので別に数える
      const rest = frameAt(SETTLE, 320).gt;
      const tight = rest.some(([x, y]) => x < 0.015 || y < 0.015 || x > 0.985 || y > 0.985);
      const st = AutoShot.create();
      let now = 0, fire = null, resets = 0, wasStable = false, seen = null, stable = null, n = 0;
      let dup = 0, occFire = 0, next = null;
      const trace = [];
      while (fire ? now < occTo + 3000 : now < SETTLE + LIMIT) {
        const { track, slow } = AutoShot.plan(st);
        const lg = track ? 320 : 384;
        const fr = frameAt(now, lg);
        const found = Detect.find(fr.px, { long: lg, prior: st.quad, quick: true, track, ...(track && st.dark ? { invert: true } : {}) });
        n++;
        // 確かめるだけの検出で受け入れられなかったときは、続けて画面全体を探すので、その分もかかる
        const spent = track ? (found && found.tracked ? 36 : 146) : 110;
        now += spent;
        const res = AutoShot.update(st, found, now, {});
        // ?only= で場面を絞ったときは、1 回ごとの様子を残す
        if (only) trace.push({ t: Math.round(now - SETTLE), track, score: found ? +found.score.toFixed(2) : 0, err: found ? +(errOf(found.quad, fr.gt) * 100).toFixed(1) : null, still: st.stableSince ? Math.round(st.stableSince - SETTLE) : null, clipped: st.clipped, jump: !!st.jump, p: +res.progress.toFixed(2) });
        if (st.quad && seen === null) seen = now;
        if (st.stableSince && stable === null) stable = now;
        if (wasStable && !st.stableSince && !res.fire) resets++;
        wasStable = !!st.stableSince;
        if (res.fire && fire) {
          // 2 枚目: 構えたままなら二重撮り、手で隠している間なら手を撮った、そのあとなら次のページ
          if (now < occFrom) dup++;
          else if (now <= occTo) occFire++;
          else { next = Math.round(now - occTo); break; }
        } else if (res.fire) {
          // シャッターを切ったときの手の動きの速さ（長辺に対する割合 / 秒。速いと写真がぶれる）
          const a = pose(now - 10), b = pose(now + 10);
          fire = { t: now, err: errOf(st.quad, fr.gt), speed: Math.hypot(b.x - a.x, b.y - a.y) / L / 0.02 };
          occFrom = now + 2000;
          occTo = occFrom + 1200;
        }
        now += Math.max(80 * slow - spent, spent * 0.5, 10);
      }
      rows.push({
        name: cfg.name, bg: cfg.bg, kind: cfg.kind, tight, n, resets,
        seen: seen === null ? null : Math.round(seen - SETTLE), stable: stable === null ? null : Math.round(stable - SETTLE),
        fired: fire ? Math.round(fire.t - SETTLE) : null, err: fire ? fire.err : null, speed: fire ? fire.speed : null, dup, occFire, next, trace,
      });
      scene.bmp.close();
    }
    const ok = rows.filter((row) => !row.tight);
    const within = (ms) => ok.filter((row) => row.fired !== null && row.fired <= ms).length;
    const times = ok.filter((row) => row.fired !== null).map((row) => row.fired).sort((a, b) => a - b);
    const summary = {
      scenes: ok.length, tight: rows.length - ok.length,
      within1000: within(1000), within1500: within(1500), within2000: within(2000), within3000: within(3000),
      never: ok.filter((row) => row.fired === null).length,
      median: times.length ? times[times.length >> 1] : null,
      early: ok.filter((row) => row.fired !== null && row.fired < 0).length,
      wrong: ok.filter((row) => row.err !== null && row.err > 0.03).length,
      tightFired: rows.filter((row) => row.tight && row.fired !== null).length,
      dup: ok.filter((row) => row.dup).length, occFire: ok.filter((row) => row.occFire).length,
      next1000: ok.filter((row) => row.next !== null && row.next <= 1000).length, next2000: ok.filter((row) => row.next !== null && row.next <= 2000).length,
      noNext: ok.filter((row) => row.fired !== null && row.next === null).length,
      speed: (() => { const v = ok.filter((row) => row.speed !== null).map((row) => row.speed).sort((a, b) => a - b); return v.length ? { median: v[v.length >> 1], max: v[v.length - 1] } : null; })(),
    };
    status.textContent = JSON.stringify(summary);
    window.__bench = { steady: summary, rows };
  }

  const params = new URLSearchParams(location.search);
  const long = Number(params.get('long')) || 480;
  const quick = params.get('quick') === '1';
  // ?yuv=canvas は同じ VideoFrame をキャンバスで縮める（前の版の取り出し方）
  const yuv = params.get('yuv');
  const only = params.get('only');
  // ?fill=0.7-0.92 で、書類が画面に占める割合を変える（スマホでは画面いっぱいに撮ることが多い）
  const fillRange = (params.get('fill') || '').split('-').map(Number);
  const list = configs(Number(params.get('n')) || 54)
    .map((c, i) => (fillRange.length === 2 && fillRange.every(Number.isFinite)
      ? { ...c, fill: fillRange[0] + ((i * 0.618) % 1) * (fillRange[1] - fillRange[0]) }
      : c))
    // ?tilt=1.5: 斜めの具合（前後・左右の傾き）を何倍かにする
    .map((c) => (params.get('tilt') ? { ...c, rx: c.rx * Number(params.get('tilt')), ry: c.ry * Number(params.get('tilt')) } : c))
    .filter((c) => !only || only.split(',').includes(c.name));
  const status = document.getElementById('status');
  const grid = document.getElementById('grid');
  if (params.get('steady')) { await steadyRun(list); return; }
  const rows = [];
  for (let i = 0; i < list.length; i++) {
    const cfg = list[i];
    status.textContent = `${i + 1} / ${list.length}`;
    const scene = await renderScene(cfg, cfg.seed);
    // 書類の一部が画面の外に出ている場面は対象外
    const inside = scene.gt.every(([x, y]) => x > 2 && y > 2 && x < scene.W - 2 && y < scene.H - 2);
    let t0 = performance.now();
    const v1 = evaluate(typeof DetectV1 !== 'undefined' ? DetectV1.detect(scene.bmp, long) : null, scene.gt, scene.W, scene.H);
    const t1 = performance.now() - t0;
    const aspectOpt = params.get('aspect') ? Number(params.get('aspect')) : null;
    t0 = performance.now();
    const prevFound = typeof DetectV2 !== 'undefined' ? DetectV2.find(scene.bmp, { long, aspect: aspectOpt, quick, refineLong: Number(params.get('refine')) || 0 }) : null;
    const tp = performance.now() - t0;
    const prev = evaluate(prevFound && prevFound.quad, scene.gt, scene.W, scene.H);
    let source = scene.bmp;
    const frame = yuv ? toNV12Frame(scene.bmp) : null;
    t0 = performance.now();
    if (yuv === 'canvas') source = frame;
    else if (frame) source = await Imaging.framePixels(frame, long);
    // ?exp=a,b で、検出の試験中の切り替え（exp.a = true）を渡す
    const exp = Object.fromEntries((params.get('exp') || '').split(',').filter(Boolean).map((k) => [k, true]));
    const timing = params.get('timing') ? {} : null;
    // ?prior=near / far: 撮影画面の枠（直前の位置）として、正解の近く（±0.5%）か、10% ずれた位置を渡す
    let priorOpt = null;
    if (params.get('prior')) {
      const pr = mulberry32(cfg.seed + 9);
      const gtN = scene.gt.map(([x, y]) => [x / scene.W, y / scene.H]);
      const ang = pr() * Math.PI * 2;
      priorOpt = params.get('prior') === 'live'
        ? (() => { const r = Detect.find(source, { long: 384, aspect: aspectOpt, quick: true }); return r && r.score >= 0.45 ? r.quad : null; })()
        : params.get('prior') === 'far'
        ? gtN.map(([x, y]) => [x + Math.cos(ang) * 0.1, y + Math.sin(ang) * 0.1])
        : gtN.map(([x, y]) => [x + (pr() - 0.5) * 0.01, y + (pr() - 0.5) * 0.01]);
    }
    const found = Detect.find(source, { long, aspect: aspectOpt, quick, exp, timing, prior: priorOpt, refineLong: Number(params.get('refine')) || 0, debug: !!only });
    const t2 = performance.now() - t0;
    if (frame) frame.close();
    const v2 = evaluate(found && found.quad, scene.gt, scene.W, scene.H);
    const edgeOf = (qn) => (!qn ? 'none' : qn.some(([x, y]) => x < 0.012 || y < 0.012 || x > 0.988 || y > 0.988) ? 'touch' : 'inner');
    // 縦横比の見積もり: 正解の四隅から求めた幅/高さと、本当の 1/aspect を比べる（素朴な辺の長さの比とも比べる）
    const trueRatio = 1 / cfg.aspect;
    const est = Geo.estimateAspect(scene.gt, scene.W, scene.H);
    const out = Geo.outputAspect(scene.gt, scene.W, scene.H, null);
    const sz = Geo.quadSize(scene.gt);
    const row = {
      name: cfg.name, bg: cfg.bg, kind: cfg.kind, inside, edge: edgeOf(found && found.quad), v1: v1.err, prev: prev.err, v2: v2.err, score: found ? found.score : 0, t1, tp, t2,
      aspZhang: est ? Math.abs(est / trueRatio - 1) : 1,
      aspOut: Math.abs(out / trueRatio - 1),
      aspNaive: Math.abs(sz.w / sz.h / trueRatio - 1),
    };
    if (only && found) {
      // 調べるとき用: 正解の四角形の点数と、上位の候補
      const gtN = scene.gt.map(([x, y]) => [x / scene.W, y / scene.H]);
      row.gtScore = found.debug.scoreOf(gtN);
      row.gtExplain = found.debug.explain(gtN);
      row.gtFast = found.debug.fastOf(gtN);
      row.bestExplain = found.debug.explain(found.quad);
      row.unrefinedErr = evaluate(found.debug.unrefined, scene.gt, scene.W, scene.H).err;
      row.refined = found.debug.refined.map((c) => ({ from: c.from, s: c.s, err: +evaluate(c.q, scene.gt, scene.W, scene.H).err.toFixed(4), area: +(Geo.area(c.q.map(([x, y]) => [x, y])) ).toFixed(3) }));
      row.regions = found.debug.regions.map((c) => ({ from: c.from, s: c.s, err: +evaluate(c.q, scene.gt, scene.W, scene.H).err.toFixed(4) }));
      row.top = found.debug.top.map((c) => ({ from: c.from, s: c.s, err: +evaluate(c.q, scene.gt, scene.W, scene.H).err.toFixed(4) }));
      // 正解の各辺に近い直線が、直線の候補に入っているか（角度 3° と 1.5% 以内）
      const [dw, dh] = found.debug.size;
      const g = scene.gt.map(([x, y]) => [x * dw / scene.W, y * dh / scene.H]);
      const near = (l, A, B, t) => {
        const d = Math.abs(l.t - t);
        if (Math.min(d, 180 - d) > 3) return false;
        const c = Math.cos(l.t * Math.PI / 180), s = Math.sin(l.t * Math.PI / 180);
        const tol = 0.015 * Math.max(dw, dh);
        return Math.abs(c * A[0] + s * A[1] - l.rho) <= tol && Math.abs(c * B[0] + s * B[1] - l.rho) <= tol;
      };
      row.gtLines = g.map((P, k) => {
        const Q = g[(k + 1) % 4];
        let t = Math.atan2(Q[1] - P[1], Q[0] - P[0]) * 180 / Math.PI + 90;
        t = ((t % 180) + 180) % 180;
        const c = Math.cos(t * Math.PI / 180), s = Math.sin(t * Math.PI / 180);
        const rho = c * P[0] + s * P[1];
        const hit = found.debug.lines.findIndex((l) => near(l, P, Q, t));
        return hit;
      });
      row.nLines = found.debug.lines.length;
      // 直線の候補の上限をなくして、正解の各辺の票数と順位を調べる
      {
        const P = Detect._parts;
        const cv = document.createElement('canvas'); cv.width = dw; cv.height = dh;
        const cx2 = cv.getContext('2d', { willReadFrequently: true }); cx2.imageSmoothingQuality = 'high';
        cx2.drawImage(scene.bmp, 0, 0, dw, dh);
        const ctx = P.makeContext({ data: cx2.getImageData(0, 0, dw, dh).data, w: dw, h: dh });
        const edges = P.thinEdges(ctx.gx, ctx.gy, ctx.mag, dw, dh, 0.15 * ctx.gscale);
        const all = P.houghLines(edges, ctx.gx, ctx.gy, dw, dh, 400, 1, 400);
        row.gtVotes = g.map((Pt, k) => {
          const Q = g[(k + 1) % 4];
          let t = Math.atan2(Q[1] - Pt[1], Q[0] - Pt[0]) * 180 / Math.PI + 90;
          t = ((t % 180) + 180) % 180;
          const cc = Math.cos(t * Math.PI / 180), ss = Math.sin(t * Math.PI / 180);
          const rho = cc * Pt[0] + ss * Pt[1];
          const i = all.findIndex((l) => near(l, Pt, Q, t));
          return i < 0 ? 'なし' : `${i}位/${all[i].votes}票`;
        });
        if (params.get('viz')) {
          // ?viz=1: 境目の点（白）と、正解（緑）・選ばれた直線（赤）を描く
          const vc = document.createElement('canvas'); vc.width = dw; vc.height = dh;
          const vx = vc.getContext('2d');
          const id = vx.createImageData(dw, dh);
          for (let i = 0; i < dw * dh; i++) { const v = edges[i] ? 255 : Math.min(120, ctx.mag[i] / ctx.gscale * 255); id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
          vx.putImageData(id, 0, 0);
          vx.strokeStyle = '#22c55e'; vx.lineWidth = 1; vx.beginPath(); g.forEach(([x, y], k) => (k ? vx.lineTo(x, y) : vx.moveTo(x, y))); vx.closePath(); vx.stroke();
          vx.strokeStyle = 'rgba(255,60,60,.7)';
          for (const l of all.slice(0, 12)) { const cc = Math.cos(l.t * Math.PI / 180), ss = Math.sin(l.t * Math.PI / 180); vx.beginPath(); vx.moveTo(cc * l.rho - ss * 2000, ss * l.rho + cc * 2000); vx.lineTo(cc * l.rho + ss * 2000, ss * l.rho - cc * 2000); vx.stroke(); }
          vc.style.cssText = 'width:480px;image-rendering:pixelated;margin:4px';
          document.getElementById('grid').before(vc);
          // 紙らしさ（明るさ − 彩度）の地図と、大津の方法で分けた塊
          const p2 = Detect._parts.halve(ctx.P, dw, dh);
          let hist = new Uint32Array(256); for (const v of p2.map) hist[Math.max(0, Math.min(255, v | 0))]++;
          const th = Imaging.otsu(hist, p2.map.length);
          const mc = document.createElement('canvas'); mc.width = p2.w; mc.height = p2.h;
          const mx = mc.getContext('2d'); const md = mx.createImageData(p2.w, p2.h);
          for (let i = 0; i < p2.map.length; i++) { const v = Math.max(0, Math.min(255, p2.map[i])); md.data[i * 4] = p2.map[i] > th ? 255 : v * 0.4; md.data[i * 4 + 1] = v * 0.4; md.data[i * 4 + 2] = v * 0.4; md.data[i * 4 + 3] = 255; }
          mx.putImageData(md, 0, 0);
          mc.style.cssText = 'width:480px;image-rendering:pixelated;margin:4px';
          document.getElementById('grid').before(mc);
        }
        row.voteTop = all.slice(0, 24).map((l) => `${l.t}°:${l.votes}`).join(' ');
      }
      row.cornerErr = v2.q ? v2.q.map((p, k) => Math.round(Geo.dist(p, scene.gt[k]))) : null;
    }
    if (params.get('track')) {
      // ?track=1: 撮影中の「追いかけ」。正解の近く（±0.5%）を直前の位置として渡したときのずれと、
      // 10% ずらした位置を渡したときに、誤って受け入れてしまうか
      const tr = mulberry32(cfg.seed + 5);
      const gtN = scene.gt.map(([x, y]) => [x / scene.W, y / scene.H]);
      const near = gtN.map(([x, y]) => [x + (tr() - 0.5) * 0.01, y + (tr() - 0.5) * 0.01]);
      const t0 = performance.now();
      // アプリと同じく、反転した画像で見つけた（地の色が濃い）書類は、反転した画像だけで追いかける
      const dark = found && found.dark ? { invert: true } : {};
      const a = Detect.find(source, { long, aspect: aspectOpt, quick: true, prior: near, track: true, exp, ...dark });
      row.trackMs = performance.now() - t0;
      row.tracked = !!(a && a.tracked);
      row.trackErr = evaluate(a && a.quad, scene.gt, scene.W, scene.H).err;
      const ang = tr() * Math.PI * 2;
      const far = gtN.map(([x, y]) => [x + Math.cos(ang) * 0.1, y + Math.sin(ang) * 0.1]);
      const f = Detect.find(source, { long, aspect: aspectOpt, quick: true, prior: far, track: true, exp, ...dark });
      row.farTracked = !!(f && f.tracked);
      row.farErr = evaluate(f && f.quad, scene.gt, scene.W, scene.H).err;
    }
    if (timing) { delete timing._t; row.timing = timing; }
    rows.push(row);

    const fig = document.createElement('figure');
    const c = document.createElement('canvas');
    const s = 240 / Math.max(scene.W, scene.H);
    c.width = scene.W * s; c.height = scene.H * s;
    const x = c.getContext('2d');
    x.drawImage(scene.bmp, 0, 0, c.width, c.height);
    const poly = (q, color, wdt) => { x.strokeStyle = color; x.lineWidth = wdt; x.beginPath(); q.forEach(([px, py], k) => (k ? x.lineTo(px * s, py * s) : x.moveTo(px * s, py * s))); x.closePath(); x.stroke(); };
    poly(scene.gt, '#22c55e', 3);
    if (v1.q) poly(v1.q, '#f97316', 1.5);
    if (v2.q) poly(v2.q, '#06b6d4', 1.5);
    const cap = document.createElement('figcaption');
    const fmt = (e) => (Number.isFinite(e) ? `${(e * 100).toFixed(1)}%` : '×');
    cap.textContent = `${cfg.name} ${cfg.bg}/${cfg.kind}  旧 ${fmt(v1.err)}  新 ${fmt(v2.err)}`;
    fig.append(c, cap);
    grid.append(fig);
    scene.bmp.close();
  }

  if (params.get('out')) {
    // はみ出した場面: 検出した四角形が画面のふち（1.2% 以内）に触れていれば「はみ出し」を知らせられる。
    // ふちに触れず内側の別の四角形を返したら誤り、見つからなければ「四隅が入るように」の案内になる
    const out = rows.filter((r) => !r.inside);
    const touch = out.filter((r) => r.edge === 'touch').length, inner = out.filter((r) => r.edge === 'inner').length, none = out.filter((r) => r.edge === 'none').length;
    const summaryOut = { scenes: out.length, touch, inner, none, innerNames: out.filter((r) => r.edge === 'inner').map((r) => r.name) };
    status.textContent = JSON.stringify(summaryOut);
    window.__bench = { profile: summaryOut, rows };
    return;
  }
  const valid = rows.filter((r) => r.inside);
  const rate = (key, lim) => valid.filter((r) => r[key] < lim).length / valid.length;
  const median = (arr) => { const a = arr.slice().sort((p, q) => p - q); return a[(a.length / 2) | 0]; };
  const summary = {
    scenes: valid.length,
    v1: { ok15: rate('v1', 0.015), ok08: rate('v1', 0.008), median: median(valid.map((r) => r.v1)), ms: median(valid.map((r) => r.t1)) },
    prev: { ok15: rate('prev', 0.015), ok08: rate('prev', 0.008), ok03: rate('prev', 0.003), median: median(valid.map((r) => r.prev)), ms: median(valid.map((r) => r.tp)) },
    v2: { ok15: rate('v2', 0.015), ok08: rate('v2', 0.008), ok03: rate('v2', 0.003), median: median(valid.map((r) => r.v2)), ms: median(valid.map((r) => r.t2)) },
    aspect: {
      naiveMedian: median(rows.map((r) => r.aspNaive)),
      naiveWithin3: rows.filter((r) => r.aspNaive < 0.03).length / rows.length,
      outMedian: median(rows.map((r) => r.aspOut)),
      outWithin3: rows.filter((r) => r.aspOut < 0.03).length / rows.length,
    },
  };
  status.textContent = JSON.stringify(summary);
  window.__bench = { summary, rows };
})();
