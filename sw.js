// RelaPDF の Service Worker
//
// アプリのファイルを最初にすべてキャッシュし、オフラインでも動くようにする。
// キャッシュするファイルの一覧とバージョンは precache-manifest.js（scripts/precache.js が作る）にある。
// 同じドメインに別のアプリを置いても壊さないよう、キャッシュ名には必ず "relapdf-" を付ける。

importScripts('./precache-manifest.js');

const { version, files } = self.RELAPDF_PRECACHE;
const CACHE_PREFIX = 'relapdf-';
const CACHE_NAME = `${CACHE_PREFIX}${version}`;
const SCOPE = new URL('./', self.location).href;
// 文字認識（OCR）の部品は、初めて使ったときにこのキャッシュに入れる（大きいので、アプリの更新では取り直さない）。
// 部品を入れ替えたら、名前の数字を上げる
const OCR_CACHE = `${CACHE_PREFIX}ocr-1`;
const OCR_PATH = new URL('./vendor/tesseract/', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // 古いキャッシュが混ざらないよう、ブラウザのキャッシュを使わずに取り直す
      await cache.addAll(files.map((path) => new Request(new URL(path, SCOPE), { cache: 'reload' })));
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME && name !== OCR_CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  // 画面側から「新しいバージョンに切り替えて」と言われたときに使う
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE)) return;

  if (url.href.startsWith(OCR_PATH)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(OCR_CACHE);
        const cached = await cache.match(url.href, { ignoreSearch: true });
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) await cache.put(url.href, response.clone());
        return response;
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // ページを開くときは、いつも index.html を返す
      const key = request.mode === 'navigate' ? new URL('./index.html', SCOPE).href : url.href.split('#')[0];
      const cached = await cache.match(key, { ignoreSearch: true });
      if (cached) return cached;
      return fetch(request);
    })(),
  );
});
