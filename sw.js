/* Sinh tự động bởi tools/build.js - đừng sửa tay. */
const VERSION = "pdfcv-faa4c54017ee";
const ASSETS = [
 "./",
 "css/app.css",
 "fonts/OFL.txt",
 "fonts/Tinos-Bold.ttf",
 "fonts/Tinos-BoldItalic.ttf",
 "fonts/Tinos-Italic.ttf",
 "fonts/Tinos-Regular.ttf",
 "icons/apple-touch-icon.png",
 "icons/icon-192.png",
 "icons/icon-512.png",
 "icons/maskable-512.png",
 "index.html",
 "js/app.js",
 "js/docx.js",
 "js/engine.js",
 "js/images.js",
 "js/nd30.js",
 "manifest.webmanifest",
 "vendor/fontkit.umd.min.js",
 "vendor/jszip.min.js",
 "vendor/pdf-lib.min.js",
 "vendor/pdf.min.js",
 "vendor/pdf.worker.min.js"
];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.open(VERSION).then((c) => c.match(e.request, { ignoreSearch: true })
    .then((hit) => hit || fetch(e.request))));
});
