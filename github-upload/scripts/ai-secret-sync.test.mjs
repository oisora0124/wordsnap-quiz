// AIキー暗号化同期の送信・受信経路の凍結ゲート（B-2 / B-3）。設計: docs/ai-secret-sync-design.md
//
// 公開HTML内の実コードを取り出して**実際に走らせる**。封筒の暗号は本物の WebCrypto を使う。
// 文字列の出現を数えるだけの検査では、配線を差し替えても通ってしまう
// （既存ユーザーを守る性質「トグルOFFなら送信内容が従来と完全に同一」は、
//  実際に組み立てて比較しない限り保証できない）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

function extractFunction(name) {
  const found = html.indexOf(`function ${name}(`);
  assert.ok(found >= 0, `function ${name} が見つかること`);
  const start = html.slice(found - 6, found) === "async " ? found - 6 : found;
  const bodyBrace = html.indexOf("{", html.indexOf(")", found));
  let depth = 0;
  for (let i = bodyBrace; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

function extractSimpleConst(name) {
  const line = new RegExp(`^const ${name} = .*;$`, "m").exec(html);
  assert.ok(line, `const ${name} が見つかること`);
  return line[0];
}

const CONSTS = [
  "AI_KEY_SYNC_AVAILABLE",
  "AI_KEY_SYNC_KEY",
  "AI_SECRET_STAMP_KEY",
  "AI_SECRET_ENVELOPE_VERSION",
  "AI_SECRET_ALG",
  "AI_SECRET_KDF",
  "AI_SECRET_HKDF_INFO",
  "AI_SECRET_ENVELOPE_LIMIT",
  "AI_SECRET_VALUE_LIMIT",
  "AI_SECRET_FUTURE_TOLERANCE_MS",
  "AI_PERSIST_KEY",
];

const FUNCTIONS = [
  "aiKeyStorageKey",
  "aiKeysPersisted",
  "getAiKey",
  "setAiKey",
  "aiKeySyncEnabled",
  "readAiSecretStamps",
  "writeAiSecretStamps",
  "bumpAiSecretStamp",
  "aiSecretCryptoAvailable",
  "aiSecretSyncRoute",
  "aiSecretBytesToBase64",
  "aiSecretBase64ToBytes",
  "deriveAiSecretKey",
  "aiSecretAad",
  "sanitizeAiSecretKeys",
  "aiSecretMaxUpdatedAt",
  "validAiSecretEnvelope",
  "sealAiSecrets",
  "openAiSecrets",
  "currentAiSecretKeySet",
  "clearAiSecretEnvelopeCache",
  "aiSecretEnvelopeCacheMatches",
  "refreshAiSecretEnvelope",
  "onAiSecretsChangedLocally",
  "aiSecretEnvelopeForPayload",
  "syncAiKeyFieldsFromStorage",
  "adoptAiSecretsFromState",
  "buildSyncPayloadState",
];

const ROOM_A = `wr_${"1".repeat(32)}`;
const VAULT_A = `wv_${"2".repeat(64)}`;
const ROOM_B = `wr_${"3".repeat(32)}`;
const VAULT_B = `wv_${"4".repeat(64)}`;
const GEMINI = "AIzaTESTKEY-gemini-do-not-use";
const GROQ = "gsk_TESTKEY-groq-do-not-use";

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

// 実コードを走らせるための最小の器。同期・UI・時刻だけを差し替え、
// 暗号とロジックは実物をそのまま使う。
function makeApp({
  // available=false で緊急停止スイッチを切った状態のランタイムを組む。
  // 文字列一致だけでは「切ったときに本当に止まるか」を確かめられない。
  available = true,
  syncOn = true,
  credential = { status: "active", roomId: ROOM_A, secret: `wk_${"9".repeat(60)}`, vaultKey: VAULT_A },
  isV2 = true,
  persist = true,
  now = 1753500000000,
} = {}) {
  const localStorage = fakeStorage();
  const sessionStorage = fakeStorage();
  if (syncOn) localStorage.setItem("wordsnap-ai-key-sync", "1");
  localStorage.setItem("wordsnap-ai-persist", persist ? "1" : "0");
  const pushes = [];
  let clock = now;

  const context = {
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    JSON,
    Object,
    Number,
    Math,
    String,
    Array,
    Boolean,
    Set,
    Map,
    Promise,
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    Date: { now: () => clock },
    localStorage,
    sessionStorage,
    AI_PROVIDERS: [{ id: "gemini" }, { id: "groq" }],
    GEMINI_MODEL_PREF_KEY: "wordsnap-gemini-model",
    geminiModelMemory: new Map(),
    geminiUnavailableModels: new Map(),
    shortKeyFingerprint: (v) => String(v).slice(0, 6),
    getActiveV2Credential: () => (credential?.status === "active" ? credential : null),
    syncRequestRoute: () => ({
      isV2,
      roomId: isV2 ? credential?.roomId || "" : "",
      expectedSyncId: isV2 ? credential?.roomId || "" : "legacy-id",
    }),
    scheduleSyncPush: () => pushes.push(clock),
    setStatus: () => {},
    trackUsage: () => {},
    elements: { aiKeyFields: null },
    document: { activeElement: null },
    LEARNING_SCHEMA_VERSION: 1,
    appState: {
      learningSchemaVersion: 1,
      words: [{ id: "w1", term: "apple", meaning: "りんご", enrich: { example: "x" } }],
      decks: [{ id: "d1", name: "単語帳1", updatedAt: 0 }],
      quizCounter: 0,
      activeDeckId: "all",
      savedAt: 0,
      deletions: [],
      trash: [],
      streak: {},
    },
  };

  const source = [
    "let aiSecretEnvelopeCache = null;",
    "let aiSecretEnvelopeGeneration = 0;",
    "let aiSecretMismatchNotifiedRoom = \"\";",
    ...CONSTS.map((name) => (
      name === "AI_KEY_SYNC_AVAILABLE" && !available
        ? "const AI_KEY_SYNC_AVAILABLE = false;"
        : extractSimpleConst(name)
    )),
    ...FUNCTIONS.map(extractFunction),
  ].join("\n");
  vm.runInNewContext(source, context);

  return {
    ctx: context,
    pushes,
    setClock: (t) => {
      clock = t;
    },
    setCredential: (next) => {
      credential = next;
    },
    setSyncOn: (on) => localStorage.setItem("wordsnap-ai-key-sync", on ? "1" : "0"),
    localStorage,
    sessionStorage,
  };
}

// 合流処理も公開HTMLの関数をそのまま走らせる。通信と描画だけを成功応答へ差し替え、
// activateV2Credentialへ渡された資格情報を観測する。
async function runSuccessfulV2Join(app, transferCode) {
  let activated = null;
  app.ctx.elements = {
    ...app.ctx.elements,
    syncV2JoinInput: { value: transferCode },
  };
  Object.assign(app.ctx, {
    syncServerAvailable: () => true,
    setV2Status: () => {},
    setV2Busy: () => {},
    v2SyncEndpoint: () => "/api/test",
    v2Fetch: async () => ({ status: 200 }),
    readJsonResponse: async () => ({
      stateRev: 7,
      state: { ...app.ctx.appState },
    }),
    validSyncGetResponse: () => true,
    snapshotState: () => ({ ...app.ctx.appState, words: [...app.ctx.appState.words] }),
    activateV2Credential: (credential) => {
      activated = { ...credential, status: "active" };
      app.setCredential(activated);
      return activated;
    },
    syncState: { applyingRemote: false },
    normalizeState: (state) => state,
    defaultState: () => ({ ...app.ctx.appState }),
    invalidatePersonalFactorCache: () => {},
    currentQuiz: null,
    selectedIds: new Set(),
    persistAppState: () => {},
    offerUndo: () => {},
    recordVerifiedSync: () => {},
    setV2JoinUndoVisible: () => {},
    renderAll: () => {},
    renderV2CredentialUi: () => {},
  });
  vm.runInNewContext(
    [
      'let v2JoinConfirm = { roomId: "", at: 0 };',
      extractFunction("parseV2TransferCode"),
      extractFunction("joinV2Room"),
    ].join("\n"),
    app.ctx,
  );
  await app.ctx.joinV2Room();
  return activated;
}

// ---- G1 / G21: 既存ユーザーを守る中心的な性質 -------------------------------

test("トグルOFFのとき、送信stateは従来と完全に同一（aiSecretsキー自体が無い）", async () => {
  const off = makeApp({ syncOn: false });
  off.ctx.setAiKey("gemini", GEMINI);
  await off.ctx.refreshAiSecretEnvelope({ push: true });
  const payload = off.ctx.buildSyncPayloadState();
  assert.ok(!("aiSecrets" in payload), "aiSecretsキーが存在しないこと");
  assert.deepEqual(
    Object.keys(payload).sort(),
    ["activeDeckId", "decks", "deletions", "learningSchemaVersion", "quizCounter", "savedAt", "streak", "trash", "words"],
  );
  assert.equal(off.pushes.length, 0, "OFFなら余計な送信予約もしないこと");
});

test("トグルOFFの送信stateは、機能導入前の組み立て結果とJSON文字列レベルで一致する", () => {
  const off = makeApp({ syncOn: false });
  const legacyShape = {
    ...off.ctx.appState,
    learningSchemaVersion: 1,
    words: off.ctx.appState.words.map(({ enrich, ...rest }) => rest),
  };
  assert.equal(JSON.stringify(off.ctx.buildSyncPayloadState()), JSON.stringify(legacyShape));
});

test("送信stateから enrich が除かれる既存の性質は変わらない", () => {
  const app = makeApp();
  const payload = app.ctx.buildSyncPayloadState();
  assert.ok(!("enrich" in payload.words[0]), "enrichが送信されないこと");
});

// ---- G2 / G2b: 鍵素材が無い経路 ---------------------------------------------

test("legacy経路では封筒を作らない", async () => {
  const app = makeApp({ isV2: false });
  app.ctx.setAiKey("gemini", GEMINI);
  await app.ctx.refreshAiSecretEnvelope();
  assert.equal(app.ctx.aiSecretEnvelopeForPayload(), null);
  assert.ok(!("aiSecrets" in app.ctx.buildSyncPayloadState()));
});

test("vault keyを持たない資格情報では封筒を作らない（2要素の旧コードで合流した端末）", async () => {
  const app = makeApp({
    credential: { status: "active", roomId: ROOM_A, secret: `wk_${"9".repeat(60)}` },
  });
  app.ctx.setAiKey("gemini", GEMINI);
  await app.ctx.refreshAiSecretEnvelope();
  assert.equal(app.ctx.aiSecretEnvelopeForPayload(), null);
});

test("V2資格情報がpendingのうちは封筒を作らない", async () => {
  const app = makeApp({
    credential: { status: "pending", roomId: ROOM_A, secret: `wk_${"9".repeat(60)}`, vaultKey: VAULT_A },
  });
  app.ctx.setAiKey("gemini", GEMINI);
  await app.ctx.refreshAiSecretEnvelope();
  assert.equal(app.ctx.aiSecretEnvelopeForPayload(), null);
});

// ---- 送信側の中身 -----------------------------------------------------------

test("トグルONなら封筒が送信stateに載り、平文キーはどこにも現れない", async () => {
  const app = makeApp();
  app.ctx.setAiKey("gemini", GEMINI);
  await app.ctx.refreshAiSecretEnvelope();
  const payload = app.ctx.buildSyncPayloadState();
  assert.ok(payload.aiSecrets, "封筒が載ること");
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes(GEMINI), "送信本文に平文キーが出ないこと");
  assert.ok(!serialized.includes("AIza"), "接頭辞すら出ないこと");
});

// G2c
test("vault key は送信stateのどこにも現れない", async () => {
  const app = makeApp();
  app.ctx.setAiKey("gemini", GEMINI);
  await app.ctx.refreshAiSecretEnvelope();
  const serialized = JSON.stringify(app.ctx.buildSyncPayloadState());
  assert.ok(!serialized.includes(VAULT_A), "vault keyが送信されないこと");
  assert.ok(!serialized.includes("wv_"), "vault keyの接頭辞すら出ないこと");
});

test("一度も触っていないproviderは封筒に入らない（未設定を削除として伝えない）", async () => {
  const app = makeApp();
  app.ctx.setAiKey("gemini", GEMINI);
  await app.ctx.refreshAiSecretEnvelope();
  const opened = await app.ctx.openAiSecrets(ROOM_A, VAULT_A, app.ctx.aiSecretEnvelopeForPayload());
  assert.ok(opened.keys.gemini, "触ったproviderは入ること");
  assert.equal(opened.keys.groq, undefined, "触っていないproviderは入らないこと");
});

// 6.2: キーだけ変えても単語は変わらないので、これが無いと封筒が永久に送られない
test("キーを変えると送信が予約される（トグルONのときだけ）", async () => {
  const app = makeApp();
  app.ctx.setAiKey("gemini", GEMINI);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(app.pushes.length >= 1, "送信が予約されること");
});

test("同じ値を入れ直しても送信予約は増えない", async () => {
  const app = makeApp();
  app.ctx.setAiKey("gemini", GEMINI);
  await new Promise((r) => setTimeout(r, 10));
  const before = app.pushes.length;
  app.ctx.setAiKey("gemini", GEMINI);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(app.pushes.length, before, "値が変わらなければ予約しないこと");
});

// G18
test("暗号化中に部屋が変わったら、その結果はキャッシュに載らない", async () => {
  const app = makeApp();
  app.ctx.setAiKey("gemini", GEMINI);
  const pending = app.ctx.refreshAiSecretEnvelope();
  app.setCredential({ status: "active", roomId: ROOM_B, secret: `wk_${"8".repeat(60)}`, vaultKey: VAULT_B });
  await pending;
  assert.equal(app.ctx.aiSecretEnvelopeForPayload(), null, "別部屋の封筒を送らないこと");
});

// ---- G12 / 受信側 -----------------------------------------------------------

async function envelopeFrom(keys, { roomId = ROOM_A, vaultKey = VAULT_A } = {}) {
  const app = makeApp();
  return app.ctx.sealAiSecrets(roomId, vaultKey, keys);
}

test("新しい封筒を受信するとキーを採用し、入力欄の値も更新する", async () => {
  const app = makeApp();
  const envelope = await envelopeFrom({
    gemini: { value: GEMINI, updatedAt: 1753500000000 },
  });
  const adopted = await app.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_A);
  assert.equal(adopted, true);
  assert.equal(app.ctx.getAiKey("gemini"), GEMINI);
});

// G12: これが崩れると、受信直後の再PUTが古いキーでサーバーを上書きする
test("採用した直後の送信stateには、採用した新しい封筒が載る", async () => {
  const app = makeApp();
  app.setClock(1753400000000);
  app.ctx.setAiKey("gemini", "OLD-LOCAL-KEY");
  await app.ctx.refreshAiSecretEnvelope();
  const envelope = await envelopeFrom({ gemini: { value: GEMINI, updatedAt: 1753500000000 } });
  app.setClock(1753500000000); // 相手が書いた時刻まで進む（未来許容の判定に掛からないように）
  const adopted = await app.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_A);
  assert.equal(adopted, true, "採用されること");
  const opened = await app.ctx.openAiSecrets(ROOM_A, VAULT_A, app.ctx.buildSyncPayloadState().aiSecrets);
  assert.equal(opened.keys.gemini.value, GEMINI, "古いキーを送り返さないこと");
  assert.equal(opened.keys.gemini.updatedAt, 1753500000000, "採用した時刻を保つこと");
});

// G6
test("復号に失敗しても、手元のキーは一切変わらない", async () => {
  const app = makeApp();
  app.ctx.setAiKey("gemini", "MY-LOCAL-KEY");
  const foreign = await envelopeFrom(
    { gemini: { value: GEMINI, updatedAt: 1753500000001 } },
    { roomId: ROOM_A, vaultKey: VAULT_B },
  );
  const adopted = await app.ctx.adoptAiSecretsFromState({ aiSecrets: foreign }, ROOM_A);
  assert.equal(adopted, false);
  assert.equal(app.ctx.getAiKey("gemini"), "MY-LOCAL-KEY");
});

test("応答が別の部屋のものなら採用しない", async () => {
  const app = makeApp();
  const envelope = await envelopeFrom({ gemini: { value: GEMINI, updatedAt: 1753500000001 } });
  assert.equal(await app.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_B), false);
  assert.equal(app.ctx.getAiKey("gemini"), "");
});

test("トグルOFFの端末は封筒を採用しない", async () => {
  const app = makeApp({ syncOn: false });
  const envelope = await envelopeFrom({ gemini: { value: GEMINI, updatedAt: 1753500000001 } });
  assert.equal(await app.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_A), false);
  assert.equal(app.ctx.getAiKey("gemini"), "");
});

// G17
test("現在時刻より24時間以上未来の封筒は採用しない（時計ずれ・細工）", async () => {
  const app = makeApp();
  const far = 1753500000000 + 25 * 60 * 60 * 1000;
  const envelope = await envelopeFrom({ gemini: { value: GEMINI, updatedAt: far } });
  assert.equal(await app.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_A), false);
  assert.equal(app.ctx.getAiKey("gemini"), "");
});

// 巻き戻り防止（8章）
test("手元のスタンプより古い封筒は採用しない", async () => {
  const app = makeApp();
  app.setClock(1753500000000);
  app.ctx.setAiKey("gemini", "NEWER-LOCAL");
  const envelope = await envelopeFrom({ gemini: { value: GEMINI, updatedAt: 1753400000000 } });
  assert.equal(await app.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_A), false);
  assert.equal(app.ctx.getAiKey("gemini"), "NEWER-LOCAL");
});

test("スタンプは永続化され、作り直した端末でも巻き戻らない", async () => {
  const app = makeApp();
  app.setClock(1753500000000);
  app.ctx.setAiKey("gemini", "NEWER-LOCAL");
  const stamps = JSON.parse(app.localStorage.getItem("wordsnap-ai-secrets-at"));
  assert.ok(stamps.gemini > 0, "スタンプがlocalStorageへ書かれること");
});

// G15: providerごとに勝敗が決まる
test("端末AのGemini更新と端末BのGroq更新が競合しても、両方残る", async () => {
  const app = makeApp();
  app.setClock(1000);
  app.ctx.setAiKey("groq", "MY-GROQ"); // この端末はGroqだけ後から更新した
  app.setClock(3000);
  app.ctx.setAiKey("groq", "MY-GROQ-NEWER");
  // 相手はGeminiだけを更新した封筒を送ってくる（Groqは古い）
  const envelope = await envelopeFrom({
    gemini: { value: GEMINI, updatedAt: 2000 },
    groq: { value: "THEIR-OLD-GROQ", updatedAt: 2000 },
  });
  app.setClock(4000);
  await app.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_A);
  assert.equal(app.ctx.getAiKey("gemini"), GEMINI, "相手の新しいGeminiを採用すること");
  assert.equal(app.ctx.getAiKey("groq"), "MY-GROQ-NEWER", "自分の新しいGroqを保つこと");
});

test("空文字は削除として採用される", async () => {
  const app = makeApp();
  app.setClock(1000);
  app.ctx.setAiKey("gemini", GEMINI);
  const envelope = await envelopeFrom({ gemini: { value: "", updatedAt: 5000 } });
  app.setClock(6000);
  await app.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_A);
  assert.equal(app.ctx.getAiKey("gemini"), "", "削除が伝搬すること");
});

// G7
test("採用は受信端末の「この端末に保存」設定に従う", async () => {
  const off = makeApp({ persist: false });
  const envelope = await envelopeFrom({ gemini: { value: GEMINI, updatedAt: 1753500000001 } });
  await off.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_A);
  assert.equal(off.ctx.getAiKey("gemini"), GEMINI, "このタブでは使えること");
  assert.equal(off.localStorage.getItem("wordsnap-ai-key:gemini"), null, "localStorageへは書かないこと");
  assert.equal(off.sessionStorage.getItem("wordsnap-ai-key:gemini"), GEMINI);

  const on = makeApp({ persist: true });
  await on.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_A);
  assert.equal(on.localStorage.getItem("wordsnap-ai-key:gemini"), GEMINI, "ONならlocalStorageへ書くこと");
});

test("採用ではスタンプを自分の時刻で進めず、封筒の時刻をそのまま使う", async () => {
  const app = makeApp();
  app.setClock(9999999999999);
  const envelope = await envelopeFrom({ gemini: { value: GEMINI, updatedAt: 1753500000001 } });
  app.setClock(1753500000002);
  await app.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_A);
  const stamps = JSON.parse(app.localStorage.getItem("wordsnap-ai-secrets-at"));
  assert.equal(stamps.gemini, 1753500000001, "封筒の時刻がスタンプになること");
});

test("壊れた封筒・封筒なしでも例外を投げず、手元のキーを保つ", async () => {
  const app = makeApp();
  app.ctx.setAiKey("gemini", "KEEP-ME");
  for (const state of [null, undefined, {}, { aiSecrets: null }, { aiSecrets: "x" }, { aiSecrets: {} }, { aiSecrets: [] }]) {
    assert.equal(await app.ctx.adoptAiSecretsFromState(state, ROOM_A), false, JSON.stringify(state));
  }
  assert.equal(app.ctx.getAiKey("gemini"), "KEEP-ME");
});

// ---- G14: 履歴の版では採用しない（配線側の検査） ----------------------------

test("syncRequestは履歴の版（revision指定）では封筒を採用しない配線になっている", () => {
  const source = extractFunction("syncRequest");
  assert.ok(
    /aiSecretsAdoptable[\s\S]*requestOptions\.revision/.test(source),
    "revision指定を採用対象から外していること",
  );
  assert.ok(
    /history !== true/.test(source),
    "history応答を採用対象から外していること",
  );
  assert.ok(
    /await adoptAiSecretsFromState/.test(source),
    "採用をawaitしていること（fire-and-forgetにしない）",
  );
  assert.ok(
    /response\.status === 409[\s\S]{0,200}adoptAiSecretsFromState/.test(source),
    "409応答の封筒も採用していること",
  );
});

test("採用は verifiedSyncTarget と同じ照合済みIDで行う", () => {
  const source = extractFunction("syncRequest");
  assert.ok(
    /adoptAiSecretsFromState\(data\?\.state, expectedSyncId\)/.test(source),
    "応答と照合済みの保存先IDを渡していること",
  );
});

// ---- 設定UI（B-4） ----------------------------------------------------------
// この機能で一番まずい失敗は「成立しない安全性を利用者に表示すること」なので、
// 文言そのものを凍結する。

const renderSource = extractFunction("renderAiKeyFields");

// 【この機能で最悪の失敗は「成立しない安全性を利用者に表示すること」】
// 以前はソースを正規表現で照合していたが、それでは実際に出る文字列を確かめていない。
// renderAiKeyFields() を本当に実行して、生成されたHTMLそのものを検査する。
function renderSettings({ syncOn, v2Active, vaultKey = true, available = true }) {
  const listeners = [];
  const stubEl = () => ({
    value: "",
    checked: false,
    dataset: { provider: "gemini", paste: "gemini", clear: "gemini" },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
  });
  let html = "";
  const container = {
    set innerHTML(value) { html = value; },
    get innerHTML() { return html; },
    querySelector: () => stubEl(),
    querySelectorAll: () => [stubEl()],
  };
  const app = makeApp({
    available,
    syncOn,
    credential: v2Active
      ? {
          status: "active",
          roomId: ROOM_A,
          secret: `wk_${"9".repeat(60)}`,
          ...(vaultKey ? { vaultKey: VAULT_A } : {}),
        }
      : null,
  });
  app.ctx.elements = { aiKeyFields: container };
  app.ctx.AI_PROVIDERS = [
    { id: "gemini", name: "Gemini", keyUrl: "https://example.com/k", placeholder: "AIza…" },
    { id: "groq", name: "Groq", keyUrl: "https://example.com/g", placeholder: "gsk_…" },
  ];
  // このテストが凍結したいのは同期まわりの「文言」なので、キーの有効性表示は
  // 呼ばれても何もしないスタブにする（表示そのものは別テストで検証する）。
  app.ctx.renderAiKeyStatuses = () => {};
  vm.runInNewContext(extractFunction("renderAiKeyFields"), app.ctx);
  app.ctx.renderAiKeyFields();
  return html;
}

test("実際に描画されるHTML: OFFのときは従来の文言のまま", () => {
  const html = renderSettings({ syncOn: false, v2Active: true });
  assert.ok(
    html.includes("キーはこの端末のブラウザだけに保存され、WordBankのサーバーへは送信されません。"),
    "OFFでは従来の文言が出ること",
  );
  assert.ok(!html.includes("暗号化してから他の端末と同期されます"), "ONの文言は出ないこと");
});

test("実際に描画されるHTML: ONのとき「サーバーへは送信されません」を含まない", () => {
  const html = renderSettings({ syncOn: true, v2Active: true });
  assert.ok(
    !html.includes("WordBankのサーバーへは送信されません"),
    "ONのとき虚偽になる文言を出さないこと",
  );
  assert.ok(html.includes("暗号化してから他の端末と同期されます"), "暗号化して同期すると書くこと");
});

test("実際に描画されるHTML: ONのとき運営が読み取れることを明示する", () => {
  const html = renderSettings({ syncOn: true, v2Active: true });
  assert.ok(html.includes("その気になれば読み取れます"), "運営が読み取れる旨を明示すること");
  assert.ok(!/運営(も|には|は)?読めません/.test(html), "「運営も読めません」とは書かないこと");
  assert.ok(
    !/サーバーは(中身を)?読めません/.test(html),
    "「サーバーは読めません」も書かないこと（運営＝配信元なので誤解を招く）",
  );
});

test("実際に描画されるHTML: トグルONでもvault keyが無ければ同期中と表示せず、直し方を示す", () => {
  const html = renderSettings({ syncOn: true, v2Active: true, vaultKey: false });
  assert.ok(!html.includes("キーは暗号化してから他の端末と同期されます"), "成立していない同期を表示しないこと");
  assert.ok(html.includes("暗号鍵がないため"), "同期できない理由を示すこと");
  assert.ok(html.includes("他の端末で引き継ぎコードを取り直し"), "復旧手順を示すこと");
  assert.ok(html.includes("そのコードから合流し直してください"), "この端末側の操作を示すこと");
});

test("実際に描画されるHTML: legacy端末にはトグルも同期の説明も出さない", () => {
  const html = renderSettings({ syncOn: false, v2Active: false });
  assert.ok(!html.includes("aiKeySyncToggle"), "トグルを出さないこと");
  assert.ok(!html.includes("APIキーも他の端末と同期する"), "同期の説明も出さないこと");
  assert.ok(
    html.includes("キーはこの端末のブラウザだけに保存され、WordBankのサーバーへは送信されません。"),
    "説明文は従来のままであること",
  );
});

test("実際に描画されるHTML: 既定はOFF（checkedが付かない）", () => {
  const html = renderSettings({ syncOn: false, v2Active: true });
  const toggle = /<input type="checkbox" id="aiKeySyncToggle"([^>]*)\/>/.exec(html);
  assert.ok(toggle, "トグルが描画されること");
  assert.ok(!toggle[1].includes("checked"), "既定でcheckedが付かないこと");
});

test("トグルはV2の同期に接続している端末にだけ出す", () => {
  assert.ok(
    /const activeV2Credential = getActiveV2Credential\(\);/.test(renderSource) &&
      /AI_KEY_SYNC_AVAILABLE && activeV2Credential[\s\S]{0,200}aiKeySyncToggle/.test(renderSource),
    "V2 active のときだけトグルを描画していること",
  );
});

test("有効化はユーザー操作からのみで、vault keyもそこでしか作らない", () => {
  const enableSource = extractFunction("enableAiKeySync");
  assert.ok(enableSource.includes("generateVaultKey()"), "有効化時にvault keyを作ること");
  assert.ok(
    /await syncRequest\("GET"\)/.test(enableSource),
    "sinceRev無しの完全GETを1回行うこと（無いと有効にしても何も起きない）",
  );
  assert.ok(
    /引き継ぎコードが新しくなりました/.test(enableSource),
    "コードを作り直したことを利用者へ伝えること",
  );
  // 起動・同期経路からvault keyを勝手に作らないこと
  for (const name of ["initWordsnapSync", "adoptAiSecretsFromState", "refreshAiSecretEnvelope", "connectWordsnapSync"]) {
    assert.ok(
      !extractFunction(name).includes("generateVaultKey"),
      `${name} からvault keyを作らないこと`,
    );
  }
});

test("無効化するとキャッシュを捨て、部屋からも封筒を消しにいく", () => {
  const disableSource = extractFunction("disableAiKeySync");
  assert.ok(disableSource.includes("clearAiSecretEnvelopeCache()"));
  assert.ok(disableSource.includes("scheduleSyncPush()"));
  assert.ok(/この端末のキーはそのまま残ります/.test(disableSource), "ローカルのキーは消さないと伝えること");
});

// ---- 「この端末に保存」オフでの復元（実ブラウザ検証で見つかった欠陥） ----------
// 既定はオフなので、これがこの機能の最も普通の使われ方になる。

test("持続オフでタブを開き直してキーが消えても、同じ時刻の封筒から復元する", async () => {
  const app = makeApp({ persist: false });
  app.setClock(1000);
  app.ctx.setAiKey("gemini", GEMINI);
  const envelope = await app.ctx.sealAiSecrets(ROOM_A, VAULT_A, app.ctx.currentAiSecretKeySet());
  // タブを閉じた＝sessionStorageが消えた状態を作る（スタンプはlocalStorageに残る）
  app.sessionStorage.map.clear();
  assert.equal(app.ctx.getAiKey("gemini"), "", "前提: キーが消えていること");
  const adopted = await app.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_A);
  assert.equal(adopted, true, "同じ時刻でも復元されること");
  assert.equal(app.ctx.getAiKey("gemini"), GEMINI);
});

test("復元は巻き戻りにならない: 手元に値があるなら同じ時刻の封筒で上書きしない", async () => {
  const app = makeApp();
  app.setClock(1000);
  app.ctx.setAiKey("gemini", "LOCAL-VALUE");
  const stamps = JSON.parse(app.localStorage.getItem("wordsnap-ai-secrets-at"));
  const envelope = await app.ctx.sealAiSecrets(ROOM_A, VAULT_A, {
    gemini: { value: "OTHER-VALUE", updatedAt: stamps.gemini },
  });
  assert.equal(await app.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_A), false);
  assert.equal(app.ctx.getAiKey("gemini"), "LOCAL-VALUE");
});

test("復元は削除の伝搬を壊さない: 空を空で上書きしない", async () => {
  const app = makeApp();
  app.setClock(1000);
  app.ctx.setAiKey("gemini", GEMINI);
  app.setClock(2000);
  app.ctx.setAiKey("gemini", ""); // 削除した
  const stamps = JSON.parse(app.localStorage.getItem("wordsnap-ai-secrets-at"));
  const envelope = await app.ctx.sealAiSecrets(ROOM_A, VAULT_A, {
    gemini: { value: "", updatedAt: stamps.gemini },
  });
  assert.equal(await app.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_A), false);
  assert.equal(app.ctx.getAiKey("gemini"), "", "削除された状態が保たれること");
});

test("V2 active になった時点でトグルの表示を作り直す（新規ユーザーが再読み込み不要）", () => {
  const source = extractFunction("refreshAiKeySyncToggleVisibility");
  assert.ok(source.includes("getActiveV2Credential()"), "V2 active を条件にすること");
  assert.ok(
    /if \(shouldShow !== shown\) renderAiKeyFields\(\);/.test(source),
    "表示の要否が変わったときだけ描き直すこと（入力中の欄を壊さない）",
  );
  for (const caller of ["renderV2CredentialUi", "applySyncIdentityUi"]) {
    assert.ok(
      extractFunction(caller).includes("refreshAiKeySyncToggleVisibility()"),
      `${caller} から呼ぶこと`,
    );
  }
});

// ---- 導入前から入っているキーの取り込み（デプロイ前監査で見つかった欠陥） --------
// この機能より前にAPIキーを入れてある利用者（開発者自身がそう）はスタンプを持たない。
// スタンプの無い provider は封筒に入らないので、これが無いと有効にしても
// 何も同期されないまま黙って終わる。

test("有効化は、既にこの端末に入っているキーを機能の対象へ取り込む", () => {
  const source = extractFunction("enableAiKeySync");
  assert.ok(
    /if \(stamps\[provider\.id\]\) continue;[\s\S]{0,120}if \(!getAiKey\(provider\.id\)\) continue;/.test(source),
    "スタンプが無く、かつキーが入っている provider だけを拾うこと",
  );
  // 順序: 相手の封筒を採用してから拾う。逆だと自分のスタンプが新しくなり採用を塞ぐ。
  const getIndex = source.indexOf('await syncRequest("GET")');
  const stampIndex = source.indexOf("readAiSecretStamps()");
  assert.ok(getIndex >= 0 && stampIndex > getIndex, "完全GETの後に取り込むこと");
});

test("スタンプが無いキーは封筒に入らない（取り込み前の状態）", async () => {
  const app = makeApp();
  // 機能導入前から入っているキーを再現する（setAiKeyを通さずストレージへ直接置く）
  app.sessionStorage.setItem("wordsnap-ai-key:gemini", GEMINI);
  assert.equal(app.ctx.getAiKey("gemini"), GEMINI, "前提: キーは読める");
  assert.equal(app.ctx.currentAiSecretKeySet(), null, "スタンプが無いので封筒の対象にならない");
  await app.ctx.refreshAiSecretEnvelope();
  assert.equal(app.ctx.aiSecretEnvelopeForPayload(), null);
});

test("スタンプを与えると、そのキーが封筒に入る", async () => {
  const app = makeApp();
  app.sessionStorage.setItem("wordsnap-ai-key:gemini", GEMINI);
  app.ctx.writeAiSecretStamps({ gemini: 1753500000000, groq: 0 });
  const keys = app.ctx.currentAiSecretKeySet();
  assert.equal(keys.gemini.value, GEMINI);
  assert.equal(keys.groq, undefined, "空のままの provider は入らないこと");
  await app.ctx.refreshAiSecretEnvelope();
  const opened = await app.ctx.openAiSecrets(ROOM_A, VAULT_A, app.ctx.aiSecretEnvelopeForPayload());
  assert.equal(opened.keys.gemini.value, GEMINI);
});

// ---- 緊急停止スイッチ -------------------------------------------------------
// 切り戻しをコミットのrevertでやると、引き継ぎコードの3要素解析まで戻ってしまい、
// 配布済みの新しいコードが解析できなくなる＝利用者を締め出す。
// 1行のスイッチで止められることを固定する。

test("通常のデプロイでは緊急停止スイッチはtrueである", () => {
  const decl = /^const AI_KEY_SYNC_AVAILABLE = (true|false);$/m.exec(html);
  assert.ok(decl, "緊急停止スイッチが1行の定数であること");
  assert.equal(decl[1], "true", "通常はtrueであること");
});

// スイッチを実際に false にしたランタイムを組んで動かす。
// 「関数の中に定数名が出てくる」ことだけを見ても、止まる保証にはならない。
test("AI_KEY_SYNC_AVAILABLE を false にすると、封筒を作らず送らない", async () => {
  const stopped = makeApp({ available: false, syncOn: true });
  stopped.ctx.setAiKey("gemini", GEMINI);
  await stopped.ctx.refreshAiSecretEnvelope({ push: true });

  assert.equal(stopped.ctx.aiKeySyncEnabled(), false, "トグルがONでも無効であること");
  assert.equal(stopped.ctx.aiSecretSyncRoute(), null, "送信経路が立たないこと");
  assert.equal(stopped.ctx.aiSecretEnvelopeForPayload(), null, "封筒を持たないこと");
  const payload = stopped.ctx.buildSyncPayloadState();
  assert.ok(!("aiSecrets" in payload), "aiSecretsキー自体が存在しないこと");
  assert.equal(stopped.pushes.length, 0, "余計な送信予約もしないこと");
});

test("AI_KEY_SYNC_AVAILABLE を false にすると、届いた封筒も採用しない", async () => {
  // まず有効な端末で封筒を作り、それを停止済みの端末へ渡す。
  const source = makeApp({ syncOn: true });
  source.ctx.setAiKey("gemini", GEMINI);
  await source.ctx.refreshAiSecretEnvelope({ push: true });
  const envelope = source.ctx.aiSecretEnvelopeForPayload();
  assert.ok(envelope, "検証の前提として封筒が作れていること");

  const stopped = makeApp({ available: false, syncOn: true });
  await stopped.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_A);
  assert.equal(stopped.ctx.getAiKey("gemini"), "", "停止中はキーを取り込まないこと");
});

test("AI_KEY_SYNC_AVAILABLE を false にすると、設定のトグルを出さない", () => {
  const markup = renderSettings({ available: false, syncOn: true, v2Active: true });
  assert.ok(!markup.includes("aiKeySyncToggle"), "停止中はトグル自体を描画しないこと");
  assert.ok(
    markup.includes("キーはこの端末のブラウザだけに保存され、WordBankのサーバーへは送信されません。"),
    "停止中は従来の（同期しない）文言に戻ること",
  );
  assert.ok(!markup.includes("暗号化してから他の端末と同期されます"), "同期する文言を出さないこと");
});

test("停止しても引き継ぎコードの3要素解析は残る（配布済みのコードを無効にしない）", () => {
  // 解析はスイッチを参照しない＝停止しても新しいコードで合流できる
  assert.ok(
    !extractFunction("parseV2TransferCode").includes("AI_KEY_SYNC_AVAILABLE"),
    "解析はスイッチに依存しないこと",
  );
  assert.ok(
    !extractFunction("normalizeV2Credential").includes("AI_KEY_SYNC_AVAILABLE"),
    "資格情報の正規化もスイッチに依存しないこと",
  );
});

// ---- 合流コードの後方互換性 -------------------------------------------------

test("同じ部屋の2要素コードで合流し直しても、既存のvault keyを失わない", async () => {
  const app = makeApp();
  const current = app.ctx.getActiveV2Credential();
  const active = await runSuccessfulV2Join(app, `${current.roomId}.${current.secret}`);
  assert.ok(active, "合流が完了すること");
  assert.equal(active.vaultKey, current.vaultKey, "既存のvault keyを保持すること");
});

test("同じ部屋でも3要素目に異なるvault keyがあれば、入力した鍵へ差し替える", async () => {
  const app = makeApp();
  const current = app.ctx.getActiveV2Credential();
  const active = await runSuccessfulV2Join(
    app,
    `${current.roomId}.${current.secret}.${VAULT_B}`,
  );
  assert.ok(active, "合流が完了すること");
  assert.equal(active.vaultKey, VAULT_B, "3要素目を明示した場合は入力側を採用すること");
});

// ---- 差分レビューで指摘されたデプロイ阻止級の2件 ------------------------------

// 【再読み込みで部屋から封筒が消える】
// キャッシュはメモリ上にしかない。起動時のGETで届いた封筒が手元と同じ内容だと
// changed=false で早期returnし、キャッシュが空のまま残る。その状態で単語を編集すると
// 次のPUTから aiSecrets が落ちて、部屋から封筒が消える＝他端末の同期が止まる。
test("再読み込み後、同じ内容の封筒を受け取っても、次のPUTで封筒が消えない", async () => {
  const app = makeApp({ persist: true });
  app.setClock(1000);
  app.ctx.setAiKey("gemini", GEMINI);
  const envelope = await app.ctx.sealAiSecrets(ROOM_A, VAULT_A, app.ctx.currentAiSecretKeySet());
  // 再読み込みを再現: メモリ上のキャッシュだけが消える（キーとスタンプは残る）
  app.ctx.clearAiSecretEnvelopeCache();
  assert.equal(app.ctx.aiSecretEnvelopeForPayload(), null, "前提: キャッシュが空であること");

  const adopted = await app.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_A);
  assert.equal(adopted, false, "内容が同じなので採用は起きない");

  const payload = app.ctx.buildSyncPayloadState();
  assert.ok(payload.aiSecrets, "それでも次のPUTには封筒が載ること（部屋から消さない）");
  const opened = await app.ctx.openAiSecrets(ROOM_A, VAULT_A, payload.aiSecrets);
  assert.equal(opened.keys.gemini.value, GEMINI);
});

test("トグルOFFの端末では、この作り直しも起きない", async () => {
  const off = makeApp({ syncOn: false });
  off.ctx.clearAiSecretEnvelopeCache();
  const envelope = await makeApp().ctx.sealAiSecrets(ROOM_A, VAULT_A, {
    gemini: { value: GEMINI, updatedAt: 1753500000000 },
  });
  await off.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_A);
  assert.equal(off.ctx.aiSecretEnvelopeForPayload(), null);
  assert.ok(!("aiSecrets" in off.ctx.buildSyncPayloadState()), "OFFでは封筒を作らないこと");
});

// 【復号中の同期先切替】
// 復号は非同期。待っている間に別の部屋へ合流していると、旧部屋のキーを新しい部屋へ
// 適用し、そのまま新しい部屋の封筒として暗号化して送ってしまう。
test("復号を待っている間に別の部屋へ切り替わったら、キーを適用しない", async () => {
  const app = makeApp();
  app.ctx.setAiKey("gemini", "MY-OWN-KEY");
  const foreign = await makeApp().ctx.sealAiSecrets(ROOM_A, VAULT_A, {
    gemini: { value: GEMINI, updatedAt: 9753500000000 },
  });
  app.setClock(9753500000000);
  const pending = app.ctx.adoptAiSecretsFromState({ aiSecrets: foreign }, ROOM_A);
  // 復号の途中で別の部屋へ合流する
  app.setCredential({ status: "active", roomId: ROOM_B, secret: `wk_${"8".repeat(60)}`, vaultKey: VAULT_B });
  assert.equal(await pending, false, "採用しないこと");
  assert.equal(app.ctx.getAiKey("gemini"), "MY-OWN-KEY", "旧部屋のキーを新しい部屋へ持ち込まないこと");
});

test("同じ部屋IDのまま vault key だけ差し替わった場合も採用しない", async () => {
  const app = makeApp();
  app.ctx.setAiKey("gemini", "MY-OWN-KEY");
  const envelope = await makeApp().ctx.sealAiSecrets(ROOM_A, VAULT_A, {
    gemini: { value: GEMINI, updatedAt: 9753500000000 },
  });
  app.setClock(9753500000000);
  const pending = app.ctx.adoptAiSecretsFromState({ aiSecrets: envelope }, ROOM_A);
  app.setCredential({ status: "active", roomId: ROOM_A, secret: `wk_${"9".repeat(60)}`, vaultKey: VAULT_B });
  assert.equal(await pending, false);
  assert.equal(app.ctx.getAiKey("gemini"), "MY-OWN-KEY");
});

test("封筒のキャッシュは vault key も照合する", async () => {
  const app = makeApp();
  app.ctx.setAiKey("gemini", GEMINI);
  await app.ctx.refreshAiSecretEnvelope();
  assert.ok(app.ctx.aiSecretEnvelopeForPayload(), "前提: 封筒があること");
  // 同じ部屋のまま vault key だけ差し替える
  app.setCredential({ status: "active", roomId: ROOM_A, secret: `wk_${"9".repeat(60)}`, vaultKey: VAULT_B });
  assert.equal(app.ctx.aiSecretEnvelopeForPayload(), null, "旧vault keyの封筒を送らないこと");
});

test("同期先を切り替えた後は旧部屋のキャッシュを無効とみなし、新しい部屋の封筒を作り直す", async () => {
  const app = makeApp();
  app.ctx.setAiKey("gemini", GEMINI);
  await app.ctx.refreshAiSecretEnvelope();
  assert.equal(
    app.ctx.aiSecretEnvelopeCacheMatches({ roomId: ROOM_A, vaultKey: VAULT_A }),
    true,
    "前提: 旧部屋のキャッシュが有効であること",
  );

  app.setCredential({
    status: "active",
    roomId: ROOM_B,
    secret: app.ctx.getActiveV2Credential().secret,
    vaultKey: VAULT_B,
  });
  assert.equal(
    app.ctx.aiSecretEnvelopeCacheMatches({ roomId: ROOM_B, vaultKey: VAULT_B }),
    false,
    "旧部屋のキャッシュを新しい部屋のものと数えないこと",
  );
  assert.equal(app.ctx.aiSecretEnvelopeForPayload(), null, "旧部屋の封筒を送らないこと");

  const received = await app.ctx.sealAiSecrets(
    ROOM_B,
    VAULT_B,
    app.ctx.currentAiSecretKeySet(),
  );
  assert.equal(
    await app.ctx.adoptAiSecretsFromState({ aiSecrets: received }, ROOM_B),
    false,
    "同じ内容なのでキー自体の採用は起きないこと",
  );

  const payloadEnvelope = app.ctx.aiSecretEnvelopeForPayload();
  assert.ok(payloadEnvelope, "新しい部屋用の封筒が次のPUTに載ること");
  const opened = await app.ctx.openAiSecrets(ROOM_B, VAULT_B, payloadEnvelope);
  assert.equal(opened.keys.gemini.value, GEMINI, "新しい部屋のvault keyで開けること");
});

test("JSON書き出しは vault key も含める（含めないと復元先が分岐する）", () => {
  const source = extractFunction("buildJsonBackupPayload");
  assert.ok(
    /\.\.\.\(active\.vaultKey \? \{ vaultKey: active\.vaultKey \} : \{\}\)/.test(source),
    "vault keyを含めること",
  );
  assert.ok(source.includes("secret: active.secret"), "従来どおりsecretも含むこと（同じ明示同意）");
});

// ---- 分岐の可視化（サイクル1の改善） ----------------------------------------
// vault key はサーバー経由で合意できないので、2台が別々の鍵を持つ分岐が起こりうる。
// 復号失敗は握り潰す設計（フェイルセーフ）だが、黙ったままだと利用者は気づけない。

test("封筒はあるのに開けないとき、利用者に知らせる", async () => {
  const app = makeApp();
  const notices = [];
  app.ctx.setStatus = (m) => notices.push(m);
  app.ctx.setAiKey("gemini", "MY-KEY");
  // 別の vault key で作られた封筒（＝分岐している相手）
  const foreign = await makeApp().ctx.sealAiSecrets(ROOM_A, VAULT_B, {
    gemini: { value: GEMINI, updatedAt: 9753500000000 },
  });
  app.setClock(9753500000000);
  assert.equal(await app.ctx.adoptAiSecretsFromState({ aiSecrets: foreign }, ROOM_A), false);
  assert.equal(notices.length, 1, "1回知らせること");
  assert.match(notices[0], /復号できませんでした/);
  assert.match(notices[0], /引き継ぎコード/, "何をすれば直るかを書くこと");
  assert.equal(app.ctx.getAiKey("gemini"), "MY-KEY", "手元のキーは変えないこと");
});

test("同じ部屋では繰り返し知らせない（ポーリングのたびに出さない）", async () => {
  const app = makeApp();
  const notices = [];
  app.ctx.setStatus = (m) => notices.push(m);
  const foreign = await makeApp().ctx.sealAiSecrets(ROOM_A, VAULT_B, {
    gemini: { value: GEMINI, updatedAt: 9753500000000 },
  });
  app.setClock(9753500000000);
  for (let i = 0; i < 5; i += 1) {
    await app.ctx.adoptAiSecretsFromState({ aiSecrets: foreign }, ROOM_A);
  }
  assert.equal(notices.length, 1, "5回試しても1回だけであること");
});

test("トグルOFFの端末には、この通知も出さない", async () => {
  const off = makeApp({ syncOn: false });
  const notices = [];
  off.ctx.setStatus = (m) => notices.push(m);
  const foreign = await makeApp().ctx.sealAiSecrets(ROOM_A, VAULT_B, {
    gemini: { value: GEMINI, updatedAt: 9753500000000 },
  });
  await off.ctx.adoptAiSecretsFromState({ aiSecrets: foreign }, ROOM_A);
  assert.equal(notices.length, 0);
});

test("引き継ぎコードの案内が3要素に触れている（貼り付け前に不安にさせない）", () => {
  assert.ok(
    html.includes('placeholder="wr_….wk_…（.wv_…）を貼り付け"'),
    "入力欄のプレースホルダが3要素目に触れること",
  );
  const joinError = /引き継ぎコードの形式を確認してください。[^"]*/.exec(html);
  assert.ok(joinError, "形式エラーの文言が見つかること");
  assert.ok(joinError[0].includes("wv_"), "形式エラーの説明も3要素目に触れること");
});
