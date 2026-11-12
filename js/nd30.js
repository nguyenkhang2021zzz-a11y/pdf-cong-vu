/* Văn bản -> PDF theo thể thức Nghị định 30/2020/NĐ-CP (Phụ lục I).
 * Port 1-1 từ bản máy tính (pdfcongvu/textdoc.py) - cùng số đo, cùng bố cục. */
(function (G) {
  "use strict";
  const CV = (G.CV = G.CV || {});
  const E = CV.engine;
  const { MM, CM, NBSP, nfc, para } = E;

  const QUOC_HIEU = "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM";
  const TIEU_NGU = "Độc lập - Tự do - Hạnh phúc";
  const TEN_LOAI = ["", "BÁO CÁO", "KẾ HOẠCH", "TỜ TRÌNH", "THÔNG BÁO", "QUYẾT ĐỊNH", "BIÊN BẢN",
    "GIẤY MỜI", "GIẤY GIỚI THIỆU", "CHƯƠNG TRÌNH", "PHƯƠNG ÁN", "ĐỀ ÁN", "HƯỚNG DẪN",
    "CÔNG ĐIỆN", "GIẤY XÁC NHẬN", "PHIẾU CHUYỂN", "THÔNG BÁO KẾT LUẬN"];

  const DEFAULTS = {
    font_size: 14, line_spacing: 1.0, first_indent_cm: 1.0, para_space_pt: 6,
    margin_top_mm: 20, margin_bottom_mm: 20, margin_left_mm: 30, margin_right_mm: 15,
    page_numbers: true,
    use_header: false, co_quan_chu_quan: "", co_quan_ban_hanh: "", so_ky_hieu: "",
    dia_danh: "", ghi_ngay: true, ngay: "", ten_loai: "", trich_yeu: "",
    use_footer: false, noi_nhan: "", tham_quyen: "", chuc_vu: "", nguoi_ky: "",
  };

  const lines = (s) => nfc(s).split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  const upper = (s) => s.toLocaleUpperCase("vi");

  function formatNgay(diaDanh, ngay, ghiNgay, today) {
    today = today || new Date();
    let s;
    if (ghiNgay !== false) {
      let d = today.getDate(), m = today.getMonth() + 1, y = today.getFullYear();
      const v = (ngay || "").trim();
      if (v) {
        const mt = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
        const dt = mt && new Date(+mt[3], +mt[2] - 1, +mt[1]);
        if (!mt || dt.getDate() !== +mt[1] || dt.getMonth() !== +mt[2] - 1) {
          throw new Error(`Ngày "${v}" không đúng dạng dd/mm/yyyy (VD: 05/02/2026).`);
        }
        d = +mt[1]; m = +mt[2]; y = +mt[3];
      }
      // ngày < 10 và tháng 1, 2 phải thêm số 0 phía trước
      const dd = d < 10 ? "0" + d : String(d);
      const mm = m < 3 ? "0" + m : String(m);
      s = `ngày ${dd} tháng ${mm} năm ${y}`;
    } else {
      const gap = NBSP.repeat(7);
      s = `ngày${gap}tháng${gap}năm ${today.getFullYear()}`;
    }
    diaDanh = nfc(diaDanh).trim();
    return diaDanh ? `${diaDanh}, ${s}` : s[0].toUpperCase() + s.slice(1);
  }

  /* **chữ đậm**, *chữ nghiêng* -> runs. Không dùng lookbehind (iPhone cũ không hỗ trợ). */
  const isWord = (ch) => !!ch && /[\p{L}\p{N}_]/u.test(ch);
  const isSpace = (ch) => !!ch && /\s/.test(ch);

  function splitItalic(text, b) {
    const out = [];
    let buf = "", i = 0;
    while (i < text.length) {
      const prev = text[i - 1], next = text[i + 1];
      if (text[i] === "*" && prev !== "*" && !isWord(prev) && next && !isSpace(next) && next !== "*") {
        let j = -1;
        for (let k = i + 2; k < text.length; k++) {
          if (text[k] === "*" && !isSpace(text[k - 1]) && text[k - 1] !== "*" &&
              text[k + 1] !== "*" && !isWord(text[k + 1])) { j = k; break; }
        }
        if (j > 0) {
          if (buf) out.push({ t: buf, b });
          out.push({ t: text.slice(i + 1, j), b, i: true });
          buf = ""; i = j + 1;
          continue;
        }
      }
      buf += text[i++];
    }
    if (buf) out.push({ t: buf, b });
    return out;
  }

  function parseInline(text) {
    text = nfc(text);
    const segs = [];
    let buf = "", i = 0;
    while (i < text.length) {
      if (text.startsWith("**", i) && text[i + 2] && !isSpace(text[i + 2])) {
        let j = -1;
        for (let k = i + 3; k < text.length - 1; k++) {
          if (text.startsWith("**", k) && !isSpace(text[k - 1])) { j = k; break; }
        }
        if (j > 0) {
          if (buf) segs.push([buf, false]);
          segs.push([text.slice(i + 2, j), true]);
          buf = ""; i = j + 2;
          continue;
        }
      }
      buf += text[i++];
    }
    if (buf) segs.push([buf, false]);
    return segs.flatMap(([t, b]) => splitItalic(t, b));
  }

  function hr(w, sb) { return { k: "hr", w, th: 0.6, sb: sb || 0, sa: 0 }; }
  function center(t, size, o) {
    o = o || {};
    return para([{ t, b: o.b, i: o.i }], { size, leading: o.leading || size * 1.2, align: o.align || "center" });
  }

  function header(o, width, W) {
    const fs = o.font_size, lw = width * 0.42, rw = width - lw, hs = 13;
    const left = [];
    const chuQuan = lines(o.co_quan_chu_quan).map(upper);
    const banHanh = lines(o.co_quan_ban_hanh).map(upper);
    chuQuan.forEach((l) => left.push(center(l, hs)));
    banHanh.forEach((l) => left.push(center(l, hs, { b: true })));
    if (banHanh.length || chuQuan.length) {
      const widest = banHanh.length ? Math.max(...banHanh.map((l) => W(l, true, hs)))
        : Math.max(...chuQuan.map((l) => W(l, false, hs)));
      left.push(hr(Math.min(widest, lw) * 0.4, 4));
    }
    // Quốc hiệu cỡ 12-13, tiêu ngữ cỡ 13-14: chọn cỡ lớn nhất vừa cột
    const qh = W(QUOC_HIEU, true, 13) <= rw - 4 ? 13 : 12;
    const tn = qh + 1;
    const right = [center(QUOC_HIEU, qh, { b: true }), center(TIEU_NGU, tn, { b: true }),
      hr(W(TIEU_NGU, true, tn), 4)];

    const left2 = [{ k: "space", h: 6 }];
    if (o.so_ky_hieu.trim() || o.co_quan_ban_hanh.trim()) {
      // giữ khoảng trắng để ghi số bằng tay: "Số:        /BC-CAT"
      let so = nfc(o.so_ky_hieu).replace(/\s+$/, "").replace(/ {2,}/g, (m) => NBSP.repeat(m.length)).replace(/^ /, NBSP);
      left2.push(center("Số:" + (so.startsWith(NBSP) ? so : " " + so), hs));
    }
    const congVan = !o.ten_loai.trim() && o.trich_yeu.trim();
    if (congVan) {
      let ty = nfc(o.trich_yeu).trim();
      if (!/^v\/v/i.test(ty)) ty = "V/v " + ty;
      left2.push({ k: "space", h: 3 }, center(ty, 12, { leading: 14 }));
    }
    const right2 = [{ k: "space", h: 6 }, center(formatNgay(o.dia_danh, o.ngay, o.ghi_ngay), fs, { i: true })];

    const blocks = [{
      k: "table", widths: [lw, rw], grid: false, pad: { l: 0, r: 0, t: 0, b: 0 },
      rows: [[{ blocks: left }, { blocks: right }], [{ blocks: left2 }, { blocks: right2 }]],
    }];
    if (o.ten_loai.trim()) {
      blocks.push({ k: "space", h: 18 }, center(upper(nfc(o.ten_loai).trim()), fs, { b: true }));
      const ty = lines(o.trich_yeu);
      ty.forEach((l) => blocks.push(center(l, fs, { b: true })));
      if (ty.length) {
        const widest = Math.max(...ty.map((l) => W(l, true, fs)));
        blocks.push(hr(Math.min(widest, width) * 0.4, 5));
      }
      blocks.push({ k: "space", h: 12 });
    } else {
      blocks.push({ k: "space", h: 18 });
    }
    return blocks;
  }

  function body(text, o) {
    const fs = o.font_size;
    const lead = fs * E.SINGLE * Number(o.line_spacing);
    const out = [];
    let blank = false;
    for (const raw of nfc(text).replace(/\r\n?/g, "\n").split("\n")) {
      const line = raw.replace(/\t/g, " ").trim();
      if (!line) {
        if (out.length && !blank) out.push({ k: "space", h: lead * 0.5 });
        blank = true;
        continue;
      }
      blank = false;
      out.push(para(parseInline(line), {
        size: fs, leading: lead, align: "justify",
        fi: Number(o.first_indent_cm) * CM, sa: Number(o.para_space_pt),
      }));
    }
    return out;
  }

  function footer(o, width) {
    const fs = o.font_size, lw = width * 0.45, rw = width - lw;
    const left = [];
    const nn = lines(o.noi_nhan);
    if (nn.length) {
      left.push(center("Nơi nhận:", 12, { b: true, i: true, align: "left" }));
      nn.forEach((l, i) => {
        if (!/^[-+–]/.test(l)) l = "- " + l;
        if (!/[;.,:]$/.test(l)) l += i === nn.length - 1 ? "." : ";";
        left.push(center(l, 11, { align: "left", leading: 13 }));
      });
    }
    const right = [];
    lines(o.tham_quyen).concat(lines(o.chuc_vu)).forEach((l) => right.push(center(upper(l), fs, { b: true })));
    right.push({ k: "space", h: 30 * MM }); // chỗ ký, đóng dấu
    if (o.nguoi_ky.trim()) right.push(center(nfc(o.nguoi_ky).trim(), fs, { b: true }));
    return [{ k: "space", h: 6 }, {
      k: "keep", blocks: [{
        k: "table", widths: [lw, rw], grid: false, pad: { l: 0, r: 0, t: 0, b: 0 },
        rows: [[{ blocks: left }, { blocks: right }]],
      }],
    }];
  }

  function normalize(o) {
    o = Object.assign({}, DEFAULTS, o || {});
    for (const k of Object.keys(DEFAULTS)) {
      if (typeof DEFAULTS[k] === "number") o[k] = Number(String(o[k]).replace(",", "."));
      else if (typeof DEFAULTS[k] === "string") o[k] = o[k] == null ? "" : String(o[k]);
      else o[k] = !!o[k];
    }
    const checks = [["font_size", 8, 30, "Cỡ chữ"], ["margin_left_mm", 0, 80, "Lề trái"],
      ["margin_right_mm", 0, 80, "Lề phải"], ["margin_top_mm", 0, 80, "Lề trên"], ["margin_bottom_mm", 0, 80, "Lề dưới"]];
    for (const [k, lo, hi, name] of checks) {
      if (!(o[k] >= lo && o[k] <= hi)) throw new Error(`${name} = ${o[k]} không hợp lệ (cho phép ${lo}-${hi}).`);
    }
    return o;
  }

  /** Dựng PDF. Trả về {bytes, pages}. */
  async function build(text, opts, fontBytes) {
    const o = normalize(opts);
    const margins = { t: o.margin_top_mm * MM, b: o.margin_bottom_mm * MM, l: o.margin_left_mm * MM, r: o.margin_right_mm * MM };
    const width = E.A4[0] - margins.l - margins.r;

    // đo chữ trước khi có tài liệu: dùng một PDF nháp để lấy bộ font
    const scratch = await G.PDFLib.PDFDocument.create();
    const F = await E.embedFonts(scratch, fontBytes);
    const W = (t, b, size) => F.width(F.get(b, false), size, t);

    let blocks = [];
    if (o.use_header) blocks = blocks.concat(header(o, width, W));
    blocks = blocks.concat(body(text, o));
    if (o.use_footer) blocks = blocks.concat(footer(o, width));
    if (!blocks.length) throw new Error("Văn bản đang trống - hãy nhập hoặc dán nội dung.");

    let title = o.use_header ? nfc([o.ten_loai.trim(), o.trich_yeu.trim()].filter(Boolean).join(" ")) : "";
    if (!title) title = (lines(text)[0] || "").slice(0, 80);
    return E.render(blocks, {
      fontBytes, size: E.A4, margins, title,
      pageNumbers: o.page_numbers ? { fromPage: 2, size: Math.min(Math.max(o.font_size, 13), 14) } : null,
    });
  }

  CV.nd30 = { DEFAULTS, TEN_LOAI, QUOC_HIEU, TIEU_NGU, formatNgay, parseInline, normalize, build };
})(typeof globalThis !== "undefined" ? globalThis : window);
