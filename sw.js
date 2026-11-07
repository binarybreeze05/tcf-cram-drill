// Minimal service worker: installable PWA + offline app-shell.
// Network-first for shell/data (stays fresh), cache fallback (offline). MP3s skip
// the SW so the browser keeps native range-request streaming/seeking.
const CACHE = 'tcf-cram-drill-v3';
const SHELL = ['./', './cram.html', './drill.html',
               './style.css?v=1', './cram.js?v=2', './drill.js?v=2', './data.js?v=3',
               './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('.mp3')) return;            // let the browser stream audio natively
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req))
  );
});
