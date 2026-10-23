// パスキーで控える（Phase C、1.0.141）のクライアント側。設計書: docs/DESIGN-2026-10-21-account-recovery.md
//
// 公開HTMLの実コードを切り出して走らせる（通信・描画・WebAuthn だけを差し替える）。
//   - 不変条件 6: 非対応環境では要素・保存キー・通信が増えない
//   - 不変条件 3: adoptV2Room の onBeforeReplace が置換前に必ず呼ばれ、「やめる」で何も変わらない。「採用」でも PUT は 1 回
//   - §6.2: appendLocalWords は復旧先を変えず、端末だけの語を新しい単語帳へ足す。409 の再送でも同じ
//   - 退避 JSON を既存の JSON 取り込みが受け付けない
//   - §7.1: 帯を隠す条件（7 日・503・unlink）と、V2_CODE_SAVED_KEY に書かないこと
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

function extractFunction(name) {
  const found = html.indexOf(`\nfunction ${name}(`) >= 0
    ? html.indexOf(`\nfunction ${name}(`) + 1
    : html.indexOf(`\nasync function ${name}(`) + 7;
  assert.ok(found > 6, `function ${name} が見つかること`);
  const start = html.slice(found - 6, found) === "async " ? found - 6 : found;
  let paren = 0;
  let i = html.indexOf("(", found);
  for (; i < html.length; i += 1) {
    if (html[i] === "(") paren += 1;
    else if (html[i] === ")" && --paren === 0) break;
  }
  const bodyBrace = html.indexOf("{", i);
  let depth = 0;
  for (let k = bodyBrace; k < html.length; k += 1) {
    if (html[k] === "{") depth += 1;
    else if (html[k] === "}" && --depth === 0) return html.slice(start, k + 1);
  }
  throw new Error(`unbalanced braces for ${name}`);
}

function extractConst(name) {
  const line = new RegExp(`^const ${name} = .*;`, "m").exec(html);
  assert.ok(line, `const ${name} が見つかること`);
  return line[0];
}

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  const writes = [];
  return {
    store,
    writes,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { writes.push(["set", k]); store.set(k, String(v)); },
    removeItem: (k) => { writes.push(["remove", k]); store.delete(k); },
  };
}

// vm の別 realm の配列・オブジェクトは deepStrictEqual で型が合わないので、比べる前に素の値へ戻す
const plain = (value) => JSON.parse(JSON.stringify(value));

function run(ctx, sources) {
  vm.createContext(ctx);
  vm.runInContext(sources.join("\n"), ctx);
  return ctx;
}

const ROOM_A = `wr_${"a".repeat(32)}`;
const ROOM_B = `wr_${"b".repeat(32)}`;
const SECRET = `wk_${"1".repeat(60)}`;
const DAY = 24 * 60 * 60 * 1000;

const word = (id, term, deckId, extra = {}) => ({
  id, term, meaning: `${term}の意味`, deckId, addedAt: "2026-01-01T00:00:00.000Z",
  stats: { correct: 3, wrong: 1 }, history: [{ at: "2026-02-01T00:00:00.000Z", correct: true }],
  learning: { status: "review", srsStage: 2 }, ...extra,
});

// ---- 不変条件 6: 非対応環境では何も増えない ----

function passkeyInitSandbox({ publicKeyCredential, uvpaa = true } = {}) {
  const created = [];
  const fetched = [];
  const localStorage = memoryStorage({ existing: "1" });
  const ctx = {
    localStorage,
    navigator: { credentials: { create() {}, get() {} } },
    window: { location: { protocol: "https:" } },
    document: { createElement: (tag) => { created.push(tag); return fakeNode(); }, body: fakeNode() },
    fetch: (url) => { fetched.push(url); return Promise.reject(new Error("no")); },
    elements: { syncV2Section: { after() {} }, recoveryPromptRestoreButton: { before() {} } },
    syncServerAvailable: () => true,
  };
  if (publicKeyCredential) {
    ctx.PublicKeyCredential = function PublicKeyCredential() {};
    ctx.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => uvpaa;
  }
  run(ctx, [
    extractFunction("passkeySupported"),
    "function buildPasskeySection() { document.createElement('details'); }",
    "function addRecoveryPromptPasskeyButton() { document.createElement('button'); }",
    extractFunction("initPasskeyUi"),
  ]);
  return { ctx, created, fetched, localStorage };
}

function fakeNode() {
  return { append() {}, after() {}, before() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
}

test("不変条件6: PublicKeyCredential が無い環境では、要素・localStorage・通信のどれも増えない", async () => {
  for (const env of [{}, { publicKeyCredential: true, uvpaa: false }]) {
    const { ctx, created, fetched, localStorage } = passkeyInitSandbox(env);
    assert.equal(await ctx.initPasskeyUi(), false);
    assert.deepEqual(created, [], "DOM を足さない");
    assert.deepEqual(fetched, [], "サーバーのフラグを探りに行かない");
    assert.deepEqual(localStorage.writes, [], "保存キー集合を変えない");
    assert.deepEqual([...localStorage.store.keys()], ["existing"]);
  }
  const supported = passkeyInitSandbox({ publicKeyCredential: true, uvpaa: true });
  assert.equal(await supported.ctx.initPasskeyUi(), true);
  assert.deepEqual(supported.created, ["details", "button"], "対応環境でだけ節とボタンを足す");
  assert.deepEqual(supported.fetched, [], "対応環境でも開いただけでは通信しない");
  assert.deepEqual(supported.localStorage.writes, []);
});

test("不変条件6: 静的なHTMLにはパスキーの要素を置かない（非対応環境の表示要素数は変更前と同一）", () => {
  const withoutScripts = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "");
  assert.doesNotMatch(withoutScripts, /passkey/i);
  assert.doesNotMatch(withoutScripts, /パスキーで(控える|復元)/);
  // 初期化は対応判定のあと。initV2SyncUi の末尾から呼ぶ（起動処理の順序は変えない）
  assert.match(extractFunction("initV2SyncUi"), /initPasskeyUi\(\);\n\}$/);
  assert.match(extractFunction("initPasskeyUi"), /if \(!\(await passkeySupported\(\)\)\) return false;\n\s*buildPasskeySection\(\);/);
});

// ---- adoptV2Room と 3 択（不変条件 3）----

function fakeIdb() {
  const store = new Map();
  return {
    store,
    fail: false,
    async set(k, v) { if (this.fail) return false; store.set(k, v); return true; },
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async delete(k) { store.delete(k); return true; },
  };
}

// 復旧の UI ロックが止める対象の代役（data-step-panel の中のボタン 2 つ。1 つは元から無効）
function fakeDocument() {
  const controls = [{ disabled: false }, { disabled: true }];
  const attrs = new Map();
  return {
    controls,
    querySelectorAll: () => controls,
    body: {
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      setAttribute: (k, v) => attrs.set(k, String(v)),
      removeAttribute: (k) => attrs.delete(k),
    },
  };
}

function adoptSandbox({ localWords = [], localTrash = [], remoteState, choose = async () => null, putStatus = 200 }) {
  const calls = [];
  const requests = [];
  let rev = 7;
  const ctx = {
    calls,
    requests,
    idb: fakeIdb(),
    document: fakeDocument(),
    appState: { words: localWords.map((w) => ({ ...w })), decks: [{ id: "l1", name: "単語帳1" }], deletions: {}, trash: localTrash },
    elements: { syncV2JoinInput: { value: "" } },
    syncState: { applyingRemote: false, dirtyGen: 0, syncedGen: 0 },
    stopSyncPolling: () => calls.push(["stopPolling"]),
    startSyncPolling: () => calls.push(["startPolling"]),
    bumpSyncRequestGen: () => calls.push(["bumpGen"]),
    syncServerAvailable: () => true,
    normalizeStreak: (v) => v || null,
    getActiveV2Credential: () => ({ roomId: ROOM_A, secret: SECRET }),
    setPasskeyStatus: (m, mode) => calls.push(["passkeyStatus", m, mode || ""]),
    pushWordsnapState: () => calls.push(["push"]),
    setV2Busy: () => {},
    setV2Status: (m) => calls.push(["status", m]),
    v2SyncEndpoint: (roomId) => `/api/wordsnap-state?room=${roomId}`,
    v2Fetch: async (url, options) => {
      requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      if (options.method === "GET") return { status: 200, json: async () => ({ syncId: ROOM_A, stateRev: rev, state: remoteState }) };
      if (putStatus !== 200) return { status: putStatus, json: async () => ({}) };
      rev += 1;
      return { status: 200, json: async () => ({ ok: true, syncId: ROOM_A, stateRev: rev }) };
    },
    readJsonResponse: async (response) => response.json(),
    cleanSyncId: (v) => String(v || ""),
    snapshotState: () => JSON.parse(JSON.stringify(ctx.appState)),
    activateV2Credential: (credential, stateRev) => { calls.push(["activate", credential.roomId, stateRev]); return credential; },
    normalizeState: (s) => JSON.parse(JSON.stringify(s)),
    defaultState: () => ({ words: [], decks: [{ id: "d0", name: "単語帳1" }], deletions: {}, trash: [] }),
    invalidatePersonalFactorCache: () => {},
    currentQuiz: null,
    selectedIds: new Set(),
    persistAppState: () => calls.push(["persist"]),
    offerUndo: () => calls.push(["offerUndo"]),
    clearUndo: () => calls.push(["clearUndo"]),
    recordVerifiedSync: () => {},
    setV2JoinUndoVisible: () => {},
    renderAll: () => {},
    renderV2CredentialUi: () => {},
    syncStateExceedsLimits: () => false,
    syncShouldCompress: () => false,
    localStorage: memoryStorage(),
    localDateString: () => "2026-10-23",
    choose: async (opts) => { calls.push(["choose", opts.choices.map((c) => c.value)]); return choose(opts); },
  };
  run(ctx, [
    extractConst("RECOVERY_PUT_MAX_ATTEMPTS"),
    extractConst("RECOVERY_BACKUP_KEY"),
    extractConst("RECOVERY_BACKUP_KIND"),
    extractConst("RECOVERY_BACKUP_TTL_MS"),
    extractConst("UNDO_EPOCH_KEY"),
    extractConst("SYNC_GZ_BASE64_LIMIT"),
    "let recoveryGeneration = 0;",
    extractFunction("stateSignature"),
    extractFunction("readUndoEpoch"),
    extractFunction("advanceUndoEpoch"),
    extractFunction("lockUiForRecovery"),
    extractFunction("restoreUiAfterRecovery"),
    extractFunction("beginRecoveryCommit"),
    extractFunction("hasLocalContent"),
    extractFunction("parseRecoveryBackup"),
    extractFunction("readRecoveryBackup"),
    extractFunction("deleteRecoveryBackup"),
    extractFunction("appendBackupWords"),
    extractFunction("validSyncGetResponse"),
    extractFunction("validSyncPutResponse"),
    extractFunction("normalizeTerm"),
    extractFunction("createId"),
    extractFunction("wordAddedMs"),
    extractFunction("revivedAddedAtIso"),
    extractFunction("appendLocalWords"),
    extractFunction("recoveryRoomRequest"),
    extractFunction("recoveryPutBody"),
    extractFunction("commitRecoveryAppend"),
    extractFunction("saveRecoveryBackup"),
    extractFunction("recoveryBeforeReplace"),
    extractFunction("adoptV2Room"),
    "globalThis.__generation = () => recoveryGeneration;",
  ]);
  return ctx;
}

const CREDENTIAL = { v: 2, status: "pending", roomId: ROOM_A, secret: SECRET, origin: "" };
const REMOTE = () => ({ words: [word("r1", "apple", "rd")], decks: [{ id: "rd", name: "英単語" }], deletions: {}, trash: [] });

test("adoptV2Room: onBeforeReplace は置換前に必ず呼ばれ、null なら何も変えない", async () => {
  const ctx = adoptSandbox({ localWords: [word("l1", "zebra", "l1")], remoteState: REMOTE() });
  let seen = null;
  const before = JSON.stringify(ctx.appState);
  const result = await ctx.adoptV2Room(CREDENTIAL, { onBeforeReplace: async (remote) => { seen = remote; return null; } });
  assert.equal(result, null);
  assert.equal(seen.syncId, ROOM_A, "取得した remote を渡す");
  assert.equal(JSON.stringify(ctx.appState), before, "端末の内容を変えない");
  assert.deepEqual(ctx.calls.filter(([k]) => ["activate", "persist", "offerUndo", "clearUndo"].includes(k)), []);
});

test("復旧: 端末に語があれば 3 択を出し、「やめる」なら送信も切替もしない", async () => {
  const ctx = adoptSandbox({ localWords: [word("l1", "zebra", "l1")], remoteState: REMOTE(), choose: async () => null });
  const outcome = {};
  const before = JSON.stringify(ctx.appState);
  await ctx.adoptV2Room(CREDENTIAL, { onBeforeReplace: ctx.recoveryBeforeReplace(CREDENTIAL, outcome, ctx.choose) });
  assert.deepEqual(plain(ctx.calls.find(([k]) => k === "choose")[1]), ["replace", "append", null]);
  assert.equal(outcome.value, "cancel");
  assert.equal(JSON.stringify(ctx.appState), before);
  assert.deepEqual(ctx.requests.map((r) => r.method), ["GET"], "PUT しない");
  assert.equal(ctx.idb.store.size, 0, "やめたら退避も作らない");
  assert.ok(!ctx.calls.some(([k]) => k === "stopPolling"), "やめたら通常同期も止めない");
  assert.ok(!ctx.calls.some(([k]) => k === "activate"));
});

test("復旧: 「採用」でも PUT を 1 回行って rev を進め、Undo は作らず消す。置換前は退避する", async () => {
  const ctx = adoptSandbox({ localWords: [word("l1", "zebra", "l1")], remoteState: REMOTE(), choose: async () => "replace" });
  const outcome = {};
  await ctx.adoptV2Room(CREDENTIAL, { onBeforeReplace: ctx.recoveryBeforeReplace(CREDENTIAL, outcome, ctx.choose) });
  assert.equal(outcome.value, "ok");
  assert.deepEqual(ctx.requests.map((r) => r.method), ["GET", "GET", "PUT"]);
  assert.equal(ctx.requests[2].body.baseRev, 7);
  assert.deepEqual(plain(ctx.requests[2].body.state.words.map((w) => w.term)), ["apple"], "採用は復旧先そのまま");
  assert.deepEqual(plain(ctx.calls.find(([k]) => k === "activate")), ["activate", ROOM_A, 8], "PUT 後の rev で切り替える");
  assert.ok(ctx.calls.some(([k]) => k === "clearUndo"));
  assert.ok(!ctx.calls.some(([k]) => k === "offerUndo"), "復旧では Undo を作らない");
  assert.deepEqual(plain(ctx.appState.words.map((w) => w.term)), ["apple"]);
  assert.ok(ctx.calls.some(([k]) => k === "stopPolling") && ctx.calls.some(([k]) => k === "bumpGen"), "送信の前に通常同期を止める");
  assert.equal(ctx.document.controls[0].disabled, true, "置換まで UI を止めたまま（戻すのは呼び出し側）");
  ctx.restoreUiAfterRecovery(outcome.lock);
  assert.deepEqual(ctx.document.controls.map((c) => c.disabled), [false, true], "元の押せる状態へ戻す");
  assert.equal(ctx.localStorage.getItem("wordsnap-undo-epoch:v1"), "1", "Undo 世代を進める");
  assert.equal(ctx.__generation(), 1, "復旧世代を進める");
  assert.equal(ctx.localStorage.getItem("wordsnap-recovery-backup:v1"), null, "退避は localStorage に置かない");
  const backup = JSON.parse(ctx.idb.store.get("wordsnap-recovery-backup:v1"));
  assert.equal(backup.kind, "wordsnap-recovery-backup");
  assert.deepEqual(plain(backup.state.words.map((w) => w.term)), ["zebra"]);
});

test("復旧: 端末が空なら 3 択を出さずに採用し、それでも PUT は 1 回", async () => {
  const ctx = adoptSandbox({ localWords: [], remoteState: REMOTE() });
  const outcome = {};
  await ctx.adoptV2Room(CREDENTIAL, { onBeforeReplace: ctx.recoveryBeforeReplace(CREDENTIAL, outcome, ctx.choose) });
  assert.ok(!ctx.calls.some(([k]) => k === "choose"));
  assert.equal(ctx.requests.filter((r) => r.method === "PUT").length, 1);
  assert.equal(ctx.idb.store.size, 0, "0 語は退避しない");
});

test("復旧: 保存に失敗したら切り替えない（退避は残す）", async () => {
  const ctx = adoptSandbox({ localWords: [word("l1", "zebra", "l1")], remoteState: REMOTE(), choose: async () => "append", putStatus: 500 });
  const outcome = {};
  const before = JSON.stringify(ctx.appState);
  await ctx.adoptV2Room(CREDENTIAL, { onBeforeReplace: ctx.recoveryBeforeReplace(CREDENTIAL, outcome, ctx.choose) });
  assert.equal(outcome.value, "fail");
  assert.equal(JSON.stringify(ctx.appState), before);
  assert.ok(!ctx.calls.some(([k]) => k === "activate"));
  assert.ok(ctx.idb.store.has("wordsnap-recovery-backup:v1"));
});

test("復旧: 語が 0 でもゴミ箱があれば 3 択を出して退避する", async () => {
  const trash = [{ id: "t1", word: word("y", "yacht", "l1"), deletedAt: Date.now() }];
  const ctx = adoptSandbox({ localWords: [], localTrash: trash, remoteState: REMOTE(), choose: async () => "replace" });
  const outcome = {};
  await ctx.adoptV2Room(CREDENTIAL, { onBeforeReplace: ctx.recoveryBeforeReplace(CREDENTIAL, outcome, ctx.choose) });
  assert.ok(ctx.calls.some(([k]) => k === "choose"));
  assert.equal(JSON.parse(ctx.idb.store.get("wordsnap-recovery-backup:v1")).state.trash.length, 1);
});

test("復旧: 退避を書けなければ（IndexedDB 不可）送信も切替もせずに中止する", async () => {
  const ctx = adoptSandbox({ localWords: [word("l1", "zebra", "l1")], remoteState: REMOTE(), choose: async () => "replace" });
  ctx.idb.fail = true;
  const outcome = {};
  await ctx.adoptV2Room(CREDENTIAL, { onBeforeReplace: ctx.recoveryBeforeReplace(CREDENTIAL, outcome, ctx.choose) });
  assert.equal(outcome.value, "fail");
  assert.deepEqual(ctx.requests.map((r) => r.method), ["GET"]);
  assert.ok(!ctx.calls.some(([k]) => k === "activate"));
});

test("復旧: 送信の間に端末の内容が変わったら置き換えない", async () => {
  const ctx = adoptSandbox({ localWords: [word("l1", "zebra", "l1")], remoteState: REMOTE(), choose: async () => "append" });
  const original = ctx.v2Fetch;
  ctx.v2Fetch = async (url, options) => {
    if (options.method === "PUT") ctx.appState.words.push(word("l2", "late", "l1"));
    return original(url, options);
  };
  const outcome = {};
  await ctx.adoptV2Room(CREDENTIAL, { onBeforeReplace: ctx.recoveryBeforeReplace(CREDENTIAL, outcome, ctx.choose) });
  assert.equal(outcome.value, "fail");
  assert.ok(!ctx.calls.some(([k]) => k === "activate"));
  assert.ok(ctx.appState.words.some((w) => w.term === "late"), "途中の変更を消さない");
});

// ---- 退避の単語を追加（appendBackupWords）----

test("退避の追加: 未送信の変更があれば始めず、通常の送信を先に促す", async () => {
  for (const patch of [{ dirtyGen: 3, syncedGen: 2 }, { retryTimer: 5 }, { pushTimer: 1 }, { pushing: true }]) {
    const ctx = adoptSandbox({ localWords: [word("l1", "zebra", "l1")], remoteState: REMOTE() });
    Object.assign(ctx.syncState, patch);
    assert.equal(await ctx.appendBackupWords([word("b", "backup", "x")]), false, JSON.stringify(patch));
    assert.deepEqual(ctx.requests, [], "送信しない");
    assert.match(ctx.calls.find(([k]) => k === "passkeyStatus")[1], /先に同期を完了/);
  }
});

test("退避の追加: 送信の間に端末の内容が変わったら置き換えず、退避を残す", async () => {
  const ctx = adoptSandbox({ localWords: [word("l1", "zebra", "l1")], remoteState: REMOTE() });
  await ctx.idb.set("wordsnap-recovery-backup:v1", JSON.stringify({ kind: "wordsnap-recovery-backup", savedAt: Date.now(), state: { words: [] } }));
  const original = ctx.v2Fetch;
  ctx.v2Fetch = async (url, options) => {
    if (options.method === "PUT") ctx.appState.words.push(word("l2", "late", "l1"));
    return original(url, options);
  };
  assert.equal(await ctx.appendBackupWords([word("b", "backup", "x")]), false);
  assert.ok(ctx.appState.words.some((w) => w.term === "late"), "途中の変更を消さない");
  assert.ok(ctx.idb.store.has("wordsnap-recovery-backup:v1"), "退避は残す");
  assert.deepEqual(ctx.document.controls.map((c) => c.disabled), [false, true], "UI のロックは戻す");
});

test("退避の追加: 成功したら appendLocalWords の規則で足し、退避を消し、UI を戻す", async () => {
  const ctx = adoptSandbox({ localWords: [word("r1", "apple", "rd")], remoteState: REMOTE() });
  await ctx.idb.set("wordsnap-recovery-backup:v1", JSON.stringify({ kind: "wordsnap-recovery-backup", savedAt: Date.now(), state: { words: [] } }));
  assert.equal(await ctx.appendBackupWords([word("b", "backup", "x"), word("a", "Apple", "x")]), true);
  assert.deepEqual(plain(ctx.appState.words.map((w) => w.term)), ["apple", "backup"]);
  assert.equal(ctx.idb.store.has("wordsnap-recovery-backup:v1"), false, "退避を消す");
  assert.ok(ctx.calls.some(([k]) => k === "clearUndo"));
  assert.ok(ctx.calls.some(([k]) => k === "stopPolling") && ctx.calls.some(([k]) => k === "startPolling"));
  assert.deepEqual(ctx.document.controls.map((c) => c.disabled), [false, true]);
});

test("退避: 30 日を過ぎたら読まずに消す", async () => {
  const ctx = adoptSandbox({ remoteState: null });
  await ctx.idb.set("wordsnap-recovery-backup:v1", JSON.stringify({ kind: "wordsnap-recovery-backup", savedAt: Date.now() - 31 * DAY, state: { words: [] } }));
  assert.equal(await ctx.readRecoveryBackup(), null);
  assert.equal(ctx.idb.store.size, 0);
});

test("joinV2Room は入力欄を読んで adoptV2Room を呼ぶだけ（復旧は入力欄に秘密を書かない）", () => {
  assert.match(extractFunction("joinV2Room"), /return adoptV2Room\(credential\);\n\}$/);
  const recover = extractFunction("recoverWithPasskey");
  assert.doesNotMatch(recover, /syncV2JoinInput/);
  assert.match(recover, /v2RecoveryBarrierStatus\(\) === "pending"/, "起動時の確認が済むまで復旧しない");
  assert.ok(recover.indexOf('acquireIdentityClaim("recover")') < recover.indexOf("adoptV2Room("), "claim を取ってから合流する");
  assert.match(recover, /releaseIdentityClaim\(claimToken\)/);
  assert.match(recover, /undoSuspended = true;[\s\S]*undoSuspended = false;/, "復旧中は Undo を止める");
});

// ---- appendLocalWords（§6.2）----

test("appendLocalWords: 端末の削除記録 X・ゴミ箱 Y・同名に改名した単語帳があっても、復旧先は一切変わらず Z だけが新しい単語帳に入る", () => {
  const ctx = adoptSandbox({ remoteState: null });
  const remote = {
    words: [word("rx", "X", "r1"), word("ry", "Y", "r1")],
    decks: [{ id: "r1", name: "英単語", updatedAt: 1 }],
    deletions: { "r1 old": 1700000000000 },
    trash: [{ id: "t", word: word("ro", "old", "r1"), deletedAt: 1700000000000 }],
    aiSecrets: { v: 1 },
  };
  const remoteBefore = JSON.stringify(remote);
  const local = [
    word("lz", "Z", "l1", { stats: { correct: 9, wrong: 2 }, enrich: { examples: ["e"] } }),
    word("lx", "x ", "l1"),
  ];
  const { state, addedCount } = ctx.appendLocalWords(remote, local, "2026-10-23");
  assert.equal(JSON.stringify(remote), remoteBefore, "入力の remote を書き換えない");
  assert.equal(addedCount, 1);
  assert.deepEqual(plain(state.words.slice(0, 2)), remote.words, "復旧先の X・Y はそのまま残る");
  assert.deepEqual(plain(state.decks.slice(0, 1)), remote.decks, "復旧先の単語帳は変えない");
  assert.equal(state.deletions, remote.deletions, "削除記録は復旧先のまま");
  assert.equal(state.trash, remote.trash, "ゴミ箱は復旧先のまま");
  assert.equal(state.aiSecrets, remote.aiSecrets, "そのほかの項目も変えない");
  const deck = state.decks[1];
  assert.equal(deck.name, "復旧前のこの端末の単語（2026-10-23）");
  assert.notEqual(deck.id, "l1", "端末の単語帳 ID は使わない");
  const z = state.words[2];
  assert.equal(z.term, "Z");
  assert.equal(z.deckId, deck.id);
  assert.deepEqual(plain(z.stats), { correct: 9, wrong: 2 }, "学習状態は語に付いたまま");
  assert.equal(z.history.length, 1);
  assert.equal(z.enrich, undefined, "取得キャッシュは持ち込まない");
});

test("appendLocalWords: 追加が無ければ復旧先そのもの。同名の単語帳があれば番号を付け、旧形式の削除記録には追加時刻で勝つ", () => {
  const ctx = adoptSandbox({ remoteState: null });
  const remote = { words: [word("r", "apple", "r1")], decks: [{ id: "r1", name: "復旧前のこの端末の単語（2026-10-23）" }], deletions: { zebra: Date.parse("2026-05-01") }, trash: [] };
  assert.equal(ctx.appendLocalWords(remote, [word("l", "Apple", "l1")], "2026-10-23").state, remote);
  const { state } = ctx.appendLocalWords(remote, [word("l", "zebra", "l1")], "2026-10-23");
  assert.equal(state.decks[1].name, "復旧前のこの端末の単語（2026-10-23） 2");
  assert.ok(Date.parse(state.words[1].addedAt) > Date.parse("2026-05-01"), "旧形式の削除記録で消されない");
  assert.deepEqual(plain(state.deletions), remote.deletions, "削除記録そのものは変えない");
});

test("復旧専用の再送: 409 なら最新 remote を取り直して組み直す（別端末の改名・新設・削除のあとでも最新の生存語が残る）", async () => {
  const ctx = adoptSandbox({ remoteState: null });
  const first = { words: [word("a", "alpha", "d1"), word("b", "beta", "d1")], decks: [{ id: "d1", name: "英単語" }], deletions: {}, trash: [] };
  // 初回 PUT の前に別端末が単語帳を改名し、新しく旧名の単語帳を作って、その中の語を削除した
  const latest = {
    words: [word("a", "alpha", "d1"), word("b", "beta", "d1"), word("g", "gamma", "d2")],
    decks: [{ id: "d1", name: "英単語（旧）" }, { id: "d2", name: "英単語" }],
    deletions: { "d2 delta": Date.now() },
    trash: [],
  };
  const puts = [];
  let gets = 0;
  ctx.v2Fetch = async (url, options) => {
    if (options.method === "GET") {
      gets += 1;
      return { status: 200, json: async () => (gets === 1 ? { syncId: ROOM_A, stateRev: 3, state: first } : { syncId: ROOM_A, stateRev: 4, state: latest }) };
    }
    const body = JSON.parse(options.body);
    puts.push(body);
    return body.baseRev === 4
      ? { status: 200, json: async () => ({ ok: true, syncId: ROOM_A, stateRev: 5 }) }
      : { status: 409, json: async () => ({ error: "conflict", stateRev: 4, state: latest }) };
  };
  const result = await ctx.commitRecoveryAppend(CREDENTIAL, [word("z", "zeta", "x"), word("a2", "alpha", "x")]);
  assert.equal(result.ok, true);
  assert.equal(result.stateRev, 5);
  assert.deepEqual(puts.map((p) => p.baseRev), [3, 4], "取り直した rev で送る");
  const sent = puts[1].state;
  assert.deepEqual(sent.words.slice(0, 3).map((w) => w.term), ["alpha", "beta", "gamma"], "最新の生存語がすべて残る");
  assert.deepEqual(sent.decks.slice(0, 2), latest.decks);
  assert.deepEqual(sent.deletions, latest.deletions);
  assert.deepEqual(sent.words.slice(3).map((w) => w.term), ["zeta"], "入力は常に端末の語だけ（前回の送信結果を使わない）");
});

test("復旧専用の再送: 409 が 5 回続いたら中止する。既存の 409 マージ（mergeAppStates）は通らない", async () => {
  const ctx = adoptSandbox({ remoteState: null });
  let puts = 0;
  ctx.v2Fetch = async (url, options) => {
    if (options.method === "GET") return { status: 200, json: async () => ({ syncId: ROOM_A, stateRev: 1, state: REMOTE() }) };
    puts += 1;
    return { status: 409, json: async () => ({}) };
  };
  const result = await ctx.commitRecoveryAppend(CREDENTIAL, [word("z", "zeta", "x")]);
  assert.deepEqual({ ok: result.ok, status: result.status }, { ok: false, status: 409 });
  assert.equal(puts, 5);
  for (const name of ["commitRecoveryAppend", "recoveryRoomRequest", "appendLocalWords", "recoveryBeforeReplace"]) {
    assert.doesNotMatch(extractFunction(name), /mergeAppStates|applyMergedRemoteState|syncRequest\(|pushWordsnapState/, name);
  }
  // 退避の追加は、始める前に未送信分を通常の送信へ回すだけ。送信を始めた後は通常の経路を使わない。
  const append = extractFunction("appendBackupWords");
  const afterBegin = append.slice(append.indexOf("beginRecoveryCommit()"));
  assert.ok(afterBegin.length > 100);
  assert.doesNotMatch(afterBegin, /mergeAppStates|applyMergedRemoteState|syncRequest\(|pushWordsnapState/);
});

// ---- 退避 JSON と既存の取り込み ----

test("退避 JSON（kind: wordsnap-recovery-backup）は、既存の JSON 取り込みでは何もせず案内だけ出す", async () => {
  const anchor = 'elements.importJsonInput.addEventListener("change", async () => {';
  const start = html.indexOf(anchor);
  assert.ok(start > 0);
  const end = html.indexOf("\n});", start);
  const statuses = [];
  const backup = { kind: "wordsnap-recovery-backup", version: 1, savedAt: 1, state: { words: [], decks: [] } };
  const ctx = {
    statuses,
    elements: { importJsonInput: { files: [{ size: 10, text: async () => JSON.stringify(backup) }], value: "x", addEventListener: (t, fn) => { ctx.handler = fn; } } },
    hideImportConfirmBar: () => {},
    setStatus: (m) => statuses.push(m),
    IMPORT_MAX_FILE_BYTES: 1000,
    IMPORT_MAX_FILE_LABEL: "1KB",
    IMPORT_MAX_WORDS: 10,
    pendingImport: null,
  };
  run(ctx, ["let importReadGen = 0;", html.slice(start, end + 4)]);
  await ctx.handler();
  assert.equal(ctx.pendingImport, null, "置換の確認へ進まない");
  assert.equal(statuses.length, 1);
  assert.match(statuses[0], /退避の単語を追加/);
});

// ---- 帯の規則（§7.1）----

function bandSandbox(initial = {}) {
  const ctx = {
    localStorage: memoryStorage(initial),
    renderV2RecoveryNotice: () => { ctx.notices = (ctx.notices || 0) + 1; },
    passkeySession: null,
  };
  run(ctx, [
    extractConst("V2_ROOM_ID_PATTERN"),
    extractConst("PASSKEY_LINKED_KEY"),
    extractConst("PASSKEY_LINKED_TTL_MS"),
    extractFunction("readPasskeyLinked"),
    extractFunction("writePasskeyLinked"),
    extractFunction("clearPasskeyLinked"),
    extractFunction("passkeyLinkProtects"),
    extractFunction("passkeyError"),
    extractFunction("accountApi"),
    "let passkeySession = null;",
  ]);
  return ctx;
}

const linked = (roomId, backedUp, checkedAt) => ({ "wordsnap-passkey-linked:v1": JSON.stringify({ roomId, backedUp, checkedAt }) });

test("帯: 今の部屋が結びつき済み・同期されたパスキー・7 日以内のときだけ隠す", () => {
  const now = Date.now();
  assert.equal(bandSandbox().passkeyLinkProtects(ROOM_A, now), false, "記録が無ければ従来どおり");
  assert.equal(bandSandbox(linked(ROOM_A, true, now - DAY)).passkeyLinkProtects(ROOM_A, now), true);
  assert.equal(bandSandbox(linked(ROOM_A, true, now - 8 * DAY)).passkeyLinkProtects(ROOM_A, now), false, "7 日を過ぎたら戻る");
  assert.equal(bandSandbox(linked(ROOM_A, false, now)).passkeyLinkProtects(ROOM_A, now), false, "端末固定のパスキーでは隠さない");
  assert.equal(bandSandbox(linked(ROOM_B, true, now)).passkeyLinkProtects(ROOM_A, now), false, "別の部屋の記録では隠さない");
  assert.equal(bandSandbox(linked(ROOM_A, true, now + DAY)).passkeyLinkProtects(ROOM_A, now), false, "未来の時刻は信用しない");
});

test("帯: shouldPromptV2CodeBackup は記録が有効なときだけ偽になり、wv_ の注意は別のまま", () => {
  const src = extractFunction("shouldPromptV2CodeBackup");
  assert.match(src, /typeof passkeyLinkProtects === "function" && passkeyLinkProtects\(identity\.roomId\)/);
  assert.doesNotMatch(extractFunction("shouldPromptVaultKeyBackup"), /passkey/i);
});

test("帯: 503 を観測したら記録を即座に消す（フラグ OFF で守られていると誤認させない）", async () => {
  const ctx = bandSandbox(linked(ROOM_A, true, Date.now()));
  ctx.v2Fetch = async () => ({ status: 503, ok: false, json: async () => ({ error: "accounts unavailable" }) });
  ctx.readJsonResponse = async (r) => r.json();
  await assert.rejects(() => ctx.accountApi("rooms", {}, "t"), (e) => e.passkeyCode === "unavailable");
  assert.equal(ctx.localStorage.store.has("wordsnap-passkey-linked:v1"), false);
  assert.equal(ctx.passkeyLinkProtects(ROOM_A), false);
});

test("帯: 結びつけを外す・アカウント削除でも記録を消す", () => {
  for (const name of ["passkeyUnlink", "passkeyDeleteAccount"]) {
    assert.match(extractFunction(name), /clearPasskeyLinked\(\)/, name);
  }
  // 一覧で今の部屋が見つからなければ消し、見つかれば確かめた時刻を更新する
  assert.match(extractFunction("loadPasskeyAccount"), /writePasskeyLinked\(currentRoomId, backedUp\);\n\s*\} else \{\n\s*clearPasskeyLinked\(\);/);
});

test("控える: 登録→結びつけで passkey-linked だけを書き、V2_CODE_SAVED_KEY には書かない", async () => {
  const localStorage = memoryStorage();
  const ops = [];
  const usage = [];
  const ab = (n) => new Uint8Array([n, n, n]).buffer;
  const ctx = {
    localStorage,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    navigator: {
      credentials: {
        create: async (opts) => {
          assert.equal(opts.publicKey.challenge.length, 32, "challenge をバイト列に戻して渡す");
          return { id: "cred-1", response: { clientDataJSON: ab(1), attestationObject: ab(2) } };
        },
      },
    },
    v2Fetch: async (url, options) => {
      assert.equal(url, "/api/account");
      const body = JSON.parse(options.body);
      ops.push([body.op, options.headers.authorization || ""]);
      const reply = {
        "register-options": { rp: { id: "wordbank.pages.dev", name: "WordBank" }, user: { id: "AAAA", name: "WordBank", displayName: "WordBank" }, challenge: Buffer.alloc(32, 7).toString("base64url"), pubKeyCredParams: [], authenticatorSelection: {}, attestation: "none", excludeCredentials: [] },
        register: { accountId: `wa_${"1".repeat(32)}`, token: "tok" },
        "link-room": { ok: true, backedUp: true },
      }[body.op];
      if (body.op === "register") assert.deepEqual(body.credential, { id: "cred-1", response: { clientDataJSON: "AQEB", attestationObject: "AgIC" } });
      if (body.op === "link-room") assert.deepEqual([body.roomId, body.secret], [ROOM_A, SECRET]);
      return { status: 200, ok: true, json: async () => reply };
    },
    readJsonResponse: async (r) => r.json(),
    getActiveV2Credential: () => ({ roomId: ROOM_A, secret: SECRET }),
    trackUsage: (name) => usage.push(name),
    renderV2RecoveryNotice: () => {},
    renderPasskeySection: () => {},
    setPasskeyStatus: () => {},
    elements: {},
    appState: { words: [] },
    HTMLElement: class {},
    document: { activeElement: null, body: {} },
  };
  run(ctx, [
    extractConst("V2_ROOM_ID_PATTERN"),
    extractConst("PASSKEY_LINKED_KEY"),
    extractConst("PASSKEY_TOKEN_MAX_AGE_MS"),
    extractConst("PASSKEY_FRESH_MAX_AGE_MS"),
    "let passkeySession = null; let passkeyBusy = false; let passkeyLoginInFlight = null;",
    "let passkeyFocusOrigin = null; let recoverPersistedSettled = true;",
    ...["readPasskeyLinked", "writePasskeyLinked", "clearPasskeyLinked", "bytesToBase64Url", "base64UrlToBytes", "passkeyError",
      "accountApi", "passkeyErrorMessage", "passkeySessionValid", "passkeyRegister", "serializeRegistration", "passkeyLogin",
      "passkeyToken", "setPasskeyBusy", "capturePasskeyFocusOrigin", "restorePasskeyFocus", "passkeyLinkCurrentRoom"].map(extractFunction),
  ]);
  await ctx.passkeyLinkCurrentRoom({ register: true });
  assert.deepEqual(ops, [], "0 語の部屋は結びつけない");
  ctx.appState.words.push({ term: "apple" });
  await ctx.passkeyLinkCurrentRoom({ register: true });
  assert.deepEqual(ops, [["register-options", ""], ["register", ""], ["link-room", "Bearer tok"]]);
  assert.deepEqual(localStorage.writes, [["set", "wordsnap-passkey-linked:v1"]], "書くのは控え済みの記録だけ");
  const record = JSON.parse(localStorage.store.get("wordsnap-passkey-linked:v1"));
  assert.deepEqual([record.roomId, record.backedUp], [ROOM_A, true]);
  assert.deepEqual(usage, ["account-register", "account-link"]);
});

test("復旧の部屋一覧: 語数の多い順、0 語は「空（0 語）」、今の資格情報と一致する部屋だけ自動発行の注記", () => {
  const ctx = run({}, [extractFunction("formatPasskeyDate"), extractFunction("passkeyRoomLabel"), extractFunction("sortRecoveryRooms")]);
  const rooms = [
    { roomId: ROOM_A, wordCount: 0, deckCount: 1, updatedAt: 0 },
    { roomId: ROOM_B, wordCount: 120, deckCount: 3, updatedAt: 0 },
    { roomId: `wr_${"c".repeat(32)}`, wordCount: null, deckCount: null, updatedAt: 0 },
  ];
  assert.deepEqual(plain(ctx.sortRecoveryRooms(rooms).map((r) => r.wordCount)), [120, 0, null]);
  assert.match(ctx.passkeyRoomLabel(rooms[0], ROOM_A), /^空（0 語）.*（この端末で自動発行）$/);
  assert.doesNotMatch(ctx.passkeyRoomLabel(rooms[1], ROOM_A), /自動発行/);
  assert.match(ctx.passkeyRoomLabel(rooms[2], ROOM_A), /^語数不明/);
});

// ---- レビュー対応（高 1〜3・中 4〜13・低 14〜19）----

// 認証・登録まわりの砂場。WebAuthn と /api/account を差し替え、呼ばれた op を記録する。
function accountSandbox({ loginAccountId = `wa_${"1".repeat(32)}`, words = 1 } = {}) {
  const ops = [];
  const gets = [];
  const usage = [];
  const localStorage = memoryStorage();
  const ab = (n) => new Uint8Array([n, n, n]).buffer;
  const ctx = {
    ops,
    gets,
    usage,
    localStorage,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    navigator: {
      credentials: {
        create: async () => ({ id: "cred-new", response: { clientDataJSON: ab(1), attestationObject: ab(2) } }),
        get: async () => {
          gets.push(1);
          await new Promise((r) => setTimeout(r, 5));
          return { id: "cred-1", response: { clientDataJSON: ab(1), authenticatorData: ab(2), signature: ab(3), userHandle: ab(4) } };
        },
      },
    },
    v2Fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      ops.push(body.op);
      const challenge = Buffer.alloc(32, 7).toString("base64url");
      const reply = {
        "register-options": { rp: {}, user: { id: "AAAA" }, challenge, pubKeyCredParams: [], excludeCredentials: [] },
        register: { accountId: `wa_${"9".repeat(32)}`, token: "tok-reg" },
        "login-options": { challenge, rpId: "wordbank.pages.dev", userVerification: "required" },
        login: { accountId: loginAccountId, token: "tok-login", backedUp: true },
        "link-room": { ok: true, backedUp: true },
      }[body.op] || { ok: true };
      return { status: 200, ok: true, json: async () => reply };
    },
    readJsonResponse: async (r) => r.json(),
    getActiveV2Credential: () => ({ roomId: ROOM_A, secret: SECRET }),
    trackUsage: (name) => usage.push(name),
    renderV2RecoveryNotice: () => {},
    renderPasskeySection: () => {},
    setPasskeyStatus: (m, mode) => { ctx.lastStatus = [m, mode || ""]; },
    elements: {},
    appState: { words: Array.from({ length: words }, () => ({ term: "x" })) },
    HTMLElement: class {},
    document: { activeElement: null, body: {} },
  };
  run(ctx, [
    extractConst("V2_ROOM_ID_PATTERN"),
    extractConst("PASSKEY_LINKED_KEY"),
    extractConst("PASSKEY_TOKEN_MAX_AGE_MS"),
    extractConst("PASSKEY_FRESH_MAX_AGE_MS"),
    "let passkeySession = null; let passkeyBusy = false; let passkeyLoginInFlight = null;",
    "let passkeyFocusOrigin = null; let recoverPersistedSettled = true; let passkeyShownAccountId = '';",
    ...["readPasskeyLinked", "writePasskeyLinked", "clearPasskeyLinked", "bytesToBase64Url", "base64UrlToBytes", "passkeyError",
      "accountApi", "passkeyErrorMessage", "passkeySessionValid", "passkeyRegister", "serializeRegistration", "passkeyLogin",
      "passkeyToken", "freshTokenForShownAccount", "setPasskeyBusy", "capturePasskeyFocusOrigin", "restorePasskeyFocus",
      "passkeyLinkCurrentRoom"].map(extractFunction),
    "globalThis.__set = (k, v) => { if (k === 'shown') passkeyShownAccountId = v; if (k === 'session') passkeySession = v; };",
    "globalThis.__session = () => passkeySession;",
  ]);
  return ctx;
}

test("控える（中10）: 「すでに控えてある」は認証して結びつけるだけで、新規登録しない", async () => {
  const ctx = accountSandbox();
  await ctx.passkeyLinkCurrentRoom({ register: false });
  assert.deepEqual(plain(ctx.ops), ["login-options", "login", "link-room"]);
  assert.deepEqual(plain(ctx.usage), ["account-link"]);
  assert.match(extractFunction("passkeyLinkCurrentRoom"), /if \(register\) \{/, "登録は明示したときだけ");
  assert.doesNotMatch(extractFunction("passkeyLinkCurrentRoom"), /readPasskeyLinked\(\)/, "記録の有無で勝手に登録しない");
});

test("認証の直列化: 同時に 2 回トークンを求めても、パスキーの認証は 1 回", async () => {
  const ctx = accountSandbox();
  const [a, b] = await Promise.all([ctx.passkeyToken(), ctx.passkeyToken()]);
  assert.equal(a, "tok-login");
  assert.equal(b, "tok-login");
  assert.equal(ctx.gets.length, 1);
  assert.deepEqual(plain(ctx.ops), ["login-options", "login"]);
});

test("中4: 破壊的な操作の再認証で別アカウントのパスキーが選ばれたら中止する", async () => {
  const ctx = accountSandbox({ loginAccountId: `wa_${"2".repeat(32)}` });
  ctx.__set("shown", `wa_${"1".repeat(32)}`);
  await assert.rejects(() => ctx.freshTokenForShownAccount(), (e) => e.passkeyCode === "account-mismatch");
  for (const name of ["passkeyRemove", "passkeyUnlink", "passkeyDeleteAccount", "passkeyAdd"]) {
    assert.match(extractFunction(name), /await freshTokenForShownAccount\(/, `${name} は表示中のアカウントを確かめる`);
    assert.doesNotMatch(extractFunction(name), /passkeyToken\(\{ fresh: true \}\)/, name);
  }
  const same = accountSandbox();
  same.__set("shown", `wa_${"1".repeat(32)}`);
  assert.equal(await same.freshTokenForShownAccount(), "tok-login");
});

test("低14: パスキーの追加は、トークンの残りが 60 秒未満なら先に認証し直す", async () => {
  const ctx = accountSandbox();
  ctx.__set("session", { token: "old", accountId: `wa_${"1".repeat(32)}`, at: Date.now() - 70 * 1000 });
  assert.equal(await ctx.passkeyToken({ fresh: true }), "old", "2 分の窓の内なら通常は使い回す");
  assert.equal(await ctx.passkeyToken({ fresh: true, maxAgeMs: 60 * 1000 }), "tok-login", "60 秒を過ぎていれば認証し直す");
  assert.match(extractFunction("passkeyAdd"), /freshTokenForShownAccount\(\{ maxAgeMs: 60 \* 1000 \}\)/);
});

test("中5: パスキーを削除したら、確かめ直すまで帯の記録を無効にする", () => {
  const src = extractFunction("passkeyRemove");
  assert.ok(src.indexOf('accountApi("remove-passkey"') < src.indexOf("clearPasskeyLinked()"));
});

// recoverWithPasskey の結果処理。adoptV2Room と復旧の合流を差し替える。
function recoverSandbox({ adoptResult, outcomeValue = "ok", settled = true, barrier = "settled" }) {
  const calls = [];
  const usage = [];
  const ctx = {
    calls,
    usage,
    localStorage: memoryStorage(),
    elements: {},
    HTMLElement: class {},
    document: { activeElement: null, body: {} },
    appState: { words: [{ term: "a" }] },
    syncTargetHalted: false,
    v2RecoveryBarrierStatus: () => barrier,
    passkeyToken: async () => { calls.push("token"); ctx.__setSession(); return "tok"; },
    accountApi: async (op) => {
      calls.push(op);
      if (op === "rooms") return [{ roomId: ROOM_A, wordCount: 3, deckCount: 1, updatedAt: 0 }];
      if (op === "recover-room") return { roomId: ROOM_A, secret: SECRET };
      return {};
    },
    askPasskeyDialog: async () => ROOM_A,
    getActiveV2Credential: () => null,
    acquireIdentityClaim: async () => "claim",
    releaseIdentityClaim: () => calls.push("release"),
    recoveryBeforeReplace: (credential, outcome) => {
      outcome.value = outcomeValue;
      outcome.lock = { snapshot: [] };
      return async () => null;
    },
    adoptV2Room: async () => adoptResult,
    restoreUiAfterRecovery: () => calls.push("restoreUi"),
    setUndoControlsDisabled: () => {},
    setPasskeyBusy: () => {},
    renderPasskeySection: () => {},
    renderV2RecoveryNotice: () => {},
    setV2Status: () => {},
    setPasskeyStatus: (m, mode) => { ctx.lastStatus = [m, mode || ""]; },
    passkeyErrorMessage: () => "error",
    passkeyError: (code) => new Error(code),
    sortRecoveryRooms: (r) => r,
    passkeyRoomLabel: () => "label",
    syncServerAvailable: () => true,
    startSyncPolling: () => calls.push("startPolling"),
    trackUsage: (name) => usage.push(name),
    writePasskeyLinked: (roomId) => calls.push(`linked:${roomId}`),
  };
  run(ctx, [
    `let passkeyBusy = false; let passkeySession = null; let passkeyFocusOrigin = null; let undoSuspended = false;`,
    `let recoverPersistedSettled = ${settled}; let passkeyRecoveredCode = "";`,
    "globalThis.__setSession = () => { passkeySession = { token: 'tok', backedUp: true }; };",
    "globalThis.__code = () => passkeyRecoveredCode;",
    extractFunction("capturePasskeyFocusOrigin"),
    extractFunction("restorePasskeyFocus"),
    extractFunction("recoverWithPasskey"),
  ]);
  return ctx;
}

test("中6/8: 復旧先への PUT が済んでも、端末の切り替えに失敗したら成功にしない（コードの表示へ導く）", async () => {
  const ctx = recoverSandbox({ adoptResult: undefined, outcomeValue: "ok" });
  await ctx.recoverWithPasskey();
  assert.deepEqual(plain(ctx.usage), ["account-recover-fail"]);
  assert.ok(!ctx.calls.some((c) => String(c).startsWith("linked:")), "控え済みの記録を書かない");
  assert.match(ctx.lastStatus[0], /サーバーへの保存は済みましたが、この端末の切り替えに失敗しました/);
  assert.equal(ctx.__code(), `${ROOM_A}.${SECRET}`, "利用者が押したときに表示するコードを用意する");
  assert.ok(ctx.calls.includes("restoreUi") && ctx.calls.includes("release"));
  assert.ok(ctx.calls.includes("startPolling"), "止めた通常同期を元の同期先で再開する");
});

test("中6/8: adoptV2Room が切り替えを終えたときだけ成功（記録・テレメトリ）", async () => {
  const ctx = recoverSandbox({ adoptResult: { roomId: ROOM_A }, outcomeValue: "ok" });
  await ctx.recoverWithPasskey();
  assert.deepEqual(plain(ctx.usage), ["account-recover-success"]);
  assert.ok(ctx.calls.includes(`linked:${ROOM_A}`));
  assert.match(ctx.lastStatus[0], /^✓ パスキーで復元しました/);
  assert.equal(ctx.__code(), "");
  assert.ok(!ctx.calls.includes("startPolling"), "切り替えたときは activateV2Credential が再開する");
});

test("高1: 起動時の復元（recoverPersisted）が終わるまでは「パスキーで復元」を始めない", async () => {
  const ctx = recoverSandbox({ adoptResult: { roomId: ROOM_A }, settled: false });
  await ctx.recoverWithPasskey();
  assert.deepEqual(plain(ctx.calls), [], "認証も通信もしない");
  assert.match(ctx.lastStatus[0], /起動時の読み込みがまだ終わっていません/);
  assert.match(html, /recoverPersistedReady = recoverPersisted\(\)\n\s*\.then\(/);
  assert.match(html, /recoverPersistedReady\.then\(markRecoverPersistedSettled, markRecoverPersistedSettled\);/);
  assert.match(extractFunction("setPasskeyBusy"), /!recoverPersistedSettled/, "完了までボタンを押せなくする");
});

test("高1: 復旧が確定した後に返った起動時の IndexedDB 読み取りは捨てる（mergeAppStates しない）", async () => {
  let release;
  const calls = [];
  const ctx = {
    calls,
    navigator: {},
    appState: { words: [{ term: "recovered" }] },
    syncState: {},
    syncInitStarted: true,
    clientIdWasNew: false,
    CLIENT_KEY: "client",
    STORAGE_KEY: "state",
    localStorage: memoryStorage(),
    stateSignature: (s) => JSON.stringify(s),
    settleV2RecoveryFromIdb: async () => false,
    revokeStartupGeneratedLegacyIdentity: () => {},
    idb: {
      get: (key) => (key === "state" ? new Promise((r) => { release = () => r(JSON.stringify({ words: [{ term: "old" }] })); }) : Promise.resolve(null)),
      set: async () => true,
    },
    mergeAppStates: () => { calls.push("merge"); return {}; },
    normalizeState: (s) => s,
    loadState: () => ({}),
    persistAppState: () => calls.push("persist"),
    renderAll: () => {},
  };
  run(ctx, ["let recoveryGeneration = 0; let v2CredentialRecoveredFromIdb = false; let currentQuiz = null;",
    "globalThis.__bump = () => { recoveryGeneration += 1; };", extractFunction("recoverPersisted")]);
  const pending = ctx.recoverPersisted();
  await new Promise((r) => setTimeout(r, 5));
  ctx.__bump(); // 読み取り待ちの間に復旧が確定した
  release();
  await pending;
  assert.ok(!calls.includes("merge"), "旧い読み取りを復旧先へ混ぜない");
  assert.equal(ctx.appState.words[0].term, "recovered");
});

// ---- 高3: 別のタブが同期先を変えたら、このタブは合流も送信もしない ----

function crossTabSandbox() {
  const calls = [];
  const listeners = {};
  const ctx = {
    calls,
    __target: ROOM_A,
    window: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      clearTimeout: () => {},
      setTimeout: () => 0,
    },
    listeners,
    SYNC_V2_CREDENTIAL_KEY: "cred",
    SYNC_ID_KEY: "sync",
    appState: { words: [{ term: "old-tab" }] },
    syncState: { connected: true, pushing: false, pulling: false, rev: 3, dirtyGen: 1, syncedGen: 0, requestGen: 0, pushQueued: false, abortControllers: new Set() },
    syncRequestRoute: () => ({ expectedSyncId: ctx.__target }),
    syncServerAvailable: () => true,
    stopSyncPolling: () => calls.push("stopPolling"),
    setSyncStatus: (m, mode) => calls.push(["status", m, mode || ""]),
    syncPutState: async () => { calls.push("put"); if (ctx.onPut) return ctx.onPut(); return { stateRev: 4, verifiedSyncTarget: ctx.__target }; },
    syncRequest: async () => { calls.push("get"); return { stateRev: 9, state: { words: [] } }; },
    applyMergedRemoteState: () => { calls.push("merge"); return true; },
    recordVerifiedSync: () => {},
    isStaleSyncError: () => false,
    validSyncGetResponse: () => true,
    scheduleSyncPush: () => calls.push("schedule"),
    scheduleSyncRetry: () => calls.push("retry"),
    connectWordsnapSync: async () => {},
    normalizeV2Credential: (c) => c,
  };
  const storageStart = html.indexOf('window.addEventListener("storage", (event) => {');
  const storageEnd = html.indexOf("\n});", storageStart);
  run(ctx, [
    extractFunction("bumpSyncRequestGen"),
    extractFunction("resetConnectedSyncTarget"),
    extractFunction("haltSyncForForeignTarget"),
    extractFunction("syncTargetChangedElsewhere"),
    extractFunction("activeRoomIdFromStored"),
    "let connectedSyncTarget = ''; let syncTargetHalted = false;",
    html.slice(storageStart, storageEnd + 4),
    extractFunction("pushWordsnapState"),
    extractFunction("pullWordsnapState"),
  ]);
  return ctx;
}

const reloadMessage = (calls) => calls.some((c) => Array.isArray(c) && /同期先が別のタブで変わりました/.test(c[1]));

test("高3: 別タブが資格情報を切り替えた後の push は送信しない（再読み込みを促す）", async () => {
  const ctx = crossTabSandbox();
  await ctx.pushWordsnapState();
  assert.equal(ctx.calls.filter((c) => c === "put").length, 1, "同じ同期先の間は従来どおり送る");
  ctx.__target = ROOM_B; // 別タブが復旧で切り替えた（V2 の資格情報は localStorage から毎回読む）
  ctx.calls.length = 0;
  await ctx.pushWordsnapState();
  assert.ok(!ctx.calls.includes("put"), "古い端末状態を新しい同期先へ送らない");
  assert.ok(ctx.calls.includes("stopPolling"));
  assert.ok(reloadMessage(ctx.calls));
  ctx.calls.length = 0;
  await ctx.pullWordsnapState({ silent: true });
  assert.deepEqual(ctx.calls.filter((c) => c === "get" || c === "merge"), [], "以後は受信も合流もしない");
});

test("高3: 409 の処理の直前に同期先が変わっていたら合流しない", async () => {
  const ctx = crossTabSandbox();
  await ctx.pullWordsnapState({ silent: true }); // ROOM_A を覚える
  ctx.calls.length = 0;
  ctx.onPut = async () => {
    ctx.__target = ROOM_B;
    const error = new Error("conflict");
    error.status = 409;
    error.data = { state: { words: [], decks: [] }, stateRev: 10, syncId: ROOM_B };
    throw error;
  };
  await ctx.pushWordsnapState();
  assert.ok(!ctx.calls.includes("merge"), "409 の本文を合流しない");
  assert.equal(ctx.calls.filter((c) => c === "put").length, 1, "再送もしない");
  assert.ok(reloadMessage(ctx.calls));
});

test("高3: pull の応答待ちの間に別タブが切り替えても合流しない", async () => {
  const ctx = crossTabSandbox();
  await ctx.pushWordsnapState(); // ROOM_A を覚える
  ctx.calls.length = 0;
  ctx.syncRequest = async () => { ctx.calls.push("get"); return { stateRev: 9, state: { words: [] } }; };
  ctx.syncRequestRoute = (() => { let n = 0; return () => ({ expectedSyncId: n++ < 2 ? ROOM_A : ROOM_B }); })();
  await ctx.pullWordsnapState({ silent: true });
  assert.ok(!ctx.calls.includes("merge"));
});

test("高3: storage イベントで別タブの切り替えを検出し、一度も送受信していないタブでも止める", async () => {
  const ctx = crossTabSandbox();
  ctx.__target = ROOM_B;
  ctx.listeners.storage({ key: "cred", oldValue: JSON.stringify({ status: "active", roomId: ROOM_A }) });
  assert.ok(reloadMessage(ctx.calls));
  ctx.calls.length = 0;
  await ctx.pushWordsnapState();
  assert.ok(!ctx.calls.includes("put"));
  // このタブ自身の切り替え（bumpSyncRequestGen を通る）は止めない
  const own = crossTabSandbox();
  await own.pushWordsnapState();
  own.__target = ROOM_B;
  own.bumpSyncRequestGen();
  own.calls.length = 0;
  await own.pushWordsnapState();
  assert.ok(own.calls.includes("put"));
  assert.ok(!reloadMessage(own.calls));
});

test("中7/18: ダイアログを閉じても、ほかのモーダルが開いていれば背景のスクロール止めを外さない", () => {
  const classes = new Set(["tutorial-open"]);
  let otherOpen = true;
  const focused = [];
  const ctx = {
    elements: { passkeyDialogBackdrop: { hidden: false } },
    document: {
      body: { classList: { remove: (c) => classes.delete(c) } },
      querySelector: () => (otherOpen ? {} : null),
    },
  };
  run(ctx, [
    "let passkeyDialogResolve = () => {}; let passkeyDialogReturnFocus = { focus: () => globalThis.__focused.push(1) };",
    extractFunction("closePasskeyDialog"),
  ]);
  ctx.__focused = focused;
  ctx.closePasskeyDialog(null);
  assert.ok(classes.has("tutorial-open"), "復元案内などが開いている間は外さない");
  assert.equal(focused.length, 1, "フォーカスは戻す");
  otherOpen = false;
  run(ctx, ["passkeyDialogResolve = () => {};"]);
  ctx.closePasskeyDialog(null);
  assert.ok(!classes.has("tutorial-open"));
  // 戻し先は操作を始める前（ボタンを無効にする前）に取る
  const recover = extractFunction("recoverWithPasskey");
  assert.ok(recover.indexOf("capturePasskeyFocusOrigin()") < recover.indexOf("setPasskeyBusy(true)"));
  assert.match(extractFunction("askPasskeyDialog"), /passkeyDialogReturnFocus = returnFocus \|\| passkeyFocusOrigin \|\|/);
});

// ---- 最終確認の反例への対応 ----

test("反例(2): 候補の保存が IndexedDB を待っている間は、退避の追加を始めない（保存中の語を置換で消さない）", async () => {
  const ctx = adoptSandbox({ localWords: [word("r1", "apple", "rd")], remoteState: REMOTE() });
  let releaseIdb;
  ctx.idb.set = (key, value) => (key === "state"
    ? new Promise((r) => { releaseIdb = () => r(true); })
    : Promise.resolve(true));
  Object.assign(ctx, {
    STORAGE_KEY: "state",
    sanitizeDeletions: (d) => d || {},
    sanitizeTrash: (t) => t || [],
    showRuntimeStorageWarning: () => {},
    scheduleSyncPush: () => { ctx.syncState.dirtyGen += 1; },
  });
  run(ctx, [
    "let storageWriteGeneration = 0;",
    extractFunction("beginLocalPersist"),
    extractFunction("endLocalPersist"),
    extractFunction("persistAppStateCheckedOnce"),
    extractFunction("persistAppStateChecked"),
  ]);
  // 候補の保存と同じ順: appState に先に入れてから、保存の完了を待つ
  ctx.appState.words.push(word("z", "zeta", "rd"));
  const saving = ctx.persistAppStateChecked();
  assert.equal(ctx.syncState.persistInFlight, 1, "保存の途中を数える");
  assert.notEqual(ctx.syncState.persistEditGen, ctx.syncState.syncedEditGen || 0, "入口で同期的に編集検出用の世代を進める");
  assert.equal(await ctx.appendBackupWords([word("b", "backup", "x")]), false, "始めない");
  assert.deepEqual(ctx.requests, [], "送信しない");
  assert.ok(ctx.appState.words.some((w) => w.term === "zeta"), "保存中の語が残る");
  releaseIdb();
  assert.equal(await saving, true);
  assert.equal(ctx.syncState.persistInFlight, 0, "完了で戻す");
  // 世代だけが残っていても（送信前）始めない
  assert.equal(await ctx.appendBackupWords([word("b", "backup", "x")]), false);
  assert.match(extractFunction("recoveryBeforeReplace"), /if \(\(Number\(syncState\.persistInFlight\) \|\| 0\) > 0\) \{/, "復旧の確定も保存の途中なら始めない");
});

// 実物の syncRequest / syncPutState を、圧縮と fetch だけ差し替えて走らせる。
function transportSandbox() {
  const fetched = [];
  const listeners = {};
  const ctx = {
    fetched,
    listeners,
    __target: ROOM_A,
    SYNC_REQUEST_TIMEOUT_MS: 60000,
    SYNC_GZ_BASE64_LIMIT: 1800000,
    SYNC_V2_CREDENTIAL_KEY: "cred",
    SYNC_ID_KEY: "sync",
    AbortController,
    window: { setTimeout: () => 0, clearTimeout: () => {}, addEventListener: (t, fn) => { listeners[t] = fn; } },
    syncState: { requestGen: 0, pushTimer: 0, retryTimer: 0, pushQueued: false, abortControllers: new Set(), connected: true },
    syncRequestRoute: () => ({ endpoint: `/api/wordsnap-state?room=${ctx.__target}`, expectedSyncId: ctx.__target, isV2: true }),
    syncEndpoint: () => `/api/wordsnap-state?room=${ctx.__target}`,
    syncHeaders: () => ({}),
    syncStateExceedsLimits: () => false,
    cleanSyncId: (v) => String(v || ""),
    stopSyncPolling: () => {},
    setSyncStatus: (m) => { ctx.lastStatus = m; },
    normalizeV2Credential: (c) => c,
    buildSyncPayloadState: () => ({ words: [{ term: "old-tab" }], decks: [] }),
    syncShouldCompress: () => true,
    gzipJsonToBase64: async () => { if (ctx.duringGzip) await ctx.duringGzip(); return "H4sI"; },
    fetch: async (url, options) => {
      fetched.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      return { ok: true, status: 200, json: async () => ({ ok: true, syncId: ctx.__target, stateRev: 5, state: { words: [], decks: [] } }) };
    },
  };
  const storageStart = html.indexOf('window.addEventListener("storage", (event) => {');
  run(ctx, [
    "let connectedSyncTarget = ''; let syncTargetHalted = false;",
    extractFunction("staleSyncError"),
    extractFunction("isStaleSyncError"),
    extractFunction("syncSendGuardHolds"),
    extractFunction("validSyncGetResponse"),
    extractFunction("validSyncHistoryResponse"),
    extractFunction("validSyncPutResponse"),
    extractFunction("bumpSyncRequestGen"),
    extractFunction("resetConnectedSyncTarget"),
    extractFunction("haltSyncForForeignTarget"),
    extractFunction("syncTargetChangedElsewhere"),
    extractFunction("activeRoomIdFromStored"),
    html.slice(storageStart, html.indexOf("\n});", storageStart) + 4),
    extractFunction("syncRequest"),
    extractFunction("syncPutState"),
    "globalThis.__halted = () => syncTargetHalted;",
  ]);
  return ctx;
}

test("反例(3B): 圧縮の途中で世代が進んだ（同期先が切り替わった）ら、旧い state を送らない", async () => {
  const ctx = transportSandbox();
  await ctx.syncPutState(3);
  assert.equal(ctx.fetched.length, 1, "通常は圧縮して送る");
  assert.equal(ctx.fetched[0].body.format, "gzip-base64");
  for (const change of [
    (t) => t.bumpSyncRequestGen(), // 同じタブでの復旧完了など（世代だけが進む）
    (t) => { t.__target = ROOM_B; }, // 別タブが資格情報を切り替えた
  ]) {
    const t = transportSandbox();
    t.duringGzip = async () => change(t);
    await assert.rejects(() => t.syncPutState(3), (e) => t.isStaleSyncError(e));
    assert.equal(t.fetched.length, 0, "送らない");
  }
});

test("反例(3B): 圧縮の途中で資格情報が切り替わったら送らない（別タブ）", async () => {
  const t = transportSandbox();
  t.duringGzip = async () => { t.__target = ROOM_B; };
  await assert.rejects(() => t.syncPutState(3), (e) => t.isStaleSyncError(e));
  assert.equal(t.fetched.length, 0);
});

test("反例(3A): 接続時の最初の GET の前に同期先を束縛し、別タブの新規発行（oldValue が null）も検出する", async () => {
  const ctx = transportSandbox();
  await ctx.syncRequest("GET"); // 接続処理の最初の GET（needsPush=false でも束縛済みになる）
  assert.equal(ctx.fetched.length, 1);
  ctx.__target = ROOM_B; // 別タブで V2 を新規発行した
  ctx.listeners.storage({ key: "cred", oldValue: null });
  assert.equal(ctx.__halted(), true, "oldValue に頼らず、束縛済みの同期先と比べて止める");
  await assert.rejects(() => ctx.syncRequest("GET", null, { sinceRev: 1 }), (e) => ctx.isStaleSyncError(e));
  assert.equal(ctx.fetched.length, 1, "前面復帰の最初の pull でも新しい部屋へ取りに行かない");
});

test("通常経路: 同期先が一定なら pull・push・409 の合流と再送は従来どおり", async () => {
  const ctx = crossTabSandbox();
  await ctx.pullWordsnapState({ silent: false });
  assert.ok(ctx.calls.includes("merge"), "pull は合流する");
  ctx.calls.length = 0;
  let first = true;
  ctx.onPut = async () => {
    if (!first) return { stateRev: 11, verifiedSyncTarget: ROOM_A };
    first = false;
    const error = new Error("conflict");
    error.status = 409;
    error.data = { state: { words: [], decks: [] }, stateRev: 10, syncId: ROOM_A };
    throw error;
  };
  await ctx.pushWordsnapState();
  assert.ok(ctx.calls.includes("merge"), "409 は従来どおり合流する");
  assert.equal(ctx.calls.filter((c) => c === "put").length, 2, "合流後に再送する");
  assert.ok(!reloadMessage(ctx.calls));
});

// ---- N1: 編集検出用の世代と送信予約用の世代を分ける（実物の送信予約経路で確かめる）----

function persistPushSandbox() {
  const timers = [];
  const puts = [];
  let releasePut = null;
  let releaseIdb = null;
  const ctx = {
    timers,
    puts,
    appState: { words: [{ term: "keep" }], decks: [], deletions: {}, trash: [] },
    syncState: {
      connected: true, pushing: false, pulling: false, rev: 3, dirtyGen: 0, syncedGen: 0, requestGen: 0,
      pushQueued: false, pushTimer: 0, retryTimer: 0, applyingRemote: false, abortControllers: new Set(),
      persistInFlight: 0, persistEditGen: 0, syncedEditGen: 0,
    },
    window: {
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
    },
    STORAGE_KEY: "state",
    localStorage: { setItem: () => { if (ctx.localFails) throw new Error("quota"); } },
    idb: { set: () => new Promise((r) => { releaseIdb = r; }) },
    sanitizeDeletions: (d) => d || {},
    sanitizeTrash: (t) => t || [],
    showRuntimeStorageWarning: () => {},
    syncRequestRoute: () => ({ expectedSyncId: ROOM_A }),
    syncServerAvailable: () => true,
    // 送信内容は送る瞬間の appState（buildSyncPayloadState と同じく呼ばれた時点で作る）
    syncPutState: async () => {
      puts.push(JSON.parse(JSON.stringify(ctx.appState)));
      if (ctx.holdPut) await new Promise((r) => { releasePut = r; });
      return { stateRev: 4 + puts.length, verifiedSyncTarget: ROOM_A };
    },
    recordVerifiedSync: () => {},
    setSyncStatus: () => {},
    isStaleSyncError: () => false,
    validSyncGetResponse: () => true,
    applyMergedRemoteState: () => true,
    scheduleSyncRetry: () => {},
  };
  run(ctx, [
    "let storageWriteGeneration = 0;",
    extractFunction("beginLocalPersist"),
    extractFunction("endLocalPersist"),
    extractFunction("persistAppStateCheckedOnce"),
    extractFunction("persistAppStateChecked"),
    extractFunction("scheduleSyncPush"),
    extractFunction("pushWordsnapState"),
  ]);
  ctx.releasePut = () => releasePut();
  ctx.releaseIdb = (ok) => releaseIdb(ok);
  // 予約済みの送信を順に走らせる（400ms 待ちの代わり）
  ctx.flushTimers = async () => {
    while (timers.length) {
      await timers.shift()();
    }
  };
  return ctx;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("N1(a): 応答待ちの PUT の間に保存しても、IndexedDB の完了前には再送を予約せず、完了後に 1 回だけ予約する", async () => {
  const ctx = persistPushSandbox();
  ctx.holdPut = true;
  const inflight = ctx.pushWordsnapState();
  await tick();
  // 取り込み（置換）と同じ形: appState を変えてから保存の完了を待つ
  ctx.appState.words.push({ term: "imported" });
  const saving = ctx.persistAppStateChecked();
  ctx.releasePut();
  await inflight;
  assert.equal(ctx.timers.length, 0, "保存が終わる前の変更で再送を予約しない");
  ctx.holdPut = false;
  ctx.releaseIdb(true);
  assert.equal(await saving, true);
  assert.equal(ctx.timers.length, 1, "保存成功後に 1 回だけ予約する");
  await ctx.flushTimers();
  assert.equal(ctx.puts.length, 2);
  assert.ok(ctx.puts[1].words.some((w) => w.term === "imported"));
  assert.equal(ctx.timers.length, 0, "同じ内容の余分な PUT を出さない");
});

test("N1(b): 保存に失敗して取り消した変更は、一度も送られない", async () => {
  const ctx = persistPushSandbox();
  ctx.localFails = true;
  ctx.holdPut = true;
  const inflight = ctx.pushWordsnapState();
  await tick();
  ctx.appState.deletions = { "d1 x": Date.now() }; // 取り込みの置換が付ける削除記録
  ctx.appState.words = [];
  const saving = ctx.persistAppStateChecked();
  ctx.releasePut();
  await inflight;
  ctx.holdPut = false;
  await ctx.flushTimers(); // IndexedDB の保存が 400ms より長くかかった場合
  ctx.releaseIdb(false);
  const persisted = await saving;
  assert.equal(persisted, false);
  // 呼び出し側（取り込み）の取り消しと同じ
  ctx.appState.words = [{ term: "keep" }];
  ctx.appState.deletions = {};
  await ctx.flushTimers();
  for (const sent of ctx.puts) {
    assert.deepEqual(plain(sent.deletions), {}, "取り消した削除記録を送らない");
    assert.ok(sent.words.some((w) => w.term === "keep"));
  }
});

test("N1(c): 退避の追加・復旧の確定のガードは、保存待ちの間（送信予約の世代が動かなくても）拒否する", async () => {
  const ctx = adoptSandbox({ localWords: [word("r1", "apple", "rd")], remoteState: REMOTE() });
  let releaseIdb;
  ctx.idb.set = (key) => (key === "state" ? new Promise((r) => { releaseIdb = () => r(true); }) : Promise.resolve(true));
  Object.assign(ctx, {
    STORAGE_KEY: "state",
    sanitizeDeletions: (d) => d || {},
    sanitizeTrash: (t) => t || [],
    showRuntimeStorageWarning: () => {},
    scheduleSyncPush: () => {},
  });
  run(ctx, [
    "let storageWriteGeneration = 0;",
    extractFunction("beginLocalPersist"),
    extractFunction("endLocalPersist"),
    extractFunction("persistAppStateCheckedOnce"),
    extractFunction("persistAppStateChecked"),
  ]);
  ctx.appState.words.push(word("z", "zeta", "rd"));
  const saving = ctx.persistAppStateChecked();
  assert.equal(ctx.syncState.dirtyGen, 0, "送信予約の世代は入口では動かない");
  assert.equal(await ctx.appendBackupWords([word("b", "backup", "x")]), false, "保存の途中は始めない");
  releaseIdb();
  await saving;
  assert.equal(await ctx.appendBackupWords([word("b", "backup", "x")]), false, "保存後も未送信の編集があれば始めない");
  assert.deepEqual(ctx.requests, []);
  ctx.syncState.syncedEditGen = ctx.syncState.persistEditGen; // 通常の送信が通った
  assert.equal(await ctx.appendBackupWords([word("b", "backup", "x")]), true);
});
