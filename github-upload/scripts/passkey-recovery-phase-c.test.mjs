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

function adoptSandbox({ localWords = [], remoteState, choose = async () => null, putStatus = 200 }) {
  const calls = [];
  const requests = [];
  let rev = 7;
  const ctx = {
    calls,
    requests,
    appState: { words: localWords.map((w) => ({ ...w })), decks: [{ id: "l1", name: "単語帳1" }], deletions: {}, trash: [] },
    elements: { syncV2JoinInput: { value: "" } },
    syncState: { applyingRemote: false },
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
    extractConst("SYNC_GZ_BASE64_LIMIT"),
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
  assert.equal(ctx.localStorage.store.size, 0, "やめたら退避も作らない");
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
  const backup = JSON.parse(ctx.localStorage.store.get("wordsnap-recovery-backup:v1"));
  assert.equal(backup.kind, "wordsnap-recovery-backup");
  assert.deepEqual(plain(backup.state.words.map((w) => w.term)), ["zebra"]);
});

test("復旧: 端末が空なら 3 択を出さずに採用し、それでも PUT は 1 回", async () => {
  const ctx = adoptSandbox({ localWords: [], remoteState: REMOTE() });
  const outcome = {};
  await ctx.adoptV2Room(CREDENTIAL, { onBeforeReplace: ctx.recoveryBeforeReplace(CREDENTIAL, outcome, ctx.choose) });
  assert.ok(!ctx.calls.some(([k]) => k === "choose"));
  assert.equal(ctx.requests.filter((r) => r.method === "PUT").length, 1);
  assert.equal(ctx.localStorage.store.size, 0, "0 語は退避しない");
});

test("復旧: 保存に失敗したら切り替えない（退避は残す）", async () => {
  const ctx = adoptSandbox({ localWords: [word("l1", "zebra", "l1")], remoteState: REMOTE(), choose: async () => "append", putStatus: 500 });
  const outcome = {};
  const before = JSON.stringify(ctx.appState);
  await ctx.adoptV2Room(CREDENTIAL, { onBeforeReplace: ctx.recoveryBeforeReplace(CREDENTIAL, outcome, ctx.choose) });
  assert.equal(outcome.value, "fail");
  assert.equal(JSON.stringify(ctx.appState), before);
  assert.ok(!ctx.calls.some(([k]) => k === "activate"));
  assert.ok(ctx.localStorage.store.has("wordsnap-recovery-backup:v1"));
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
  };
  run(ctx, [
    extractConst("V2_ROOM_ID_PATTERN"),
    extractConst("PASSKEY_LINKED_KEY"),
    extractConst("PASSKEY_TOKEN_MAX_AGE_MS"),
    extractConst("PASSKEY_FRESH_MAX_AGE_MS"),
    "let passkeySession = null; let passkeyBusy = false;",
    ...["readPasskeyLinked", "writePasskeyLinked", "clearPasskeyLinked", "bytesToBase64Url", "base64UrlToBytes", "passkeyError",
      "accountApi", "passkeyErrorMessage", "passkeySessionValid", "passkeyRegister", "serializeRegistration", "passkeyLogin",
      "passkeyToken", "setPasskeyBusy", "passkeyLinkCurrentRoom"].map(extractFunction),
  ]);
  await ctx.passkeyLinkCurrentRoom();
  assert.deepEqual(ops, [], "0 語の部屋は結びつけない");
  ctx.appState.words.push({ term: "apple" });
  await ctx.passkeyLinkCurrentRoom();
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
