// service-worker.js
// Caching app-shell sederhana supaya dashboard bisa di-install sebagai PWA
// dan loading lebih cepat di kunjungan berikutnya.
// CATATAN: Ini TIDAK membuat dashboard bisa kerja penuh offline — data order
// dan sync tetap butuh koneksi internet (Firestore). Ini cuma mem-percepat
// loading file HTML/CSS/JS statisnya sendiri.

const CACHE_NAME = "mmh-dashboard-shell-v2";
const APP_SHELL = [
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Hanya cache request GET ke file di app-shell sendiri (origin sama).
  // Request ke Firestore/CDN tetap langsung ke jaringan seperti biasa.
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // NETWORK-FIRST: selalu coba ambil versi terbaru dari internet dulu.
  // Cache cuma dipakai sebagai fallback kalau internet mati (offline).
  // Ini penting supaya update file (index.html dll) selalu langsung
  // kepakai begitu di-deploy, tidak nyangkut di versi lama.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
