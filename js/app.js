/* PDF Công Vụ - giao diện điện thoại. */
(function (G) {
  "use strict";
  const CV = G.CV;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const bridge = () => G.AndroidBridge || null; // có khi chạy trong app Android (APK)
  const state = { imgs: [], words: [], outs: [], fontBytes: null, seq: 0 };

  const LS = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem("pdfcv." + k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("pdfcv." + k, JSON.stringify(v)); } catch (e) { /* chế độ ẩn danh */ } },
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const human = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1).replace(".", ",") + " MB";
  const stamp = () => { const d = new Date(), p = (x) => String(x).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };

  /* ------------------------------------------------------------ tiện ích giao diện */
  let toastTimer;
  function toast(msg, ms) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), ms || 2800);
  }

  function openOverlay(el) {
    el.classList.remove("hidden");
    history.pushState({ ov: el.id }, "");
  }
  function closeTop() { // nút Back của điện thoại / nút ✕
    for (const id of ["viewer", "sheet"]) {
      const el = document.getElementById(id);
      if (!el.classList.contains("hidden")) { el.classList.add("hidden"); if (id === "viewer") $("#viewer-pages").innerHTML = ""; return true; }
    }
    return false;
  }
  G.addEventListener("popstate", closeTop);
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => {
    if (history.state && history.state.ov) history.back(); else closeTop();
  }));

  async function run(text, fn) {
    const box = $("#busy");
    const ctl = { cancelled: false };
    $("#busy-text").textContent = text;
    $("#busy-bar").style.width = "0";
    box.classList.remove("hidden");
    $("#busy-cancel").onclick = () => { ctl.cancelled = true; $("#busy-text").textContent = "Đang hủy..."; };
    await new Promise((r) => setTimeout(r, 30));
    try {
      return await fn({
        cancelled: () => ctl.cancelled,
        progress: (i, n, name) => {
          $("#busy-bar").style.width = Math.round((i / Math.max(n, 1)) * 100) + "%";
          if (i < n) $("#busy-text").textContent = `Đang xử lý ${i + 1}/${n}: ${name}`;
        },
      });
    } catch (e) {
      if (e && e.cancelled) toast("Đã hủy.");
      else { console.error(e); alert((e && e.message) || String(e)); }
      return null;
    } finally {
      box.classList.add("hidden");
    }
  }

  async function fontBytes() {
    if (state.fontBytes) return state.fontBytes;
    const names = { r: "Regular", b: "Bold", i: "Italic", bi: "BoldItalic" };
    const out = {};
    await Promise.all(Object.entries(names).map(async ([k, n]) => {
      const r = await fetch(`fonts/Tinos-${n}.ttf`);
      if (!r.ok) throw new Error("Không tải được font chữ. Hãy mở lại ứng dụng.");
      out[k] = new Uint8Array(await r.arrayBuffer());
    }));
    state.fontBytes = out;
    return out;
  }

  /* ------------------------------------------------------------ tab */
  function showTab(id) {
    $$(".tab").forEach((t) => t.classList.toggle("active", t.id === id));
    $$(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === id));
    LS.set("tab", id);
  }
  $$(".tabbar button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  /* ------------------------------------------------------------ kết quả: xem / lưu / chia sẻ */
  const toB64 = (bytes) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(new Blob([bytes]));
  });
  const pdfName = (s) => { s = String(s || "").trim().replace(/[\\/:*?"<>|]+/g, "_") || "Van ban"; return /\.pdf$/i.test(s) ? s : s + ".pdf"; };

  // iPhone/iPad (kể cả iPad báo là Mac): mở từ màn hình chính thì <a download> không chạy
  const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  async function saveOut(o) {
    if (bridge()) {
      toast(bridge().saveFile(o.name, await toB64(o.bytes), "application/pdf"), 4000);
      return;
    }
    if (IOS) { // bảng chia sẻ của iOS có sẵn "Lưu vào Tệp". Gọi share ngay, không await trước (Safari đòi đang trong cú chạm)
      const files = [new File([o.bytes], o.name, { type: "application/pdf" })];
      if (navigator.canShare && navigator.canShare({ files })) {
        toast("Chọn \"Lưu vào Tệp\" để lưu file vào máy.", 5000);
        try { await navigator.share({ files }); }
        catch (e) { if (e.name !== "AbortError") alert("Không lưu được: " + e.message); }
        return;
      }
    }
    const url = URL.createObjectURL(new Blob([o.bytes], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url; a.download = o.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast("Đã lưu vào mục Tải xuống (Downloads).");
  }

  async function shareOuts(outs) {
    if (bridge()) {
      const arr = [];
      for (const o of outs) arr.push({ name: o.name, data: await toB64(o.bytes) });
      bridge().shareFiles(JSON.stringify(arr));
      return;
    }
    const files = outs.map((o) => new File([o.bytes], o.name, { type: "application/pdf" }));
    if (navigator.canShare && navigator.canShare({ files })) {
      try { await navigator.share({ files, title: outs[0].name }); }
      catch (e) { if (e.name !== "AbortError") alert("Không chia sẻ được: " + e.message); }
      return;
    }
    toast("Trình duyệt này chưa hỗ trợ chia sẻ file - đã lưu về máy.");
    for (const o of outs) await saveOut(o);
  }

  function showResults(outs) {
    state.outs = outs;
    $("#results").innerHTML = outs.map((o, i) => `
      <li>
        <input class="fname" data-i="${i}" value="${esc(o.name)}" aria-label="Tên file">
        <div class="sub">${o.pages} trang · ${human(o.bytes.length)}</div>
        <div class="acts">
          <button class="btn" data-act="view" data-i="${i}">Xem</button>
          <button class="btn" data-act="save" data-i="${i}">Lưu về máy</button>
          <button class="btn primary" data-act="share" data-i="${i}">Chia sẻ</button>
        </div>
      </li>`).join("");
    $("#results-all").classList.toggle("hidden", outs.length < 2);
    openOverlay($("#sheet"));
  }
  $("#results").addEventListener("input", (e) => {
    if (e.target.classList.contains("fname")) state.outs[+e.target.dataset.i].name = pdfName(e.target.value);
  });
  $("#results").addEventListener("change", (e) => {
    if (e.target.classList.contains("fname")) e.target.value = state.outs[+e.target.dataset.i].name;
  });
  $("#results").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const o = state.outs[+b.dataset.i];
    if (b.dataset.act === "view") view(o.bytes, o.name);
    else if (b.dataset.act === "save") saveOut(o);
    else shareOuts([o]);
  });
  $("#share-all").addEventListener("click", () => shareOuts(state.outs));

  /* --- xem trước bằng pdf.js: chỉ vẽ trang đang hiện trên màn hình (điện thoại ít RAM) */
  let pdfjs;
  function loadPdfjs() {
    if (!pdfjs) {
      pdfjs = new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "vendor/pdf.min.js";
        s.onload = () => { G.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js"; res(G.pdfjsLib); };
        s.onerror = () => { pdfjs = null; rej(new Error("Không tải được bộ xem PDF.")); };
        document.head.appendChild(s);
      });
    }
    return pdfjs;
  }

  async function view(bytes, title) {
    let doc;
    try {
      const lib = await loadPdfjs();
      doc = await lib.getDocument({ data: bytes.slice() }).promise;
    } catch (e) { alert(e.message || String(e)); return; }
    const box = $("#viewer-pages");
    box.innerHTML = "";
    $("#viewer-title").textContent = title || "Xem trước";
    openOverlay($("#viewer"));
    const width = Math.min(box.clientWidth - 24, 820);
    const dpr = Math.min(G.devicePixelRatio || 1, 2);
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting || en.target.dataset.done) continue;
        en.target.dataset.done = "1";
        const c = en.target;
        doc.getPage(+c.dataset.page).then((page) => {
          const vp = page.getViewport({ scale: (width / page.getViewport({ scale: 1 }).width) * dpr });
          c.width = vp.width; c.height = vp.height;
          return page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
        }).catch(() => {});
      }
    }, { root: box, rootMargin: "600px 0px" });
    const first = await doc.getPage(1);
    const v1 = first.getViewport({ scale: 1 });
    for (let i = 1; i <= doc.numPages; i++) {
      const c = document.createElement("canvas");
      c.dataset.page = i;
      c.style.aspectRatio = `${v1.width} / ${v1.height}`;
      box.appendChild(c);
      const n = document.createElement("div");
      n.className = "pno";
      n.textContent = `Trang ${i}/${doc.numPages}`;
      box.appendChild(n);
      io.observe(c);
    }
  }

  /* ------------------------------------------------------------ TAB ẢNH */
  const imgOpts = LS.get("img", Object.assign({ merge: true }, CV.images.DEFAULTS));
  const IMG_FIELDS = { paper: "#o-paper", orientation: "#o-orient", margin_mm: "#o-margin", color: "#o-color", quality: "#o-quality" };
  for (const [k, sel] of Object.entries(IMG_FIELDS)) $(sel).value = String(imgOpts[k]);
  $("#o-clean").checked = !!imgOpts.clean_bg;
  $("#o-merge").checked = imgOpts.merge !== false;
  function readImgOpts() {
    const o = {};
    for (const [k, sel] of Object.entries(IMG_FIELDS)) o[k] = $(sel).value;
    o.margin_mm = +o.margin_mm;
    o.clean_bg = $("#o-clean").checked;
    o.merge = $("#o-merge").checked;
    LS.set("img", o);
    return o;
  }
  $("#img-opts").addEventListener("change", readImgOpts);

  function addImgs(fileList) {
    const skipped = [];
    for (const f of Array.from(fileList || [])) {
      if (CV.images.isPdf(f)) state.imgs.push({ id: ++state.seq, file: f, rotation: 0, pdf: true });
      else if (CV.images.isImage(f)) state.imgs.push({ id: ++state.seq, file: f, rotation: 0, url: URL.createObjectURL(f) });
      else skipped.push(f.name);
    }
    if (skipped.length) toast("Bỏ qua file không phải ảnh/PDF: " + skipped.join(", "), 4000);
    renderImgs();
  }
  $("#in-camera").addEventListener("change", (e) => { addImgs(e.target.files); e.target.value = ""; });
  $("#in-files").addEventListener("change", (e) => { addImgs(e.target.files); e.target.value = ""; });

  function renderImgs() {
    const ul = $("#img-list");
    ul.innerHTML = state.imgs.map((it, i) => `
      <li class="item" data-id="${it.id}">
        <span class="idx">${i + 1}</span>
        ${it.pdf ? `<div class="thumb">PDF</div>` : `<img class="thumb" src="${it.url}" alt="" style="transform:rotate(${it.rotation}deg)">`}
        <div class="meta"><div class="name">${esc(it.file.name)}</div><div class="sub">${it.pdf ? "PDF" : "Ảnh"} · ${human(it.file.size)}${it.rotation ? " · xoay " + it.rotation + "°" : ""}</div></div>
        <div class="ops">
          <button data-op="up" aria-label="Lên">↑</button>
          <button data-op="down" aria-label="Xuống">↓</button>
          <button data-op="rot" aria-label="Xoay">↻</button>
          <button data-op="del" aria-label="Xóa">✕</button>
        </div>
      </li>`).join("");
    $("#img-empty").style.display = state.imgs.length ? "none" : "";
    $("#img-make").textContent = state.imgs.length ? `TẠO PDF (${state.imgs.length} file)` : "TẠO PDF";
  }
  $("#img-list").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-op]");
    if (!b) return;
    const id = +b.closest(".item").dataset.id;
    const i = state.imgs.findIndex((x) => x.id === id);
    const L = state.imgs;
    switch (b.dataset.op) {
      case "up": if (i > 0) [L[i - 1], L[i]] = [L[i], L[i - 1]]; break;
      case "down": if (i < L.length - 1) [L[i + 1], L[i]] = [L[i], L[i + 1]]; break;
      case "rot": L[i].rotation = (L[i].rotation + 90) % 360; break;
      case "del": if (L[i].url) URL.revokeObjectURL(L[i].url); L.splice(i, 1); break;
    }
    renderImgs();
  });

  $("#img-make").addEventListener("click", async () => {
    if (!state.imgs.length) { toast("Chưa có ảnh nào. Bấm “Chụp ảnh” hoặc “Chọn ảnh / PDF”."); return; }
    const o = readImgOpts();
    const outs = await run("Đang tạo PDF...", (ui) => CV.images.build(state.imgs, o, o.merge, ui));
    if (!outs) return;
    if (o.merge) outs[0].name = `HoSo_${stamp()}.pdf`;
    showResults(outs);
  });

  /* ------------------------------------------------------------ TAB VĂN BẢN */
  $("#dl-tenloai").innerHTML = CV.nd30.TEN_LOAI.filter(Boolean).map((t) => `<option value="${esc(t)}">`).join("");
  const T = {
    font_size: "#t-size", line_spacing: "#t-spacing", first_indent_cm: "#t-indent",
    margin_top_mm: "#t-mt", margin_bottom_mm: "#t-mb", margin_left_mm: "#t-ml", margin_right_mm: "#t-mr",
    co_quan_chu_quan: "#t-chuquan", co_quan_ban_hanh: "#t-banhanh", so_ky_hieu: "#t-so", dia_danh: "#t-diadanh",
    ngay: "#t-ngay", ten_loai: "#t-tenloai", trich_yeu: "#t-trichyeu",
    noi_nhan: "#t-noinhan", tham_quyen: "#t-thamquyen", chuc_vu: "#t-chucvu", nguoi_ky: "#t-nguoiky",
  };
  const TB = { page_numbers: "#t-pagenum", use_header: "#t-header", use_footer: "#t-footer" };
  // Chỉ nhớ thông tin cơ quan / người ký / tùy chọn - KHÔNG lưu nội dung văn bản (có thể là tài liệu mật).
  const saved = Object.assign({}, CV.nd30.DEFAULTS, LS.get("nd30", {}));
  for (const [k, sel] of Object.entries(T)) $(sel).value = saved[k] == null ? "" : String(saved[k]);
  for (const [k, sel] of Object.entries(TB)) $(sel).checked = !!saved[k];
  $("#t-blankdate").checked = saved.ghi_ngay === false;
  function readNd30() {
    const o = {};
    for (const [k, sel] of Object.entries(T)) o[k] = $(sel).value;
    for (const [k, sel] of Object.entries(TB)) o[k] = $(sel).checked;
    o.ghi_ngay = !$("#t-blankdate").checked;
    const keep = Object.assign({}, o);
    delete keep.ngay; // ngày thay đổi theo từng văn bản
    LS.set("nd30", keep);
    return o;
  }
  $("#tab-txt").addEventListener("change", (e) => { if (e.target.id !== "txt") readNd30(); });

  $("#in-txt").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const text = await run("Đang đọc file...", async () => {
      const buf = new Uint8Array(await f.arrayBuffer());
      if (/\.docx$/i.test(f.name)) return CV.docx.readText(buf);
      if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf);
      if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf);
      return new TextDecoder("utf-8").decode(buf);
    });
    if (text == null) return;
    if ($("#txt").value.trim() && !confirm("Thay nội dung đang soạn bằng nội dung file?")) return;
    $("#txt").value = text.normalize("NFC");
    toast("Đã mở " + f.name);
  });
  $("#txt-clear").addEventListener("click", () => {
    if ($("#txt").value.trim() && confirm("Xóa toàn bộ nội dung đang soạn?")) $("#txt").value = "";
  });

  async function buildText() {
    const o = readNd30();
    const text = $("#txt").value;
    if (!text.trim() && !o.use_header) { toast("Hãy nhập hoặc dán nội dung văn bản trước."); return null; }
    return run("Đang dựng văn bản...", async () => CV.nd30.build(text, o, await fontBytes()));
  }
  $("#txt-preview").addEventListener("click", async () => {
    const res = await buildText();
    if (res) view(res.bytes, "Xem trước");
  });
  $("#txt-make").addEventListener("click", async () => {
    const res = await buildText();
    if (!res) return;
    const loai = $("#t-tenloai").value.trim();
    const base = $("#t-header").checked ? (loai ? loai.toLowerCase().replace(/^./, (c) => c.toUpperCase()) : "Cong van") : "Van ban";
    showResults([{ name: pdfName(`${base} ${stamp()}`), bytes: res.bytes, pages: res.pages }]);
  });

  /* ------------------------------------------------------------ TAB WORD */
  $("#in-word").addEventListener("change", (e) => {
    for (const f of Array.from(e.target.files || [])) {
      if (/\.(docx|txt)$/i.test(f.name)) state.words.push({ id: ++state.seq, file: f, status: "Chờ chuyển" });
      else if (/\.(doc|rtf|odt)$/i.test(f.name)) toast(`${f.name}: hãy lưu lại dạng .docx bằng Word/WPS rồi chọn lại.`, 5000);
      else toast(`Bỏ qua ${f.name}: không phải file Word.`);
    }
    e.target.value = "";
    renderWords();
  });
  function renderWords() {
    $("#word-list").innerHTML = state.words.map((w) => `
      <li class="item" data-id="${w.id}">
        <div class="thumb">${/\.txt$/i.test(w.file.name) ? "TXT" : "DOCX"}</div>
        <div class="meta"><div class="name">${esc(w.file.name)}</div><div class="sub ${w.cls || ""}">${esc(w.status)}</div></div>
        <div class="ops"><button data-op="del" aria-label="Xóa">✕</button></div>
      </li>`).join("");
    $("#word-make").textContent = state.words.length ? `CHUYỂN SANG PDF (${state.words.length} file)` : "CHUYỂN SANG PDF";
  }
  $("#word-list").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-op]");
    if (!b) return;
    const id = +b.closest(".item").dataset.id;
    state.words = state.words.filter((w) => w.id !== id);
    renderWords();
  });
  $("#word-make").addEventListener("click", async () => {
    if (!state.words.length) { toast("Chưa có file Word nào. Bấm “Chọn file Word”."); return; }
    const outs = await run("Đang chuyển file Word...", async (ui) => {
      const fb = await fontBytes();
      const res = [];
      for (let i = 0; i < state.words.length; i++) {
        const w = state.words[i];
        if (ui.cancelled()) throw new CV.images.Cancelled();
        ui.progress(i, state.words.length, w.file.name);
        await new Promise((r) => setTimeout(r, 0));
        try {
          const buf = new Uint8Array(await w.file.arrayBuffer());
          const stem = w.file.name.replace(/\.[^.]+$/, "");
          const r = /\.txt$/i.test(w.file.name)
            ? await CV.nd30.build(new TextDecoder().decode(buf), { first_indent_cm: 0, page_numbers: false }, fb)
            : await CV.docx.build(buf, fb, stem);
          res.push({ name: stem + ".pdf", bytes: r.bytes, pages: r.pages });
          w.status = `Xong · ${r.pages} trang`; w.cls = "ok";
        } catch (err) {
          w.status = "Lỗi: " + (err.message || err); w.cls = "err";
        }
      }
      return res;
    });
    renderWords();
    if (outs && outs.length) showResults(outs);
    else if (outs) alert("Không chuyển được file nào - xem lỗi trong danh sách.");
  });

  /* ------------------------------------------------------------ khởi động */
  showTab(LS.get("tab", "tab-img"));
  renderImgs();
  renderWords();
  fontBytes().catch(() => {}); // tải sẵn font
  if ("serviceWorker" in navigator && !bridge() && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  CV.app = { state, toast, view, showResults };
})(window);
