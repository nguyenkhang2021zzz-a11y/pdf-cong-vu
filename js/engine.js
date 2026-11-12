/* PDF Công Vụ - bộ dàn trang dựng PDF bằng pdf-lib (chạy trên điện thoại và Node).
 *
 * Mô hình khối (đơn vị point, 1 pt = 1/72 inch):
 *   {k:"p", runs:[{t,b,i,u,size}], size, leading, align:"left|center|right|justify",
 *    fi (lùi dòng đầu), li, ri (lề trái/phải đoạn), sb, sa (cách trên/dưới)}
 *   {k:"space", h}            {k:"hr", w, th, sb, sa}         {k:"pagebreak"}
 *   {k:"img", bytes, type:"png|jpg", w, h}
 *   {k:"table", widths:[..], rows:[[cell|null..]..], grid:bool, pad:{l,r,t,b}}
 *        cell = {blocks:[..], rs, cs}  (null = ô bị gộp)
 *   {k:"keep", blocks:[..]}   giữ cả nhóm trên cùng một trang
 */
(function (G) {
  "use strict";
  const CV = (G.CV = G.CV || {});
  const MM = 72 / 25.4;
  const CM = 72 / 2.54;
  const ASC = 0.891, DESC = 0.216; // Tinos có số đo giống hệt Times New Roman
  const SINGLE = 1.15; // "dòng đơn" của Word với Times New Roman
  const NBSP = " ";
  const A4 = [595.2756, 841.8898];

  function nfc(s) { return String(s == null ? "" : s).normalize("NFC"); }
  function black() { return G.PDFLib.rgb(0, 0, 0); }

  class Fonts {
    constructor(f) { this.f = f; this.cache = new Map(); }
    get(b, i) { return this.f[b && i ? "bi" : b ? "b" : i ? "i" : "r"]; }
    width(font, size, text) {
      const key = font.__cvKey + "\u0001" + text;
      let w = this.cache.get(key);
      if (w === undefined) {
        w = font.widthOfTextAtSize(text, 1000);
        this.cache.set(key, w);
      }
      return (w * size) / 1000;
    }
  }

  async function embedFonts(pdf, bytes) {
    pdf.registerFontkit(G.fontkit);
    const f = {};
    for (const k of ["r", "b", "i", "bi"]) {
      f[k] = await pdf.embedFont(bytes[k], { subset: true });
      f[k].__cvKey = k;
    }
    return new Fonts(f);
  }

  /* ------------------------------------------------------------ đoạn văn */

  function para(runs, o) {
    o = o || {};
    const size = o.size || 14;
    return {
      k: "p", runs: typeof runs === "string" ? [{ t: runs }] : runs, size,
      leading: o.leading || size * SINGLE, align: o.align || "left",
      fi: o.fi || 0, li: o.li || 0, ri: o.ri || 0, sb: o.sb || 0, sa: o.sa || 0,
    };
  }

  function tokenize(p, fonts) {
    const items = [];
    let group = null;
    for (const r of p.runs) {
      if (!r || !r.t) continue;
      const font = fonts.get(r.b, r.i);
      const size = r.size || p.size;
      const parts = nfc(r.t).replace(/\t/g, NBSP.repeat(6)).replace(/\r\n?/g, "\n").split(/(\n| +)/);
      for (const s of parts) {
        if (!s) continue;
        if (s === "\n") { group = null; items.push({ k: "br" }); continue; }
        if (s.charCodeAt(0) === 32) {
          group = null;
          items.push({ k: "s", w: fonts.width(font, size, " ") * s.length, u: r.u, size });
          continue;
        }
        const part = { t: s, font, size, u: r.u, w: fonts.width(font, size, s) };
        // chữ dính liền nhưng khác kiểu (VD "**Phòng**,") phải đi chung một dòng
        if (!group) { group = { k: "g", parts: [], w: 0 }; items.push(group); }
        group.parts.push(part);
        group.w += part.w;
      }
    }
    return items;
  }

  function splitGroup(g, avail, fonts) {
    const out = [];
    let cur = { k: "g", parts: [], w: 0 };
    for (const part of g.parts) {
      let buf = "";
      for (const ch of Array.from(part.t)) {
        const w = fonts.width(part.font, part.size, buf + ch);
        if (cur.w + w > avail && (cur.parts.length || buf)) {
          if (buf) {
            const bw = fonts.width(part.font, part.size, buf);
            cur.parts.push(Object.assign({}, part, { t: buf, w: bw }));
            cur.w += bw;
          }
          out.push(cur);
          cur = { k: "g", parts: [], w: 0 };
          buf = ch;
        } else {
          buf += ch;
        }
      }
      if (buf) {
        const bw = fonts.width(part.font, part.size, buf);
        cur.parts.push(Object.assign({}, part, { t: buf, w: bw }));
        cur.w += bw;
      }
    }
    if (cur.parts.length) out.push(cur);
    return out;
  }

  function breakLines(p, width, fonts) {
    const items = tokenize(p, fonts);
    const lines = [];
    const availFor = (first) => width - p.li - p.ri - (first ? p.fi : 0);
    let cur = { items: [], w: 0, first: true, maxSize: p.size };
    let space = null;

    function push(forced) {
      cur.forced = forced;
      lines.push(cur);
      cur = { items: [], w: 0, first: false, maxSize: p.size };
      space = null;
    }
    function add(g) {
      if (space && cur.items.length) { cur.items.push(space); cur.w += space.w; }
      cur.items.push(g);
      cur.w += g.w;
      for (const part of g.parts) cur.maxSize = Math.max(cur.maxSize, part.size);
      space = null;
    }

    for (const it of items) {
      if (it.k === "br") { push(true); continue; }
      if (it.k === "s") { if (cur.items.length) space = it; continue; }
      const sp = space && cur.items.length ? space.w : 0;
      if (cur.items.length && cur.w + sp + it.w > availFor(cur.first) + 0.01) push(false);
      const avail = availFor(cur.first);
      if (!cur.items.length && it.w > avail + 0.01) { // từ quá dài (đường link...) -> cắt theo ký tự
        const pieces = splitGroup(it, avail, fonts);
        pieces.forEach((piece, idx) => { if (idx) push(false); add(piece); });
        continue;
      }
      add(it);
    }
    push(true);
    return lines;
  }

  function lineLeading(p, line) {
    return p.leading * Math.max(1, line.maxSize / p.size);
  }

  function drawLine(page, p, line, x0, width, top) {
    const lead = lineLeading(p, line);
    const size = line.maxSize;
    const base = top - lead + DESC * size + (lead - (ASC + DESC) * size) / 2;
    const avail = width - p.li - p.ri - (line.first ? p.fi : 0);
    let x = x0 + p.li + (line.first ? p.fi : 0);
    let extra = 0;
    const gaps = line.items.filter((i) => i.k === "s").length;
    if (p.align === "center") x += (avail - line.w) / 2;
    else if (p.align === "right") x += avail - line.w;
    else if (p.align === "justify" && !line.forced && gaps) extra = Math.max(0, (avail - line.w) / gaps);
    const color = black();
    const underline = (x1, w, sz) => page.drawLine({
      start: { x: x1, y: base - sz * 0.12 }, end: { x: x1 + w, y: base - sz * 0.12 },
      thickness: Math.max(0.5, sz * 0.05), color,
    });
    line.items.forEach((it, idx) => {
      if (it.k === "s") {
        if (it.u) underline(x, it.w + extra, it.size);
        x += it.w + extra;
        return;
      }
      // Vẽ kèm dấu cách thật sau từ: nếu chỉ chừa khoảng trống, trình đọc PDF phải đoán
      // và hay đoán sai -> copy/tìm kiếm chữ bị dính ("Tựdo"). Độ giãn căn đều nằm ngoài glyph.
      const spaced = line.items[idx + 1] && line.items[idx + 1].k === "s";
      it.parts.forEach((part, j) => {
        const t = spaced && j === it.parts.length - 1 ? part.t + " " : part.t;
        page.drawText(t, { x, y: base, size: part.size, font: part.font, color });
        if (part.u) underline(x, part.w, part.size);
        x += part.w;
      });
    });
    return lead;
  }

  /* ------------------------------------------------------------ đo & vẽ khối */

  function layout(b, width, fonts) {
    if (b.k === "p") {
      // cache theo bề rộng + bộ font của đúng tài liệu đang dựng
      if (!b._lines || b._lw !== width || b._lf !== fonts) {
        b._lines = breakLines(b, width, fonts); b._lw = width; b._lf = fonts;
      }
      return b._lines;
    }
    return null;
  }

  function imgSize(b, width) {
    let w = b.w, h = b.h;
    if (w > width) { h = (h * width) / w; w = width; }
    return [w, h];
  }

  function rowHeights(t, fonts) {
    const n = t.rows.length;
    const hs = new Array(n).fill(0);
    const pad = t.pad;
    const spanning = [];
    t.rows.forEach((row, r) => row.forEach((cell, c) => {
      if (!cell) return;
      const w = sum(t.widths.slice(c, c + (cell.cs || 1))) - pad.l - pad.r;
      cell._w = w;
      cell._h = measureBlocks(cell.blocks, w, fonts) + pad.t + pad.b;
      if ((cell.rs || 1) === 1) hs[r] = Math.max(hs[r], cell._h);
      else spanning.push([r, cell]);
    }));
    for (const [r, cell] of spanning) {
      const last = Math.min(n - 1, r + cell.rs - 1);
      const have = sum(hs.slice(r, last + 1));
      if (cell._h > have) hs[last] += cell._h - have;
    }
    return hs;
  }

  function sum(a) { return a.reduce((s, v) => s + v, 0); }

  function measure(b, width, fonts) {
    switch (b.k) {
      case "p": return b.sb + sum(layout(b, width, fonts).map((l) => lineLeading(b, l))) + b.sa;
      case "space": return b.h;
      case "hr": return (b.sb || 0) + (b.th || 0.6) + (b.sa || 0);
      case "img": return imgSize(b, width)[1];
      case "table": return sum(rowHeights(b, fonts));
      case "keep": return measureBlocks(b.blocks, width, fonts);
      default: return 0;
    }
  }

  function measureBlocks(blocks, width, fonts) {
    return sum((blocks || []).map((b) => measure(b, width, fonts)));
  }

  // Vẽ một khối tại vị trí cố định (dùng trong ô bảng / khối giữ chung) - không ngắt trang.
  function drawAt(page, b, x, top, width, fonts) {
    switch (b.k) {
      case "p": {
        let y = top - b.sb;
        for (const line of layout(b, width, fonts)) y -= drawLine(page, b, line, x, width, y);
        return top - y + b.sa;
      }
      case "space": return b.h;
      case "hr": {
        const th = b.th || 0.6;
        const w = Math.min(b.w, width);
        const y = top - (b.sb || 0) - th / 2;
        const x1 = x + (width - w) / 2;
        page.drawLine({ start: { x: x1, y }, end: { x: x1 + w, y }, thickness: th, color: black() });
        return measure(b, width, fonts);
      }
      case "img": {
        const [w, h] = imgSize(b, width);
        if (b._pdfImage) page.drawImage(b._pdfImage, { x: x + (b.align === "center" ? (width - w) / 2 : 0), y: top - h, width: w, height: h });
        return h;
      }
      case "table": {
        const hs = rowHeights(b, fonts);
        let y = top;
        hs.forEach((h, r) => { drawRow(page, b, r, hs, x, y, fonts); y -= h; });
        return top - y;
      }
      case "keep": {
        let y = top;
        for (const c of b.blocks) y -= drawAt(page, c, x, y, width, fonts);
        return top - y;
      }
      default: return 0;
    }
  }

  function drawRow(page, t, r, hs, x, top, fonts) {
    const colX = [0];
    t.widths.forEach((w, i) => colX.push(colX[i] + w));
    t.rows[r].forEach((cell, c) => {
      if (!cell) return;
      const cs = cell.cs || 1, rs = cell.rs || 1;
      const cx = x + colX[c];
      const cw = colX[c + cs] - colX[c];
      const ch = sum(hs.slice(r, r + rs));
      let y = top - t.pad.t;
      for (const b of cell.blocks) y -= drawAt(page, b, cx + t.pad.l, y, cell._w, fonts);
      if (t.grid) {
        const color = black(), thickness = 0.5;
        const L = (x1, y1, x2, y2) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color });
        L(cx, top, cx + cw, top); L(cx, top - ch, cx + cw, top - ch);
        L(cx, top, cx, top - ch); L(cx + cw, top, cx + cw, top - ch);
      }
    });
  }

  /* ------------------------------------------------------------ dòng chảy trang */

  class Flow {
    constructor(pdf, fonts, o) {
      this.pdf = pdf; this.fonts = fonts; this.o = o;
      this.pw = o.size[0]; this.ph = o.size[1]; this.m = o.margins;
      this.width = this.pw - this.m.l - this.m.r;
      this.page = null; this.pageNo = 0; this.y = 0; this.atTop = true;
    }
    newPage() {
      this.page = this.pdf.addPage([this.pw, this.ph]);
      this.pageNo++;
      this.y = this.ph - this.m.t;
      this.atTop = true;
      if (this.o.onPage) this.o.onPage(this.page, this.pageNo, this);
    }
    room() { return this.y - this.m.b; }
    fits(h) { return h <= this.room() + 0.01; }
    used(h) { this.y -= h; if (h > 0) this.atTop = false; }

    add(b) {
      if (!this.page) this.newPage();
      const F = this.fonts, W = this.width, x = this.m.l;
      switch (b.k) {
        case "p": {
          if (!this.atTop) this.y -= b.sb;
          for (const line of layout(b, W, F)) {
            const lead = lineLeading(b, line);
            if (!this.fits(lead) && !this.atTop) this.newPage();
            drawLine(this.page, b, line, x, W, this.y);
            this.used(lead);
          }
          this.y -= b.sa;
          return;
        }
        case "pagebreak":
          if (!this.atTop) this.newPage();
          return;
        case "space":
          if (!this.fits(b.h)) { if (!this.atTop) this.newPage(); return; }
          this.y -= b.h;
          return;
        case "table": {
          const hs = rowHeights(b, F);
          hs.forEach((h, r) => {
            if (!this.fits(h) && !this.atTop) this.newPage();
            drawRow(this.page, b, r, hs, x, this.y, F);
            this.used(h);
          });
          return;
        }
        case "keep": {
          const h = measureBlocks(b.blocks, W, F);
          if (!this.fits(h) && !this.atTop && h <= this.ph - this.m.t - this.m.b) this.newPage();
          for (const c of b.blocks) this.add(c);
          return;
        }
        default: {
          const h = measure(b, W, F);
          if (!this.fits(h) && !this.atTop) this.newPage();
          drawAt(this.page, b, x, this.y, W, F);
          this.used(h);
        }
      }
    }
  }

  async function embedImages(pdf, blocks) {
    for (const b of blocks || []) {
      if (b.k === "img") {
        try {
          b._pdfImage = b.type === "png" ? await pdf.embedPng(b.bytes) : await pdf.embedJpg(b.bytes);
        } catch (e) {
          b._pdfImage = null; // ảnh hỏng/định dạng lạ -> bỏ qua
        }
      } else if (b.k === "table") {
        for (const row of b.rows) for (const cell of row) if (cell) await embedImages(pdf, cell.blocks);
      } else if (b.k === "keep") {
        await embedImages(pdf, b.blocks);
      }
    }
  }

  /**
   * Dựng PDF từ danh sách khối.
   * opts: {fontBytes:{r,b,i,bi}, size:[w,h], margins:{t,r,b,l}, title, pageNumbers:{fromPage,size}}
   * Trả về {bytes: Uint8Array, pages}
   */
  async function render(blocks, opts) {
    const { PDFDocument } = G.PDFLib;
    const pdf = await PDFDocument.create();
    const fonts = await embedFonts(pdf, opts.fontBytes);
    await embedImages(pdf, blocks);
    const pn = opts.pageNumbers;
    const flow = new Flow(pdf, fonts, {
      size: opts.size || A4,
      margins: opts.margins,
      onPage: (page, no, fl) => {
        if (!pn || no < (pn.fromPage || 2)) return;
        const size = pn.size || 13;
        const t = String(no);
        const w = fonts.width(fonts.get(), size, t);
        page.drawText(t, {
          x: fl.m.l + fl.width / 2 - w / 2, y: fl.ph - fl.m.t / 2 - size / 3,
          size, font: fonts.get(), color: black(),
        });
      },
    });
    for (const b of blocks) flow.add(b);
    if (!flow.page) flow.newPage();
    pdf.setTitle(opts.title || "", { showInWindowTitleBar: false });
    pdf.setCreator("PDF Công Vụ");
    pdf.setProducer("PDF Công Vụ");
    pdf.setAuthor("");
    const bytes = await pdf.save();
    return { bytes, pages: pdf.getPageCount() };
  }

  CV.engine = { MM, CM, A4, SINGLE, NBSP, nfc, para, render, embedFonts, measure, breakLines, Fonts };
})(typeof globalThis !== "undefined" ? globalThis : window);
