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

  // co/nở ô vuông 2r+1 (tách hàng rồi cột). Co: ngoài ảnh = 1; nở: ngoài ảnh = 0.
  // Cửa sổ trượt có bộ đếm: mỗi điểm 2 phép tính dù bán kính lớn (máy quét chạy liên tục).
  function morph(m, w, h, r, all) {
    const a = new Uint8Array(w * h), b = new Uint8Array(w * h);
    const bad = all ? 0 : 1; // co: đếm số điểm 0 trong cửa sổ; nở: đếm số điểm 1
    const pass = (src, dst, n, len, step) => { // n đường, mỗi đường len điểm cách nhau step
      for (let k = 0; k < n; k++) {
        const o = k * (step === 1 ? len : 1);
        let c = 0;
        for (let i = 0; i <= Math.min(r, len - 1); i++) if (src[o + i * step] === bad) c++;
        for (let i = 0; i < len; i++) {
          dst[o + i * step] = all ? (c === 0 ? 1 : 0) : (c > 0 ? 1 : 0);
          const add = i + r + 1, rem = i - r;
          if (add < len && src[o + add * step] === bad) c++;
          if (rem >= 0 && src[o + rem * step] === bad) c--;
        }
      }
    };
    pass(m, a, h, w, 1); // theo hàng
    pass(a, b, w, h, w); // theo cột
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

  const blur2 = (a, w, h, r) => blurV(blurH(blurV(blurH(a, w, h, r), w, h, r), w, h, r), w, h, r);
  const open = (m, w, h, r) => morph(morph(m, w, h, r, true), w, h, r, false);
  const g3 = (a, b, c) => Math.floor((299 * a + 587 * b + 114 * c + 500) / 1000);

  function fillHoles(mask, w, h) { // lấp lỗ (chữ, dấu, ảnh trong giấy): vùng tối không chạm mép ảnh
    const bg = components(mask, w, h, 0);
    for (let i = 0; i < mask.length; i++) if (!mask[i] && !bg.comps[bg.lab[i]].border) mask[i] = 1;
    return mask;
  }

  // khoảng cách màu tới màu tờ giấy ở giữa khung (như _paper_distance): theo sắc độ, làm mờ nhẹ
  function paperDistance(px, w, h, r) {
    const n = w * h, ch = [new Int32Array(n), new Int32Array(n), new Int32Array(n)];
    for (let i = 0, p = 0; i < n; i++, p += 4) { ch[0][i] = px[p]; ch[1][i] = px[p + 1]; ch[2][i] = px[p + 2]; }
    const rb = Math.max(1, Math.floor(r / 3));
    const B = ch.map((c) => blur2(c, w, h, rb));
    const y0 = Math.floor((h * 35) / 100), y1 = Math.floor((h * 65) / 100);
    const x0 = Math.floor((w * 35) / 100), x1 = Math.floor((w * 65) / 100);
    const win = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) win.push(y * w + x);
    const Lw = Int32Array.from(win, (i) => g3(B[0][i], B[1][i], B[2][i]));
    const med = Int32Array.from(Lw).sort()[(Lw.length - 1) >> 1];
    const ref = B.map((c) => {
      const v = [];
      for (let k = 0; k < win.length; k++) if (Lw[k] >= med) v.push(c[win[k]]); // nửa sáng hơn: bỏ chữ, mực
      const sv = Int32Array.from(v).sort();
      return sv[(sv.length - 1) >> 1];
    });
    const L0 = g3(ref[0], ref[1], ref[2]), dr = ref[0] - ref[1], db = ref[2] - ref[1];
    if (L0 < 120 || Math.max(...ref) - Math.min(...ref) > 60) return null; // giữa khung không phải màu giấy
    const dist = (C) => {
      const out = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const d = 2 * (Math.abs(C[0][i] - C[1][i] - dr) + Math.abs(C[2][i] - C[1][i] - db)) +
          Math.max(0, L0 - g3(C[0][i], C[1][i], C[2][i]) - 40);
        out[i] = Math.min(d, 255);
      }
      return out;
    };
    const Db = dist(B), Dr = dist(ch);
    const v = Int32Array.from(win, (i) => Db[i]).sort();
    return { Db, Dr, t: Math.min(32, Math.max(16, 2 * v[(v.length - 1) >> 1] + 10)) };
  }

  // khớp đường thẳng cho từng mép rồi lấy giao điểm làm góc (như _refine)
  function refine(q, lab, id, w, h, border) {
    const rx0 = new Int32Array(h).fill(-1), rx1 = new Int32Array(h), cmin = new Int32Array(w).fill(h), cmax = new Int32Array(w).fill(-1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (lab[y * w + x] !== id) continue;
      if (rx0[y] < 0) rx0[y] = x;
      rx1[y] = x + 1;
      if (y < cmin[x]) cmin[x] = y;
      if (y > cmax[x]) cmax[x] = y;
    }
    const pts = [];
    for (let y = 0; y < h; y++) if (rx0[y] >= 0) pts.push([rx0[y], y + 0.5], [rx1[y], y + 0.5]);
    for (let x = 0; x < w; x++) if (cmax[x] >= 0) pts.push([x + 0.5, cmin[x]], [x + 0.5, cmax[x] + 1]);
    const tol = 3 + 0.01 * Math.max(w, h);
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], ex = b[0] - a[0], ey = b[1] - a[1], L = Math.sqrt(ex * ex + ey * ey);
      let line = [a[0], a[1], ex, ey];
      if (!border[i]) {
        const ux = ex / L, uy = ey / L, sel = [];
        for (const [px, py] of pts) {
          if (px <= 0 || px >= w || py <= 0 || py >= h) continue; // mép ảnh, không phải mép giấy
          const dx = px - a[0], dy = py - a[1], t = (dx * ux + dy * uy) / L;
          if (t >= 0.15 && t <= 0.85 && Math.abs(dx * uy - dy * ux) <= tol) sel.push([px, py]);
        }
        if (sel.length >= 12) {
          const n = sel.length;
          let mx = 0, my = 0;
          for (const [px, py] of sel) { mx += px; my += py; }
          mx /= n; my /= n;
          let sxx = 0, sxy = 0, syy = 0;
          for (const [px, py] of sel) { const dx = px - mx, dy = py - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
          const hd = (sxx - syy) / 2, lam = (sxx + syy) / 2 + Math.sqrt(hd * hd + sxy * sxy);
          const v1 = [lam - syy, sxy], v2 = [sxy, lam - sxx];
          const [vx, vy] = Math.abs(v1[0]) + Math.abs(v1[1]) >= Math.abs(v2[0]) + Math.abs(v2[1]) ? v1 : v2;
          if (vx !== 0 || vy !== 0) line = [mx, my, vx, vy];
        }
      }
      lines.push(line);
    }
    const out = [], lim = 0.04 * Math.max(w, h);
    for (let i = 0; i < 4; i++) {
      const [m1x, m1y, v1x, v1y] = lines[(i + 3) % 4], [m2x, m2y, v2x, v2y] = lines[i];
      const d = v1x * v2y - v1y * v2x;
      if (Math.abs(d) < 1e-9) return q;
      const s = ((m2x - m1x) * v2y - (m2y - m1y) * v2x) / d;
      const cx = m1x + s * v1x, cy = m1y + s * v1y, ox = cx - q[i][0], oy = cy - q[i][1];
      if (ox * ox + oy * oy > lim * lim) return q;
      out.push([Math.min(Math.max(cx, 0), w), Math.min(Math.max(cy, 0), h)]);
    }
    return out;
  }

  // vùng giấy (đã lấp lỗ) -> {q, full, area} đã kiểm tra kỹ, hoặc null (như _candidate)
  function candidate(mask, F, w, h, center) {
    const { lab, comps } = components(mask, w, h, 1);
    if (!comps.length) return null;
    let id = -1;
    if (center) {
      const c0 = Math.floor(h / 2) * w + Math.floor(w / 2);
      if (mask[c0]) id = lab[c0];
      if (id >= 0 && comps[id].area < MIN_AREA * w * h) id = -1;
    }
    if (id < 0) {
      id = 0;
      for (let c = 1; c < comps.length; c++) if (comps[c].area > comps[id].area) id = c;
    }
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
    const bx = BORDER * w, by = BORDER * h, border = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      const on = (a[0] <= bx && b[0] <= bx) || (a[0] >= w - bx && b[0] >= w - bx) ||
        (a[1] <= by && b[1] <= by) || (a[1] >= h - by && b[1] >= h - by);
      border.push(on);                                                      // giấy tràn khung ở cạnh này
      if (!on && edgeStep(F, w, h, a, b, cx, cy) < EDGE_STEP) return null;   // không có mép rõ
    }
    if (border.filter(Boolean).length > 2) return null;
    return { q: refine(q, lab, id, w, h, border), full: !border.some(Boolean), area: qa };
  }

  /** px: RGBA (ImageData.data) của ảnh đã thu nhỏ w×h.
   *  -> {quad: [[x,y] TL,TR,BR,BL theo tỉ lệ 0..1], full: thấy đủ 4 mép} hoặc null.
   *  Hai cách tìm (như detect_small): theo độ sáng, và theo màu giấy ở giữa khung (nền sáng như vải sọc).
   *  Cả hai đạt thì lấy cái khít hơn nhưng không nhỏ hơn cách 1 quá 15%. */
  function detect(px, w, h) {
    if (w < 32 || h < 32) return null;
    const g = gray(px, w, h);
    const r = Math.max(2, Math.floor((Math.max(w, h) + 48) / 96));
    const blur = blur2(g, w, h, r);
    const t1 = otsu(blur);
    let m1 = new Uint8Array(w * h);
    for (let i = 0; i < m1.length; i++) m1[i] = blur[i] > t1 ? 1 : 0;
    const c1 = candidate(fillHoles(open(m1, w, h, 2), w, h), g, w, h, false);
    let c2 = null;
    const pd = paperDistance(px, w, h, r);
    if (pd) {
      let m2 = new Uint8Array(w * h);
      for (let i = 0; i < m2.length; i++) m2[i] = pd.Db[i] <= pd.t ? 1 : 0;
      const ro = Math.max(2, Math.floor((Math.max(w, h) * 2 + 50) / 100));
      m2 = open(fillHoles(open(m2, w, h, 2), w, h), w, h, ro); // cắt các sọc/vệt mảnh dính vào giấy
      c2 = candidate(m2, pd.Dr.map((d) => 255 - d), w, h, true);
    }
    let best = c1;
    if (c2 && (!c1 || (0.85 * c1.area <= c2.area && c2.area < c1.area))) best = c2;
    if (!best) return null;
    return { quad: best.q.map((p) => [p[0] / w, p[1] / h]), full: best.full };
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
