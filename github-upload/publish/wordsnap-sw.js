// WordBank — Service Worker
// オフラインでもアプリを起動できるようにするキャッシュ層。
// 方針:
//   - HTML（ナビゲーション）: network-first。最新を取りに行き、オフライン時だけキャッシュを返す
//   - 静的アセット（アイコン等）: cache-first
//   - /api/（同期サーバー）とクロスオリジン（辞書API等）は絶対にキャッシュせず素通しする。
//     オフライン中に解いた進捗はlocalStorageに溜まり、オンライン復帰時にアプリ側が同期する前提。
// キャッシュ名はバージョン付き。更新時は番号を上げると activate で古いキャッシュが消える。
const CACHE_NAME = "wordsnap-v2";

// 最初に確保しておく最低限のファイル（1つ失敗しても他は続ける）
// 本番はindex.html（"./"）、ローカルサーバーではwordsnap-quiz.htmlなので両方入れておく
const PRECACHE_URLS = [
  "./",
  "./wordsnap-quiz.html",
  "./wordsnap.webmanifest",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // 同期のPUT等はそのままネットワークへ

  const url = new URL(request.url);
  // クロスオリジン（Datamuse等の辞書API）はキャッシュ対象外。素通しする
  if (url.origin !== self.location.origin) return;
  // /api/（同期サーバー）は絶対にキャッシュしない。素通しする
  if (url.pathname.startsWith("/api/")) return;

  // HTML（ページ本体）: network-first。?w=個人キー付きURLでも同じキャッシュを使えるよう ignoreSearch で探す
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches
            .match(request, { ignoreSearch: true })
            .then((cached) => cached || caches.match("./"))
            .then((cached) => cached || caches.match("./wordsnap-quiz.html")),
        ),
    );
    return;
  }

  // 静的アセット: cache-first（無ければ取得してキャッシュに足す）
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
