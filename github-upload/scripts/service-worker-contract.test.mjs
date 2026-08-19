// Service Worker（publish/wordsnap-sw.js）の契約を、実コードを動かして固定する。
//
// 既存の検査との関係:
//   check-release.mjs も SW を見ているが、ほとんどが**ソースの文字列一致**で、
//   実際に動かしているのは install の2ケース（本体失敗／任意失敗）だけ。
//   文字列一致は、その並びを保ったまま流れを変える改修を素通しする。
//   ここでは **fetch ハンドラを実際に動かして**、check-release が見ていない
//   振る舞いを固定する。SW 自体は変更しない。
//
// このファイルは本番へ配信される実コードで、過去に少なくとも4種類の実害を踏んでいる:
//   v5: 個人キー付きURL（?w=...）を Cache Storage に保存していた（秘密の残留）
//   v6: 本体の事前取得に失敗しても activate へ進み、旧キャッシュを消して
//       オフライン起動を壊していた
//   v7: 版なしパスの残骸が端末に残っていた
//   precache に存在しない wordsnap-quiz.html を入れ、本体を二重に持っていた
//
// なかでも v5 は「秘密が端末のキャッシュに残る」経路で、いちばん重い。
// check-release はこれを `new URL("./", self.registration.scope).href` という
// 文字列があるかでしか見ていない。ここでは実際にキャッシュへ書かせて、
// 書かれたキーに個人キーが含まれないことを確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Script } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const SW_PATH = join(here, "..", "publish", "wordsnap-sw.js");
const source = readFileSync(SW_PATH, "utf8");

const ORIGIN = "https://wordbank.pages.dev";
const SCOPE = `${ORIGIN}/`;
// キャッシュ名は `wordsnap-v7-${APP_REV}` のテンプレートリテラル。実物と同じ値を
// 組み立てて使う（固定文字列で書くと、実物が変わってもテストだけ通り続ける）。
const APP_REV = source.match(/const APP_REV = "([^"]+)";/)[1];
const CACHE_NAME = source
  .match(/const CACHE_NAME = `([^`]+)`;/)[1]
  .replace("${APP_REV}", APP_REV);

// ---- 実物に形を寄せたスタブ ----
// スタブが実物と形が違うと「壊れているのに通るテスト」になる。
// ここでは SW が実際に触る性質（ok / clone / mode / method / ignoreSearch）だけを
// 忠実に再現し、それ以外は持たせない（持たせると使えてしまい、実物との差が隠れる）。

class FakeResponse {
  constructor({ ok = true, url = "", tag = "" } = {}) {
    this.ok = ok;
    this.url = url;
    this.tag = tag;
    // 実物の Response は body を一度しか読めない。Cache へ保存すると消費される。
    // これを再現しないと、.clone() を消す改悪を検出できない
    // （利用者には「真っ白な画面」として出る）。
    this.bodyUsed = false;
    this.cloneCount = 0;
  }
  clone() {
    this.cloneCount += 1;
    const copy = new FakeResponse({ ok: this.ok, url: this.url, tag: this.tag });
    copy.isClone = true;
    return copy;
  }
}

/** ブラウザへ返す応答として使えるか（body が残っているか）。 */
function assertUsableResponse(response, message) {
  assert.ok(response, `${message}: 応答がない`);
  assert.equal(
    response.bodyUsed,
    false,
    `${message}: キャッシュへ渡した本体をそのまま返している（clone 漏れ。画面が真っ白になる）`,
  );
}

class FakeRequest {
  constructor(url, { method = "GET", mode = "no-cors" } = {}) {
    this.url = url;
    this.method = method;
    this.mode = mode;
  }
}

/** URL からクエリを落とした形。ignoreSearch の判定に使う。 */
const withoutSearch = (href) => {
  const u = new URL(href);
  u.search = "";
  return u.href;
};

/** cache.put / cache.match のキー。Request でも文字列でも受ける。 */
const keyOf = (requestOrUrl) =>
  typeof requestOrUrl === "string"
    ? new URL(requestOrUrl, SCOPE).href
    : new URL(requestOrUrl.url, SCOPE).href;

class FakeCache {
  constructor(name, env) {
    this.name = name;
    this.env = env;
    this.entries = new Map();
    this.putKeys = []; // put されたキーの記録（順序込み）
    this.addKeys = [];
  }
  // 実物の Cache.add は fetch して 2xx でなければ reject する。
  async add(url) {
    this.addKeys.push(url);
    const response = await this.env.fetch(new FakeRequest(new URL(url, SCOPE).href));
    if (!response.ok) throw new TypeError(`Request failed: ${url}`);
    this.entries.set(keyOf(url), response);
    return undefined;
  }
  async put(requestOrUrl, response) {
    const key = keyOf(requestOrUrl);
    this.putKeys.push(key);
    // 実物は保存時に body を読み切る。渡した Response はもう返せない。
    response.bodyUsed = true;
    this.entries.set(key, response);
    return undefined;
  }
  async match(requestOrUrl, options = {}) {
    // 実物の match は毎回あたらしい Response を作って返す（body は未消費）。
    const fresh = (entry) => new FakeResponse({ ok: entry.ok, url: entry.url, tag: entry.tag });
    const key = keyOf(requestOrUrl);
    if (this.entries.has(key)) return fresh(this.entries.get(key));
    if (options.ignoreSearch) {
      const bare = withoutSearch(key);
      for (const [entryKey, value] of this.entries) {
        if (withoutSearch(entryKey) === bare) return fresh(value);
      }
    }
    return undefined;
  }
}

class FakeCacheStorage {
  constructor(env) {
    this.env = env;
    this.caches = new Map();
    this.deleted = [];
  }
  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache(name, this.env));
    return this.caches.get(name);
  }
  async keys() {
    return [...this.caches.keys()];
  }
  async delete(name) {
    this.deleted.push(name);
    return this.caches.delete(name);
  }
  async match(requestOrUrl, options = {}) {
    for (const cache of this.caches.values()) {
      const hit = await cache.match(requestOrUrl, options);
      if (hit) return hit;
    }
    return undefined;
  }
  /** 全キャッシュに書かれたキー。「最初の1つ」しか見ないと取りこぼす。 */
  allPutKeys() {
    return [...this.caches.values()].flatMap((cache) => cache.putKeys);
  }
}

/**
 * SW を node:vm で実行し、登録されたハンドラと周辺のスタブを返す。
 * テストごとに作り直すので、状態はテスト間で共有されない。
 */
function loadServiceWorker({ fetchImpl } = {}) {
  const listeners = new Map();
  const calls = { skipWaiting: 0, claim: 0, fetches: [] };

  const env = {};
  env.fetch = async (requestOrUrl) => {
    const url = typeof requestOrUrl === "string" ? requestOrUrl : requestOrUrl.url;
    calls.fetches.push(url);
    if (fetchImpl) return fetchImpl(requestOrUrl, url);
    return new FakeResponse({ ok: true, url, tag: "network" });
  };

  const cacheStorage = new FakeCacheStorage(env);

  const self = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    skipWaiting() {
      calls.skipWaiting += 1;
      return Promise.resolve();
    },
    clients: {
      claim() {
        calls.claim += 1;
        return Promise.resolve();
      },
    },
    location: { origin: ORIGIN },
    registration: { scope: SCOPE },
  };

  const sandbox = {
    self,
    caches: cacheStorage,
    fetch: env.fetch,
    URL,
    Promise,
    TypeError,
    console,
  };
  sandbox.globalThis = sandbox;
  new Script(source).runInNewContext(sandbox);

  return { listeners, caches: cacheStorage, calls, sandbox };
}

/** fetch イベントを1回流し、respondWith が呼ばれたかと、その結果を返す。 */
async function dispatchFetch(sw, request) {
  let responded = false;
  let result;
  const event = {
    request,
    respondWith(value) {
      responded = true;
      result = value;
    },
  };
  sw.listeners.get("fetch")(event);
  return { responded, response: responded ? await result : undefined };
}

/**
 * install / activate を流し、waitUntil に渡された Promise を**そのまま**返す。
 * ここで await してしまうと、拒否を assert.rejects へ渡す前に投げてしまう。
 */
function dispatchLifecycle(sw, type) {
  let waited;
  const event = {
    waitUntil(value) {
      waited = value;
    },
  };
  sw.listeners.get(type)(event);
  assert.ok(waited, `${type} が waitUntil を呼んでいない（処理が途中で打ち切られる）`);
  return waited;
}

// ---- 素通し（respondWith を呼ばない） ----

test("GET 以外は素通しする（同期の PUT を横取りしない）", async () => {
  const sw = loadServiceWorker();
  // 宛先は /api/ 以外の同一オリジンにする。/api/ に投げると後段の
  // 「/api/ は素通し」に救われてしまい、メソッドの判定を検査できない。
  for (const method of ["PUT", "POST", "DELETE", "HEAD"]) {
    const { responded } = await dispatchFetch(sw, new FakeRequest(`${ORIGIN}/`, { method }));
    assert.equal(responded, false, `${method} を横取りしている`);
  }
  // 同期APIへの非GETも当然素通し（実際の宛先での確認）。
  for (const method of ["PUT", "POST"]) {
    const { responded } = await dispatchFetch(
      sw,
      new FakeRequest(`${ORIGIN}/api/wordsnap-state`, { method }),
    );
    assert.equal(responded, false, `${method} /api/ を横取りしている`);
  }
  // 「応答を返さない」だけでなく「キャッシュに何も書かない」ことまで確認する。
  assert.deepEqual(sw.caches.allPutKeys(), [], "素通しのはずが Cache Storage へ書いている");
});

test("クロスオリジン（辞書API等）は素通しする", async () => {
  const sw = loadServiceWorker();
  for (const url of [
    "https://api.datamuse.com/words?ml=test",
    "https://api.dictionaryapi.dev/api/v2/entries/en/test",
    "https://cdn.jsdelivr.net/npm/tesseract.js/dist/worker.min.js",
  ]) {
    const { responded } = await dispatchFetch(sw, new FakeRequest(url));
    assert.equal(responded, false, `${url} をキャッシュ対象にしている`);
  }
  assert.deepEqual(sw.caches.allPutKeys(), [], "クロスオリジンの応答を保存している");
});

test("/api/ は素通しする（同期・フィードバック・テレメトリを絶対にキャッシュしない）", async () => {
  const sw = loadServiceWorker();
  for (const path of ["/api/wordsnap-state", "/api/feedback", "/api/telemetry"]) {
    const { responded } = await dispatchFetch(sw, new FakeRequest(`${ORIGIN}${path}?sync=KEY`));
    assert.equal(responded, false, `${path} を横取りしている`);
  }
  // 同期・フィードバックの応答が端末のキャッシュに残ると、内容の漏えい経路になる。
  assert.deepEqual(sw.caches.allPutKeys(), [], "/api/ の応答を Cache Storage へ書いている");
});

// ---- 個人キーをキャッシュに残さない（v5 の回帰防止） ----

test("個人キー付きURLで開いても、キャッシュのキーに個人キーが残らない", async () => {
  const sw = loadServiceWorker();
  const secret = "wk_THIS_MUST_NOT_BE_CACHED";
  const { responded } = await dispatchFetch(
    sw,
    new FakeRequest(`${ORIGIN}/?w=${secret}`, { mode: "navigate" }),
  );
  assert.equal(responded, true, "ナビゲーションを処理していない");

  // 「最初のキャッシュ」ではなく**全キャッシュ**を見る。キーごとに別キャッシュを
  // 作る実装だと、各キャッシュ内のキーだけ正規化されていて素通りしてしまう。
  const written = sw.caches.allPutKeys();
  assert.ok(written.length > 0, "本体をキャッシュしていない");
  for (const key of written) {
    assert.ok(!key.includes(secret), `個人キーがキャッシュに残っている: ${key}`);
    assert.ok(!key.includes("?w="), `?w= 付きURLをキャッシュしている: ${key}`);
  }
  // キャッシュ名そのものにも個人キーを混ぜない。
  for (const name of await sw.caches.keys()) {
    assert.ok(!name.includes(secret), `キャッシュ名に個人キーが入っている: ${name}`);
  }
  assert.deepEqual(await sw.caches.keys(), [CACHE_NAME], "想定外のキャッシュが作られている");
  // scope の "./" に正規化されること。ここがずれるとキー切替ごとに重複が増える。
  // 書き込み回数までは縛らない（再検証で複数回書く実装も正当）。
  assert.deepEqual([...new Set(written)], [SCOPE]);
});

test("個人キーが違っても、キャッシュは1つに集約される", async () => {
  const sw = loadServiceWorker();
  for (const key of ["wk_aaa", "wk_bbb", "wk_ccc"]) {
    await dispatchFetch(sw, new FakeRequest(`${ORIGIN}/?w=${key}`, { mode: "navigate" }));
  }
  assert.deepEqual(
    [...new Set(sw.caches.allPutKeys())],
    [SCOPE],
    "キーごとに別エントリを作っている",
  );
  assert.deepEqual(await sw.caches.keys(), [CACHE_NAME], "キーごとに別キャッシュを作っている");
});

// ---- ナビゲーションの network-first とオフライン復帰 ----

test("オンラインではネットワークの応答を返す（古いキャッシュを優先しない）", async () => {
  const sw = loadServiceWorker();
  // 空のキャッシュから始めると、cache-first へ改悪しても同じ結果になり検出できない。
  // 「古い本体が入っている」状態を作ってから確かめる。
  const cache = await sw.caches.open(CACHE_NAME);
  await cache.put(SCOPE, new FakeResponse({ ok: true, tag: "stale" }));

  const { response } = await dispatchFetch(
    sw,
    new FakeRequest(`${ORIGIN}/`, { mode: "navigate" }),
  );
  assert.equal(response.tag, "network", "キャッシュ済みの古い本体を返している");
  assertUsableResponse(response, "ナビゲーションの応答");
});

test("オフラインでは、個人キー付きURLでもキャッシュ済み本体を返す", async () => {
  let online = true;
  const sw = loadServiceWorker({
    fetchImpl: async (_req, url) => {
      if (!online) throw new TypeError("offline");
      return new FakeResponse({ ok: true, url, tag: "network" });
    },
  });
  // まずオンラインで1回開いてキャッシュを作る
  await dispatchFetch(sw, new FakeRequest(`${ORIGIN}/`, { mode: "navigate" }));
  online = false;
  const { responded, response } = await dispatchFetch(
    sw,
    new FakeRequest(`${ORIGIN}/?w=wk_secret`, { mode: "navigate" }),
  );
  assert.equal(responded, true);
  assert.ok(response, "オフラインで応答を返せていない（アプリが開けない）");
  assert.equal(response.tag, "network", "キャッシュ済みの本体が返っていない");
});

test("オフライン復帰は、キャッシュ側にクエリが付いていても効く（ignoreSearch）", async () => {
  // 上のテストだけだと、末尾の caches.match("./") のフォールバックに救われて
  // ignoreSearch を外しても通ってしまう（変異テストで判明）。
  // 「クエリ違いでも同じ本体を引く」という明示された意図をここで固定する。
  const sw = loadServiceWorker({
    fetchImpl: async () => {
      throw new TypeError("offline");
    },
  });
  const cache = await sw.caches.open(CACHE_NAME);
  // "./" ではなくクエリ付きのキーしか無い状態を作る。
  await cache.put(`${ORIGIN}/?w=wk_old`, new FakeResponse({ ok: true, tag: "cached-with-query" }));

  const { responded, response } = await dispatchFetch(
    sw,
    new FakeRequest(`${ORIGIN}/?w=wk_new`, { mode: "navigate" }),
  );
  assert.equal(responded, true);
  assert.ok(response, "クエリ違いのキャッシュを引けずオフラインで開けない");
  assert.equal(response.tag, "cached-with-query");
});

// ---- 静的アセットは cache-first ----

test("静的アセットはキャッシュにあればネットワークへ行かない", async () => {
  const sw = loadServiceWorker();
  const url = `${ORIGIN}/assets/icon-192.png`;
  // 実際に存在するのは CACHE_NAME のキャッシュだけなので、それに合わせる。
  const cache = await sw.caches.open(CACHE_NAME);
  await cache.put(url, new FakeResponse({ ok: true, url, tag: "cached" }));

  const before = sw.calls.fetches.length;
  const { responded, response } = await dispatchFetch(sw, new FakeRequest(url));
  assert.equal(responded, true);
  assert.equal(response.tag, "cached");
  assert.equal(sw.calls.fetches.length, before, "キャッシュにあるのにネットワークへ行っている");
});

test("静的アセットがキャッシュに無ければ取得してキャッシュへ足す", async () => {
  const sw = loadServiceWorker();
  const url = `${ORIGIN}/assets/icon-512.png`;
  const { response } = await dispatchFetch(sw, new FakeRequest(url));
  assert.equal(response.tag, "network");
  assertUsableResponse(response, "静的アセットの応答");
  assert.ok(sw.caches.allPutKeys().includes(url), "取得した静的アセットをキャッシュしていない");
});

test("取得に失敗した静的アセット（404等）はキャッシュしない", async () => {
  const sw = loadServiceWorker({
    fetchImpl: async (_req, url) => new FakeResponse({ ok: false, url, tag: "404" }),
  });
  const url = `${ORIGIN}/assets/missing.png`;
  const { response } = await dispatchFetch(sw, new FakeRequest(url));
  assert.equal(response.tag, "404");
  assert.ok(!sw.caches.allPutKeys().includes(url), "失敗応答をキャッシュしている");
});

// ---- install / activate の契約 ----

test("install: 本体の取得に失敗したら install も失敗する（v6の回帰防止）", async () => {
  const sw = loadServiceWorker({
    fetchImpl: async (_req, url) => {
      // 本体だけ落とす。アイコン等は成功させる。
      if (url === SCOPE) return new FakeResponse({ ok: false, url });
      return new FakeResponse({ ok: true, url });
    },
  });
  const pending = dispatchLifecycle(sw, "install");
  await assert.rejects(
    () => pending,
    "本体が取れないのに install が成功している。activate で旧キャッシュを消してオフライン起動を壊す",
  );
  assert.equal(sw.calls.skipWaiting, 0, "本体が取れていないのに skipWaiting している");
});

test("install: アイコン等の取得失敗は握りつぶして続行する", async () => {
  const sw = loadServiceWorker({
    fetchImpl: async (_req, url) => {
      if (url.includes("/assets/") || url.includes("webmanifest")) {
        return new FakeResponse({ ok: false, url });
      }
      return new FakeResponse({ ok: true, url });
    },
  });
  await assert.doesNotReject(async () => {
    await dispatchLifecycle(sw, "install");
  }, "オプションの取得失敗で install 全体を落としている");
  assert.equal(sw.calls.skipWaiting, 1, "install 成功時に skipWaiting していない");
});

test("activate: 現行以外のキャッシュだけを削除する", async () => {
  const sw = loadServiceWorker();
  await sw.caches.open(CACHE_NAME);
  await sw.caches.open("wordsnap-v4");
  await sw.caches.open("wordsnap-v6");

  await dispatchLifecycle(sw, "activate");
  assert.deepEqual([...sw.caches.deleted].sort(), ["wordsnap-v4", "wordsnap-v6"]);
  assert.ok(!sw.caches.deleted.includes(CACHE_NAME), "現行のキャッシュを消している");
  assert.equal(sw.calls.claim, 1, "clients.claim() を呼んでいない");
});

// ---- precache の内容 ----

test("precache は本体だけを必須にし、存在しないファイルを含めない", async () => {
  const sw = loadServiceWorker();
  await dispatchLifecycle(sw, "install");
  const cache = [...sw.caches.caches.values()][0];
  assert.ok(cache, "install でキャッシュが作られていない");
  // かつて存在しない wordsnap-quiz.html を入れ、本体を二重に持っていた。
  assert.ok(
    !cache.addKeys.some((k) => k.includes("wordsnap-quiz.html")),
    "存在しないファイルを precache している（本体を二重に持つ）",
  );
  assert.ok(cache.addKeys.includes("./"), "本体を precache していない");
});

// ---- リリースごとの入れ替わり（1.0.90） -------------------------------------
// ブラウザは「wordsnap-sw.js の中身が変わったとき」だけ Service Worker を入れ直す。
// 以前はキャッシュ名が手動の固定値だったため、リリースしてもこのファイルが変わらず、
// 端末には古い本体（1.0.77）が残り続けた。HTMLは network-first なので普段は最新が
// 出るが、通信が一瞬でも失敗するとフォールバックでその古い本体が表示される。

test("キャッシュ名にアプリの版が入る（リリースのたびに入れ直される）", () => {
  assert.match(
    source,
    /const\s+APP_REV\s*=\s*["'][^"']+["']/,
    "版を埋め込んでいないと、リリースしてもファイルの中身が変わらない",
  );
  assert.match(
    source,
    /const\s+CACHE_NAME\s*=\s*`wordsnap-v7-\$\{APP_REV\}`/,
    "キャッシュ名に版が入っていないと、activate で前の版のキャッシュが消えない",
  );
});

test("Service Worker の版は package.json と一致する", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const swRev = source.match(/const\s+APP_REV\s*=\s*["']([^"']+)["']/)?.[1];
  assert.equal(swRev, pkg.version, "ズレていると、その版だけ入れ替えが起きない");
});

test("activate は今の版以外のキャッシュを消す（古い本体を残さない）", () => {
  assert.match(
    source,
    /keys\.filter\(\(key\) => key !== CACHE_NAME\)\.map\(\(key\) => caches\.delete\(key\)\)/,
    "版が変わったときに前の版のキャッシュを消していない",
  );
});

// ---- 古いアプリキャッシュの自己修復（1.0.94） -------------------------------
// install は「アプリ本体を取得してキャッシュできたとき」だけ成功する作りなので、
// 保存容量が足りない等で失敗すると新しいSWが有効化されず、古い本体が残り続ける。
// HTMLは network-first なので普段は最新が出るが、通信が一瞬でも途切れると
// フォールバックでその古い本体が表示される（1.0.77 が時々出る事故）。
// いま動いているページは必ず最新なので、ページ側から古いキャッシュを消して自己修復する。

const appHtml = readFileSync(new URL("../publish/index.html", import.meta.url), "utf8");

function extractPurgeFunction() {
  const start = appHtml.indexOf("async function purgeStaleAppCaches(");
  if (start < 0) throw new Error("purgeStaleAppCaches not found");
  const brace = appHtml.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < appHtml.length; i += 1) {
    if (appHtml[i] === "{") depth += 1;
    else if (appHtml[i] === "}") {
      depth -= 1;
      if (depth === 0) return appHtml.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces");
}

function buildPurgeSandbox({ shownVersion, existing }) {
  const deleted = [];
  const sandbox = {
    caches: {
      keys: async () => existing.slice(),
      delete: async (key) => {
        deleted.push(key);
        return true;
      },
    },
    document: {
      querySelector: () => (shownVersion === null ? null : { textContent: shownVersion }),
    },
  };
  new Script(`${extractPurgeFunction()}\nglobalThis.__p = purgeStaleAppCaches;`, {
    filename: "sw-purge-check.js",
  }).runInNewContext(sandbox);
  return { run: sandbox.__p, deleted };
}

test("自己修復: いまの版と違うアプリキャッシュだけを消す", async () => {
  const { run, deleted } = buildPurgeSandbox({
    shownVersion: "バージョン 1.0.94",
    existing: ["wordsnap-v7", "wordsnap-v7-1.0.77", "wordsnap-v7-1.0.94", "other-cache"],
  });
  await run();
  assert.deepEqual(
    deleted.sort(),
    ["wordsnap-v7", "wordsnap-v7-1.0.77"],
    "古い版だけを消し、いまの版と無関係のキャッシュは触らない",
  );
});

test("自己修復: 版が読めないときは何も消さない（現行キャッシュを誤って消さない）", async () => {
  const { run, deleted } = buildPurgeSandbox({
    shownVersion: "バージョン 不明",
    existing: ["wordsnap-v7-1.0.94"],
  });
  await run();
  assert.deepEqual(deleted, []);
});

test("自己修復: フッターが無い環境でも落ちない", async () => {
  const { run, deleted } = buildPurgeSandbox({ shownVersion: null, existing: ["wordsnap-v7-1.0.77"] });
  await assert.doesNotReject(() => run());
  assert.deepEqual(deleted, []);
});

test("自己修復: 起動時に呼ばれる配線が残っている", () => {
  assert.match(
    appHtml,
    /navigator\.serviceWorker\.register\("wordsnap-sw\.js"\)[\s\S]{0,200}purgeStaleAppCaches\(\)/,
    "登録と一緒に掃除を呼んでいない＝古いキャッシュが残り続ける",
  );
});

test("案内: 古い版が出たときの直し方が画面に書いてある", () => {
  assert.match(
    appHtml,
    /ここが古い版のときは、アプリを一度終了して開き直す/,
    "版表示の隣に直し方が無い（気づいた場所で解決できない）",
  );
  assert.match(appHtml, /古いバージョンが表示されるとき/, "設定にも説明が無い");
});
