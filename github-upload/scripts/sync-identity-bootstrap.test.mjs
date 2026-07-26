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

const SYNC_ID_KEY = "wordsnap-sync-id:v1";
const SYNC_ACCESS_KEY = "wordsnap-sync-access-key:v1";
const LEGACY_A = `ws_${"a".repeat(60)}`;
const LEGACY_B = `ws_${"b".repeat(60)}`;
const GENERATED = `ws_${"c".repeat(60)}`;
const ROOM_ID = `wr_${"1".repeat(32)}`;
const SECRET = `wk_${"2".repeat(60)}`;

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

async function makeInit({
  storedSyncId = "",
  urlSyncId = "",
  v2RoomId = "",
  serverAvailable = true,
  claimBlocks = false,
  generateThrows = false,
  storageWriteThrows = false,
  storageRemoveThrows = false,
  // --- 段階5-3b: V2ネイティブ自動発行 ---
  issueAllowed = false,      // 回復バリアが settled か
  claimAvailable = true,     // claimを取れるか
  blockAfterAcquire = false, // 取得後の再確認で他タブに負けるか
  issueResponse = null,      // { status, body } / "network" / "timeout"
  credentialAppearsDuringIssue = false, // 応答待ちの間に別タブが確定した
  v2CredentialAppearsDuringIssue = false, // 応答待ちの間に別タブがV2を確定した
  fallbackThrows = false, // フォールバック中に予期しない例外が起きる
  rawV2CredentialPresent = false, // バリア確定後に別タブが資格情報を書いた
  uiApplyThrows = false, // UI反映が例外を投げる
} = {}) {
  const trace = [];
  const record = (name) => (...args) => { trace.push([name, ...args]); };
  const store = new Map();
  if (storedSyncId) store.set(SYNC_ID_KEY, storedSyncId);
  if (rawV2CredentialPresent) store.set("wordsnap-sync-credential:v2", "{壊れている");
  if (v2RoomId) {
    store.set("wordsnap-sync-credential:v2", JSON.stringify({
      roomId: v2RoomId, secret: SECRET, status: "active", provenance: "native-default:v1",
    }));
  }

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
  let claimBlocked = claimBlocks;
  let applyCalls = 0;
  // 実物の syncRequestRoute と同じ判定にする。特に isV2Native は
  //   !legacyId && credential.provenance === "native-default:v1"
  // であり、決め打ちにすると「印を付け忘れた」欠陥を隠してしまう。
  const NATIVE_PROVENANCE = "native-default:v1";
  const activeCredential = () => {
    const raw = store.get("wordsnap-sync-credential:v2");
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed?.status === "active" ? parsed : null;
    } catch {
      return null;
    }
  };
  const route = () => {
    const credential = activeCredential();
    if (credential) {
      return {
        kind: "v2",
        isV2: true,
        isV2Native: !syncState.id && credential.provenance === NATIVE_PROVENANCE,
        legacyId: syncState.id,
        roomId: credential.roomId,
        expectedSyncId: credential.roomId,
      };
    }
    return { kind: "legacy", isV2: false, isV2Native: false, legacyId: syncState.id, expectedSyncId: syncState.id };
  };

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
      removeItem(k) {
        if (storageRemoveThrows) throw new Error("remove failed");
        store.delete(k);
      },
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
    // 実物と同じく、自分のtokenを渡されたときは自分のclaimでは止まらない。
    identityClaimBlocksDecision: (ownToken = "") => {
      if (blockAfterAcquire && ownToken === "claim-token") return true;
      return claimBlocked;
    },
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
    applySyncIdentityUi: (...args) => {
      trace.push(["applySyncIdentityUi", ...args]);
      // 起動時の1回目は5-3b以前からある呼び出し。壊すのは発行後の再適用だけ。
      applyCalls += 1;
      if (uiApplyThrows && applyCalls > 1) throw new Error("render failed");
    },
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
    // --- 段階5-3b: V2ネイティブ自動発行 ---
    SYNC_V2_CREDENTIAL_KEY: "wordsnap-sync-credential:v2",
    SYNC_V2_NATIVE_PROVENANCE: "native-default:v1",
    LEARNING_SCHEMA_VERSION: 1,
    V2_NATIVE_ISSUE_TIMEOUT_MS: 6000,
    v2NativeIssueAllowed: () => { trace.push(["v2NativeIssueAllowed"]); return issueAllowed; },
    async acquireIdentityClaim(kind) {
      trace.push(["acquireIdentityClaim", kind]);
      return claimAvailable ? "claim-token" : "";
    },
    releaseIdentityClaim: (token) => { trace.push(["releaseIdentityClaim", token]); },
    pendingV2Credential: (origin) => ({ roomId: ROOM_ID, secret: SECRET, status: "pending", origin }),
    writeV2Credential(credential) {
      trace.push(["writeV2Credential", credential.status]);
      store.set("wordsnap-sync-credential:v2", JSON.stringify(credential));
      return credential;
    },
    readV2Credential() {
      const raw = store.get("wordsnap-sync-credential:v2");
      return raw ? JSON.parse(raw) : null;
    },
    removePendingV2Credential(roomId) {
      const raw = store.get("wordsnap-sync-credential:v2");
      const current = raw ? JSON.parse(raw) : null;
      if (current?.status === "pending" && (!roomId || current.roomId === roomId)) {
        trace.push(["removePendingV2Credential", roomId]);
        store.delete("wordsnap-sync-credential:v2");
      }
    },
    activateV2Credential(credential, stateRev) {
      trace.push(["activateV2Credential", credential.roomId, stateRev]);
      // 実物は preserveV2NativeProvenance を通すが、それは「既にネイティブなら保つ」
      // だけなので、渡されたcredentialの provenance をそのまま保存するのと等価。
      store.set("wordsnap-sync-credential:v2", JSON.stringify({ ...credential, status: "active" }));
    },
    getActiveV2Credential() {
      if (fallbackThrows) throw new Error("unexpected");
      const raw = store.get("wordsnap-sync-credential:v2");
      const current = raw ? JSON.parse(raw) : null;
      return current?.status === "active" ? current : null;
    },
    v2SyncEndpoint: (roomId) => `/api/wordsnap-state?sync=${roomId}`,
    buildSyncPayloadState: () => ({ words: [] }),
    validSyncPutResponse: (data, expected) => data?.ok === true && String(data.syncId || "") === expected,
    readJsonResponse: async (response) => response.body,
    recordVerifiedSync: (target, count) => { trace.push(["recordVerifiedSync", target, count]); },
    trackUsage: (name) => { trace.push(["trackUsage", name]); },
    async v2Fetch(url, options, timeoutMs) {
      trace.push(["v2Fetch", url, timeoutMs]);
      if (credentialAppearsDuringIssue) store.set(SYNC_ID_KEY, LEGACY_B);
      if (v2CredentialAppearsDuringIssue) {
        store.set("wordsnap-sync-credential:v2", JSON.stringify({ roomId: `wr_${"9".repeat(32)}`, secret: SECRET, status: "active" }));
      }
      if (issueResponse === "network") throw new Error("network down");
      if (issueResponse === "timeout") { const e = new Error("aborted"); e.name = "AbortError"; throw e; }
      return { status: issueResponse.status, body: issueResponse.body ?? {} };
    },
  };
  context.globalThis = context;
  vm.runInNewContext(INIT_SOURCE, context);
  context.initWordsnapSync();
  // 段階5-3b: 新規ユーザーの確立は非同期。マイクロタスクを流し切ってから観測する。
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
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

test("新規ユーザーはlegacyキーを持って着地し、接続まで進む", async () => {
  const run = await makeInit();
  assert.equal(run.syncState.id, GENERATED, "identityが確立していること");
  assert.equal(run.store.get(SYNC_ID_KEY), GENERATED, "耐久保存もされること");
  assert.ok(run.names.includes("connectWordsnapSync"), "同期を開始すること");
});

test("既存legacyユーザーは新規発行されず、そのまま接続する", async () => {
  const run = await makeInit({ storedSyncId: LEGACY_A });
  assert.equal(run.syncState.id, LEGACY_A, "保存済みキーを使うこと");
  assert.ok(!run.names.includes("generatePrivateKey"), "鍵を作り直さないこと");
  assert.ok(run.names.includes("connectWordsnapSync"));
});

test("4秒フォールバックで自動生成したlegacyだけをV2復元成功後に取り消す", async () => {
  const run = await makeInit();
  run.store.set("wordsnap-sync-credential:v2", JSON.stringify({
    roomId: ROOM_ID,
    status: "active",
    provenance: "native-default:v1",
  }));
  assert.equal(run.context.revokeStartupGeneratedLegacyIdentity(), true);
  assert.equal(run.store.has(SYNC_ID_KEY), false, "自動生成した保存値を削除すること");
  assert.equal(run.syncState.id, "", "メモリ上のlegacyも空にすること");
  assert.equal(run.context.syncRequestRoute().isV2Native, true, "V2ネイティブへ戻ること");
});

test("起動前から持っていたlegacyはV2復元後も絶対に削除しない", async () => {
  const run = await makeInit({ storedSyncId: LEGACY_A });
  assert.equal(run.context.revokeStartupGeneratedLegacyIdentity(), false);
  assert.equal(run.store.get(SYNC_ID_KEY), LEGACY_A);
  assert.equal(run.syncState.id, LEGACY_A);
});

test("復元待ちの間に差し替わったlegacyは自動生成IDと取り違えて削除しない", async () => {
  const run = await makeInit();
  run.store.set(SYNC_ID_KEY, LEGACY_B);
  run.syncState.id = LEGACY_B;
  assert.equal(run.context.revokeStartupGeneratedLegacyIdentity(), false);
  assert.equal(run.store.get(SYNC_ID_KEY), LEGACY_B);
  assert.equal(run.syncState.id, LEGACY_B);
});

test("自動生成legacyの削除に失敗しても例外を漏らさず同期経路を残す", async () => {
  const run = await makeInit({ storageRemoveThrows: true });
  assert.doesNotThrow(() => {
    assert.equal(run.context.revokeStartupGeneratedLegacyIdentity(), false);
  });
  assert.equal(run.store.get(SYNC_ID_KEY), GENERATED);
  assert.equal(run.syncState.id, GENERATED);
});

test("V2ネイティブユーザーにはlegacyキーを発行しない", async () => {
  const run = await makeInit({ v2RoomId: ROOM_ID });
  assert.ok(!run.names.includes("generatePrivateKey"), "legacyを発行しないこと");
  assert.equal(run.store.has(SYNC_ID_KEY), false, "legacyキーを保存しないこと");
  assert.ok(run.names.includes("connectWordsnapSync"), "V2で接続すること");
});

test("安全な鍵を作れない環境では、同期を開始せずその旨を伝える", async () => {
  const run = await makeInit({ generateThrows: true });
  assert.equal(run.syncState.id, "", "推測可能なキーを置かないこと");
  assert.equal(run.store.has(SYNC_ID_KEY), false);
  assert.ok(!run.names.includes("connectWordsnapSync"), "接続しないこと");
  assert.match(run.status.join("\n"), /安全な個人キーを生成できない/);
});

test("localStorageへ書けない環境でも例外を外へ出さず、同期を開始しない", async () => {
  const run = await makeInit({ storageWriteThrows: true });
  assert.ok(!run.names.includes("connectWordsnapSync"));
});

test("別タブがidentity操作中は、何も決めずに再読み込みを促す", async () => {
  const run = await makeInit({ claimBlocks: true });
  assert.equal(run.syncState.id, "", "identityを採用しないこと");
  assert.equal(run.store.has(SYNC_ID_KEY), false, "URLキーも新規キーも保存しないこと");
  assert.ok(!run.names.includes("generatePrivateKey"), "自動発行しないこと");
  assert.ok(!run.names.includes("connectWordsnapSync"), "同期を開始しないこと");
  assert.match(run.status.join("\n"), /再読み込み/);
});

test("確定したidentityを持つ端末は、claim中でも従来どおり動く", async () => {
  // claimを見るのは「まだ何も持っていない」端末だけ。既存ユーザーを止めない。
  const run = await makeInit({ storedSyncId: LEGACY_A, claimBlocks: true });
  assert.equal(run.syncState.id, LEGACY_A);
  assert.ok(run.names.includes("connectWordsnapSync"));
});

test("file:// ではサーバー同期を開始せず、鍵も発行しない", async () => {
  const run = await makeInit({ serverAvailable: false });
  assert.ok(!run.names.includes("generatePrivateKey"));
  assert.ok(!run.names.includes("connectWordsnapSync"));
  assert.match(run.status.join("\n"), /ファイルを直接開いている/);
});

// ---- 他人の共有リンク ----

test("他人の共有リンクを開いても、自分のキーのまま確認を促す", async () => {
  const run = await makeInit({ storedSyncId: LEGACY_A, urlSyncId: LEGACY_B });
  assert.equal(run.syncState.id, LEGACY_A, "リンク先へ切り替えないこと");
  assert.equal(run.store.get(SYNC_ID_KEY), LEGACY_A, "保存済みキーを上書きしないこと");
  assert.ok(run.names.includes("showSyncSwitchConfirm"), "確認バナーを出すこと");
  assert.ok(!run.names.includes("rememberSyncIdInUrl"), "URLを書き換えないこと");
});

test("初回に共有リンクで来た人は、そのキーを採用する", async () => {
  const run = await makeInit({ urlSyncId: LEGACY_B });
  assert.equal(run.syncState.id, LEGACY_B);
  assert.equal(run.store.get(SYNC_ID_KEY), LEGACY_B);
  assert.ok(!run.names.includes("generatePrivateKey"), "新規発行しないこと");
});

// ---- 呼び出し順序（切り出しで崩れやすい） ----

test("UI反映は「legacy側 → V2初期化 → identity適用」の順を保つ", async () => {
  const run = await makeInit();
  const order = run.names.filter((n) =>
    ["updateSyncKeySecurityWarning", "initV2SyncUi", "applySyncIdentityUi"].includes(n));
  assert.deepEqual(order.slice(0, 3), [
    "updateSyncKeySecurityWarning",
    "initV2SyncUi",
    "applySyncIdentityUi",
  ]);
});

test("identityが確立してからUIへ反映し、そのあとで接続する", async () => {
  const run = await makeInit();
  const generated = run.names.indexOf("generatePrivateKey");
  const applied = run.names.indexOf("applySyncIdentityUi");
  const connected = run.names.indexOf("connectWordsnapSync");
  assert.ok(generated >= 0 && applied > generated, "確立→UI反映の順であること");
  assert.ok(connected > applied, "UI反映→接続の順であること");
});

test("URLへ反映するキーは、実際に採用したidentityと一致する", async () => {
  const run = await makeInit();
  const remembered = run.trace.find((e) => e[0] === "rememberSyncIdInUrl");
  assert.ok(remembered, "URLへ反映すること");
  assert.equal(remembered[1], GENERATED, "発行したキーであること");
});

// ---- 構造（5-3bの前提） ----

test("起動時のlegacy発行の入口は1つだけ", async () => {
  // 5-3b で発行前にV2を試すようになる。入口が複数あると、片方だけガードが漏れる。
  assert.equal((html.match(/function establishLegacyIdentity/g) || []).length, 1);
  const init = sourceBetween("function initWordsnapSync", "\n  initV2SyncUi();");
  assert.equal((init.match(/establishLegacyIdentity\(\)/g) || []).length, 1);
  assert.doesNotMatch(init, /generatePrivateKey\(\)/, "起動側で直接鍵を作らないこと");
});

test("identity確定後の接続開始は1本の出口に集約されている", async () => {
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

test("identityのUI反映は保存も発行も同期も伴わない（何度呼んでも安全）", async () => {
  // 5-3b では、V2発行の結果が出てからもう一度呼ぶ。
  const apply = sourceBetween("function applyLegacyIdentityToUi", "\nfunction applyEstablishedIdentityToUi");
  assert.doesNotMatch(apply, /localStorage\.setItem/);
  assert.doesNotMatch(apply, /generatePrivateKey|establishLegacyIdentity/);
  assert.doesNotMatch(apply, /connectWordsnapSync|pushWordsnapState|pullWordsnapState/);
  const both = sourceBetween("function applyEstablishedIdentityToUi", "\nfunction startSyncWithEstablishedIdentity");
  assert.doesNotMatch(both, /initV2SyncUi/, "一度きりの初期化を再適用に含めないこと");
});

// ---- 段階5-3b: V2ネイティブの自動発行 ----
//
// 起動経路で走るので、どんな失敗でも必ず legacy へ着地することが最優先。
// サーバー側フラグ(SYNC_V2_NATIVE_DEFAULT)が立つまでは常に403なので、
// 本番の現状は「常にlegacyへ倒れる」＝挙動不変。

const OK_RESPONSE = { status: 200, body: { ok: true, syncId: ROOM_ID, stateRev: 7 } };

test("発行に成功したらV2で着地し、legacyキーは作らない", async () => {
  const run = await makeInit({ issueAllowed: true, issueResponse: OK_RESPONSE });
  assert.ok(run.names.includes("activateV2Credential"), "V2を有効化すること");
  assert.ok(!run.names.includes("generatePrivateKey"), "legacyキーを作らないこと");
  assert.equal(run.store.has(SYNC_ID_KEY), false, "legacyキーを保存しないこと");
  assert.ok(run.names.includes("connectWordsnapSync"), "同期を開始すること");
  assert.ok(run.names.includes("recordVerifiedSync"), "保管を促せるよう検証済みにすること");
});

test("発行した資格情報にはネイティブ印が付く", async () => {
  // 印が無いと isV2Native が永久に false のままになり、次回起動で余計なlegacyキーが
  // 生えて「個人リンク」が空の部屋を指し、引き継ぎコードの保管催促も出なくなる。
  const run = await makeInit({ issueAllowed: true, issueResponse: OK_RESPONSE });
  const stored = JSON.parse(run.store.get("wordsnap-sync-credential:v2"));
  assert.equal(stored.status, "active");
  assert.equal(stored.provenance, "native-default:v1", "ネイティブ印が付くこと");
  assert.equal(run.context.syncRequestRoute().isV2Native, true, "ネイティブとして扱われること");
});

test("発行した端末を次に起動しても、余計なlegacyキーが生えない", async () => {
  const first = await makeInit({ issueAllowed: true, issueResponse: OK_RESPONSE });
  const credential = JSON.parse(first.store.get("wordsnap-sync-credential:v2"));
  // 発行済みの状態から起動し直す
  const second = await makeInit({ v2RoomId: credential.roomId, issueAllowed: true, issueResponse: OK_RESPONSE });
  assert.ok(!second.names.includes("generatePrivateKey"), "legacyキーを作らないこと");
  assert.equal(second.store.has(SYNC_ID_KEY), false, "legacyキーを保存しないこと");
  assert.ok(!second.names.includes("v2Fetch"), "二重に発行しないこと");
  assert.ok(!second.names.includes("rememberSyncIdInUrl"), "空のlegacy部屋をURLに載せないこと");
});

test("claim取得後の再確認で他タブに負けたら、通信の前に降りる", async () => {
  const run = await makeInit({
    issueAllowed: true,
    blockAfterAcquire: true,
    issueResponse: OK_RESPONSE,
  });
  assert.ok(run.names.includes("acquireIdentityClaim"), "claimは取ること");
  assert.ok(!run.names.includes("v2Fetch"), "再確認で降りて通信しないこと");
  assert.ok(!run.names.includes("writeV2Credential"), "資格情報も書かないこと");
  assert.ok(run.names.includes("releaseIdentityClaim"), "claimは解放すること");
  assert.equal(run.syncState.id, GENERATED, "legacyへ着地すること");
});

test("展開が止まっている間は無言でlegacyへ倒れ、再試行しない（本番の現状）", async () => {
  const run = await makeInit({
    issueAllowed: true,
    issueResponse: { status: 403, body: { error: "native default disabled", code: "native-default-disabled" } },
  });
  assert.equal(run.syncState.id, GENERATED, "legacyへ着地すること");
  assert.equal(run.store.get(SYNC_ID_KEY), GENERATED);
  assert.equal(run.names.filter((n) => n === "v2Fetch").length, 1, "再試行しないこと");
  assert.ok(run.names.includes("removePendingV2Credential"), "pendingを破棄すること");
  assert.equal(run.store.has("wordsnap-sync-credential:v2"), false, "資格情報を残さないこと");
  assert.ok(run.names.includes("connectWordsnapSync"));
  // 拒否をユーザーに見せない（本人は何も頼んでいない）
  assert.ok(!run.status.join("\n").includes("エラー"));
});

test("どんな応答でもlegacyへ着地する", async () => {
  const cases = [
    { status: 403, body: { error: "forbidden" } },     // 一般の403（room衝突）
    { status: 409, body: { code: "room-taken" } },
    { status: 413, body: {} },
    { status: 422, body: {} },
    { status: 429, body: { code: "rate-limited" } },
    { status: 500, body: {} },
    { status: 503, body: {} },
    { status: 200, body: {} },                          // 応答が検証を通らない
    { status: 200, body: { ok: true, syncId: "別の保存先" } },
  ];
  for (const issueResponse of cases) {
    const run = await makeInit({ issueAllowed: true, issueResponse });
    const label = JSON.stringify(issueResponse);
    assert.equal(run.syncState.id, GENERATED, `legacyへ着地すること: ${label}`);
    assert.ok(!run.names.includes("activateV2Credential"), `有効化しないこと: ${label}`);
    assert.ok(run.names.includes("connectWordsnapSync"), `同期を開始すること: ${label}`);
    assert.equal(run.store.has("wordsnap-sync-credential:v2"), false, `資格情報を残さないこと: ${label}`);
  }
});

test("通信断・タイムアウトでもlegacyへ着地する", async () => {
  for (const issueResponse of ["network", "timeout"]) {
    const run = await makeInit({ issueAllowed: true, issueResponse });
    assert.equal(run.syncState.id, GENERATED, issueResponse);
    assert.ok(run.names.includes("connectWordsnapSync"), issueResponse);
    assert.equal(run.store.has("wordsnap-sync-credential:v2"), false, issueResponse);
  }
});

test("発行には短い上限を渡す（起動画面を60秒待たせない）", async () => {
  const run = await makeInit({ issueAllowed: true, issueResponse: OK_RESPONSE });
  const call = run.trace.find((e) => e[0] === "v2Fetch");
  assert.ok(call, "発行リクエストを投げること");
  assert.match(call[1], /create=1&native=1/, "native発行として投げること");
  assert.ok(Number(call[2]) > 0 && Number(call[2]) <= 15000, `上限が短いこと（${call[2]}ms）`);
});

test("回復バリアが確定していなければ発行を試みない（4秒フォールバックの状態）", async () => {
  const run = await makeInit({ issueAllowed: false, issueResponse: OK_RESPONSE });
  assert.ok(!run.names.includes("v2Fetch"), "通信しないこと");
  assert.ok(!run.names.includes("acquireIdentityClaim"), "claimも取らないこと");
  assert.equal(run.syncState.id, GENERATED, "legacyへ着地すること");
});

test("claimを取れなければ発行せず、legacyへ着地する", async () => {
  const run = await makeInit({ issueAllowed: true, claimAvailable: false, issueResponse: OK_RESPONSE });
  assert.ok(!run.names.includes("v2Fetch"), "通信しないこと");
  assert.equal(run.syncState.id, GENERATED);
  assert.ok(run.names.includes("connectWordsnapSync"));
});


test("応答待ちの間に別タブがidentityを確定したら、後出しで上書きしない", async () => {
  const run = await makeInit({
    issueAllowed: true,
    issueResponse: OK_RESPONSE,
    credentialAppearsDuringIssue: true,
  });
  assert.ok(!run.names.includes("activateV2Credential"), "V2を有効化しないこと");
  assert.ok(!run.names.includes("generatePrivateKey"), "新しいlegacyキーを作らないこと");
  assert.equal(run.store.get(SYNC_ID_KEY), LEGACY_B, "別タブが決めたキーを残すこと");
  assert.equal(run.syncState.id, LEGACY_B, "それに合流すること");
  assert.ok(run.names.includes("connectWordsnapSync"));
});

test("応答待ちの間に別タブがV2を確定したら、legacyキーを足さない", async () => {
  const run = await makeInit({
    issueAllowed: true,
    issueResponse: { status: 500, body: {} },
    v2CredentialAppearsDuringIssue: true,
  });
  assert.ok(!run.names.includes("generatePrivateKey"), "legacyキーを作らないこと");
  assert.equal(run.store.has(SYNC_ID_KEY), false, "legacyキーを保存しないこと");
});

test("フォールバック中に予期しない例外が起きても、必ず着地して接続まで進む", async () => {
  // 着地保証の最後の砦。ここが抜けると新規ユーザーが同期の無いまま取り残される。
  const run = await makeInit({
    issueAllowed: true,
    issueResponse: { status: 403, body: {} },
    fallbackThrows: true,
  });
  assert.equal(run.syncState.id, GENERATED, "最後の手段でlegacyを発行すること");
  assert.ok(run.names.includes("applySyncIdentityUi"), "UIへ反映すること");
  assert.ok(run.names.includes("connectWordsnapSync"), "同期を開始すること");
});

test("バリア確定後に資格情報の痕跡が現れたら、発行しない", async () => {
  // 別タブがバリア確定の直後に書いた場合。壊れたレコードでも「保存あり」として扱う
  // （rawキーの不在でしか「資格情報なし」と判断しない）。
  const run = await makeInit({
    issueAllowed: true,
    rawV2CredentialPresent: true,
    issueResponse: OK_RESPONSE,
  });
  assert.ok(!run.names.includes("v2Fetch"), "通信しないこと");
  assert.ok(!run.names.includes("writeV2Credential"), "資格情報を上書きしないこと");
  assert.equal(run.store.get("wordsnap-sync-credential:v2"), "{壊れている", "痕跡を消さないこと");
  assert.equal(run.syncState.id, GENERATED, "legacyへ着地すること");
});

test("展開停止の拒否は、一般の403より先に確定させる（再試行を生やさせない）", async () => {
  // 挙動では区別できない（どちらもcatch-allでlegacyへ倒れる）。区別が要るのは
  // 将来ここに一般403のリトライを足したときで、その時に順序が逆だと
  // フラグ未設定の間ずっと無駄な再試行が走る。順序を構造として固定しておく。
  const issue = html.slice(
    html.indexOf("async function issueV2NativeCredential"),
    html.indexOf("async function bootstrapNewUserIdentity"),
  );
  const nativeDenied = issue.indexOf('data?.code === "native-default-disabled"');
  const success = issue.indexOf("response.status === 200");
  assert.ok(nativeDenied >= 0, "codeまで見て判定すること");
  assert.ok(nativeDenied < success, "他のstatus処理より先に判定すること");
  assert.doesNotMatch(issue, /for \(let attempt/, "再試行ループを持たないこと");
  assert.equal((issue.match(/v2Fetch\(/g) || []).length, 1, "1回しか投げないこと");
});

test("UI反映が失敗しても、同期の開始まで到達する", async () => {
  // 表示が古いだけなら再描画で直るが、同期が始まらないとサーバー保存も
  // 端末間の引き継ぎも効かない。着地保証で優先すべきは接続のほう。
  const run = await makeInit({
    issueAllowed: true,
    issueResponse: { status: 403, body: { code: "native-default-disabled" } },
    uiApplyThrows: true,
  });
  assert.equal(run.syncState.id, GENERATED, "identityは確立していること");
  assert.ok(run.names.includes("connectWordsnapSync"), "同期を開始すること");
});

test("既存ユーザーには自動発行を試みない", async () => {
  for (const opts of [{ storedSyncId: LEGACY_A }, { v2RoomId: ROOM_ID }]) {
    const run = await makeInit({ ...opts, issueAllowed: true, issueResponse: OK_RESPONSE });
    assert.ok(!run.names.includes("v2Fetch"), JSON.stringify(opts));
    assert.ok(!run.names.includes("acquireIdentityClaim"), JSON.stringify(opts));
  }
});

test("成否によらず、claimは必ず解放される", async () => {
  for (const issueResponse of [OK_RESPONSE, { status: 403, body: {} }, "network", "timeout"]) {
    const run = await makeInit({ issueAllowed: true, issueResponse });
    assert.ok(
      run.names.includes("releaseIdentityClaim"),
      `解放すること: ${JSON.stringify(issueResponse)}`,
    );
  }
});

test("発行の結果が出てからUIへ反映し、そのあとで接続する", async () => {
  const run = await makeInit({ issueAllowed: true, issueResponse: OK_RESPONSE });
  const fetched = run.names.indexOf("v2Fetch");
  const applied = run.names.lastIndexOf("applySyncIdentityUi");
  const connected = run.names.indexOf("connectWordsnapSync");
  assert.ok(fetched >= 0 && applied > fetched, "発行→UI反映の順であること");
  assert.ok(connected > applied, "UI反映→接続の順であること");
});

// catch-all は失敗を legacy へ倒すためのものだが、単純な打ち間違い（未定義の定数・
// 関数名）まで飲み込んで「静かにlegacyへ倒れる」に化ける。実際にこの経路で
// SYNC_V2_NATIVE_PROVENANCE の参照ミスを一度作り込んだ。機械的に潰しておく。
test("発行経路が参照する定数・関数は、すべてこのファイル内で定義されている", () => {
  const raw = html.slice(
    html.indexOf("async function issueV2NativeCredential"),
    html.indexOf("\nfunction initWordsnapSync"),
  );
  assert.ok(raw.length > 0);
  // コメントと文字列リテラルは対象外（日本語コメント中の英単語を拾わないため）
  const region = raw
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/'[^'\n]*'/g, " ");
  const BUILTINS = new Set([
    "String", "Number", "Boolean", "Math", "JSON", "Object", "Array", "Promise", "Date", "Error",
    "if", "for", "while", "switch", "catch",
  ]);
  const referenced = new Set();
  // メソッド呼び出し（直前が `.`）は除く＝このファイルで定義された自由関数だけを見る
  for (const m of region.matchAll(/(^|[^.\w$])([a-z][A-Za-z0-9_$]*)\s*\(/g)) referenced.add(m[2]);
  for (const m of region.matchAll(/(^|[^.\w$])([A-Z][A-Z0-9_]{2,})\b/g)) referenced.add(m[2]);

  const missing = [];
  for (const name of referenced) {
    if (BUILTINS.has(name)) continue;
    const defined =
      new RegExp(`(?:const|let|var)\\s+${name}\\b`).test(html) ||
      new RegExp(`(?:async )?function ${name}\\b`).test(html) ||
      new RegExp(`\\b${name}\\s*[:=]\\s*(?:async\\s*)?(?:\\(|function)`).test(html);
    if (!defined) missing.push(name);
  }
  assert.deepEqual(missing.sort(), [], `発行経路で未定義の識別子を参照している: ${missing.join(", ")}`);
});

test("発行経路は1つで、他から呼ばれない", async () => {
  assert.equal((html.match(/create=1&native=1/g) || []).length, 1);
  assert.equal((html.match(/issueV2NativeCredential\(/g) || []).length, 2, "定義と呼び出しが1つずつ");
  const bootstrap = sourceBetween("async function bootstrapNewUserIdentity", "\nfunction initWordsnapSync");
  assert.match(bootstrap, /issueV2NativeCredential\(\)/, "bootstrapからのみ呼ぶこと");
  // 着地保証: 発行しなかったすべての枝で identity を確立する
  assert.match(bootstrap, /establishLegacyIdentity\(\)/);
  assert.match(bootstrap, /startSyncWithEstablishedIdentity\(/, "必ず出口を通ること");
});
