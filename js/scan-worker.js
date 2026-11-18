/* Dò mép tờ giấy trên khung hình camera - chạy ngoài luồng giao diện cho khung hình khỏi giật. */
importScripts("crop.js");
self.onmessage = (e) => {
  const { id, w, h, buf } = e.data;
  let det = null;
  try { det = self.CV.crop.detect(new Uint8ClampedArray(buf), w, h); } catch (err) { det = null; }
  self.postMessage({ id, det });
};
