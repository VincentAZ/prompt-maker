// Keeps a copy of the app's page, so it still opens when Prompt Maker's server is off. The page then shows
// "Prompt Maker's server isn't running" with a Start button, and reconnects once the server is back.
// Network first: while the server is up, every load is fresh (and refreshes the copy).
const CACHE = 'prompt-maker-shell-v1';
const SHELL = ['/', '/app.js', '/app.css', '/icon.svg', '/fonts/bricolage.woff2', '/fonts/jetbrains-mono.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const page = e.request.mode === 'navigate';
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || (!page && !SHELL.includes(url.pathname))) return;
  const key = page ? '/' : url.pathname;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then(c => c.put(key, copy)));
        }
        return res;
      })
      .catch(() => caches.match(key).then(hit => hit || Response.error())),
  );
});
