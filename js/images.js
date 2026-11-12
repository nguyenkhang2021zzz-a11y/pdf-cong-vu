/* Ảnh / PDF -> PDF trên điện thoại (port từ pdfcongvu/images.py). Xử lý ảnh bằng canvas,
 * hoàn toàn trên máy. */
(function (G) {
  "use strict";
  const CV = (G.CV = G.CV || {});
  const MM = 72 / 25.4;
  const PAPERS = { A4: [210, 297], A5: [148, 210], A3: [297, 420], Letter: [215.9, 279.4] };
  // chất lượng: [dpi ảnh màu/xám, chất lượng JPEG, dpi ảnh đen trắng]
  const QUALITY = { high: [300, 0.9, 300], standard: [200, 0.8, 300], small: [150, 0.6, 200] };
  const MAX_PIXELS = 16e6; // giới hạn diện tích canvas của Safari trên iPhone
  const DEFAULTS = { paper: "A4", orientation: "auto", margin_mm: 10, color: "color", clean_bg: false, quality: "standard" };

  class Cancelled extends Error { constructor() { super("Đã hủy"); this.cancelled = true; } }

  const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  const isImage = (f) => /^image\//.test(f.type) || /\.(jpe?g|jfif|png|bmp|gif|webp|heic|heif|tiff?)$/i.test(f.name);
  const isJpeg = (f) => /jpe?g/.test(f.type) || /\.(jpe?g|jfif)$/i.test(f.name);

  /* Hướng ảnh EXIF của JPEG (1 = bình thường). */
  function jpegOrientation(b) {
    if (b[0] !== 0xff || b[1] !== 0xd8) return 0;
    let i = 2;
    while (i + 4 < b.length) {
      if (b[i] !== 0xff) return 0;
      const marker = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
      if (marker === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78) { // "Exif"
        const t = i + 10, le = b[t] === 0x49;
        const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
        const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216
          : b[o] * 16777216 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
        const ifd = t + u32(t + 4);
        const n = u16(ifd);
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (u16(e) === 0x0112) return u16(e + 8);
        }
        return 1;
      }
      if (marker === 0xda) break;
      i += 2 + len;
    }
    return 1;
  }

  async function decode(blob) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    try {
      await img.decode(); // trình duyệt tự xoay theo EXIF của điện thoại
    } catch (e) {
      URL.revokeObjectURL(url);
      throw new Error("Điện thoại không đọc được định dạng ảnh này (TIFF/HEIC?). Hãy chụp lại hoặc đổi sang JPG.");
    }
    return { img, url, w: img.naturalWidth, h: img.naturalHeight };
  }

  function layout(iw, ih, o) {
    const m = Math.max(0, +o.margin_mm || 0) * MM;
    const land = iw > ih;
    if (o.paper === "fit") {
      let [bw, bh] = PAPERS.A4;
      if (land) [bw, bh] = [bh, bw];
      const s = Math.min((bw * MM - 2 * m) / iw, (bh * MM - 2 * m) / ih);
      const w = iw * s, h = ih * s;
      return { pw: w + 2 * m, ph: h + 2 * m, x: m, y: m, w, h };
    }
    let [pw, ph] = (PAPERS[o.paper] || PAPERS.A4).map((v) => v * MM);
    if (o.orientation === "landscape" || (o.orientation === "auto" && land)) [pw, ph] = [ph, pw];
    const s = Math.min((pw - 2 * m) / iw, (ph - 2 * m) / ih);
    const w = iw * s, h = ih * s;
    return { pw, ph, x: (pw - w) / 2, y: (ph - h) / 2, w, h };
  }

  function canvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }
  function free(c) { c.width = c.height = 0; } // iPhone giới hạn tổng bộ nhớ canvas

  function draw(img, rot, tw, th) {
    const c = canvas(tw, th);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, tw, th);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.translate(tw / 2, th / 2);
    ctx.rotate((rot * Math.PI) / 180);
    const sw = rot % 180 ? th : tw, sh = rot % 180 ? tw : th;
    ctx.drawImage(img, -sw / 2, -sh / 2, sw, sh);
    return c;
  }

  /* --- làm trắng nền: ước lượng nền giấy (max-filter trên ảnh thu nhỏ) rồi chia cho nền */
  function backgroundOf(chan, w, h) {
    const sw = Math.max(8, w >> 3), sh = Math.max(8, h >> 3);
    const small = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      const y0 = Math.floor((y * h) / sh), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / sh));
      for (let x = 0; x < sw; x++) {
        const x0 = Math.floor((x * w) / sw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / sw));
        let s = 0, n = 0;
        for (let yy = y0; yy < y1; yy += 2) for (let xx = x0; xx < x1; xx += 2) { s += chan[yy * w + xx]; n++; }
        small[y * sw + x] = s / n;
      }
    }
    const pass = (src, fn, r) => {
      const a = new Float32Array(src.length), b = new Float32Array(src.length);
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        let v = fn === "max" ? 0 : 0, n = 0;
        for (let k = -r; k <= r; k++) { const xx = Math.min(sw - 1, Math.max(0, x + k)); const s = src[y * sw + xx]; v = fn === "max" ? Math.max(v, s) : v + s; n++; }
        a[y * sw + x] = fn === "max" ? v : v / n;
      }
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        let v = 0, n = 0;
        for (let k = -r; k <= r; k++) { const yy = Math.min(sh - 1, Math.max(0, y + k)); const s = a[yy * sw + x]; v = fn === "max" ? Math.max(v, s) : v + s; n++; }
        b[y * sw + x] = fn === "max" ? v : v / n;
      }
      return b;
    };
    let bg = pass(small, "max", 3);
    bg = pass(pass(bg, "mean", 2), "mean", 2);
    return { bg, sw, sh };
  }

  const LUT = (() => {
    const t = new Uint8ClampedArray(1025);
    for (let i = 0; i <= 1024; i++) t[i] = Math.round(255 * Math.pow(i / 1024, 1.6));
    return t;
  })();

  function flatten(data, w, h, channels) {
    for (const c of channels) {
      const chan = new Float32Array(w * h);
      for (let i = 0, p = c; i < chan.length; i++, p += 4) chan[i] = data[p];
      const { bg, sw, sh } = backgroundOf(chan, w, h);
      for (let y = 0; y < h; y++) {
        const fy = Math.min(sh - 1.001, Math.max(0, ((y + 0.5) * sh) / h - 0.5));
        const y0 = Math.floor(fy), dy = fy - y0;
        for (let x = 0; x < w; x++) {
          const fx = Math.min(sw - 1.001, Math.max(0, ((x + 0.5) * sw) / w - 0.5));
          const x0 = Math.floor(fx), dx = fx - x0;
          const i0 = y0 * sw + x0;
          const g = (bg[i0] * (1 - dx) + bg[i0 + 1] * dx) * (1 - dy) + (bg[i0 + sw] * (1 - dx) + bg[i0 + sw + 1] * dx) * dy;
          const r = chan[y * w + x] / Math.max(g, 1) / 0.92;
          data[(y * w + x) * 4 + c] = LUT[r >= 1 ? 1024 : Math.round(r * 1024)];
        }
      }
    }
  }

  function toGray(data) {
    for (let p = 0; p < data.length; p += 4) {
      const v = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
      data[p] = data[p + 1] = data[p + 2] = v;
    }
  }

  function otsu(data) {
    const hist = new Float64Array(256);
    for (let p = 0; p < data.length; p += 4) hist[data[p]]++;
    const total = data.length / 4;
    let sumAll = 0;
    for (let i = 0; i < 256; i++) sumAll += i * hist[i];
    let wB = 0, sB = 0, best = 0, t = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sB += i * hist[i];
      const mB = sB / wB, mF = (sumAll - sB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; t = i; }
    }
    return Math.min(Math.max(t, 140), 225);
  }

  function packBits(data, w, h, t) {
    const rowBytes = (w + 7) >> 3; // mỗi dòng đệm đủ byte như PDF yêu cầu
    const out = new Uint8Array(rowBytes * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4] > t) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7); // 1 = trắng
      }
    }
    return out;
  }

  function drawBilevel(pdf, page, bits, w, h, r) {
    const P = G.PDFLib;
    const ref = pdf.context.register(pdf.context.flateStream(bits, {
      Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceGray", BitsPerComponent: 1,
    }));
    const name = page.node.newXObject("Im", ref);
    page.pushOperators(P.pushGraphicsState(), P.concatTransformationMatrix(r.w, 0, 0, r.h, r.x, r.y),
      P.drawObject(name), P.popGraphicsState());
  }

  const toBlob = (c, type, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Hết bộ nhớ khi nén ảnh"))), type, q));

  async function addImage(pdf, item, o) {
    const [dpi, q, bwDpi] = QUALITY[o.quality] || QUALITY.standard;
    const raw = new Uint8Array(await item.file.arrayBuffer());
    const d = await decode(item.file);
    try {
      const rot = ((item.rotation % 360) + 360) % 360;
      const iw = rot % 180 ? d.h : d.w, ih = rot % 180 ? d.w : d.h;
      const L = layout(iw, ih, o);
      const page = pdf.addPage([L.pw, L.ph]);
      const useDpi = o.color === "bw" ? bwDpi : dpi;
      let tw = Math.max(1, Math.round((L.w / 72) * useDpi)), th = Math.max(1, Math.round((L.h / 72) * useDpi));
      if (iw <= tw * 1.05) { tw = iw; th = ih; } // không phóng to ảnh nhỏ
      if (tw * th > MAX_PIXELS) { const s = Math.sqrt(MAX_PIXELS / (tw * th)); tw = Math.floor(tw * s); th = Math.floor(th * s); }

      // JPEG không cần sửa gì -> nhúng nguyên bản (giữ nguyên chất lượng, nhanh)
      if (isJpeg(item.file) && !rot && o.color === "color" && !o.clean_bg && iw <= tw * 1.15 &&
          [0, 1].includes(jpegOrientation(raw))) {
        try {
          page.drawImage(await pdf.embedJpg(raw), { x: L.x, y: L.y, width: L.w, height: L.h });
          return;
        } catch (e) { /* JPEG lạ (CMYK...) -> đi đường canvas */ }
      }

      const c = draw(d.img, rot, tw, th);
      try {
        if (o.color !== "color" || o.clean_bg) {
          const ctx = c.getContext("2d");
          const im = ctx.getImageData(0, 0, tw, th);
          if (o.color !== "color") toGray(im.data);
          if (o.clean_bg || o.color === "bw") flatten(im.data, tw, th, o.color === "color" ? [0, 1, 2] : [0]);
          if (o.color === "bw") {
            drawBilevel(pdf, page, packBits(im.data, tw, th, otsu(im.data)), tw, th, L);
            return;
          }
          if (o.color !== "color") for (let p = 0; p < im.data.length; p += 4) im.data[p + 1] = im.data[p + 2] = im.data[p];
          ctx.putImageData(im, 0, 0);
        }
        const enc = new Uint8Array(await (await toBlob(c, "image/jpeg", q)).arrayBuffer());
        // trình duyệt không có bộ nén JPEG được phép trả PNG (đúng chuẩn) -> nhận diện theo byte đầu, không tin vào loại đã xin
        const isJpg = enc[0] === 0xff && enc[1] === 0xd8;
        page.drawImage(await (isJpg ? pdf.embedJpg(enc) : pdf.embedPng(enc)), { x: L.x, y: L.y, width: L.w, height: L.h });
      } finally {
        free(c);
      }
    } finally {
      URL.revokeObjectURL(d.url);
    }
  }

  async function addPdf(pdf, item) {
    const P = G.PDFLib;
    let src;
    try {
      src = await P.PDFDocument.load(await item.file.arrayBuffer());
    } catch (e) {
      if (/encrypt/i.test(String(e))) throw new Error(`File ${item.file.name} có mật khẩu - hãy gỡ mật khẩu trước.`);
      throw e;
    }
    const pages = await pdf.copyPages(src, src.getPageIndices());
    for (const p of pages) {
      if (item.rotation % 360) p.setRotation(P.degrees((p.getRotation().angle + item.rotation) % 360));
      pdf.addPage(p);
    }
  }

  async function append(pdf, item, o) {
    try {
      if (isPdf(item.file)) await addPdf(pdf, item);
      else await addImage(pdf, item, o);
    } catch (e) {
      if (e.cancelled) throw e;
      throw new Error(e.message && e.message.includes(item.file.name) ? e.message
        : `Không xử lý được file ${item.file.name}: ${e.message || e}`);
    }
  }

  async function newDoc(title) {
    const pdf = await G.PDFLib.PDFDocument.create();
    pdf.setTitle(title || "");
    pdf.setCreator("PDF Công Vụ");
    pdf.setProducer("PDF Công Vụ");
    return pdf;
  }

  const stem = (name) => name.replace(/\.[^.]+$/, "");

  /** items: [{file, rotation}] -> [{name, bytes, pages}] */
  async function build(items, opts, merge, ui) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    if (!items.length) throw new Error("Chưa có ảnh nào trong danh sách.");
    const step = async (i, name) => {
      if (ui && ui.cancelled && ui.cancelled()) throw new Cancelled();
      if (ui && ui.progress) ui.progress(i, items.length, name);
      await new Promise((r) => setTimeout(r, 0)); // nhả luồng cho giao diện vẽ thanh tiến trình
    };
    const outs = [];
    if (merge) {
      const name = stem(items[0].file.name);
      const pdf = await newDoc(name);
      for (let i = 0; i < items.length; i++) { await step(i, items[i].file.name); await append(pdf, items[i], o); }
      outs.push({ name: name + ".pdf", bytes: await pdf.save(), pages: pdf.getPageCount() });
    } else {
      for (let i = 0; i < items.length; i++) {
        await step(i, items[i].file.name);
        const pdf = await newDoc(stem(items[i].file.name));
        await append(pdf, items[i], o);
        outs.push({ name: stem(items[i].file.name) + ".pdf", bytes: await pdf.save(), pages: pdf.getPageCount() });
      }
    }
    if (ui && ui.progress) ui.progress(items.length, items.length, "Xong");
    return outs;
  }

  CV.images = { DEFAULTS, PAPERS, QUALITY, isPdf, isImage, jpegOrientation, layout, otsu, packBits, build, Cancelled };
})(typeof globalThis !== "undefined" ? globalThis : window);
