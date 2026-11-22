// 房屋修圖器 Service Worker：外殼快取優先；HTML 導覽網路優先；不碰 Gemini API 與模型快取
const SHELL = 'house-shell-v1';
const KEEP = [SHELL, 'house-ai-models-v1']; // 模型快取由 engine 管理，絕不刪除
const FILES = [
  './', './index.html', './styles.css', './app.js',
  './engine/local.js', './engine/gemini.js',
  './lib/db.js', './lib/image.js', './lib/editor.js', './lib/engines.js',
  './lib/export.js', './lib/ui.js', './lib/settings.js',
  './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(FILES.map((f) => c.add(f).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('house-shell-') && !KEEP.includes(k)) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'generativelanguage.googleapis.com') return; // 不攔截
  if (url.origin !== location.origin) return; // CDN / HuggingFace 交給瀏覽器與 engine
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const c = await caches.open(SHELL);
        c.put('./index.html', res.clone()).catch(() => {});
        return res;
      } catch (err) {
        return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && !url.pathname.includes('/models/')) {
        const c = await caches.open(SHELL);
        c.put(req, res.clone()).catch(() => {});
      }
      return res;
    } catch (err) {
      return Response.error();
    }
  })());
});
