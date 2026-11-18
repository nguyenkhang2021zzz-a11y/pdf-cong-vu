/* Máy quét giấy tờ trong app, kiểu máy quét tài liệu của iPhone:
 * camera sống, lớp phủ xanh bám theo tờ giấy, Tự động (giữ yên là tự chụp) / Thủ công (chụp xong chỉnh góc ngay),
 * ảnh nhỏ trang vừa chụp ở góc dưới (chạm để chỉnh), chụp liền nhiều trang.
 * Dò mép bằng đúng thuật toán của crop.js (chạy trong Web Worker cho khung hình khỏi giật).
 * Không mở được camera (chưa cho quyền, trình duyệt cũ, không phải https) -> nút dùng camera của máy. */
(function (G) {
  "use strict";
  const CV = (G.CV = G.CV || {});
  const STEP_MS = 120;     // nhịp dò mép
  const STABLE_MS = 900;   // giữ yên ngần này thì tự chụp
  const MOVE_TOL = 0.015;  // góc xê dịch dưới 1,5% khung = coi như đứng yên
  const REARM = 0.06;      // sau khi chụp: tờ giấy phải đổi chỗ > 6% (hoặc ra khỏi khung) mới tự chụp tiếp

  const supported = () => !!(G.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const delta = (a, b) => {
    let m = 0;
    for (let i = 0; i < 4; i++) for (let k = 0; k < 2; k++) m = Math.max(m, Math.abs(a[i][k] - b[i][k]));
    return m;
  };
  const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("quá lâu")), ms))]);
  let pageNo = 0; // đánh số trang chụp trong phiên: Trang_01.jpg, Trang_02.jpg...

  /** opts: onCapture(file, det) -> item; onReview(item) -> Promise; onManual(item) -> Promise<"keep"|"retake">;
   *  auto (bool), onMode(auto), toast(msg) */
  function create(el, opts) {
    const $ = (s) => el.querySelector(s);
    const video = $("#scan-video"), overlay = $("#scan-overlay"), hint = $("#scan-hint");
    const thumbBtn = $("#scan-thumb"), modeBtn = $("#scan-mode");
    const small = document.createElement("canvas");
    let stream = null, track = null, imageCapture = null, worker = null, running = false, timer = 0;
    let det = null, last = null, stableSince = 0, armed = true, shotQuad = null, lost = 0, busy = false, count = 0;
    let torchOn = false, paused = false, capturing = false, auto = opts.auto !== false;
    let pages = []; // [{item, thumb (dataURL)}] trang chụp trong phiên này

    const say = (t) => { if (hint.textContent !== t) hint.textContent = t; };
    const setState = (s) => { el.dataset.state = s; };
    const fit = () => { // video hiển thị kiểu "contain": thấy trọn khung sẽ chụp
      const W = el.clientWidth, H = el.clientHeight, vw = video.videoWidth, vh = video.videoHeight;
      const s = Math.min(W / vw, H / vh);
      return { s, ox: (W - vw * s) / 2, oy: (H - vh * s) / 2, vw, vh };
    };

    function showMode() {
      modeBtn.dataset.auto = auto ? "1" : "0";
      modeBtn.textContent = auto ? "Tự động" : "Thủ công";
    }
    function showPages() {
      $("#scan-count").textContent = String(count);
      const p = pages[pages.length - 1];
      thumbBtn.classList.toggle("hidden", !p);
      if (p) { thumbBtn.querySelector("img").src = p.thumb; thumbBtn.querySelector(".badge").textContent = String(count); }
    }

    function draw() {
      const W = el.clientWidth, H = el.clientHeight, dpr = Math.min(2, G.devicePixelRatio || 1);
      if (overlay.width !== Math.round(W * dpr) || overlay.height !== Math.round(H * dpr)) {
        overlay.width = Math.round(W * dpr); overlay.height = Math.round(H * dpr);
      }
      const g = overlay.getContext("2d");
      g.clearRect(0, 0, overlay.width, overlay.height);
      if (!det || !video.videoWidth) return;
      const f = fit();
      const pts = det.quad.map(([x, y]) => [(x * f.vw * f.s + f.ox) * dpr, (y * f.vh * f.s + f.oy) * dpr]);
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.lineJoin = "round";
      g.lineWidth = 3 * dpr;
      if (armed || !auto) { // lớp phủ xanh trong suốt như iPhone
        g.fillStyle = "rgba(10, 132, 255, 0.32)";
        g.fill();
        g.strokeStyle = "rgb(10, 132, 255)";
        g.setLineDash([]);
      } else { // trang này chụp rồi
        g.strokeStyle = "rgba(255, 255, 255, 0.9)";
        g.setLineDash([10 * dpr, 8 * dpr]);
      }
      g.stroke();
    }

    function onDet(d) {
      busy = false;
      if (!running) return;
      if (!paused) {
        det = d;
        const now = performance.now();
        if (!d) {
          last = null; stableSince = 0;
          if (++lost >= 2) armed = true; // tờ cũ đã ra khỏi khung -> sẵn sàng trang mới
          setState("searching");
          say(count ? "Đưa trang tiếp theo vào khung hình" : "Đưa cả tờ giấy vào khung hình");
        } else {
          lost = 0;
          if (!armed && shotQuad && delta(d.quad, shotQuad) > REARM) armed = true;
          if (!last || delta(d.quad, last) >= MOVE_TOL) stableSince = now;
          last = d.quad;
          setState("found");
          if (!auto) say("Thấy tờ giấy - bấm nút chụp");
          else if (!armed) say("Đã chụp - lật sang trang tiếp theo");
          else if (now - stableSince >= STABLE_MS) capture();
          else say("Giữ yên máy…");
        }
        draw();
      }
      timer = setTimeout(tick, STEP_MS);
    }

    function frame() { // khung hình hiện tại thu nhỏ để dò mép
      const vw = video.videoWidth, vh = video.videoHeight;
      const s = Math.min(1, CV.crop.DET / Math.max(vw, vh));
      const sw = Math.max(1, Math.round(vw * s)), sh = Math.max(1, Math.round(vh * s));
      if (small.width !== sw || small.height !== sh) { small.width = sw; small.height = sh; }
      const x = small.getContext("2d", { willReadFrequently: true });
      x.drawImage(video, 0, 0, sw, sh);
      return x.getImageData(0, 0, sw, sh);
    }

    function tick() {
      if (!running) return;
      if (busy || paused || video.readyState < 2 || !video.videoWidth) { timer = setTimeout(tick, STEP_MS); return; }
      const im = frame();
      busy = true;
      if (worker) worker.postMessage({ id: 0, w: im.width, h: im.height, buf: im.data.buffer }, [im.data.buffer]);
      else onDet(CV.crop.detect(im.data, im.width, im.height));
    }

    async function grab() {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (imageCapture) { // Android: ảnh gốc đủ độ phân giải của cảm biến
        try {
          const blob = await timeout(imageCapture.takePhoto(), 4000);
          const bmp = await createImageBitmap(blob);
          const ok = (bmp.width > bmp.height) === (vw > vh) && bmp.width * bmp.height > vw * vh;
          if (bmp.close) bmp.close();
          if (ok) return blob; // ảnh lệch chiều so với khung hình (máy lạ) -> lấy khung hình cho chắc
        } catch (e) { /* lấy khung hình video */ }
      }
      const c = document.createElement("canvas");
      c.width = vw; c.height = vh;
      c.getContext("2d").drawImage(video, 0, 0, vw, vh);
      const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("hết bộ nhớ"))), "image/jpeg", 0.92));
      c.width = c.height = 0;
      return blob;
    }

    function thumbOf(im, d) { // ảnh nhỏ trang vừa chụp (đã nắn nếu thấy tờ giấy)
      const c = document.createElement("canvas");
      if (d) {
        const { q, size: [W, H] } = CV.crop.plan(d, im.width, im.height);
        const t = Math.min(1, 160 / Math.max(W, H));
        c.width = Math.max(1, Math.round(W * t)); c.height = Math.max(1, Math.round(H * t));
        const x = c.getContext("2d"), out = x.createImageData(c.width, c.height);
        CV.crop.warp(im.data, im.width, im.height, q, out.data, c.width, c.height);
        x.putImageData(out, 0, 0);
      } else {
        const t = Math.min(1, 160 / Math.max(im.width, im.height));
        c.width = Math.round(im.width * t); c.height = Math.round(im.height * t);
        const s = document.createElement("canvas");
        s.width = im.width; s.height = im.height;
        s.getContext("2d").putImageData(im, 0, 0);
        c.getContext("2d").drawImage(s, 0, 0, c.width, c.height);
      }
      return c.toDataURL("image/jpeg", 0.8);
    }

    function fly(src, d) { // trang vừa chụp thu nhỏ bay vào ô ảnh góc dưới
      if (!d || !el.animate) return;
      const f = fit();
      const xs = d.quad.map((p) => f.ox + p[0] * f.vw * f.s), ys = d.quad.map((p) => f.oy + p[1] * f.vh * f.s);
      const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0, h = Math.max(...ys) - y0;
      const im = new Image();
      im.src = src;
      im.className = "scan-fly";
      Object.assign(im.style, { left: x0 + "px", top: y0 + "px", width: w + "px", height: h + "px" });
      el.appendChild(im);
      const t = thumbBtn.getBoundingClientRect(), r = el.getBoundingClientRect();
      const dx = t.left - r.left + t.width / 2 - (x0 + w / 2), dy = t.top - r.top + t.height / 2 - (y0 + h / 2);
      const a = im.animate([{ transform: "none", opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(${t.width / w})`, opacity: 0.7 }],
        { duration: 420, easing: "cubic-bezier(.4,0,.6,1)" });
      a.onfinish = () => im.remove();
    }

    async function capture() {
      if (capturing || !running || !video.videoWidth) return;
      capturing = true;
      armed = false;
      const d = det;
      shotQuad = d ? d.quad : null;
      const fl = $(".scan-flash");
      fl.classList.add("on");
      setTimeout(() => fl.classList.remove("on"), 120);
      try {
        const im = frame();
        const blob = await grab();
        const name = `Trang_${String(++pageNo).padStart(2, "0")}.jpg`;
        const item = opts.onCapture(new File([blob], name, { type: "image/jpeg", lastModified: Date.now() }), d);
        const page = { item, thumb: thumbOf(im, d) };
        pages.push(page);
        count++;
        showPages();
        fly(page.thumb, d);
        say(`Đã chụp trang ${count}`);
        if (!auto) { // Thủ công: chỉnh góc ngay, Chụp lại / Giữ bản quét
          paused = true;
          const r = await opts.onManual(item);
          paused = false;
          if (r === "retake") {
            pages.pop();
            count--;
            showPages();
            say("Chụp lại trang này");
          }
        }
      } catch (e) {
        armed = true;
        opts.toast("Không chụp được: " + e.message);
      } finally {
        capturing = false;
      }
    }

    function fail(e) {
      setState("error");
      say(e && e.name === "NotAllowedError"
        ? "Chưa cho phép dùng camera. Bấm nút dưới để dùng camera của máy."
        : "Không mở được camera trong app. Bấm nút dưới để dùng camera của máy.");
    }

    async function start() {
      count = 0; pages = [];
      showPages(); showMode();
      det = last = shotQuad = null; armed = true; lost = 0; stableSince = 0; busy = false; torchOn = false; paused = false;
      $("#scan-torch").classList.add("hidden");
      setState("starting");
      say("Đang mở camera…");
      draw();
      running = true;
      const slow = setTimeout(() => { // hộp xin quyền bị che / camera kẹt: cho lối ra, camera lên thì tự ẩn
        if (running && el.dataset.state === "starting") { setState("slow"); say("Camera chưa mở được?"); }
      }, 5000);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 4096 }, height: { ideal: 3072 } },
        });
      } catch (e) {
        clearTimeout(slow);
        running = false;
        fail(e);
        return;
      }
      clearTimeout(slow);
      if (!running) { stop(); return; } // người dùng đã đóng trong lúc chờ quyền
      video.srcObject = stream;
      try { await video.play(); } catch (e) { /* muted + playsinline: tự chạy */ }
      track = stream.getVideoTracks()[0];
      try { imageCapture = G.ImageCapture ? new G.ImageCapture(track) : null; } catch (e) { imageCapture = null; }
      try {
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        if (caps.torch) $("#scan-torch").classList.remove("hidden");
      } catch (e) { /* không có đèn */ }
      try {
        worker = new Worker("js/scan-worker.js");
        worker.onmessage = (e) => onDet(e.data.det);
        worker.onerror = () => { // luồng phụ không chạy được -> dò ngay trên luồng chính
          worker = null; busy = false;
          clearTimeout(timer); timer = setTimeout(tick, STEP_MS);
        };
      } catch (e) { worker = null; }
      setState("searching");
      say("Đưa cả tờ giấy vào khung hình");
      tick();
    }

    function stop() {
      running = false;
      clearTimeout(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = track = imageCapture = null;
      if (worker) worker.terminate();
      worker = null;
      video.srcObject = null;
      det = null;
      draw();
    }

    $("#scan-shot").addEventListener("click", () => { if (running && !paused) capture(); });
    modeBtn.addEventListener("click", () => {
      auto = !auto;
      armed = true;
      showMode();
      if (opts.onMode) opts.onMode(auto);
      draw();
    });
    thumbBtn.addEventListener("click", async () => {
      const p = pages[pages.length - 1];
      if (!p || paused || capturing) return;
      paused = true;
      await opts.onReview(p.item);
      paused = false;
      if (p.item.thumb) { p.thumb = p.item.thumb; showPages(); }
    });
    $("#scan-torch").addEventListener("click", async () => {
      if (!track) return;
      try {
        torchOn = !torchOn;
        await track.applyConstraints({ advanced: [{ torch: torchOn }] });
        $("#scan-torch").classList.toggle("on", torchOn);
      } catch (e) { torchOn = false; }
    });
    G.addEventListener("resize", draw);
    showMode();
    return { start, stop, get count() { return count; } };
  }

  CV.scanner = { supported, create };
})(typeof globalThis !== "undefined" ? globalThis : window);
