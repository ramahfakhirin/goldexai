// GOLDEX AI — Service Worker minimal
// Tujuan utama: memenuhi syarat "installable PWA" di Chrome/Android (butuh SW
// terdaftar dengan fetch handler). TIDAK melakukan caching agresif — dashboard
// selalu butuh data live (harga, sinyal), jadi network-first tanpa fallback
// offline adalah pilihan yang tepat di sini, bukan kekurangan.

const CACHE_NAME = "goldex-ai-shell-v1";
const SHELL_ASSETS = [
  "/static/manifest.json",
  "/static/favicon.svg",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first: selalu ambil data terbaru. Cache cuma dipakai sebagai
// fallback kalau benar-benar offline (bukan strategi utama).
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
