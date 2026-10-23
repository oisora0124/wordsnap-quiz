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
// v7: OCRの実行コードを自前配信へ移した際、一時的に版なしパス
// (assets/tesseract/*.js) をキャッシュした端末がいる。名前を上げると
// activate 時に旧キャッシュ全体が捨てられるので、その残骸も消える。
//
// 【重要】APP_REV はアプリの版と必ず同じ値にする（check-release.mjs が一致を強制）。
// ブラウザは「このファイルの中身が変わったとき」だけ Service Worker を入れ直す。
// 以前は名前が手動の固定値だったため、リリースしてもこのファイルが変わらず、
// 端末には古い本体がキャッシュされたまま残った。通信が一瞬でも失敗すると
// network-first のフォールバックでその古い本体が表示される（1.0.77 が出る事故）。
// 版を埋め込めばリリースのたびに中身が変わり、入れ直し→本体の取り直し→
// activate で旧キャッシュ削除、まで自動で起きる。
const APP_REV = "1.0.140";
const CACHE_NAME = `wordsnap-v7-${APP_REV}`;
// OCRの実行コード・言語データ（計十数MB）はアプリの版と別のキャッシュに置き、更新で消さない。
// 版ごとに消していた頃は、アプリ更新後にオフラインになると以前使えたOCRが起動できなかった。
// パスに版が入っているので、中身が古くなることはない（版が変われば別URLとして取り直す）。
// 名前を "wordsnap-" で始めないのは、ページ側の purgeStaleAppCaches() に消させないため。
// shortcut: Tesseract・言語データの版を上げると旧版のファイルがこのキャッシュに残る。版を上げるときは名前の v を上げる。
const OCR_CACHE_NAME = "wordbank-ocr-assets-v1";
// 版のディレクトリ付きだけ（v7以前の版なし assets/tesseract/*.js は対象外にして持ち越さない）
const isOcrAsset = (url) => /\/assets\/(?:tesseract|tessdata)\/[^/]+\//.test(url.pathname);

// 旧版のアプリキャッシュに入っているOCR資産を、消す前に専用キャッシュへ移す。
// 専用キャッシュを作る前の版でOCRを使った端末が、更新後オフラインでOCRを失わないように。
async function moveOcrAssets(fromNames) {
  try {
    const target = await caches.open(OCR_CACHE_NAME);
    for (const name of fromNames) {
      const source = await caches.open(name);
      for (const request of await source.keys()) {
        if (!isOcrAsset(new URL(request.url))) continue;
        const response = await source.match(request);
        if (response) await target.put(request, response);
      }
    }
  } catch {
    // 移せなくても次にOCRを使うとき取り直せる。旧キャッシュの削除は止めない
  }
}

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
      .then(async (keys) => {
        const stale = keys.filter((key) => key !== CACHE_NAME && key !== OCR_CACHE_NAME);
        await moveOcrAssets(stale);
        return Promise.all(stale.map((key) => caches.delete(key)));
      })
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
            .open(isOcrAsset(url) ? OCR_CACHE_NAME : CACHE_NAME)
            .then((cache) => cache.put(request, copy))
            .catch(() => {})
            .then(() => response);
        }
        return response;
      }).catch(
        // オフラインで未キャッシュの資産（OCR の実行コード・言語データ等）は、拒否のまま返さず
        // ネットワークエラー応答として返す（SW 側で未処理の拒否を残さない。挙動は同じ）
        () => Response.error(),
      );
    }),
  );
});
