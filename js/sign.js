/* Ký tên lên PDF: vẽ chữ ký bằng ngón tay (lưu ngay trên máy để dùng lại, không gửi đi đâu),
 * đặt lên trang, kéo / đổi cỡ, ký nhiều chỗ, nhiều trang. Ghi vào PDF bằng pdf-lib. */
(function (G) {
  "use strict";
  const CV = (G.CV = G.CV || {});
  const MAX_SAVED = 4;
  const KEY = "pdfcv.sigs";
  const saved = {
    get() { try { const v = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(v) ? v : []; } catch (e) { return []; } },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(v.slice(0, MAX_SAVED))); } catch (e) { /* hết chỗ / ẩn danh */ } },
  };

  /* ---------------------------------------------------------------- bảng ký */
  function createPad(el) {
    const cv = el.querySelector("#sp-canvas");
    let ink = "#111111", drawing = false, pts = [], dirty = false, finish = null;
    const dpr = () => Math.min(3, G.devicePixelRatio || 1);
    function size() {
      const W = Math.min(560, el.clientWidth - 48), H = Math.round(W * 0.42), d = dpr();
      cv.style.width = W + "px"; cv.style.height = H + "px";
      cv.width = Math.round(W * d); cv.height = Math.round(H * d);
      const g = cv.getContext("2d");
      g.setTransform(d, 0, 0, d, 0, 0);
      g.lineCap = "round"; g.lineJoin = "round"; g.lineWidth = 3;
      dirty = false;
    }
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* cũ */ }
      drawing = true; pts = [pos(e)];
      const g = cv.getContext("2d");
      g.strokeStyle = ink; g.fillStyle = ink;
      g.beginPath(); g.arc(pts[0][0], pts[0][1], 1.5, 0, Math.PI * 2); g.fill();
      dirty = true;
    });
    cv.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      const p = pos(e), g = cv.getContext("2d");
      pts.push(p);
      if (pts.length >= 3) { // nét mượt: cong bậc hai qua trung điểm
        const [a, b, c] = pts.slice(-3);
        g.beginPath();
        g.moveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        g.quadraticCurveTo(b[0], b[1], (b[0] + c[0]) / 2, (b[1] + c[1]) / 2);
        g.stroke();
      } else {
        g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); g.lineTo(p[0], p[1]); g.stroke();
      }
    });
    const end = () => { drawing = false; };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    el.querySelectorAll("[data-ink]").forEach((b) => b.addEventListener("click", () => {
      ink = b.dataset.ink;
      el.querySelectorAll("[data-ink]").forEach((x) => x.classList.toggle("on", x === b));
    }));
    el.querySelector("#sp-clear").addEventListener("click", size);
    el.querySelector("#sp-cancel").addEventListener("click", () => done(null));
    el.querySelector("#sp-save").addEventListener("click", () => {
      if (!dirty) { done(null); return; }
      done(trim());
    });
    function trim() { // cắt sát nét ký, nền trong suốt
      const g = cv.getContext("2d"), { width: w, height: h } = cv, d = g.getImageData(0, 0, w, h).data;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < 0) return null;
      const pad = Math.round(6 * dpr());
      x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
      const o = document.createElement("canvas");
      o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
      o.getContext("2d").drawImage(cv, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
      return o.toDataURL("image/png");
    }
    function done(v) {
      el.classList.add("hidden");
      const f = finish;
      finish = null;
      if (f) f(v);
    }
    return {
      open() { el.classList.remove("hidden"); size(); return new Promise((r) => { finish = r; }); },
      close() { if (finish) done(null); },
    };
  }

  /* ---------------------------------------------------------------- đặt chữ ký lên trang */
  function create(el, opts) {
    const $ = (s) => el.querySelector(s);
    const stage = $("#sg-stage"), cv = $("#sg-page"), list = $("#sg-list");
    const pad = createPad(document.getElementById("sigpad"));
    let doc = null, out = null, pageNo = 1, nPages = 1, view = null, marks = [], finish = null, renderTask = null;

    async function render() {
      if (renderTask) { try { renderTask.cancel(); } catch (e) { /* đã xong */ } }
      const pg = await doc.getPage(pageNo);
      const v1 = pg.getViewport({ scale: 1 });
      const W = stage.clientWidth, H = stage.clientHeight, padd = 16;
      const s = Math.min((W - 2 * padd) / v1.width, (H - 2 * padd) / v1.height);
      const vp = pg.getViewport({ scale: s * Math.min(2, G.devicePixelRatio || 1) });
      cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      view = { ox: (W - v1.width * s) / 2, oy: (H - v1.height * s) / 2, w: v1.width * s, h: v1.height * s };
      Object.assign(cv.style, { left: view.ox + "px", top: view.oy + "px", width: view.w + "px", height: view.h + "px" });
      stage.dataset.view = JSON.stringify(view);
      $("#sg-pno").textContent = `Trang ${pageNo}/${nPages}`;
      renderTask = pg.render({ canvasContext: cv.getContext("2d"), viewport: vp });
      try { await renderTask.promise; } catch (e) { /* bị huỷ khi chuyển trang */ }
      drawMarks();
    }

    function drawMarks() { // các chữ ký đặt trên trang đang xem
      stage.querySelectorAll(".sg-box").forEach((b) => b.remove());
      marks.forEach((m, idx) => {
        if (m.page !== pageNo) return;
        const b = document.createElement("div");
        b.className = "sg-box";
        b.dataset.i = String(idx);
        b.innerHTML = `<img alt="" src="${m.sig}"><button class="sg-del" aria-label="Bỏ chữ ký">×</button><span class="sg-size" aria-label="Đổi cỡ"></span>`;
        place(b, m);
        stage.appendChild(b);
        hook(b, m);
      });
      stage.dataset.marks = JSON.stringify(marks.map((m) => ({ page: m.page, x: m.x, y: m.y, w: m.w, h: m.h })));
    }
    function place(b, m) {
      Object.assign(b.style, { left: view.ox + m.x * view.w + "px", top: view.oy + m.y * view.h + "px", width: m.w * view.w + "px", height: m.h * view.h + "px" });
    }
    function hook(b, m) {
      let mode = null, sx = 0, sy = 0, m0 = null;
      b.addEventListener("pointerdown", (e) => {
        if (e.target.classList.contains("sg-del")) return;
        e.preventDefault();
        mode = e.target.classList.contains("sg-size") ? "size" : "move";
        sx = e.clientX; sy = e.clientY; m0 = Object.assign({}, m);
        try { b.setPointerCapture(e.pointerId); } catch (err) { /* cũ */ }
      });
      b.addEventListener("pointermove", (e) => {
        if (!mode) return;
        const dx = (e.clientX - sx) / view.w, dy = (e.clientY - sy) / view.h;
        if (mode === "move") {
          m.x = Math.min(1 - m.w, Math.max(0, m0.x + dx));
          m.y = Math.min(1 - m.h, Math.max(0, m0.y + dy));
        } else { // đổi cỡ giữ đúng tỉ lệ chữ ký
          const k = Math.max(0.2, (m0.w + dx) / m0.w);
          m.w = Math.min(1 - m.x, m0.w * k);
          m.h = (m.w / m0.w) * m0.h;
          if (m.y + m.h > 1) { m.h = 1 - m.y; m.w = (m.h / m0.h) * m0.w; }
        }
        place(b, m);
      });
      const end = () => { if (mode) { mode = null; stage.dataset.marks = JSON.stringify(marks.map((x) => ({ page: x.page, x: x.x, y: x.y, w: x.w, h: x.h }))); } };
      b.addEventListener("pointerup", end);
      b.addEventListener("pointercancel", end);
      b.querySelector(".sg-del").addEventListener("click", () => { marks.splice(marks.indexOf(m), 1); drawMarks(); });
    }

    function addMark(sig) { // đặt chữ ký ở góc dưới bên phải trang (chỗ ký thường gặp), giữ tỉ lệ chữ ký
      const img = new Image();
      img.onload = () => {
        const ar = img.naturalWidth / img.naturalHeight;
        let w = 0.34, h = (w * view.w) / ar / view.h;
        if (h > 0.3) { h = 0.3; w = (h * view.h * ar) / view.w; }
        marks.push({ page: pageNo, sig, x: Math.min(0.6, 1 - w), y: Math.min(0.72, 1 - h), w, h });
        drawMarks();
      };
      img.src = sig;
    }

    function showSaved() {
      const s = saved.get();
      list.innerHTML = s.map((u, i) => `<div class="sg-item"><button class="sg-pick" data-i="${i}" aria-label="Đặt chữ ký ${i + 1}"><img alt="" src="${u}"></button><button class="sg-forget" data-i="${i}" aria-label="Xoá chữ ký đã lưu">×</button></div>`).join("") +
        `<button class="sg-new" id="sg-new">＋ Chữ ký mới</button>`;
    }
    list.addEventListener("click", async (e) => {
      const pick = e.target.closest(".sg-pick"), forget = e.target.closest(".sg-forget");
      if (pick) addMark(saved.get()[+pick.dataset.i]);
      else if (forget) { const s = saved.get(); s.splice(+forget.dataset.i, 1); saved.set(s); showSaved(); }
      else if (e.target.closest("#sg-new")) {
        const sig = await pad.open();
        if (!sig) return;
        saved.set([sig].concat(saved.get().filter((x) => x !== sig)));
        showSaved();
        addMark(sig);
      }
    });
    $("#sg-prev").addEventListener("click", () => { if (pageNo > 1) { pageNo--; render(); } });
    $("#sg-next").addEventListener("click", () => { if (pageNo < nPages) { pageNo++; render(); } });
    $("#sg-done").addEventListener("click", () => opts.requestClose("done"));
    $("#sg-cancel").addEventListener("click", () => opts.requestClose("cancel"));
    G.addEventListener("resize", () => { if (doc) render(); });

    async function apply() { // ghi chữ ký vào PDF (đúng chỗ, đúng chiều kể cả trang đang xoay)
      const P = G.PDFLib;
      const pdf = await P.PDFDocument.load(out.bytes);
      const cache = new Map();
      for (const m of marks) {
        let img = cache.get(m.sig);
        if (!img) {
          img = await pdf.embedPng(Uint8Array.from(atob(m.sig.split(",")[1]), (c) => c.charCodeAt(0)));
          cache.set(m.sig, img);
        }
        const page = pdf.getPage(m.page - 1);
        const box = page.getCropBox ? page.getCropBox() : { x: 0, y: 0, ...page.getSize() };
        const R = ((page.getRotation().angle % 360) + 360) % 360;
        const W = box.width, H = box.height;
        const toPdf = (u, v) => { // điểm trên trang đang hiển thị (0..1) -> toạ độ PDF
          const [x, y] = R === 90 ? [v * W, u * H] : R === 180 ? [(1 - u) * W, v * H] : R === 270 ? [(1 - v) * W, (1 - u) * H] : [u * W, (1 - v) * H];
          return [box.x + x, box.y + y];
        };
        const bl = toPdf(m.x, m.y + m.h), br = toPdf(m.x + m.w, m.y + m.h), tl = toPdf(m.x, m.y);
        const name = page.node.newXObject("Sig", img.ref);
        page.pushOperators(P.pushGraphicsState(),
          P.concatTransformationMatrix(br[0] - bl[0], br[1] - bl[1], tl[0] - bl[0], tl[1] - bl[1], bl[0], bl[1]),
          P.drawObject(name), P.popGraphicsState());
      }
      return pdf.save();
    }

    /** Mở ký trên một kết quả {name, bytes}. Trả Promise: số chữ ký đã đặt (0 = huỷ). out.bytes được thay. */
    async function open(o) {
      out = o; marks = []; pageNo = 1;
      el.classList.remove("hidden");
      showSaved();
      const pdfjs = await opts.pdfjs();
      doc = await pdfjs.getDocument({ data: o.bytes.slice(0) }).promise;
      nPages = doc.numPages;
      await render();
      if (!saved.get().length) setTimeout(() => $("#sg-new") && $("#sg-new").click(), 0); // chưa có chữ ký: vẽ luôn
      return new Promise((r) => { finish = r; });
    }

    /** Đóng (nút hoặc Back): "done" ghi chữ ký vào file. */
    async function close(r) {
      pad.close();
      if (!finish) { el.classList.add("hidden"); return; }
      const f = finish;
      finish = null;
      let n = 0;
      if (r === "done" && marks.length) {
        try { out.bytes = await apply(); n = marks.length; } catch (e) { opts.toast("Không ký được: " + e.message); }
      }
      el.classList.add("hidden");
      stage.querySelectorAll(".sg-box").forEach((b) => b.remove());
      if (doc) { doc.destroy(); doc = null; }
      f(n);
    }

    return { open, close };
  }

  CV.sign = { create };
})(typeof globalThis !== "undefined" ? globalThis : window);
