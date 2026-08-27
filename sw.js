// 도서모음 — 앱 셸 오프라인 캐시. CACHE 이름 바꾸면 옛 캐시 자동 폐기.
const CACHE = 'book-collection-v9';
const ASSETS = ['./', './index.html', './assets/app.css?v=9', './assets/app.js?v=9', './manifest.webmanifest', './assets/icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); return res; })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
