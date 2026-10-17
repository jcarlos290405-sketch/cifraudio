// Service worker: guarda SOLO los archivos de la aplicacion para que abra sin
// conexion. No guarda mensajes, contrasenas ni archivos del usuario.
const CACHE = 'cifraudio-v1';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'crypto.js', 'relay.js',
  'kdf-worker.js', 'argon2-bundled.min.js', 'manifest.json',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'chat_bg.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
