// Inkwell service worker: offline app shell. Bump VERSION when deploying changes.
const VERSION = 'inkwell-1.5.0';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/store.js', 'js/sync.js', 'js/github.js', 'js/ink.js', 'js/ui.js', 'js/icons.js', 'js/sanitize.js', 'js/pdf.js', 'js/glass.js', 'vendor/html2canvas.min.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache (GitHub Pages keeps files 10 min): otherwise a new
  // index.html could be cached next to an old app.js right after a deploy, and the modules would not match.
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('inkwell-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.includes('/api/')) return; // sync traffic: network only

  if (req.mode === 'navigate') {
    // App shell first so the app opens instantly offline; refresh the cached copy in the background.
    e.respondWith(
      caches.open(VERSION).then(async (c) => {
        const cached = await c.match('index.html');
        const fresh = fetch(req.url, { cache: 'no-cache' }).then((res) => { if (res.ok) c.put('index.html', res.clone()); return res; }).catch(() => null);
        return cached || (await fresh) || new Response('Offline', { status: 503 });
      }),
    );
    return;
  }

  e.respondWith(
    caches.open(VERSION).then(async (c) => {
      const cached = await c.match(req, { ignoreSearch: true });
      // revalidate (cheap 304) instead of trusting the HTTP cache, for the same reason as above
      const fresh = fetch(req, { cache: 'no-cache' }).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
      return cached || (await fresh) || new Response('', { status: 504 });
    }),
  );
});
