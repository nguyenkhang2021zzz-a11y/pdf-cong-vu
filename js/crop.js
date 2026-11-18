/* Tự động cắt gọn ảnh chụp giấy tờ: tìm 4 góc tờ giấy, bỏ phần nền thừa, nắn thẳng nếu chụp xiên.
 * Không chắc là tờ giấy (ảnh hiện trường, giấy kín khung...) -> null = giữ nguyên ảnh.
 * CÙNG MỘT thuật toán với pdfcongvu/crop.py - sửa bên này phải sửa bên kia
 * (test so khớp kết quả hai bản trên cùng điểm ảnh: tests/crop.test.js). Hàm thuần, chạy được cả trong Node. */
(function (G) {
  "use strict";
  const CV = (G.CV = G.CV || {});
  const DET = 480, MIN_AREA = 0.12, MAX_AREA = 0.97, EDGE_STEP = 18, BORDER = 0.015, SHRINK = 0.012, MAX_HULL = 300;
  const A4 = Math.SQRT2;
  const R = (x) => Math.floor(x + 0.5);

  function gray(px, w, h) {
    const g = new Int32Array(w * h);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = Math.floor((299 * px[p] + 587 * px[p + 1] + 114 * px[p + 2] + 500) / 1000);
    return g;
  }

  // trung bình cửa sổ 2r+1, kéo dài mép, chia lấy phần nguyên (như _blur1)
  function blurH(a, w, h, r) {
    const out = new Int32Array(w * h), k = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let s = 0;
      for (let t = -r; t <= r; t++) s += a[row + Math.min(w - 1, Math.max(0, t))];
      for (let x = 0; x < w; x++) {
        out[row + x] = Math.floor(s / k);
        s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    return out;
  }
  function blurV(a, w, h, r) {
    const out = new Int32Array(w * h), k = 2 * r + 1;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let t = -r; t <= r; t++) s += a[Math.min(h - 1, Math.max(0, t)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = Math.floor(s / k);
        s += a[Math.min(h - 1, y + r + 1) * w + x] - a[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  function otsu(a) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < a.length; i++) hist[a[i]]++;
    const total = a.length;
    let sumAll = 0;
    for (let i = 0; i < 256; i++) sumAll += i * hist[i];
    let wb = 0, sb = 0, best = 0, t = 0;
    for (let i = 0; i < 256; i++) {
      wb += hist[i];
      if (wb === 0) continue;
      const wf = total - wb;
      if (wf === 0) break;
      sb += i * hist[i];
      const d = sb / wb - (sumAll - sb) / wf;
      const between = wb * wf * d * d;
      if (between > best) { best = between; t = i; }
    }
    return t;
  }

  // co/nở ô vuông 2r+1 (tách được theo hàng rồi cột). Co: ngoài ảnh = 1; nở: ngoài ảnh = 0.
  function morph(m, w, h, r, all) {
    const a = new Uint8Array(w * h), b = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = all ? 1 : 0;
      for (let t = -r; t <= r; t++) {
        const xx = x + t;
        if (xx < 0 || xx >= w) continue;
        if (all) v &= m[y * w + xx]; else v |= m[y * w + xx];
      }
      a[y * w + x] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = all ? 1 : 0;
      for (let t = -r; t <= r; t++) {
        const yy = y + t;
        if (yy < 0 || yy >= h) continue;
        if (all) v &= a[yy * w + x]; else v |= a[yy * w + x];
      }
      b[y * w + x] = v;
    }
    return b;
  }

  // vùng liên thông 4 hướng của các điểm m == val (thứ tự vùng = thứ tự điểm đầu tiên theo dòng)
  function components(m, w, h, val) {
    const lab = new Int32Array(w * h).fill(-1), stack = new Int32Array(w * h), comps = [];
    for (let i = 0; i < w * h; i++) {
      if (m[i] !== val || lab[i] !== -1) continue;
      const id = comps.length;
      let area = 0, border = false, sp = 0;
      lab[i] = id; stack[sp++] = i;
      while (sp) {
        const p = stack[--sp];
        area++;
        const x = p % w, y = (p - x) / w;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
        if (x > 0 && m[p - 1] === val && lab[p - 1] === -1) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && m[p + 1] === val && lab[p + 1] === -1) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && m[p - w] === val && lab[p - w] === -1) { lab[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && m[p + w] === val && lab[p + w] === -1) { lab[p + w] = id; stack[sp++] = p + w; }
      }
      comps.push({ area, first: i, border });
    }
    return { lab, comps };
  }

  function hull(pts) {
    pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .filter((p, i, A) => i === 0 || p[0] !== A[i - 1][0] || p[1] !== A[i - 1][1]);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }

  // 4 đỉnh bao lồi tạo tứ giác diện tích lớn nhất (như _max_quad: hòa thì lấy chỉ số nhỏ)
  function maxQuad(P) {
    const n = P.length, M = new Float64Array(n * n);
    let best = -1, bq = null;
    for (let i = 0; i < n - 3; i++) {
      const ox = P[i][0], oy = P[i][1];
      for (let a = 0; a < n; a++) {
        const ax = P[a][0] - ox, ay = P[a][1] - oy;
        for (let b = 0; b < n; b++) M[a * n + b] = Math.abs(ax * (P[b][1] - oy) - ay * (P[b][0] - ox));
      }
      for (let k = i + 2; k < n - 1; k++) {
        let j = i + 1;
        for (let t = i + 2; t < k; t++) if (M[t * n + k] > M[j * n + k]) j = t;
        let l = k + 1;
        for (let t = k + 2; t < n; t++) if (M[k * n + t] > M[k * n + l]) l = t;
        const area = M[j * n + k] + M[k * n + l];
        if (area > best) { best = area; bq = [i, j, k, l]; }
      }
    }
    return { bq, best };
  }

  // chênh sáng (trong - ngoài) sát cạnh a-b: mép giấy thật là một bước nhảy rõ
  function edgeStep(g, w, h, a, b, cx, cy) {
    const ex = b[0] - a[0], ey = b[1] - a[1], L = Math.sqrt(ex * ex + ey * ey);
    let nx = ey / L, ny = -ex / L;
    if (((a[0] + b[0]) / 2 - cx) * nx + ((a[1] + b[1]) / 2 - cy) * ny < 0) { nx = -nx; ny = -ny; }
    const diffs = [];
    for (let s = 0; s < 32; s++) {
      const t = 0.1 + 0.8 * (s + 0.5) / 32;
      const px = a[0] + ex * t, py = a[1] + ey * t;
      let si = 0, so = 0, ok = true;
      for (const dd of [3, 4, 5, 6]) {
        const xi = Math.floor(px - nx * dd + 0.5), yi = Math.floor(py - ny * dd + 0.5);
        const xo = Math.floor(px + nx * dd + 0.5), yo = Math.floor(py + ny * dd + 0.5);
        if (!(xi >= 0 && xi < w && yi >= 0 && yi < h && xo >= 0 && xo < w && yo >= 0 && yo < h)) { ok = false; break; }
        si += g[yi * w + xi]; so += g[yo * w + xo];
      }
      if (ok) diffs.push(si - so);
    }
    if (diffs.length < 16) return 0;
    diffs.sort((x, y) => x - y);
    return diffs[(diffs.length - 1) >> 1] / 4;
  }

  function angle(p, a, b) {
    const ux = a[0] - p[0], uy = a[1] - p[1], vx = b[0] - p[0], vy = b[1] - p[1];
    const c = (ux * vx + uy * vy) / (Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy));
    return Math.acos(Math.max(-1, Math.min(1, c))) / (Math.PI / 180);
  }

  /** px: RGBA (ImageData.data) của ảnh đã thu nhỏ w×h.
   *  -> {quad: [[x,y] TL,TR,BR,BL theo tỉ lệ 0..1], full: thấy đủ 4 mép} hoặc null. */
  function detect(px, w, h) {
    if (w < 32 || h < 32) return null;
    const g = gray(px, w, h);
    const r = Math.max(2, Math.floor((Math.max(w, h) + 48) / 96));
    const blur = blurV(blurH(blurV(blurH(g, w, h, r), w, h, r), w, h, r), w, h, r);
    const t = otsu(blur);
    let mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = blur[i] > t ? 1 : 0;
    mask = morph(morph(mask, w, h, 2, true), w, h, 2, false); // bỏ chi tiết mảnh dính vào tờ giấy
    const bg = components(mask, w, h, 0);                    // lấp lỗ (chữ, dấu, ảnh trong giấy)
    for (let i = 0; i < mask.length; i++) if (!mask[i] && !bg.comps[bg.lab[i]].border) mask[i] = 1;
    const { lab, comps } = components(mask, w, h, 1);
    if (!comps.length) return null;
    let id = 0;
    for (let c = 1; c < comps.length; c++) if (comps[c].area > comps[id].area) id = c;
    const area = comps[id].area;
    if (area < MIN_AREA * w * h) return null;
    const pts = [];
    for (let y = 0; y < h; y++) {
      let x0 = -1, x1 = -1;
      for (let x = 0; x < w; x++) if (lab[y * w + x] === id) { if (x0 < 0) x0 = x; x1 = x + 1; }
      if (x0 >= 0) pts.push([x0, y], [x0, y + 1], [x1, y], [x1, y + 1]);
    }
    const H = hull(pts);
    if (H.length < 4 || H.length > MAX_HULL) return null;
    const { bq, best } = maxQuad(H);
    if (!bq) return null;
    let q = bq.map((i) => H[i]);
    const qa = best / 2;
    if (qa > MAX_AREA * w * h || !(qa / area >= 0.90 && qa / area <= 1.06)) return null;
    let s = 0;
    for (let i = 0; i < 4; i++) s += q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1];
    if (s < 0) q = q.reverse();
    let k = 0;
    for (let i = 1; i < 4; i++) if (q[i][0] + q[i][1] < q[k][0] + q[k][1]) k = i;
    q = q.slice(k).concat(q.slice(0, k)); // TL, TR, BR, BL
    for (let i = 0; i < 4; i++) {
      const A = angle(q[i], q[(i + 3) % 4], q[(i + 1) % 4]);
      if (!(A >= 45 && A <= 135)) return null;
    }
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    const bx = BORDER * w, by = BORDER * h;
    let nBorder = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      if ((a[0] <= bx && b[0] <= bx) || (a[0] >= w - bx && b[0] >= w - bx) ||
          (a[1] <= by && b[1] <= by) || (a[1] >= h - by && b[1] >= h - by)) nBorder++; // giấy tràn khung
      else if (edgeStep(g, w, h, a, b, cx, cy) < EDGE_STEP) return null;           // không có mép rõ
    }
    if (nBorder > 2) return null;
    return { quad: q.map((p) => [p[0] / w, p[1] / h]), full: nBorder === 0 };
  }

  /* ------------------------------------------------------------ nắn thẳng */
  function homography(src, dst) { // 8 hệ số src -> dst (giải hệ 8x8, khử Gauss chọn trụ)
    const A = [], B = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
    }
    for (let c = 0; c < 8; c++) {
      let p = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [B[c], B[p]] = [B[p], B[c]];
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const f = A[r][c] / A[c][c];
        if (!f) continue;
        for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
        B[r] -= f * B[c];
      }
    }
    return B.map((b, i) => b / A[i][i]);
  }

  function shrink(q) {
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    return q.map(([x, y]) => [x + (cx - x) * SHRINK, y + (cy - y) * SHRINK]);
  }

  // tỉ lệ rộng/cao THẬT của tờ giấy từ ảnh phối cảnh (Zhang & He 2007; tâm quang học giữa ảnh)
  function aspect(q, u0, v0, scale) {
    const [tl, tr, br, bl] = q;
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const m1 = [tl[0], tl[1], 1], m2 = [tr[0], tr[1], 1], m3 = [bl[0], bl[1], 1], m4 = [br[0], br[1], 1];
    const d2 = dot(cross(m2, m4), m3), d3 = dot(cross(m3, m4), m2);
    if (d2 === 0 || d3 === 0) return null;
    const c14 = cross(m1, m4);
    const k2 = dot(c14, m3) / d2, k3 = dot(c14, m2) / d3;
    const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 - 1], n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 - 1];
    const zz = n2[2] * n3[2];
    if (Math.abs(zz) < 1e-9) return null;
    const f2 = -((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + zz * u0 * u0) +
      (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + zz * v0 * v0)) / zz;
    const lo = 0.25 * scale, hi = 6 * scale;
    if (!(lo * lo <= f2 && f2 <= hi * hi)) return null; // tiêu cự điện thoại hợp lý
    const nn = (n) => { const x = n[0] - u0 * n[2], y = n[1] - v0 * n[2]; return (x * x + y * y) / f2 + n[2] * n[2]; };
    const r = Math.sqrt(nn(n2) / nn(n3));
    return r > 0.2 && r < 5 ? r : null;
  }

  function outSize(q, iw, ih, full) { // cỡ ảnh sau khi nắn (điểm ảnh)
    const [tl, tr, br, bl] = q;
    const d = (a, b) => { const x = a[0] - b[0], y = a[1] - b[1]; return Math.sqrt(x * x + y * y); };
    const top = d(tl, tr), bot = d(bl, br), lef = d(tl, bl), rig = d(tr, br);
    let W = Math.max(top, bot), H = Math.max(lef, rig);
    if (full) {
      let r = aspect(q, iw / 2, ih / 2, Math.max(iw, ih));
      if (r === null) r = (top + bot) / (lef + rig);
      for (const snap of [1 / A4, A4]) if (Math.abs(r / snap - 1) < 0.03) r = snap; // A4 dọc / ngang
      if (W / r >= H) H = W / r; else W = H * r;
    }
    return [Math.max(1, R(W)), Math.max(1, R(H))];
  }

  function plan(det, iw, ih) {
    const q = shrink(det.quad.map(([x, y]) => [x * iw, y * ih]));
    return { q, size: outSize(q, iw, ih, det.full) };
  }

  /** Nắn: ảnh nguồn RGBA sw×sh, 4 góc q (điểm ảnh nguồn) -> ghi vào dst RGBA ow×oh (nội suy song tuyến). */
  function warp(src, sw, sh, q, dst, ow, oh) {
    const [a, b, c, d, e, f, g, h] = homography([[0, 0], [ow, 0], [ow, oh], [0, oh]], q);
    for (let y = 0; y < oh; y++) {
      const Y = y + 0.5;
      for (let x = 0; x < ow; x++) {
        const X = x + 0.5, den = g * X + h * Y + 1;
        const sx = (a * X + b * Y + c) / den - 0.5, sy = (d * X + e * Y + f) / den - 0.5;
        const o = (y * ow + x) * 4;
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        dst[o + 3] = 255;
        if (x0 < -1 || y0 < -1 || x0 >= sw || y0 >= sh) { dst[o] = dst[o + 1] = dst[o + 2] = 255; continue; }
        const fx = sx - x0, fy = sy - y0;
        const xa = Math.max(0, x0), xb = Math.min(sw - 1, x0 + 1), ya = Math.max(0, y0), yb = Math.min(sh - 1, y0 + 1);
        const p00 = (ya * sw + xa) * 4, p01 = (ya * sw + xb) * 4, p10 = (yb * sw + xa) * 4, p11 = (yb * sw + xb) * 4;
        for (let k = 0; k < 3; k++) {
          dst[o + k] = (src[p00 + k] * (1 - fx) + src[p01 + k] * fx) * (1 - fy) + (src[p10 + k] * (1 - fx) + src[p11 + k] * fx) * fy;
        }
      }
    }
  }

  CV.crop = { DET, detect, plan, outSize, shrink, homography, warp, _otsu: otsu };
})(typeof globalThis !== "undefined" ? globalThis : window);
