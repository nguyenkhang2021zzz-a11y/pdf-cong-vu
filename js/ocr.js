/* Nhận dạng chữ (OCR) ngay trên máy: Tesseract (mã nguồn mở), dữ liệu tiếng Việt đóng gói sẵn trong app,
 * không gửi ảnh hay chữ ra ngoài. Thư viện nặng (~5 MB) nên chỉ nạp khi cần lần đầu.
 * Lớp chữ ẩn đặt đúng vị trí chữ trong ảnh -> PDF tìm kiếm, bôi đen, chép được chữ như văn bản gốc. */
(function (G) {
  "use strict";
  const CV = (G.CV = G.CV || {});
  let lib = null, worker = null, onLog = null;
  const base = () => new URL("vendor/ocr/", G.location.href).href;

  function loadLib() {
    if (!lib) {
      lib = new Promise((res, rej) => {
        if (G.Tesseract) { res(G.Tesseract); return; }
        const s = document.createElement("script");
        s.src = "vendor/ocr/tesseract.min.js";
        s.onload = () => res(G.Tesseract);
        s.onerror = () => { lib = null; rej(new Error("Không tải được bộ nhận dạng chữ (lần đầu cần có mạng).")); };
        document.head.appendChild(s);
      });
    }
    return lib;
  }

  function getWorker() {
    if (!worker) {
      worker = loadLib().then((T) => T.createWorker("vie", 1 /* chỉ LSTM */, {
        workerPath: base() + "worker.min.js", corePath: base(), langPath: base(),
        // APK: công cụ đóng gói Android giải nén file .gz trong assets -> đọc bản không nén
        gzip: !G.AndroidBridge, workerBlobURL: false, cacheMethod: "none",
        logger: (m) => { if (onLog) onLog(m); },
      })).catch((e) => { worker = null; throw e; });
    }
    return worker;
  }

  /** source: canvas / ảnh. -> {text, words: [{t, b: {x0,y0,x1,y1}}]} (toạ độ điểm ảnh của source) */
  async function recognize(source, progress) {
    onLog = progress || null;
    const w = await getWorker();
    try {
      const { data } = await w.recognize(source);
      const words = (data.words || []).filter((x) => x.text && x.text.trim()).map((x) => ({ t: x.text.trim(), b: x.bbox }));
      return { text: (data.text || "").replace(/\n{3,}/g, "\n\n").trim(), words };
    } finally {
      onLog = null;
    }
  }

  /** Lớp chữ ẩn trên trang. r = chỗ đặt ảnh trên trang {x, y (đáy), w, h} (pt); iw×ih = cỡ ảnh đã nhận dạng. */
  function addTextLayer(page, font, words, r, iw, ih) {
    const P = G.PDFLib;
    if (!words.length) return;
    const key = page.node.newFontDictionary(font.name, font.ref);
    const sx = r.w / iw, sy = r.h / ih;
    const ops = [P.pushGraphicsState(), P.beginText(), P.setTextRenderingMode(P.TextRenderingMode.Invisible)];
    for (const { t, b } of words) {
      const h = (b.y1 - b.y0) * sy, wPt = (b.x1 - b.x0) * sx;
      if (!(h > 0.5 && wPt > 0.5)) continue;
      const tw = font.widthOfTextAtSize(t, h);
      if (!(tw > 0)) continue;
      ops.push(P.setFontAndSize(key, h), P.setCharacterSqueeze((100 * wPt) / tw),
        P.setTextMatrix(1, 0, 0, 1, r.x + b.x0 * sx, r.y + r.h - b.y1 * sy + h * 0.18), P.showText(font.encodeText(t)));
    }
    ops.push(P.endText(), P.popGraphicsState());
    page.pushOperators(...ops);
  }

  async function stop() { // giải phóng bộ nhớ sau khi xong (điện thoại ít RAM)
    if (!worker) return;
    const w = worker;
    worker = null;
    try { await (await w).terminate(); } catch (e) { /* đã dừng */ }
  }

  CV.ocr = { recognize, addTextLayer, stop };
})(typeof globalThis !== "undefined" ? globalThis : window);
