/* Màn chỉnh trang kiểu máy quét iPhone: kéo 4 góc (có kính lúp), Tự dò / Cả ảnh, xoay, bộ lọc
 * Gốc / Tài liệu / Xám / Đen trắng. Góc lưu theo tỉ lệ 0..1 của ảnh gốc (đã xoay EXIF, chưa xoay tay)
 * - đúng dạng kết quả của crop.detect, nên images.js dùng chung một đường nắn ảnh. */
(function (G) {
  "use strict";
  const CV = (G.CV = G.CV || {});
  const FILTER_LABEL = { color: "Gốc", doc: "Tăng cường", gray: "Xám", bw: "Đen trắng" };
  const INSET = [[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92]];
  const FULL = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const copy = (q) => q.map((p) => [p[0], p[1]]);

  // toạ độ tỉ lệ: ảnh gốc <-> ảnh đang hiển thị (đã xoay tay theo chiều kim đồng hồ)
  const rotFwd = (x, y, r) => (r === 90 ? [1 - y, x] : r === 180 ? [1 - x, 1 - y] : r === 270 ? [y, 1 - x] : [x, y]);
  const rotInv = (u, v, r) => (r === 90 ? [v, 1 - u] : r === 180 ? [1 - u, 1 - v] : r === 270 ? [1 - v, u] : [u, v]);

  /** Xếp 4 góc thành TL, TR, BR, BL theo chiều kim đồng hồ; null nếu không phải tứ giác lồi. */
  function order(q) {
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    const s = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    let k = 0;
    for (let i = 1; i < 4; i++) if (s[i][0] + s[i][1] < s[k][0] + s[k][1]) k = i;
    const o = s.slice(k).concat(s.slice(0, k));
    for (let i = 0; i < 4; i++) {
      const a = o[i], b = o[(i + 1) % 4], c = o[(i + 2) % 4];
      if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 0) return null;
    }
    return o;
  }
  // thấy đủ 4 mép giấy (không cạnh nào nằm sát mép ảnh) -> được tính lại tỉ lệ thật của tờ giấy
  function isFull(q) {
    const B = 0.015;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      if ((a[0] <= B && b[0] <= B) || (a[0] >= 1 - B && b[0] >= 1 - B) || (a[1] <= B && b[1] <= B) || (a[1] >= 1 - B && b[1] >= 1 - B)) return false;
    }
    return true;
  }
  const isWhole = (q) => q.every((p, i) => Math.abs(p[0] - FULL[i][0]) < 0.006 && Math.abs(p[1] - FULL[i][1]) < 0.006);

  function create(el, opts) {
    const $ = (s) => el.querySelector(s);
    const stage = $("#ed-stage"), cv = $("#ed-canvas"), loupe = $("#ed-loupe");
    const handles = Array.from(el.querySelectorAll(".ed-handle"));
    let img = null, url = null, quad = null, rot = 0, filter = "color", touched = false, item = null;
    let finish = null, view = null, drag = -1, scan = false;
    const dpr = () => Math.min(2, G.devicePixelRatio || 1);

    function layout() {
      const W = stage.clientWidth, H = stage.clientHeight, pad = 24;
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const rw = rot % 180 ? ih : iw, rh = rot % 180 ? iw : ih;
      const s = Math.min((W - 2 * pad) / rw, (H - 2 * pad) / rh);
      view = { ox: (W - rw * s) / 2, oy: (H - rh * s) / 2, w: rw * s, h: rh * s };
      stage.dataset.view = JSON.stringify(view);
      const d = dpr();
      cv.width = Math.round(W * d); cv.height = Math.round(H * d);
    }
    const toScreen = (p) => { const [u, v] = rotFwd(p[0], p[1], rot); return [view.ox + u * view.w, view.oy + v * view.h]; };

    function draw() {
      if (!img || !view) return;
      const g = cv.getContext("2d"), d = dpr();
      g.setTransform(d, 0, 0, d, 0, 0);
      g.clearRect(0, 0, cv.width, cv.height);
      g.save();
      g.translate(view.ox + view.w / 2, view.oy + view.h / 2);
      g.rotate((rot * Math.PI) / 180);
      const sw = rot % 180 ? view.h : view.w, sh = rot % 180 ? view.w : view.h;
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
      g.drawImage(img, -sw / 2, -sh / 2, sw, sh);
      g.restore();
      const pts = quad.map(toScreen);
      g.beginPath(); // tối phần ngoài tờ giấy
      g.rect(view.ox, view.oy, view.w, view.h);
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fillStyle = "rgba(0, 0, 0, 0.55)";
      g.fill("evenodd");
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.strokeStyle = "#0a84ff"; g.lineWidth = 2.5; g.lineJoin = "round";
      g.stroke();
      handles.forEach((h, k) => { h.style.left = pts[k][0] + "px"; h.style.top = pts[k][1] + "px"; });
      stage.dataset.quad = JSON.stringify(quad);
    }

    function showLoupe(x, y) { // kính lúp phóng 2 lần chỗ ngón tay đang che
      const L = 120, src = 60, d = dpr();
      loupe.width = L * d; loupe.height = L * d;
      const g = loupe.getContext("2d");
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = "#000"; g.fillRect(0, 0, loupe.width, loupe.height);
      g.drawImage(cv, (x - src / 2) * d, (y - src / 2) * d, src * d, src * d, 0, 0, loupe.width, loupe.height);
      g.strokeStyle = "#ffd60a"; g.lineWidth = 1.5 * d;
      g.beginPath(); g.moveTo(loupe.width / 2, 0); g.lineTo(loupe.width / 2, loupe.height);
      g.moveTo(0, loupe.height / 2); g.lineTo(loupe.width, loupe.height / 2); g.stroke();
      loupe.classList.remove("hidden");
      loupe.style.left = (x < stage.clientWidth / 2 ? stage.clientWidth - L - 12 : 12) + "px";
      loupe.style.top = (y < L + 40 ? stage.clientHeight - L - 12 : 12) + "px";
    }

    function moveTo(e) {
      const r = stage.getBoundingClientRect();
      const u = Math.min(1, Math.max(0, (e.clientX - r.left - view.ox) / view.w));
      const v = Math.min(1, Math.max(0, (e.clientY - r.top - view.oy) / view.h));
      quad[drag] = rotInv(u, v, rot);
      draw();
      const p = toScreen(quad[drag]);
      showLoupe(p[0], p[1]);
    }
    handles.forEach((h, k) => {
      h.addEventListener("pointerdown", (e) => {
        if (!view) return;
        e.preventDefault();
        drag = k;
        try { h.setPointerCapture(e.pointerId); } catch (err) { /* trình duyệt cũ */ }
        h.classList.add("on");
      });
      h.addEventListener("pointermove", (e) => { if (drag === k) moveTo(e); });
      const end = () => { if (drag === k) { drag = -1; h.classList.remove("on"); loupe.classList.add("hidden"); } };
      h.addEventListener("pointerup", end);
      h.addEventListener("pointercancel", end);
    });

    function setFilter(f) {
      filter = f;
      el.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("on", b.dataset.filter === f));
    }
    el.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => { touched = true; setFilter(b.dataset.filter); }));
    el.querySelectorAll("[data-ed]").forEach((b) => b.addEventListener("click", () => {
      if (!img) return;
      const a = b.dataset.ed;
      if (a === "auto") {
        if (item.autoCrop) quad = copy(item.autoCrop.quad);
        else opts.toast("Không tự dò được mép giấy - kéo 4 góc bằng tay.");
      } else if (a === "full") quad = copy(FULL);
      else if (a === "rot") { rot = (rot + 90) % 360; layout(); }
      draw();
    }));
    $("#ed-done").addEventListener("click", () => opts.requestClose("done"));
    $("#ed-keep").addEventListener("click", () => opts.requestClose("keep"));
    $("#ed-retake").addEventListener("click", () => opts.requestClose("retake"));
    $("#ed-cancel").addEventListener("click", () => opts.requestClose("cancel"));
    G.addEventListener("resize", () => { if (img) { layout(); draw(); } });

    /** Mở chỉnh một trang. o.scan: vừa chụp ở chế độ Thủ công (nút Chụp lại / Giữ bản quét).
     *  o.filter: bộ lọc đang áp dụng. Trả Promise: "done" | "keep" | "retake" | "cancel". */
    async function open(it, o) {
      o = o || {};
      item = it; scan = !!o.scan; rot = it.rotation || 0; touched = false; view = null;
      setFilter(it.filter || o.filter || "color");
      quad = it.cropOff ? copy(FULL) : it.crop ? copy(it.crop.quad) : copy(INSET);
      el.classList.toggle("scan", scan);
      el.classList.remove("hidden");
      delete stage.dataset.view;
      url = URL.createObjectURL(it.file);
      img = new Image();
      img.src = url;
      try { await img.decode(); } catch (e) { /* vẽ khi có thể */ }
      layout();
      draw();
      return new Promise((res) => { finish = res; });
    }

    /** Đóng (nút hoặc Back). Trả false nếu 4 góc không hợp lệ - giữ màn chỉnh để kéo lại. */
    function close(r) {
      if (!finish) { el.classList.add("hidden"); return true; }
      const res = r === "back" ? (scan ? "keep" : "cancel") : r;
      if (res === "done" || res === "keep") {
        if (isWhole(quad)) item.cropOff = true;
        else {
          const q = order(quad);
          if (!q) { opts.toast("4 góc không tạo thành tờ giấy - kéo lại cho đúng."); return false; }
          item.crop = { quad: q, full: isFull(q) };
          item.cropOff = false;
          item.cropManual = true;
        }
        item.rotation = rot;
        if (touched || scan) item.filter = filter;
      }
      el.classList.add("hidden");
      loupe.classList.add("hidden");
      if (url) URL.revokeObjectURL(url);
      url = img = view = null;
      const f = finish;
      finish = null;
      f(res);
      return true;
    }

    return { open, close, get isOpen() { return !!finish; } };
  }

  CV.editor = { create, order, isFull, FILTER_LABEL };
})(typeof globalThis !== "undefined" ? globalThis : window);
