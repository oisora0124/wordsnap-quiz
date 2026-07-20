// WordBank — Service Worker
// オフラインでもアプリを起動できるようにするキャッシュ層。
// 方針:
//   - HTML（ナビゲーション）: network-first。最新を取りに行き、オフライン時だけキャッシュを返す
//   - 静的アセット（アイコン等）: cache-first
//   - /api/（同期サーバー）とクロスオリジン（辞書API等）は絶対にキャッシュせず素通しする。
//     オフライン中に解いた進捗はlocalStorageに溜まり、オンライン復帰時にアプリ側が同期する前提。
// キャッシュ名はバージョン付き。更新時は番号を上げると activate で古いキャッシュが消える。
// v5: 個人キー付きURLをキャッシュせず、v4に残ったキー付きキャッシュもactivateで削除する。
// v6: 新しいアプリ本体の事前取得に成功した場合だけactivateへ進み、更新失敗時は旧キャッシュを残す。
const CACHE_NAME = "wordsnap-v6";

// 最初に確保しておくファイル（アプリ本体は必須、アイコン等は1つ失敗しても他を続ける）
// かつて wordsnap-quiz.html も入れていたが、このファイルは存在せず、配信側の
// フォールバックで index.html が返るため、アプリ本体（約550KB）を誤ったURLで
// もう一部キャッシュしていた。端末の空き容量を無駄に使うので "./" だけにする。
const CORE_PRECACHE_URL = "./";
const OPTIONAL_PRECACHE_URLS = [
  "./wordsnap.webmanifest",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // アプリ本体が取れない状態でskipWaitingすると、activate時に動作中の旧キャッシュまで
      // 削除してオフライン起動を壊す。必須HTMLだけは失敗をinstall失敗として扱う。
      .then((cache) =>
        cache
          .add(CORE_PRECACHE_URL)
          .then(() => Promise.allSettled(OPTIONAL_PRECACHE_URLS.map((url) => cache.add(url)))),
      )
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
          if (!response.ok) return response;
          const copy = response.clone();
          // ?w= の個人キーをCache Storageへ残さず、キー切替ごとの重複も作らない。
          const navigationCacheUrl = new URL("./", self.registration.scope).href;
          return caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(navigationCacheUrl, copy))
            .catch(() => {})
            .then(() => response);
        })
        .catch(() =>
          caches
            .match(request, { ignoreSearch: true })
            .then((cached) => cached || caches.match("./")),
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
          return caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, copy))
            .catch(() => {})
            .then(() => response);
        }
        return response;
      });
    }),
  );
});
