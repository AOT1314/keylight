/* KEYLIGHT service worker.
   Registered only on HTTPS; the local LAN version still installs to the iOS
   home screen, but iOS does not allow service workers over plain HTTP. */

const CACHE = "keylight-shell-v7";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./js/audio.js",
  "./js/jianpu-ocr.js",
  "./js/model.js",
  "./js/omr.js",
  "./js/piano-roll.js",
  "./js/playback.js",
  "./js/stage.js",
  "./js/util.js",
  "./assets/icon-180.png",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/favicon-32.png",
  "./assets/favicon-64.png",
];

// PDF.js is only needed after a PDF is chosen. Cache it separately so a
// missing/updated vendor file can never break installation of the app shell.
const PDF_SHELL = [
  "./js/vendor/pdf.min.js",
  "./js/vendor/pdf.worker.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL)
        .then(() => Promise.all(PDF_SHELL.map((url) => cache.add(url).catch(() => undefined)))))
      .then(() => self.skipWaiting())
      .catch(() => undefined)
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put("./index.html", copy)).catch(() => undefined);
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return response;
      });
    })
  );
});
