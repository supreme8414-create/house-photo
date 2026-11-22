// 房屋修圖器 Service Worker
// 策略：有網路 → 一律拿最新版（並順便存一份）；沒網路 → 用存起來的舊版。
// 這樣每次修正上線後，手機重新打開 App 就會拿到新版，不會卡在舊程式。
// 不碰 Gemini API、CDN、以及 AI 模型（模型快取 'house-ai-models-v1' 由 engine/local.js 管理）。
const SHELL = 'house-shell-v2';
const KEEP = [SHELL, 'house-ai-models-v1'];
const FILES = [
  './', './index.html', './styles.css', './app.js',
  './engine/local.js', './engine/gemini.js',
  './lib/db.js', './lib/image.js', './lib/editor.js', './lib/engines.js',
  './lib/export.js', './lib/ui.js', './lib/settings.js',
  './lib/errors.js', './lib/tutorial.js',
  './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // 逐一快取，缺檔不影響安裝；cache:'reload' 繞過瀏覽器 HTTP 快取，確保存到最新版
    await Promise.all(FILES.map((f) => c.add(new Request(f, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
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
  if (url.origin !== location.origin) return;       // Gemini / CDN / HuggingFace 不攔截
  if (url.pathname.includes('/models/')) return;     // 模型交給 engine 自己快取

  e.respondWith((async () => {
    try {
      // 網路優先，且繞過 HTTP 快取（GitHub Pages 預設快取 10 分鐘）
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) {
        const c = await caches.open(SHELL);
        c.put(req.mode === 'navigate' ? './index.html' : req, res.clone()).catch(() => {});
      }
      return res;
    } catch (err) {
      // 離線：用存起來的版本
      const hit = req.mode === 'navigate'
        ? (await caches.match('./index.html')) || (await caches.match('./'))
        : await caches.match(req, { ignoreSearch: true });
      return hit || Response.error();
    }
  })());
});
