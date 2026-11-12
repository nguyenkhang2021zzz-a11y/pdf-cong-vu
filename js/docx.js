/* File .docx -> khối dàn trang (port từ pdfcongvu/docx_render.py).
 * Giữ: khổ giấy + lề, căn lề, thụt dòng, khoảng cách đoạn, giãn dòng, đậm/nghiêng/gạch chân/cỡ chữ,
 * chữ in hoa, ngắt trang, bảng (gộp ô, kẻ khung), ảnh PNG/JPG, danh sách đánh số tự động.
 * Không giữ: header/footer, textbox, font khác (mọi chữ dùng Tinos = Times New Roman). */
(function (G) {
  "use strict";
  const CV = (G.CV = G.CV || {});
  const E = CV.engine;
  const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const NBSP = " ";

  /* ---------------- tiện ích XML (chạy được cả DOMParser của trình duyệt lẫn xmldom) */
  function kids(el, name) {
    const out = [];
    if (!el) return out;
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1 && (!name || n.localName === name)) out.push(n);
    }
    return out;
  }
  const kid = (el, name) => kids(el, name)[0] || null;
  function path(el, ...names) {
    for (const n of names) { el = kid(el, n); if (!el) return null; }
    return el;
  }
  function desc(el, name, out) {
    out = out || [];
    for (const c of kids(el)) { if (c.localName === name) out.push(c); desc(c, name, out); }
    return out;
  }
  function attr(el, name) {
    if (!el) return null;
    const v = el.getAttributeNS(W_NS, name);
    return v === "" || v == null ? el.getAttribute("w:" + name) || null : v;
  }
  const num = (v, d) => (v == null || v === "" || isNaN(+v) ? d : +v);
  const tw = (v) => (v == null ? null : num(v, 0) / 20); // twips -> pt
  function toggle(el) { // <w:b/>, <w:b w:val="0"/>
    if (!el) return null;
    const v = attr(el, "val");
    return !(v === "0" || v === "false" || v === "off" || v === "none");
  }

  /* ---------------- thuộc tính đoạn / chữ */
  function readPPr(pPr) {
    const o = {};
    if (!pPr) return o;
    const jc = attr(kid(pPr, "jc"), "val");
    if (jc) o.align = { center: "center", right: "right", end: "right", both: "justify", distribute: "justify" }[jc] || "left";
    const ind = kid(pPr, "ind");
    if (ind) {
      const l = attr(ind, "left") || attr(ind, "start");
      const r = attr(ind, "right") || attr(ind, "end");
      if (l != null) o.li = tw(l);
      if (r != null) o.ri = tw(r);
      if (attr(ind, "firstLine") != null) o.fi = tw(attr(ind, "firstLine"));
      if (attr(ind, "hanging") != null) o.fi = -tw(attr(ind, "hanging"));
    }
    const sp = kid(pPr, "spacing");
    if (sp) {
      if (attr(sp, "before") != null) o.sb = tw(attr(sp, "before"));
      if (attr(sp, "after") != null) o.sa = tw(attr(sp, "after"));
      if (attr(sp, "line") != null) {
        const rule = attr(sp, "lineRule") || "auto";
        o.line = rule === "auto" ? { mult: num(attr(sp, "line"), 240) / 240 } : { pt: tw(attr(sp, "line")), rule };
      }
    }
    const numPr = kid(pPr, "numPr");
    if (numPr) o.numPr = { id: attr(kid(numPr, "numId"), "val"), lvl: num(attr(kid(numPr, "ilvl"), "val"), 0) };
    return o;
  }

  function readRPr(rPr) {
    const o = {};
    if (!rPr) return o;
    const b = toggle(kid(rPr, "b")); if (b != null) o.b = b;
    const i = toggle(kid(rPr, "i")); if (i != null) o.i = i;
    const u = kid(rPr, "u"); if (u) o.u = (attr(u, "val") || "single") !== "none";
    const caps = toggle(kid(rPr, "caps")); if (caps != null) o.caps = caps;
    const sz = attr(kid(rPr, "sz"), "val"); if (sz) o.size = num(sz, 24) / 2;
    return o;
  }

  class Styles {
    constructor(doc) {
      this.map = {};
      this.defP = null;
      this.defR = {};
      this.defPPr = {};
      if (!doc) return;
      const root = doc.documentElement;
      const dd = kid(root, "docDefaults");
      this.defR = readRPr(path(dd, "rPrDefault", "rPr"));
      this.defPPr = readPPr(path(dd, "pPrDefault", "pPr"));
      for (const s of kids(root, "style")) {
        const id = attr(s, "styleId");
        const st = {
          type: attr(s, "type"), basedOn: attr(kid(s, "basedOn"), "val"),
          p: readPPr(kid(s, "pPr")), r: readRPr(kid(s, "rPr")),
          borders: kids(path(s, "tblPr", "tblBorders")),
        };
        this.map[id] = st;
        if (st.type === "paragraph" && attr(s, "default") === "1") this.defP = id;
      }
    }
    chain(id) {
      const out = [];
      const seen = new Set();
      while (id && this.map[id] && !seen.has(id)) { seen.add(id); out.unshift(this.map[id]); id = this.map[id].basedOn; }
      return out; // gốc trước, con sau
    }
    para(id) {
      return Object.assign({}, this.defPPr, ...this.chain(id || this.defP).map((s) => s.p));
    }
    run(pStyle, rStyle) {
      return Object.assign({}, this.defR, ...this.chain(pStyle || this.defP).map((s) => s.r),
        ...this.chain(rStyle).map((s) => s.r));
    }
  }

  /* ---------------- đánh số tự động */
  function roman(n) {
    const v = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"],
      [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
    let s = "";
    for (const [a, r] of v) while (n >= a) { s += r; n -= a; }
    return s;
  }
  function letter(n) {
    let s = "";
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(97 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  class Numbering {
    constructor(doc) {
      this.nums = {}; this.abs = {}; this.counters = {};
      if (!doc) return;
      const root = doc.documentElement;
      for (const a of kids(root, "abstractNum")) {
        const lv = {};
        for (const l of kids(a, "lvl")) {
          lv[num(attr(l, "ilvl"), 0)] = {
            fmt: attr(kid(l, "numFmt"), "val") || "decimal",
            text: attr(kid(l, "lvlText"), "val") ?? "%1.",
            start: num(attr(kid(l, "start"), "val"), 1),
          };
        }
        this.abs[attr(a, "abstractNumId")] = lv;
      }
      for (const n of kids(root, "num")) this.nums[attr(n, "numId")] = attr(kid(n, "abstractNumId"), "val");
    }
    level(id, lvl) {
      const a = this.abs[this.nums[id]];
      return (a && a[lvl]) || { fmt: "bullet", text: "•", start: 1 };
    }
    label(numPr) {
      if (!numPr || !numPr.id || numPr.id === "0") return "";
      const id = numPr.id, lvl = numPr.lvl;
      const cnt = (this.counters[id] = this.counters[id] || new Array(9).fill(0));
      const L = this.level(id, lvl);
      cnt[lvl] = (cnt[lvl] || L.start - 1) + 1;
      for (let d = lvl + 1; d < 9; d++) cnt[d] = 0;
      if (L.fmt === "none") return "";
      if (L.fmt === "bullet") {
        const t = L.text || "";
        return !t || t.charCodeAt(0) > 0xf000 || t === "o" ? "• " : t + " ";
      }
      return L.text.replace(/%(\d)/g, (_, k) => {
        const lv = +k - 1;
        const n = cnt[lv] || this.level(id, lv).start;
        const f = this.level(id, lv).fmt;
        return { lowerLetter: letter(n), upperLetter: letter(n).toUpperCase(), lowerRoman: roman(n),
          upperRoman: roman(n).toUpperCase() }[f] || String(n);
      }) + " ";
    }
  }

  /* ---------------- chuyển đổi */
  class Converter {
    constructor(zip, xml) {
      this.zip = zip; this.xml = xml;
      this.styles = new Styles(xml.styles);
      this.numbering = new Numbering(xml.numbering);
      this.rels = {};
      if (xml.rels) {
        for (const r of kids(xml.rels.documentElement, "Relationship")) {
          this.rels[r.getAttribute("Id")] = r.getAttribute("Target");
        }
      }
      this.defSize = this.styles.defR.size || 12;
      this.images = []; // {block, target}
    }

    paragraph(p, width) {
      const pPr = kid(p, "pPr");
      const pStyle = attr(kid(pPr, "pStyle"), "val");
      const po = Object.assign(this.styles.para(pStyle), readPPr(pPr));
      const base = this.styles.run(pStyle, null).size || this.defSize;
      const runs = [], before = [], after = [];
      let maxSize = base;

      const runEls = [];
      const collect = (el) => {
        for (const c of kids(el)) {
          if (c.localName === "r") runEls.push(c);
          else if (["hyperlink", "ins", "smartTag", "fldSimple", "customXml"].includes(c.localName)) collect(c);
          else if (c.localName === "sdt") collect(kid(c, "sdtContent"));
        }
      };
      collect(p);

      for (const r of runEls) {
        const rPr = kid(r, "rPr");
        const ro = Object.assign(this.styles.run(pStyle, attr(kid(rPr, "rStyle"), "val")), readRPr(rPr));
        const size = ro.size || base;
        let text = "";
        for (const c of kids(r)) {
          switch (c.localName) {
            case "t": text += c.textContent; break;
            case "tab": text += NBSP.repeat(6); break;
            case "noBreakHyphen": text += "-"; break;
            case "cr": text += "\n"; break;
            case "br":
              if (attr(c, "type") === "page") (runs.length || text ? after : before).push({ k: "pagebreak" });
              else text += "\n";
              break;
            case "drawing": case "pict": after.push(...this.images_(c, width)); break;
          }
        }
        if (!text) continue;
        text = E.nfc(text);
        if (ro.caps) text = text.toLocaleUpperCase("vi");
        text = text.replace(/ {2,}/g, (m) => NBSP.repeat(m.length)); // giữ khoảng trắng căn chỉnh
        maxSize = Math.max(maxSize, size);
        runs.push({ t: text, b: !!ro.b, i: !!ro.i, u: !!ro.u, size });
      }
      const label = this.numbering.label(po.numPr);
      if (label && runs.length) runs.unshift({ t: label, size: base });

      let leading;
      if (po.line && po.line.mult) leading = maxSize * E.SINGLE * po.line.mult;
      else if (po.line && po.line.rule === "exact") leading = po.line.pt;
      else if (po.line) leading = Math.max(po.line.pt, maxSize * E.SINGLE);
      else leading = maxSize * E.SINGLE;
      const sa = po.sa || 0;

      if (!runs.length) {
        return before.concat(after.length ? after : [{ k: "space", h: leading + sa }]);
      }
      return before.concat([E.para(runs, {
        size: base, leading: leading * (base / maxSize), align: po.align || "left",
        fi: po.fi || 0, li: Math.max(0, po.li || 0), ri: Math.max(0, po.ri || 0), sb: po.sb || 0, sa,
      })], after);
    }

    images_(el, width) {
      const out = [];
      for (const blip of desc(el, "blip")) {
        const rid = blip.getAttributeNS(R_NS, "embed") || blip.getAttribute("r:embed");
        const target = rid && this.rels[rid];
        if (!target) continue;
        const ext = (target.split(".").pop() || "").toLowerCase();
        const type = ext === "png" ? "png" : ext === "jpg" || ext === "jpeg" ? "jpg" : null;
        if (!type) continue; // EMF/WMF/GIF... bỏ qua
        let w = 200, h = 150;
        const drawing = el;
        const extent = desc(drawing, "extent")[0];
        if (extent) { w = num(extent.getAttribute("cx"), 0) / 12700 || w; h = num(extent.getAttribute("cy"), 0) / 12700 || h; }
        if (w > width) { h = (h * width) / w; w = width; }
        const block = { k: "img", type, w, h };
        const file = target.startsWith("/") ? target.slice(1) : "word/" + target.replace(/^\.\//, "");
        this.images.push({ block, file });
        out.push(block);
      }
      return out;
    }

    hasBorders(tbl) {
      const tblPr = kid(tbl, "tblPr");
      let b = kids(kid(tblPr, "tblBorders"));
      if (!b.length) {
        const st = this.styles.chain(attr(kid(tblPr, "tblStyle"), "val"));
        for (const s of st) if (s.borders.length) b = s.borders;
      }
      return b.some((e) => !["nil", "none", null].includes(attr(e, "val")));
    }

    table(tbl, width) {
      let widths = kids(kid(tbl, "tblGrid"), "gridCol").map((g) => tw(attr(g, "w")) || 0);
      const trs = kids(tbl, "tr");
      // dựng lưới: gridSpan = gộp ngang, vMerge = gộp dọc
      const grid = [];
      let ncols = widths.length;
      trs.forEach((tr, r) => {
        grid[r] = [];
        let c = num(attr(path(tr, "trPr", "gridBefore"), "val"), 0);
        for (const tc of kids(tr, "tc")) {
          const tcPr = kid(tc, "tcPr");
          const cs = num(attr(kid(tcPr, "gridSpan"), "val"), 1);
          const vm = kid(tcPr, "vMerge");
          const cont = vm && (attr(vm, "val") || "continue") === "continue";
          if (cont && r > 0) {
            for (let rr = r - 1; rr >= 0; rr--) {
              const above = grid[rr][c];
              if (above && above.cell) { above.cell.rs = r - rr + 1; break; }
            }
            for (let k = 0; k < cs; k++) grid[r][c + k] = { covered: true };
          } else {
            const cell = { tc, rs: 1, cs };
            grid[r][c] = { cell };
            for (let k = 1; k < cs; k++) grid[r][c + k] = { covered: true };
          }
          c += cs;
        }
        ncols = Math.max(ncols, c);
      });
      if (widths.length !== ncols || widths.some((w) => !w)) widths = new Array(ncols).fill(width / ncols);
      const total = widths.reduce((s, v) => s + v, 0);
      if (total > width) widths = widths.map((w) => (w * width) / total);

      const pad = { l: 3, r: 3, t: 2, b: 2 };
      const rows = grid.map((row) => {
        const out = new Array(ncols).fill(null);
        row.forEach((g, c) => {
          if (!g || !g.cell) return;
          const cw = widths.slice(c, c + g.cell.cs).reduce((s, v) => s + v, 0) - pad.l - pad.r;
          out[c] = { blocks: this.blocks(g.cell.tc, cw), rs: g.cell.rs, cs: g.cell.cs };
        });
        return out;
      });
      return { k: "table", widths, rows, grid: this.hasBorders(tbl), pad };
    }

    blocks(container, width) {
      let out = [];
      for (const c of kids(container)) {
        if (c.localName === "p") out = out.concat(this.paragraph(c, width));
        else if (c.localName === "tbl") out.push(this.table(c, width));
        else if (c.localName === "sdt") out = out.concat(this.blocks(kid(c, "sdtContent"), width));
      }
      return out;
    }
  }

  async function readZipXml(zip, name, parse) {
    const f = zip.file(name);
    return f ? parse(await f.async("string")) : null;
  }

  function parser() {
    if (G.DOMParser) { const p = new G.DOMParser(); return (s) => p.parseFromString(s, "application/xml"); }
    throw new Error("Thiếu DOMParser");
  }

  /** Đọc .docx -> {blocks, size, margins, title} */
  async function parse(bytes) {
    let zip;
    try { zip = await G.JSZip.loadAsync(bytes); } catch (e) {
      throw new Error("Không đọc được file Word (file hỏng, có mật khẩu, hoặc là .doc đời cũ - hãy lưu lại dạng .docx).");
    }
    const P = parser();
    const xml = {
      doc: await readZipXml(zip, "word/document.xml", P),
      styles: await readZipXml(zip, "word/styles.xml", P),
      numbering: await readZipXml(zip, "word/numbering.xml", P),
      rels: await readZipXml(zip, "word/_rels/document.xml.rels", P),
    };
    if (!xml.doc) throw new Error("File không phải văn bản Word (.docx).");
    const body = kid(xml.doc.documentElement, "body");
    const sect = desc(body, "sectPr")[0] || kid(body, "sectPr");
    const pg = kid(sect, "pgSz"), mar = kid(sect, "pgMar");
    const size = pg && attr(pg, "w") ? [tw(attr(pg, "w")), tw(attr(pg, "h"))] : E.A4;
    const margins = {
      t: mar ? Math.abs(tw(attr(mar, "top")) ?? 56.7) : 56.7, b: mar ? Math.abs(tw(attr(mar, "bottom")) ?? 56.7) : 56.7,
      l: mar ? tw(attr(mar, "left") || attr(mar, "start")) ?? 85 : 85, r: mar ? tw(attr(mar, "right") || attr(mar, "end")) ?? 42.5 : 42.5,
    };
    const conv = new Converter(zip, xml);
    const blocks = conv.blocks(body, size[0] - margins.l - margins.r);
    for (const im of conv.images) {
      const f = zip.file(im.file);
      im.block.bytes = f ? await f.async("uint8array") : null;
      if (!im.block.bytes) im.block.k = "space", im.block.h = 0;
    }
    while (blocks.length && ["space", "pagebreak"].includes(blocks[blocks.length - 1].k)) blocks.pop();
    let title = "";
    const core = await readZipXml(zip, "docProps/core.xml", P);
    if (core) { const t = desc(core.documentElement, "title")[0]; title = t ? t.textContent : ""; }
    return { blocks, size, margins, title };
  }

  async function build(bytes, fontBytes, name) {
    const d = await parse(bytes);
    if (!d.blocks.length) d.blocks.push({ k: "space", h: 1 });
    return E.render(d.blocks, { fontBytes, size: d.size, margins: d.margins, title: d.title || name || "" });
  }

  /** Lấy nội dung chữ của .docx (để đưa vào ô soạn thảo). */
  async function readText(bytes) {
    const d = await parse(bytes);
    const textOf = (blocks) => {
      const out = [];
      for (const b of blocks) {
        if (b.k === "p") out.push(b.runs.map((r) => r.t).join("").replace(/ /g, " ").replace(/ {2,}/g, " ").trim());
        else if (b.k === "space") out.push("");
        else if (b.k === "table") {
          for (const row of b.rows) {
            out.push(row.filter(Boolean).map((c) => textOf(c.blocks).filter(Boolean).join(" ")).join(" | "));
          }
        }
      }
      return out;
    };
    return textOf(d.blocks).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  CV.docx = { parse, build, readText };
})(typeof globalThis !== "undefined" ? globalThis : window);
