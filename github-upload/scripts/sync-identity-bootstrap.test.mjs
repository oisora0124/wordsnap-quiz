// Phase 2 段階5-3a（新規ユーザーのidentity確立を1か所へ集約）の凍結ゲート。
//
// 5-3b では、この手前に「V2ネイティブ資格情報の自動発行」を挟む。発行は
// ネットワークを伴い、失敗もタイムアウトもする。そこで先に固定しておくのが
// **着地保証** — どの経路を通っても、新規ユーザーは最後に必ず legacy キーを持つ。
// ここが崩れると、新規ユーザーが同期の無いまま取り残される（サーバー保存も
// 端末間の引き継ぎも効かず、端末を変えると単語が消えたように見える）。
//
// このファイルは initWordsnapSync を**実際に実行して**呼び出し順・引数・最終状態を
// 比較する。文字列の出現回数を数えるだけだと、配線を差し替えても通ってしまうため
// （5-3bで同期→非同期に組み替えるので、そこを検出できないゲートでは意味がない）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(scriptDir, "..", "publish", "index.html"), "utf8");

const SYNC_ID_KEY = "wordsnap-sync-id";
const SYNC_ACCESS_KEY = "wordsnap-sync-access-key";
const LEGACY_A = `ws_${"a".repeat(60)}`;
const LEGACY_B = `ws_${"b".repeat(60)}`;
const GENERATED = `ws_${"c".repeat(60)}`;
const ROOM_ID = `wr_${"1".repeat(32)}`;

// 終端needleにはコメントではなくコードを使う（文言の言い換えで落ちないように）。
function sourceBetween(startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  assert.ok(start >= 0, `${startNeedle} が見つかること`);
  const end = html.indexOf(endNeedle, start);
  assert.ok(end > start, `${startNeedle} の終端が見つかること`);
  return html.slice(start, end);
}

// 起動時のidentity確立まわりを丸ごと取り出す。syncStartupIdentityDecision は
// 判定の本体なのでスタブにせず実物を使う。
const INIT_SOURCE = sourceBetween(
  "function syncStartupIdentityDecision",
  "\nfunction saveState",
);

// addEventListener などを受け流すだけの要素スタブ。存在しないキーを触っても落ちない。
function fakeElement(key) {
  return {
    __key: key,
    value: "",
    type: "password",
    textContent: "",
    hidden: true,
    disabled: false,
    isConnected: true,
    dataset: {},
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    focus() {},
    click() {},
    closest: () => null,
  };
}

function makeInit({
  storedSyncId = "",
  urlSyncId = "",
  v2RoomId = "",
  serverAvailable = true,
  claimBlocks = false,
  generateThrows = false,
  storageWriteThrows = false,
} = {}) {
  const trace = [];
  const record = (name) => (...args) => { trace.push([name, ...args]); };
  const store = new Map();
  if (storedSyncId) store.set(SYNC_ID_KEY, storedSyncId);

  const elementCache = new Map();
  const elements = new Proxy({}, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      if (!elementCache.has(key)) elementCache.set(key, fakeElement(key));
      return elementCache.get(key);
    },
    has: () => true,
  });

  const syncState = { id: "", connected: false, pollTimer: 0 };
  // V2資格情報があるときの identity。実物の syncRequestRoute と同じ形だけ用意する。
  const route = () => (v2RoomId
    ? { kind: "v2-native", isV2Native: true, legacyId: "", expectedSyncId: v2RoomId, roomId: v2RoomId }
    : { kind: "legacy", isV2Native: false, legacyId: syncState.id, expectedSyncId: syncState.id });

  const search = urlSyncId ? `?w=${urlSyncId}` : "";
  const context = {
    JSON, Math, Date, Promise, Boolean, Number, String, URLSearchParams, Object, Array,
    console: { log() {}, warn() {}, error() {} },
    SYNC_ID_KEY,
    SYNC_ACCESS_KEY,
    MAX_TIMED_ANSWER_MS: 60000,
    elements,
    syncState,
    appState: { words: [] },
    currentQuiz: null,
    activeStepId: "settings",
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem(k, v) {
        if (storageWriteThrows) throw new Error("quota");
        store.set(k, String(v));
      },
      removeItem: (k) => { store.delete(k); },
    },
    window: {
      location: { search, href: `https://wordbank.example/${search}` },
      setTimeout: () => 0,
      clearTimeout() {},
      setInterval: () => 0,
      addEventListener() {},
    },
    document: { hidden: false, addEventListener() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    // --- 判定に効くもの（実際の分岐を作る） ---
    cleanSyncId: (v) => (/^ws_[0-9a-z]{60}$/.test(String(v || "").trim()) ? String(v).trim() : ""),
    syncRequestRoute: route,
    syncServerAvailable: () => serverAvailable,
    identityClaimBlocksDecision: () => claimBlocks,
    generatePrivateKey() {
      trace.push(["generatePrivateKey"]);
      if (generateThrows) throw new Error("no secure random");
      return GENERATED;
    },
    // --- 記録するだけのもの ---
    connectWordsnapSync: record("connectWordsnapSync"),
    setSyncStatus: (message, tone) => { trace.push(["setSyncStatus", message, tone]); },
    showSyncSwitchConfirm: record("showSyncSwitchConfirm"),
    initV2SyncUi: record("initV2SyncUi"),
    applySyncIdentityUi: record("applySyncIdentityUi"),
    updateSyncKeySecurityWarning: record("updateSyncKeySecurityWarning"),
    rememberSyncIdInUrl: record("rememberSyncIdInUrl"),
    updateSyncBadge: record("updateSyncBadge"),
    startSyncPolling() {}, stopSyncPolling() {}, stopQuizTimer() {},
    updateQuizControls() {}, flushPendingSyncPush() {}, pullWordsnapState() {},
    pushWordsnapState() {}, acceptSyncMergeOffer() {}, hideSyncMergeOffer() {},
    adoptForeignSyncId() {}, generateSyncId: () => GENERATED, issueNewSyncId() {},
    extractSyncIdFromJoinInput: () => "", forcePullReplace() {}, forcePushOverwrite() {},
    loadRestoreHistory() {}, restoreFromRevision() {}, setActiveStep() {},
    armDangerButton() {}, hadStoredLegacyKeyAtStartup: false,
  };
  context.globalThis = context;
  vm.runInNewContext(INIT_SOURCE, context);
  context.initWordsnapSync();
  return {
    trace,
    names: trace.map((entry) => entry[0]),
    syncState,
    store,
    context,
    status: trace.filter((e) => e[0] === "setSyncStatus").map((e) => e[1]),
  };
}

// ---- 着地保証（5-3bで最も壊れやすいところ） ----

test("新規ユーザーはlegacyキーを持って着地し、接続まで進む", () => {
  const run = makeInit();
  assert.equal(run.syncState.id, GENERATED, "identityが確立していること");
  assert.equal(run.store.get(SYNC_ID_KEY), GENERATED, "耐久保存もされること");
  assert.ok(run.names.includes("connectWordsnapSync"), "同期を開始すること");
});

test("既存legacyユーザーは新規発行されず、そのまま接続する", () => {
  const run = makeInit({ storedSyncId: LEGACY_A });
  assert.equal(run.syncState.id, LEGACY_A, "保存済みキーを使うこと");
  assert.ok(!run.names.includes("generatePrivateKey"), "鍵を作り直さないこと");
  assert.ok(run.names.includes("connectWordsnapSync"));
});

test("V2ネイティブユーザーにはlegacyキーを発行しない", () => {
  const run = makeInit({ v2RoomId: ROOM_ID });
  assert.ok(!run.names.includes("generatePrivateKey"), "legacyを発行しないこと");
  assert.equal(run.store.has(SYNC_ID_KEY), false, "legacyキーを保存しないこと");
  assert.ok(run.names.includes("connectWordsnapSync"), "V2で接続すること");
});

test("安全な鍵を作れない環境では、同期を開始せずその旨を伝える", () => {
  const run = makeInit({ generateThrows: true });
  assert.equal(run.syncState.id, "", "推測可能なキーを置かないこと");
  assert.equal(run.store.has(SYNC_ID_KEY), false);
  assert.ok(!run.names.includes("connectWordsnapSync"), "接続しないこと");
  assert.match(run.status.join("\n"), /安全な個人キーを生成できない/);
});

test("localStorageへ書けない環境でも例外を外へ出さず、同期を開始しない", () => {
  let run;
  assert.doesNotThrow(() => { run = makeInit({ storageWriteThrows: true }); });
  assert.ok(!run.names.includes("connectWordsnapSync"));
});

test("別タブがidentity操作中は、何も決めずに再読み込みを促す", () => {
  const run = makeInit({ claimBlocks: true });
  assert.equal(run.syncState.id, "", "identityを採用しないこと");
  assert.equal(run.store.has(SYNC_ID_KEY), false, "URLキーも新規キーも保存しないこと");
  assert.ok(!run.names.includes("generatePrivateKey"), "自動発行しないこと");
  assert.ok(!run.names.includes("connectWordsnapSync"), "同期を開始しないこと");
  assert.match(run.status.join("\n"), /再読み込み/);
});

test("確定したidentityを持つ端末は、claim中でも従来どおり動く", () => {
  // claimを見るのは「まだ何も持っていない」端末だけ。既存ユーザーを止めない。
  const run = makeInit({ storedSyncId: LEGACY_A, claimBlocks: true });
  assert.equal(run.syncState.id, LEGACY_A);
  assert.ok(run.names.includes("connectWordsnapSync"));
});

test("file:// ではサーバー同期を開始せず、鍵も発行しない", () => {
  const run = makeInit({ serverAvailable: false });
  assert.ok(!run.names.includes("generatePrivateKey"));
  assert.ok(!run.names.includes("connectWordsnapSync"));
  assert.match(run.status.join("\n"), /ファイルを直接開いている/);
});

// ---- 他人の共有リンク ----

test("他人の共有リンクを開いても、自分のキーのまま確認を促す", () => {
  const run = makeInit({ storedSyncId: LEGACY_A, urlSyncId: LEGACY_B });
  assert.equal(run.syncState.id, LEGACY_A, "リンク先へ切り替えないこと");
  assert.equal(run.store.get(SYNC_ID_KEY), LEGACY_A, "保存済みキーを上書きしないこと");
  assert.ok(run.names.includes("showSyncSwitchConfirm"), "確認バナーを出すこと");
  assert.ok(!run.names.includes("rememberSyncIdInUrl"), "URLを書き換えないこと");
});

test("初回に共有リンクで来た人は、そのキーを採用する", () => {
  const run = makeInit({ urlSyncId: LEGACY_B });
  assert.equal(run.syncState.id, LEGACY_B);
  assert.equal(run.store.get(SYNC_ID_KEY), LEGACY_B);
  assert.ok(!run.names.includes("generatePrivateKey"), "新規発行しないこと");
});

// ---- 呼び出し順序（切り出しで崩れやすい） ----

test("UI反映は「legacy側 → V2初期化 → identity適用」の順を保つ", () => {
  const run = makeInit();
  const order = run.names.filter((n) =>
    ["updateSyncKeySecurityWarning", "initV2SyncUi", "applySyncIdentityUi"].includes(n));
  assert.deepEqual(order.slice(0, 3), [
    "updateSyncKeySecurityWarning",
    "initV2SyncUi",
    "applySyncIdentityUi",
  ]);
});

test("identityが確立してからUIへ反映し、そのあとで接続する", () => {
  const run = makeInit();
  const generated = run.names.indexOf("generatePrivateKey");
  const applied = run.names.indexOf("applySyncIdentityUi");
  const connected = run.names.indexOf("connectWordsnapSync");
  assert.ok(generated >= 0 && applied > generated, "確立→UI反映の順であること");
  assert.ok(connected > applied, "UI反映→接続の順であること");
});

test("URLへ反映するキーは、実際に採用したidentityと一致する", () => {
  const run = makeInit();
  const remembered = run.trace.find((e) => e[0] === "rememberSyncIdInUrl");
  assert.ok(remembered, "URLへ反映すること");
  assert.equal(remembered[1], GENERATED, "発行したキーであること");
});

// ---- 構造（5-3bの前提） ----

test("起動時のlegacy発行の入口は1つだけ", () => {
  // 5-3b で発行前にV2を試すようになる。入口が複数あると、片方だけガードが漏れる。
  assert.equal((html.match(/function establishLegacyIdentity/g) || []).length, 1);
  const init = sourceBetween("function initWordsnapSync", "\n  initV2SyncUi();");
  assert.equal((init.match(/establishLegacyIdentity\(\)/g) || []).length, 1);
  assert.doesNotMatch(init, /generatePrivateKey\(\)/, "起動側で直接鍵を作らないこと");
});

test("identity確定後の接続開始は1本の出口に集約されている", () => {
  const exit = sourceBetween(
    "function startSyncWithEstablishedIdentity",
    "\nfunction initWordsnapSync",
  );
  assert.match(exit, /connectWordsnapSync\(\{ silent: true \}\)/);
  assert.match(exit, /keyGenerationFailed/);
  assert.match(exit, /identityDecisionDeferred/);
  const init = sourceBetween("function initWordsnapSync", "\nfunction saveState");
  assert.doesNotMatch(
    init,
    /connectWordsnapSync\(\{ silent: true \}\)/,
    "接続開始を出口の外に散らさないこと",
  );
});

test("identityのUI反映は保存も発行も同期も伴わない（何度呼んでも安全）", () => {
  // 5-3b では、V2発行の結果が出てからもう一度呼ぶ。
  const apply = sourceBetween("function applyLegacyIdentityToUi", "\nfunction applyEstablishedIdentityToUi");
  assert.doesNotMatch(apply, /localStorage\.setItem/);
  assert.doesNotMatch(apply, /generatePrivateKey|establishLegacyIdentity/);
  assert.doesNotMatch(apply, /connectWordsnapSync|pushWordsnapState|pullWordsnapState/);
  const both = sourceBetween("function applyEstablishedIdentityToUi", "\nfunction startSyncWithEstablishedIdentity");
  assert.doesNotMatch(both, /initV2SyncUi/, "一度きりの初期化を再適用に含めないこと");
});

test("段階5-3aの時点ではV2ネイティブの自動発行経路はまだ無い", () => {
  // 5-3b で解禁する。ここが増えていたら、着地保証より先に分岐が入っている。
  assert.equal((html.match(/v2NativeIssueAllowed/g) || []).length, 1);
  assert.doesNotMatch(html, /create=1&native=1/);
});
