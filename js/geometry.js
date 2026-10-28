// 四角形・射影変換まわりの計算
const Geo = (() => {
  'use strict';

  // 部分ピボット付きのガウスの消去法で A x = b を解く
  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-12) return null;
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        if (!f) continue;
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  // src の4点を dst の4点へ移す射影変換（3x3 行列を長さ9の配列で返す）
  function homography(src, dst) {
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i];
      const [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b);
    return h ? [...h, 1] : null;
  }

  function project(h, x, y) {
    const d = h[6] * x + h[7] * y + h[8];
    return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
  }

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  function area(pts) {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(s) / 2;
  }

  // 左上・右上・右下・左下の順に並べ替える（画面座標なので y は下向き）
  function orderQuad(pts) {
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const sorted = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    let start = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i][0] + sorted[i][1] < sorted[start][0] + sorted[start][1]) start = i;
    }
    return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
  }

  function isConvex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) < 1e-9) return false;
      const s = Math.sign(cross);
      if (sign && s !== sign) return false;
      sign = s;
    }
    return true;
  }

  // 各頂点の内角（度）
  function angles(q) {
    return q.map((p, i) => {
      const a = q[(i + 3) % 4], c = q[(i + 1) % 4];
      const v1 = [a[0] - p[0], a[1] - p[1]];
      const v2 = [c[0] - p[0], c[1] - p[1]];
      const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1);
      return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    });
  }

  // 補正後の幅と高さ（向かい合う辺の長い方）
  function quadSize(q) {
    return {
      w: Math.max(dist(q[0], q[1]), dist(q[3], q[2])),
      h: Math.max(dist(q[0], q[3]), dist(q[1], q[2])),
    };
  }

  // Andrew の単調連鎖法による凸包
  function convexHull(points) {
    const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
  }

  function lineIntersect(p1, p2, p3, p4) {
    const d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
    if (Math.abs(d) < 1e-9) return null;
    const a = p1[0] * p2[1] - p1[1] * p2[0];
    const b = p3[0] * p4[1] - p3[1] * p4[0];
    return [
      (a * (p3[0] - p4[0]) - (p1[0] - p2[0]) * b) / d,
      (a * (p3[1] - p4[1]) - (p1[1] - p2[1]) * b) / d,
    ];
  }

  // 凸多角形を外接する四角形に縮める。
  // 足される面積がいちばん小さい辺を消し、両隣の辺を延長した交点で置き換えることを繰り返す。
  // 角が丸く写った紙でも、内側に削らず本来の角に近い点が残る。
  function hullToQuad(hull) {
    const pts = hull.slice();
    while (pts.length > 4) {
      const n = pts.length;
      let best = -1;
      let bestArea = Infinity;
      let bestPoint = null;
      for (let i = 0; i < n; i++) {
        const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n], d = pts[(i + 2) % n];
        const p = lineIntersect(a, b, c, d);
        if (!p) continue;
        // 交点が辺 b-c の外側（a→b と d→c の延長の先）にあるときだけ使える
        const t = (p[0] - b[0]) * (b[0] - a[0]) + (p[1] - b[1]) * (b[1] - a[1]);
        const s = (p[0] - c[0]) * (c[0] - d[0]) + (p[1] - c[1]) * (c[1] - d[1]);
        if (t < 0 || s < 0) continue;
        const added = area([b, p, c]);
        if (added < bestArea) { bestArea = added; best = i; bestPoint = p; }
      }
      if (best < 0) {
        // 延長できないときは、消しても面積の減りが小さい頂点を消す
        let k = 0;
        let kArea = Infinity;
        for (let i = 0; i < n; i++) {
          const ar = area([pts[(i - 1 + n) % n], pts[i], pts[(i + 1) % n]]);
          if (ar < kArea) { kArea = ar; k = i; }
        }
        pts.splice(k, 1);
        continue;
      }
      const next = (best + 1) % n;
      pts[best] = bestPoint;
      pts.splice(next, 1);
    }
    return pts.length === 4 ? pts : null;
  }

  // 斜めから撮った長方形の本当の縦横比（上辺 / 左辺）を見積もる。
  // Zhang & He (2006) の方法で、レンズの中心が画像の中心にあるとしてカメラの焦点距離ごと解く。
  // 正面に近く解けないときや、答えが不自然なときは null
  function estimateAspect(q, W, H) {
    const cx = W / 2, cy = H / 2;
    const m1 = [q[0][0] - cx, q[0][1] - cy, 1]; // 左上
    const m2 = [q[1][0] - cx, q[1][1] - cy, 1]; // 右上
    const m3 = [q[3][0] - cx, q[3][1] - cy, 1]; // 左下
    const m4 = [q[2][0] - cx, q[2][1] - cy, 1]; // 右下
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
    const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
    if (!Number.isFinite(k2) || !Number.isFinite(k3)) return null;
    const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
    const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
    const L = Math.max(W, H);
    let ratio = null;
    if (Math.abs(n2[2]) > 1e-3 && Math.abs(n3[2]) > 1e-3) {
      const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
      // スマホのカメラの焦点距離（画素）は長辺の 0.5〜2 倍くらい
      if (f2 > (0.4 * L) ** 2 && f2 < (2.5 * L) ** 2) {
        ratio = Math.sqrt((n2[0] ** 2 + n2[1] ** 2 + f2 * n2[2] ** 2) / (n3[0] ** 2 + n3[1] ** 2 + f2 * n3[2] ** 2));
      }
    }
    if (!ratio) {
      // ほぼ正面から撮ったとき（遠近がほとんどない）は、平行四辺形として求める
      ratio = Math.sqrt((n2[0] ** 2 + n2[1] ** 2) / (n3[0] ** 2 + n3[1] ** 2));
    }
    return Number.isFinite(ratio) && ratio > 0.1 && ratio < 10 ? ratio : null;
  }

  // 補正後の画像の縦横比（幅 / 高さ）。
  // preset（長辺 / 短辺。A4 なら 1.414）が指定され、見積もりがそれに近いときはその比にそろえる
  function outputAspect(q, W, H, preset) {
    const { w, h } = quadSize(q);
    const naive = w / Math.max(h, 1e-6);
    let est = estimateAspect(q, W, H);
    if (!est || est / naive > 1.6 || naive / est > 1.6) est = naive;
    if (preset) {
      const target = est >= 1 ? preset : 1 / preset;
      if (Math.abs(Math.log(est / target)) < 0.2) return target;
    }
    return est;
  }

  return { solve, homography, project, dist, area, orderQuad, isConvex, angles, quadSize, convexHull, hullToQuad, estimateAspect, outputAspect };
})();
