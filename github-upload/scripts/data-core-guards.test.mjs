// データ保全の中核（取り込み・削除・復元・単語帳操作・JSON入出力）の Codex レビュー
// （gpt-5.6-sol / gpt-6-astra, 2026-09-13）で直した点を、実コードのまま固定する（1.0.108）。
//
// 1. 「元に戻す」は、取り消す操作のあとに学習・同期・編集で内容が変わっていたら適用しない
//    （undoSignature / performUndo）。丸ごと戻すと別の語の学習まで巻き戻るため。
// 2. 単語帳をまたぐ移動（単体・一括・単語帳の削除）は、移動先に同じ語があれば止める
//    （deckHasTerm）。同じ単語帳に同じ語が2つあると次の同期で1語に畳まれ、片方の意味が消える。
// 3. 移動先に同じ語の墓標が残っていたら、移動した語が次の同期で消えないようにする
//    （reviveAgainstDeletion）。JSON読み込みで戻した語も同じ。
// 4. JSON読み込みは置換前の墓標を引き継ぐ。件数は正規化後の数。別ファイル選択・二重押しのガード。
// 5. 削除済みの id は一意にする（sanitizeTrash）。
// 6. 一括削除の2段階確認は、確認したときの対象と同じときだけ確定する。
// 7. 単体移動・単語帳の新規作成で、見えない選択を残さない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Script } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const paramOpen = html.indexOf("(", start);
  let paren = 0;
  let paramEnd = paramOpen;
  for (let i = paramOpen; i < html.length; i += 1) {
    if (html[i] === "(") paren += 1;
    else if (html[i] === ")") {
      paren -= 1;
      if (paren === 0) {
        paramEnd = i;
        break;
      }
    }
  }
  const bodyBrace = html.indexOf("{", paramEnd);
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

// 名前の無いイベントハンドラ本体（`anchor` の直後の "{" から対応する "}" まで）を切り出す。
function extractHandlerBody(anchor) {
  const start = html.indexOf(anchor);
  if (start < 0) throw new Error(`anchor not found: ${anchor}`);
  const bodyBrace = start + anchor.length - 1;
  if (html[bodyBrace] !== "{") throw new Error("anchor must end with {");
  let depth = 0;
  for (let i = bodyBrace; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(bodyBrace, i + 1);
    }
  }
  throw new Error("unbalanced handler");
}

// 墓標の時刻。「追加時刻を今にする」は実時刻で入るので、実時刻より前（20日前）に置く。
const NOW = Date.now() - 20 * 86400000;
const iso = (ms) => new Date(ms).toISOString();

const W = (id, term, meaning, deckId, extra = {}) => ({
  id,
  term,
  meaning,
  deckId,
  deckUpdatedAt: 0,
  addedAt: iso(NOW - 10 * 86400000),
  favorite: false,
  progressUpdatedAt: 0,
  stats: { correct: 0, wrong: 0 },
  history: [],
  learning: { status: "new", nextReviewAt: 0 },
  cefr: null,
  pos: null,
  enrich: null,
  ...extra,
});

// 本体の共通部品（実コード）。正規化は本物を使う（指紋は normalizeWord を通すため）。
const COMMON = [
  "const LEARNING_SCHEMA_VERSION = 1;",
  "const SRS_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60, 120];",
  "const SRS_DAY_MS = 24 * 60 * 60 * 1000;",
  "const SRS_MAX_FUTURE_DAYS = 400;",
  "const DAY_MS = 24 * 60 * 60 * 1000;",
  "const DELETION_TTL_MS = 90 * DAY_MS;",
  "const TRASH_TTL_MS = 30 * DAY_MS;",
  "const SAFE_CEFR_LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);",
  "const SAFE_POS_TAGS = new Set(['n', 'v', 'adj', 'adv']);",
  "const clearSavedReviewProgress = () => false;",
  "let __idSeq = 0; function createId() { return `id${++__idSeq}`; }",
  extractFunction("sanitizeId"),
  extractFunction("normalizeTerm"),
  extractFunction("nonNegativeNumber"),
  extractFunction("nonNegativeInteger"),
  extractFunction("emptyEnrich"),
  extractFunction("normalizeEnrich"),
  extractFunction("safeCefrLevel"),
  extractFunction("normalizeCefr"),
  extractFunction("normalizePos"),
  extractFunction("normalizeHistory"),
  extractFunction("repairFarFutureReviewAt"),
  extractFunction("normalizeLearning"),
  extractFunction("normalizeWord"),
  extractFunction("localDateString"),
  extractFunction("normalizeStreak"),
  extractFunction("isNextDayString"),
  extractFunction("sanitizeDeletions"),
  extractFunction("trashKeyForWord"),
  extractFunction("sanitizeTrash"),
  extractFunction("wordAddedMs"),
  extractFunction("wordProgressMs"),
  extractFunction("deletionKeyForWord"),
  extractFunction("defaultState"),
  extractFunction("normalizeState"),
  extractFunction("revivedAddedAtIso"),
  extractFunction("buildDeckIdRemap"),
  extractFunction("canonicalDeckIdMapper"),
  extractFunction("remapDeletionKeyWith"),
  extractFunction("mergeHistory"),
  extractFunction("mergeEnrichData"),
  extractFunction("mergeLearningState"),
  extractFunction("minPositiveNumber"),
  extractFunction("mergeDeckPlacement"),
  extractFunction("mergeWord"),
  extractFunction("consolidateSameNameDecks"),
  extractFunction("deletionBlocksMove"),
];

// ============================================================================
// 1. 「元に戻す」の有効判定
// ============================================================================
function undoSandbox() {
  const pieces = [
    ...COMMON,
    "let __store = {};",
    "const localStorage = {" +
      " getItem: (k) => (Object.hasOwn(__store, k) ? __store[k] : null)," +
      " setItem: (k, v) => { __store[k] = String(v); }," +
      " removeItem: (k) => { delete __store[k]; } };",
    "const UNDO_STORAGE_KEY = 'undo:test';",
    "let appState = { words: [], decks: [], deletions: {}, trash: [], quizCounter: 0, streak: { count: 0, best: 0 } };",
    "let currentQuiz = null;",
    "const selectedIds = new Set();",
    "const elements = { undoButton: { hidden: true } };",
    "let __status = [];",
    "let __saved = 0;",
    "function setStatus(m) { __status.push(m); }",
    "function setV2JoinUndoVisible() {}",
    "function saveState() { __saved += 1; undoSnapshot = null; undoAfterSignature = null; }",
    // 1.0.119: performUndo は保存を確かめてから確定する（__persistOk=false で保存失敗を再現）
    "let __persistOk = true; let __rendered = 0;",
    "let __duringPersist = null;",
    "async function persistAppStateChecked() { __saved += 1; if (__duringPersist) { const f = __duringPersist; __duringPersist = null; f(); } return __persistOk; }",
    "function renderAll() { __rendered += 1; }",
    "function invalidatePersonalFactorCache() {}",
    "let undoSnapshot = null;",
    "let undoAfterSignature = null;",
    "let undoCreatedAt = 0;",
    extractFunction("snapshotState"),
    extractFunction("undoSignature"),
    extractFunction("offerUndo"),
    extractFunction("clearUndo"),
    "let undoInFlight = false;",
    "async " + extractFunction("performUndo"),
    "async " + extractFunction("performUndoOnce"),
    "globalThis.__u = {" +
      " setState: (s) => { appState = s; }, getState: () => appState," +
      " snapshotState, offerUndo, performUndo, undoSignature, normalizeState," +
      " reload: () => { appState = normalizeState(appState); }," +
      " dropSignature: () => { undoAfterSignature = null; }, createdAt: () => undoCreatedAt," +
      " status: () => __status, saved: () => __saved, hasUndo: () => Boolean(undoSnapshot)," +
      " setPersistOk: (v) => { __persistOk = v; }, rendered: () => __rendered, quiz: () => currentQuiz, setQuiz: (q) => { currentQuiz = q; }," +
      " setDuringPersist: (f) => { __duringPersist = f; }," +
      " raw: () => JSON.parse(__store[UNDO_STORAGE_KEY] || 'null') };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "data-core-undo.js" }).runInNewContext(sandbox);
  return sandbox.__u;
}

function baseState() {
  return {
    words: [W("a", "apple", "りんご", "d1"), W("b", "bank", "銀行", "d1")],
    decks: [{ id: "d1", name: "単語帳1", updatedAt: 0 }],
    deletions: {},
    trash: [],
    quizCounter: 3,
    streak: { count: 1, best: 2 },
    activeDeckId: "all",
  };
}

test("元に戻す: 何も変わっていなければ従来どおり戻る", async () => {
  const u = undoSandbox();
  u.setState(baseState());
  const snapshot = u.snapshotState();
  // 削除の操作
  u.getState().words = u.getState().words.filter((w) => w.id !== "a");
  u.getState().deletions["d1 apple"] = NOW;
  u.offerUndo(snapshot);
  assert.equal(typeof u.raw().after, "string", "指紋を保存していない");
  await u.performUndo();
  assert.equal(u.getState().words.length, 2, "削除が戻っていない");
  assert.equal(u.status().at(-1), "元に戻しました。");
  const a = u.getState().words.find((w) => w.id === "a");
  assert.ok(Date.parse(a.addedAt) > NOW, "墓標より新しい追加時刻にする");
  assert.equal(a.progressUpdatedAt, 0, "学習の更新時刻は触らない（作問時の変更検知に使うため）");
});

test("元に戻す: 取り込み直後の語（既定値の無い項目がある）でも、再読込のあとに戻せる", async () => {
  const u = undoSandbox();
  const state = baseState();
  // 共有単語帳の追加やサンプル取り込みが作る形＝deckUpdatedAt / favoriteUpdatedAt が無い
  state.words.push({
    id: "fresh", term: "fresh", meaning: "新しい", deckId: "d1", addedAt: iso(NOW),
    favorite: false, progressUpdatedAt: 0, stats: { correct: 0, wrong: 0 }, history: [],
    learning: { status: "new", firstAttempted: false, reviewAt: 0, blockedUntil: 0, correctStreak: 0, srsStage: 0, nextReviewAt: 0, srsUpdatedAt: 0, lastSrsResult: "" },
  });
  u.setState(state);
  const snapshot = u.snapshotState();
  u.getState().words = u.getState().words.filter((w) => w.id !== "a");
  u.offerUndo(snapshot);
  u.reload(); // 再読込＝保存データを normalizeState で読み戻した状態
  await u.performUndo();
  assert.equal(u.getState().words.length, 3, "再読込しただけで取り消せなくなってはいけない");
});

test("元に戻す: 削除のあとに別の語を学習していたら戻さない（学習が巻き戻るため）", async () => {
  const u = undoSandbox();
  u.setState(baseState());
  const snapshot = u.snapshotState();
  u.getState().words = u.getState().words.filter((w) => w.id !== "a");
  u.offerUndo(snapshot);
  // b に解答した（stats / history / learning / progressUpdatedAt / quizCounter / streak が変わる）
  const b = u.getState().words.find((w) => w.id === "b");
  b.stats.correct += 1;
  b.history.push({ at: iso(NOW), correct: true });
  b.progressUpdatedAt = NOW;
  u.getState().quizCounter += 1;
  await u.performUndo();
  assert.equal(u.getState().words.length, 1, "戻してはいけない");
  assert.equal(u.getState().words[0].stats.correct, 1, "学習を巻き戻してはいけない");
  assert.match(u.status().at(-1), /元に戻せませんでした/);
  assert.match(u.status().at(-1), /「削除済み」から戻せます/);
  assert.equal(u.hasUndo(), false, "無効になった取り消しは消す");
});

test("元に戻す: 指紋は学習の各項目（stats・history・learning・progressUpdatedAt）を個別に見る", async () => {
  const u = undoSandbox();
  const cases = [
    (b) => { b.stats.wrong += 1; },
    (b) => { b.history.push({ at: iso(NOW), correct: false }); },
    (b) => { b.learning.status = "review"; },
    (b) => { b.progressUpdatedAt = NOW; },
  ];
  for (const mutate of cases) {
    u.setState(baseState());
    const snapshot = u.snapshotState();
    u.getState().words = u.getState().words.filter((w) => w.id !== "a");
    u.offerUndo(snapshot);
    mutate(u.getState().words.find((w) => w.id === "b"));
    await u.performUndo();
    assert.equal(u.getState().words.length, 1, `学習の変化を見落としている: ${mutate.toString()}`);
  }
});

test("元に戻す: 背景の補完（cefr / pos / enrich / addedAt）だけの変化では戻せる", async () => {
  const u = undoSandbox();
  u.setState(baseState());
  const snapshot = u.snapshotState();
  u.getState().words = u.getState().words.filter((w) => w.id !== "a");
  u.offerUndo(snapshot);
  const b = u.getState().words.find((w) => w.id === "b");
  b.cefr = { level: "A1", estimated: true };
  b.pos = { tag: "n" };
  b.enrich = { examples: [{ en: "x", ja: "y" }] };
  await u.performUndo();
  assert.equal(u.getState().words.length, 2, "補完だけなら戻せるべき");
});

test("元に戻す: 同期で他端末の変更（語の追加・削除記録）が入っていたら戻さない", async () => {
  const u = undoSandbox();
  u.setState(baseState());
  const snapshot = u.snapshotState();
  u.getState().words = u.getState().words.filter((w) => w.id !== "a");
  u.offerUndo(snapshot);
  u.getState().words.push(W("c", "cat", "猫", "d1")); // 他端末で追加された語が同期で入った
  await u.performUndo();
  assert.equal(u.getState().words.some((w) => w.id === "c"), true, "同期で入った語を消してはいけない");
  assert.match(u.status().at(-1), /元に戻せませんでした/);
});

// 起動時の実際の並び（parseUndoSnapshot 〜 performUndo の宣言・初期化）をそのまま動かす。
// 宣言順を誤ると、保存済みの取り消しがある状態で再読込したときに TDZ で起動が止まる。
function startupUndoRegion() {
  const start = html.indexOf("function parseUndoSnapshot(raw) {");
  const end = html.indexOf("let undoInFlight = false;"); // 1.0.119: 保存を確かめるため async に。進行中ガードの宣言まで
  if (start < 0 || end < 0 || end < start) throw new Error("undo region not found");
  return html.slice(start, end);
}

function startupSandbox(savedRecord) {
  const pieces = [
    ...COMMON,
    "let __store = {};",
    `if (${JSON.stringify(savedRecord)}) __store['undo:test'] = JSON.stringify(${JSON.stringify(savedRecord)});`,
    "const localStorage = {" +
      " getItem: (k) => (Object.hasOwn(__store, k) ? __store[k] : null)," +
      " setItem: (k, v) => { __store[k] = String(v); }," +
      " removeItem: (k) => { delete __store[k]; } };",
    "const UNDO_STORAGE_KEY = 'undo:test';",
    "let appState = { words: [], decks: [], deletions: {}, trash: [], quizCounter: 0, streak: { count: 0, best: 0 } };",
    "const elements = { undoButton: { hidden: true } };",
    "function setV2JoinUndoVisible() {}",
    startupUndoRegion(),
    "globalThis.__s = { hasUndo: () => Boolean(undoSnapshot), after: () => undoAfterSignature, createdAt: () => undoCreatedAt, buttonHidden: () => elements.undoButton.hidden };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "data-core-undo-startup.js" }).runInNewContext(sandbox);
  return sandbox.__s;
}

test("起動: 保存済みの取り消し（新形式・after あり）を読み戻しても止まらず、指紋も戻る", () => {
  const s = startupSandbox({ createdAt: 1, state: baseState(), after: "sig-123" });
  assert.equal(s.hasUndo(), true);
  assert.equal(s.after(), "sig-123");
  assert.equal(s.buttonHidden(), false);
});

test("起動: 旧形式（after 無し）の保存データでも止まらず、指紋は無しで提示時刻だけ戻る", () => {
  const s = startupSandbox({ createdAt: 1234, state: baseState() });
  assert.equal(s.hasUndo(), true);
  assert.equal(s.after(), null);
  assert.equal(s.createdAt(), 1234);
});

test("起動: 保存が無ければ取り消しは無い", () => {
  const s = startupSandbox(null);
  assert.equal(s.hasUndo(), false);
  assert.equal(s.buttonHidden(), true);
});

test("元に戻す: 指紋の無い旧い保存データは、提示のあとに保存が無いときだけ戻す", async () => {
  const u = undoSandbox();
  u.setState(baseState());
  const snapshot = u.snapshotState();
  u.getState().words = u.getState().words.filter((w) => w.id !== "a");
  u.offerUndo(snapshot);
  u.dropSignature(); // 旧版が保存した形（after 無し）を読み込んだ状態を再現
  u.getState().savedAt = u.createdAt() - 500; // 提示より前に保存された＝その後の保存なし
  await u.performUndo();
  assert.equal(u.getState().words.length, 2, "保存が無ければ従来どおり戻せる");

  u.setState(baseState());
  const snapshot2 = u.snapshotState();
  u.getState().words = u.getState().words.filter((w) => w.id !== "a");
  u.offerUndo(snapshot2);
  u.dropSignature();
  u.getState().savedAt = u.createdAt() + 5000; // 提示のあとに保存があった（学習・同期・編集はすべて保存を伴う）
  await u.performUndo();
  assert.equal(u.getState().words.length, 1, "提示後に保存があれば戻さない");
  assert.match(u.status().at(-1), /元に戻せませんでした/);

  // 猶予は無し: 提示の直後（1ms / 500ms）の保存でも戻さない。同時刻までは戻せる
  for (const delta of [1, 500, 1000]) {
    u.setState(baseState());
    const snap = u.snapshotState();
    u.getState().words = u.getState().words.filter((w) => w.id !== "a");
    u.offerUndo(snap);
    u.dropSignature();
    u.getState().savedAt = u.createdAt() + delta;
    await u.performUndo();
    assert.equal(u.getState().words.length, 1, `提示の${delta}ms後の保存を巻き戻してはいけない`);
  }
  u.setState(baseState());
  const snap = u.snapshotState();
  u.getState().words = u.getState().words.filter((w) => w.id !== "a");
  u.offerUndo(snap);
  u.dropSignature();
  u.getState().savedAt = u.createdAt(); // 提示と同時刻の保存（提示直前の保存）は許す
  await u.performUndo();
  assert.equal(u.getState().words.length, 2);
});

test("元に戻す: 指紋は favoriteUpdatedAt も見る（値が同じで時刻だけ新しい同期を見落とさない）", async () => {
  const u = undoSandbox();
  u.setState(baseState());
  const snapshot = u.snapshotState();
  u.getState().words = u.getState().words.filter((w) => w.id !== "a");
  u.offerUndo(snapshot);
  u.getState().words.find((w) => w.id === "b").favoriteUpdatedAt = NOW;
  await u.performUndo();
  assert.equal(u.getState().words.length, 1, "お気に入りの更新時刻の変化を見落としている");
});

test("元に戻す: 起動時に保存した指紋を読み戻す配線がある", async () => {
  assert.match(html, /if \(undoSnapshot\) \(\{ after: undoAfterSignature, createdAt: undoCreatedAt \} = readLocalUndoRecordMeta\(\)\);/);
  assert.match(extractFunction("readLocalUndoRecordMeta"), /typeof record\?\.after === "string"/);
  assert.match(extractFunction("clearUndo"), /undoAfterSignature = null;\s*\n\s*undoCreatedAt = 0;/);
});

// ============================================================================
// 2〜3. 移動先の同じ語・墓標の始末
// ============================================================================
function moveSandbox(state) {
  const pieces = [
    ...COMMON,
    `let appState = ${JSON.stringify(state)};`,
    "const selectedIds = new Set(['a', 'b', 'x']);",
    "let __status = [];",
    "let __saved = 0;",
    "function setStatus(m) { __status.push(m); }",
    "function saveState() { __saved += 1; }",
    "function deckName(id) { return appState.decks.find((d) => d.id === id)?.name || '単語帳'; }",
    extractFunction("deckHasTerm"),
    extractFunction("reviveAgainstDeletion"),
    extractFunction("moveWordToDeck"),
    "globalThis.__m = { appState, selectedIds, deckHasTerm, reviveAgainstDeletion, moveWordToDeck, revivedAddedAtIso, buildDeckIdRemap, canonicalDeckIdMapper, remapDeletionKeyWith, consolidateSameNameDecks, deletionBlocksMove," +
      " status: () => __status, saved: () => __saved };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "data-core-move.js" }).runInNewContext(sandbox);
  return sandbox.__m;
}

const twoDecks = () => ({
  decks: [
    { id: "d1", name: "A" },
    { id: "d2", name: "B" },
  ],
  words: [
    W("a", "bank", "銀行", "d1", { stats: { correct: 3, wrong: 1 } }),
    W("b", "Bank", "土手", "d2"),
    W("x", "apple", "りんご", "d1"),
  ],
  deletions: {},
  trash: [],
});

test("同じ語の検査: 大文字小文字・前後の空白を無視し、自分自身は除く", () => {
  const m = moveSandbox(twoDecks());
  assert.equal(m.deckHasTerm("d2", "bank"), true);
  assert.equal(m.deckHasTerm("d2", "  BANK "), true);
  assert.equal(m.deckHasTerm("d2", "apple"), false);
  assert.equal(m.deckHasTerm("d1", "bank", "a"), false, "自分自身は数えない");
});

test("単体移動: 移動先に同じ語があれば止めて、データを変えない", () => {
  const m = moveSandbox(twoDecks());
  const ok = m.moveWordToDeck("a", "d2");
  assert.equal(ok, false);
  assert.equal(m.appState.words.find((w) => w.id === "a").deckId, "d1", "動かしてはいけない");
  assert.equal(m.saved(), 0, "保存もしない");
  assert.match(m.status().at(-1), /「bank」は単語帳「B」にもうあるため移動できません。移動先の「bank」を別の単語帳へ移すか/);
});

test("単体移動: 移動できるときは移動時刻を打ち、見えない選択を残さない", () => {
  const m = moveSandbox(twoDecks());
  const ok = m.moveWordToDeck("x", "d2");
  assert.equal(ok, true);
  const x = m.appState.words.find((w) => w.id === "x");
  assert.equal(x.deckId, "d2");
  assert.ok(x.deckUpdatedAt > 0);
  assert.equal(m.selectedIds.has("x"), false, "移動した語の選択は解除する");
  assert.equal(m.selectedIds.has("a"), true, "他の選択は触らない");
  assert.equal(m.saved(), 1);
});

test("単体移動: 同じ単語帳への「移動」は何もしない（移動時刻を無駄に更新しない）", () => {
  const m = moveSandbox(twoDecks());
  assert.equal(m.moveWordToDeck("x", "d1"), true);
  assert.equal(m.appState.words.find((w) => w.id === "x").deckUpdatedAt, 0);
  assert.equal(m.saved(), 0);
});

test("墓標の始末: 新しい墓標があれば追加時刻を今にして墓標を消す。古い墓標は追加時刻据え置きで消すだけ", () => {
  const state = twoDecks();
  state.deletions["d2 apple"] = NOW; // B で apple を削除した記録（語の追加より新しい）
  state.deletions["d2 bank"] = NOW - 30 * 86400000; // 語の追加より古い記録
  const m = moveSandbox(state);
  const x = m.appState.words.find((w) => w.id === "x");
  const before = x.addedAt;
  x.deckId = "d2"; // 所属が決まったあとで呼ぶ
  assert.equal(m.reviveAgainstDeletion(x), true);
  assert.notEqual(x.addedAt, before, "墓標より新しい追加時刻にしていない");
  assert.ok(Date.parse(x.addedAt) > NOW);
  assert.equal(x.progressUpdatedAt, 0, "学習の更新時刻は触らない");
  assert.equal("d2 apple" in m.appState.deletions, false, "端末側の墓標を消していない");
  assert.equal("d2 bank" in m.appState.deletions, true, "無関係な墓標は触らない");
  // 古い墓標: 追加時刻は据え置き、印は付く、墓標は消す
  const b = m.appState.words.find((w) => w.id === "b");
  const beforeB = b.addedAt;
  m.reviveAgainstDeletion(b);
  assert.equal(b.addedAt, beforeB);
  assert.equal("d2 bank" in m.appState.deletions, false);
  // 墓標が無ければ何もしない
  const a = m.appState.words.find((w) => w.id === "a");
  const beforeA = a.addedAt;
  assert.equal(m.reviveAgainstDeletion(a), false);
  assert.equal(a.addedAt, beforeA);
});

test("墓標の始末: 追加時刻は「今」と「墓標の直後」の遅い方。極端な値は1年先までに抑える", () => {
  const state = twoDecks();
  const future = Date.now() + 60 * 1000; // 時計が1分進んだ端末が付けた墓標
  state.deletions["d2 apple"] = future;
  const m = moveSandbox(state);
  const x = m.appState.words.find((w) => w.id === "x");
  x.deckId = "d2";
  assert.equal(m.reviveAgainstDeletion(x), true);
  assert.equal(Date.parse(x.addedAt), future + 1, "墓標より厳密に新しい時刻にする");
  const iso = m.revivedAddedAtIso(9e15); // 壊れた値でも Date が例外を出さず、1年先までに抑える
  assert.ok(Date.parse(iso) <= Date.now() + 366 * 86400000);
});

test("削除の記録の時刻は「今」のまま（先に進めると、ゴミ箱の保管期限や「削除後に別端末で回答していれば残す」を崩す）", () => {
  assert.match(extractFunction("recordDeletion"), /const deletedAt = Date\.now\(\);/);
  assert.doesNotMatch(html, /function deletionStampFor/);
  assert.match(html, /deletions\[deletionKeyForWord\(word\)\] = deletedAt;/);
  assert.match(html, /appState\.deletions\[key\] = Math\.max\(Number\(appState\.deletions\[key\] \|\| 0\), deletedAt\);/);
});

test("単体移動: 移動先に語より新しい墓標があれば止める（そのまま移すと同期で消える）", () => {
  const state = twoDecks();
  state.deletions["d2 apple"] = NOW; // apple の追加（NOW-10日）より新しい
  const m = moveSandbox(state);
  assert.equal(m.moveWordToDeck("x", "d2"), false);
  const x = m.appState.words.find((w) => w.id === "x");
  assert.equal(x.deckId, "d1");
  assert.equal("d2 apple" in m.appState.deletions, true, "墓標は触らない");
  assert.equal(m.saved(), 0);
  assert.match(m.status().at(-1), /以前に削除した記録が残っているため、そのまま移すと同期で消えます/);
  assert.match(m.status().at(-1), /取り込み直してからこちらを削除/);
  // 語より古い墓標なら動かせる（手元の墓標は残る。移動では触らない）
  m.appState.deletions["d2 apple"] = NOW - 30 * 86400000;
  assert.equal(m.moveWordToDeck("x", "d2"), true);
  assert.equal(x.deckId, "d2");
  // 学習してから削除された語（学習時刻が墓標より新しい）も動かせる
  m.appState.words = m.appState.words.filter((w) => w.id !== "b"); // 移動先の同じ語を消しておく
  m.appState.deletions["d2 bank"] = NOW;
  const a = m.appState.words.find((w) => w.id === "a");
  a.progressUpdatedAt = NOW + 1000;
  assert.equal(m.moveWordToDeck("a", "d2"), true);
});

test("墓標の始末: 旧形式（語だけ）の墓標も見る", () => {
  const state = twoDecks();
  state.deletions["apple"] = NOW;
  const m = moveSandbox(state);
  const x = m.appState.words.find((w) => w.id === "x");
  assert.equal(m.reviveAgainstDeletion(x), true);
  assert.equal("apple" in m.appState.deletions, false);
  assert.ok(Date.parse(x.addedAt) > NOW);
});

test("一括移動: 移動先に同じ語がある語（選んだ語どうしの重なりも）は残し、残りだけ動かす", () => {
  const body = extractHandlerBody('elements.moveSelectedButton?.addEventListener("click", () => {');
  const state = {
    decks: [
      { id: "d1", name: "A" },
      { id: "d2", name: "B" },
    ],
    words: [
      W("a", "bank", "銀行", "d1"),
      W("b", "bank", "土手", "d2"),
      W("c", "cat", "猫", "d1"),
      W("d", "Cat", "ネコ", "d3"),
      W("e", "egg", "卵", "d1"),
    ],
    deletions: {},
    trash: [],
  };
  const pieces = [
    ...COMMON,
    `const appState = ${JSON.stringify(state)};`,
    "const selectedIds = new Set(['a', 'c', 'd', 'e']);",
    "const elements = { moveSelectedButton: {}, moveSelectedDeckSelect: { value: 'd2' } };",
    "let __status = []; let __saved = 0; let __undo = 0;",
    "function setStatus(m) { __status.push(m); }",
    "function saveState() { __saved += 1; }",
    "function snapshotState() { return JSON.parse(JSON.stringify(appState)); }",
    "function offerUndo() { __undo += 1; }",
    "function deckName(id) { return appState.decks.find((d) => d.id === id)?.name || '単語帳'; }",
    "function deletionBlocksMove() { return false; }",
    `function handler() ${body}`,
    "handler();",
    "globalThis.__r = { appState, selectedIds, status: __status, saved: __saved, undo: __undo };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "data-core-bulk-move.js" }).runInNewContext(sandbox);
  const byId = (id) => sandbox.__r.appState.words.find((w) => w.id === id);
  assert.equal(byId("a").deckId, "d1", "移動先に bank があるので動かさない");
  assert.equal(byId("c").deckId, "d2", "cat は動く");
  assert.equal(byId("d").deckId, "d3", "同じ選択内の2つ目の cat は動かさない");
  assert.equal(byId("e").deckId, "d2");
  assert.equal(sandbox.__r.saved, 1);
  assert.equal(sandbox.__r.undo, 1);
  assert.match(sandbox.__r.status.at(-1), /2件を単語帳「B」へ移動しました。2件（bank、Cat）は移動先に同じ語があるため残しました。/);
});

test("一括移動: 移動先に新しい墓標がある語は残し、理由と語を分けて伝える", () => {
  const body = extractHandlerBody('elements.moveSelectedButton?.addEventListener("click", () => {');
  const state = {
    decks: [
      { id: "d1", name: "A" },
      { id: "d2", name: "B" },
    ],
    words: [W("c", "cat", "猫", "d1"), W("e", "egg", "卵", "d1")],
    deletions: { "d2 cat": NOW },
    trash: [],
  };
  const pieces = [
    ...COMMON,
    `const appState = ${JSON.stringify(state)};`,
    "const selectedIds = new Set(['c', 'e']);",
    "const elements = { moveSelectedButton: {}, moveSelectedDeckSelect: { value: 'd2' } };",
    "let __status = []; let __saved = 0;",
    "function setStatus(m) { __status.push(m); }",
    "function saveState() { __saved += 1; }",
    "function snapshotState() { return JSON.parse(JSON.stringify(appState)); }",
    "function offerUndo() {}",
    "function deckName(id) { return appState.decks.find((d) => d.id === id)?.name || '単語帳'; }",
    `function handler() ${body}`,
    "handler();",
    "globalThis.__r = { appState, status: __status, saved: __saved };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "data-core-bulk-move-tomb.js" }).runInNewContext(sandbox);
  const byId = (id) => sandbox.__r.appState.words.find((w) => w.id === id);
  assert.equal(byId("c").deckId, "d1", "新しい墓標がある語は動かさない");
  assert.equal(byId("e").deckId, "d2");
  assert.equal("d2 cat" in sandbox.__r.appState.deletions, true, "墓標は触らない");
  assert.match(sandbox.__r.status.at(-1), /1件を単語帳「B」へ移動しました。1件（cat）は移動先で以前に削除した記録があり、同期で消えるため残しました。/);
});

test("一括移動: 全部が移動先の同じ語に当たるときは何も変えず理由を出す", () => {
  const body = extractHandlerBody('elements.moveSelectedButton?.addEventListener("click", () => {');
  const state = twoDecks();
  const pieces = [
    ...COMMON,
    `const appState = ${JSON.stringify(state)};`,
    "const selectedIds = new Set(['a']);",
    "const elements = { moveSelectedButton: {}, moveSelectedDeckSelect: { value: 'd2' } };",
    "let __status = []; let __saved = 0;",
    "function setStatus(m) { __status.push(m); }",
    "function saveState() { __saved += 1; }",
    "function snapshotState() { throw new Error('snapshot must not be taken'); }",
    "function offerUndo() { throw new Error('undo must not be offered'); }",
    "function deckName(id) { return appState.decks.find((d) => d.id === id)?.name || '単語帳'; }",
    "function deletionBlocksMove() { return false; }",
    `function handler() ${body}`,
    "handler();",
    "globalThis.__r = { appState, status: __status, saved: __saved };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "data-core-bulk-move-blocked.js" }).runInNewContext(sandbox);
  assert.equal(sandbox.__r.appState.words.find((w) => w.id === "a").deckId, "d1");
  assert.equal(sandbox.__r.saved, 0);
  assert.match(sandbox.__r.status.at(-1), /移動できる語がありません。1件（bank）は移動先に同じ語があるため残しました。/);
});

test("単語帳の削除: 移動先に同じ語がある語が残っていれば、確認を求める前に止める", () => {
  const state = {
    decks: [
      { id: "d1", name: "A" },
      { id: "d2", name: "B" },
    ],
    words: [W("a", "bank", "銀行", "d1"), W("b", "bank", "土手", "d2"), W("c", "cat", "猫", "d2")],
    deletions: { "d1 cat": NOW },
    trash: [],
    activeDeckId: "d2",
  };
  const pieces = [
    ...COMMON,
    `let appState = ${JSON.stringify(state)};`,
    "let currentQuiz = { answer: { id: 'c' } };",
    "let __status = []; let __saved = 0; let __armed = 0;",
    "function setStatus(m) { __status.push(m); }",
    "function saveState() { __saved += 1; }",
    "function armDangerButton() { __armed += 1; return true; }",
    "function deckName(id) { return appState.decks.find((d) => d.id === id)?.name || '単語帳'; }",
    extractFunction("deckHasTerm"),
    extractFunction("deleteDeck"),
    "globalThis.__d = { run: () => deleteDeck({}), state: () => appState, status: () => __status, saved: () => __saved, armed: () => __armed };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "data-core-delete-deck.js" }).runInNewContext(sandbox);
  const d = sandbox.__d;
  d.run();
  assert.equal(d.state().decks.length, 2, "削除してはいけない");
  assert.equal(d.armed(), 0, "確認を求める前に止める");
  assert.match(d.status().at(-1), /「B」はまだ削除できません。「bank」は移動先の「A」にも同じ語があります/);
  // 同じ語を片づけても、移動先に cat の新しい墓標が残っている間は削除できない
  d.state().words = d.state().words.filter((w) => w.id !== "b");
  d.run();
  assert.equal(d.state().decks.length, 2, "新しい墓標がある語を動かしてはいけない");
  assert.equal(d.armed(), 0);
  assert.match(d.status().at(-1), /「cat」は移動先の「A」で以前に削除した記録が残っていて/);
  // 墓標が語より古ければ削除でき、移動した語の追加時刻は据え置き（墓標にも触らない）
  d.state().deletions["d1 cat"] = NOW - 30 * 86400000;
  const before = d.state().words.find((w) => w.id === "c").addedAt;
  d.run();
  assert.equal(d.state().decks.length, 1);
  const c = d.state().words.find((w) => w.id === "c");
  assert.equal(c.deckId, "d1");
  assert.equal(c.addedAt, before);
  assert.equal(d.saved(), 1);
});

test("配線: 行の単語帳選択で移動できなかったときは選択欄を実際の所属へ戻す", () => {
  assert.match(html, /if \(select && !moveWordToDeck\(select\.dataset\.moveWord, select\.value\)\) \{[\s\S]*?select\.value = word\.deckId;/);
});

test("単語帳の新規作成: 表示が切り替わるので選択を捨てる", () => {
  const body = extractFunction("addDeck");
  assert.match(body, /appState\.activeDeckId = deck\.id;\s*\n(?:\s*\/\/[^\n]*\n)*\s*selectedIds\.clear\(\);/);
});

// ============================================================================
// 4. JSON読み込み
// ============================================================================
test("JSON読み込み（確定）: 置換前の墓標を引き継ぎ、戻した語は墓標に負けないようにし、二重押しを防ぐ", () => {
  const body = extractHandlerBody('elements.importConfirmButton?.addEventListener("click", async () => {');
  assert.match(body, /if \(importConfirmBusy\) return;/);
  assert.match(body, /const previousDeletions = appState\.deletions \|\| \{\};/);
  assert.match(body, /for \(const word of appState\.words\) reviveAgainstDeletion\(word\);/);
  assert.match(body, /appState = consolidateSameNameDecks\(normalizeState\(imported\)\);/);
  assert.match(body, /finally \{[\s\S]*importConfirmBusy = false;/);
  const current = {
    words: [W("k", "kept", "残る", "d1"), W("g", "gone", "消える", "d1")],
    decks: [{ id: "d1", name: "A", updatedAt: 0 }],
    deletions: { "d1 old": NOW - 1000, "d1 apple": NOW }, // apple は削除済み（バックアップには入っている）
    trash: [],
  };
  const imported = {
    words: [W("k", "kept", "残る", "d1"), W("p", "apple", "りんご", "d1")],
    decks: [{ id: "d1", name: "A", updatedAt: 0 }],
    deletions: { "d1 stale": NOW - 5000 },
    trash: [],
  };
  const pieces = [
    ...COMMON,
    `let appState = ${JSON.stringify(current)};`,
    `let pendingImport = ${JSON.stringify(imported)};`,
    "let pendingImportV2Credential = null;",
    "let importConfirmMode = 'replace';",
    "let currentQuiz = { answer: { id: 'g' } };",
    "const elements = { importConfirmButton: { disabled: false, dataset: {} } };",
    "let __status = []; let __saved = 0; let __undo = 0; let __hidden = 0;",
    "function setStatus(m) { __status.push(m); }",
    "function saveState() { __saved += 1; }",
    // 1.0.121: 置き換えは保存を確かめ（persistAppStateChecked）、ゴミ箱を引き継ぐ（mergeTrashEntries）
    "async function persistAppStateChecked() { __saved += 1; return true; }",
    "function mergeTrashEntries(sources) { return sources.flat(); }",
    "function clearUndo() {}",
    "function renderAll() {}",
    "function offerUndo() { __undo += 1; }",
    "function snapshotState() { return JSON.parse(JSON.stringify(appState)); }",
    "function normalizeState(s) { const c = JSON.parse(JSON.stringify(s)); c.deletions = c.deletions || {}; return c; }",
    "function invalidatePersonalFactorCache() {}",
    "function trackUsage() {}",
    "function getActiveV2Credential() { return null; }",
    "function hideImportConfirmBar() { __hidden += 1; }",
    "function showImportedV2CredentialConfirm() { throw new Error('unexpected'); }",
    "async function connectImportedV2Credential() {}",
    extractFunction("reviveAgainstDeletion"),
    "let importConfirmBusy = false;",
    `const handler = async () => ${body};`,
    "globalThis.__j = { run: handler, state: () => appState, status: () => __status, saved: () => __saved, undo: () => __undo, hidden: () => __hidden, button: elements.importConfirmButton };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "data-core-import.js" }).runInNewContext(sandbox);
  const j = sandbox.__j;
  return j.run().then(() => {
    const st = j.state();
    assert.equal(st.words.length, 2);
    assert.equal(st.deletions["d1 old"], NOW - 1000, "置換前の墓標を引き継いでいない");
    assert.equal(st.deletions["d1 stale"], NOW - 5000, "ファイル側の墓標も残す");
    assert.ok(st.deletions["d1 gone"] > 0, "置換で消えた語には墓標を付ける");
    assert.equal("d1 apple" in st.deletions, false, "戻した語の墓標は消す");
    const apple = st.words.find((w) => w.id === "p");
    assert.ok(Date.parse(apple.addedAt) > NOW, "戻した語は墓標より新しい追加時刻にする");
    assert.equal(st.words.find((w) => w.id === "k").addedAt, current.words[0].addedAt, "墓標の無い語の追加時刻は触らない");
    assert.ok(st.words.every((w) => w.progressUpdatedAt === 0), "学習の更新時刻は触らない");
    assert.ok(st.deletions["d1 gone"] >= Date.now() - 5000, "消えた語の墓標は今の時刻");
    assert.equal(st.deletions["d1 gone"] >= NOW, true);
    assert.equal(j.saved(), 1);
    assert.equal(j.undo(), 1);
    assert.equal(j.hidden(), 1);
    assert.equal(j.button.disabled, false, "処理後は押せる状態に戻す");
  });
});

test("JSON読み込み（選択）: 世代番号で最後に選んだファイルだけを採用し、件数は正規化後の数を出す", () => {
  const body = extractHandlerBody('elements.importJsonInput.addEventListener("change", async () => {');
  assert.match(body, /const gen = \+\+importReadGen;/);
  assert.match(body, /hideImportConfirmBar\(\);\s*\n\s*\n?\s*try \{/, "読み込み開始時に前の確認を消す");
  assert.match(body, /const imported = JSON\.parse\(await file\.text\(\)\);\s*\n\s*if \(gen !== importReadGen\) return;/);
  assert.doesNotMatch(body, /normalizeState\(imported\)/, "件数のために normalizeState を呼ぶと、重複IDの振り直しで選択と再開データが消える");
  assert.match(body, /const usable = imported\.words\.filter\(/);
  assert.match(body, /\} catch \{\s*\n(?:\s*\/\/[^\n]*\n)*\s*if \(gen !== importReadGen\) return;/, "失敗経路も世代で守る");
  assert.match(body, /if \(gen === importReadGen\) elements\.importJsonInput\.value = "";/);
  assert.match(body, /読み込んだ\$\{usable\}語で置き換えます/);
  assert.match(body, /行は単語か意味が空のため読み込めません/);
  // 実際に2つのファイルを続けて選び、先に選んだ方の読み込みが遅れて完了しても採用しないことを動かして確かめる
  const pieces = [
    "const IMPORT_MAX_FILE_BYTES = 1e9; const IMPORT_MAX_WORDS = 1e6; const IMPORT_MAX_FILE_LABEL = '1GB';",
    "let pendingImport = null; let pendingImportV2Credential = null; let __hidden = 0; let __status = [];",
    "const elements = { importJsonInput: { files: [], value: 'x' }, importConfirmText: { textContent: '' }, importConfirmBar: { hidden: true } };",
    "function hideImportConfirmBar() { __hidden += 1; pendingImport = null; }",
    "function setStatus(m) { __status.push(m); }",
    "function normalizeV2Credential() { return null; }",
    "function getActiveV2Credential() { return null; }",
    "function resetImportConfirmUi() {}",
    "function normalizeState() { throw new Error('normalizeState must not run while choosing a file'); }",
    "let importReadGen = 0;",
    `const handler = async () => ${body};`,
    "let releaseA; const fileA = { size: 10, text: () => new Promise((r) => { releaseA = r; }) };",
    "const fileB = { size: 10, text: async () => JSON.stringify({ words: [{ term: 'b', meaning: 'B' }, { term: '', meaning: 'x' }] }) };",
    "let rejectC; const fileC = { size: 10, text: () => new Promise((r, j) => { rejectC = j; }) };",
    "globalThis.__g = { run: async () => {" +
      "  elements.importJsonInput.files = [fileA]; const pa = handler();" +
      "  elements.importJsonInput.files = [fileB]; await handler();" +
      "  const afterB = { pending: JSON.parse(JSON.stringify(pendingImport)), text: elements.importConfirmText.textContent };" +
      "  releaseA(JSON.stringify({ words: [{ term: 'a', meaning: 'A' }] })); await pa;" +
      "  const afterA = { pending: JSON.parse(JSON.stringify(pendingImport)), hidden: __hidden, text: elements.importConfirmText.textContent };" +
      "  elements.importJsonInput.files = [fileC]; const pc = handler();" +
      "  elements.importJsonInput.files = [fileB]; await handler();" +
      "  const hiddenBeforeFail = __hidden; elements.importJsonInput.value = 'B';" +
      "  rejectC(new Error('broken')); await pc;" +
      "  const afterFail = { pending: pendingImport ? pendingImport.words[0].term : null, hidden: __hidden, inputValue: elements.importJsonInput.value, status: __status.at(-1) };" +
      "  return { afterB, ...afterA, hiddenBeforeFail, afterFail }; } };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "data-core-import-gen.js" }).runInNewContext(sandbox);
  return sandbox.__g.run().then((r) => {
    assert.equal(r.afterB.pending.words[0].term, "b");
    assert.equal(r.pending.words[0].term, "b", "遅れて完了した先のファイルで上書きしてはいけない");
    assert.match(r.text, /読み込んだ1語で置き換えます/);
    assert.match(r.text, /1行は単語か意味が空のため読み込めません/);
    assert.ok(r.hidden >= 2, "ファイルを選ぶたびに前の確認を消す");
    assert.equal(r.afterFail.pending, "b", "先に選んだファイルの失敗で、あとの確認を消してはいけない");
    assert.equal(r.afterFail.hidden, r.hiddenBeforeFail, "失敗経路でも確認バーを消さない");
    assert.equal(r.afterFail.inputValue, "B", "失敗経路の後始末で入力欄を触らない");
    assert.doesNotMatch(String(r.afterFail.status), /読み込めませんでした/, "古い失敗の案内を出さない");
  });
});

test("JSON読み込み（資格情報の確認）: 「接続する」へ切り替えた直後は少しの間押せない", () => {
  const body = extractFunction("showImportedV2CredentialConfirm");
  assert.match(body, /button\.dataset\.holdDisabled = "1";\s*\n\s*button\.disabled = true;/);
  assert.match(body, /window\.setTimeout\(\(\) => \{\s*\n\s*delete button\.dataset\.holdDisabled;/);
  // 確定処理の finally は、この保留中は押せる状態に戻さない
  const confirm = extractHandlerBody('elements.importConfirmButton?.addEventListener("click", async () => {');
  assert.match(confirm, /!elements\.importConfirmButton\.dataset\.holdDisabled/);
});

// ============================================================================
// 5. 削除済みの id
// ============================================================================
test("削除済み: 同じ id が別の語に付いていたら振り直す（押した行と別の語を戻さない）", () => {
  const pieces = [
    ...COMMON, // sanitizeTrash / normalizeWord / TRASH_TTL_MS は本物が入っている
    "globalThis.__t = sanitizeTrash;",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "data-core-trash.js" }).runInNewContext(sandbox);
  const out = sandbox.__t(
    [
      { id: "same", word: { term: "apple", meaning: "りんご", deckId: "d1" }, deletedAt: NOW },
      { id: "same", word: { term: "bank", meaning: "銀行", deckId: "d1" }, deletedAt: NOW - 1 },
      { id: "other", word: { term: "cat", meaning: "猫", deckId: "d1" }, deletedAt: NOW - 2 },
    ],
    NOW,
  );
  const ids = Array.from(out, (e) => e.id);
  assert.equal(out.length, 3);
  assert.equal(new Set(ids).size, 3, "id が重なっている");
  assert.equal(ids[0], "same", "先頭（新しい方）は元の id を保つ");
  assert.equal(ids[2], "other");
  // 数値 1 と文字列 "1" は DOM の data-trash-id では同じ "1" になるので、文字列として一意にする
  const mixed = sandbox.__t(
    [
      { id: 1, word: { term: "apple", meaning: "りんご", deckId: "d1" }, deletedAt: NOW },
      { id: "1", word: { term: "bank", meaning: "銀行", deckId: "d1" }, deletedAt: NOW - 1 },
    ],
    NOW,
  );
  const mixedIds = Array.from(mixed, (e) => e.id);
  assert.ok(mixedIds.every((id) => typeof id === "string"), "id は文字列にそろえる");
  assert.equal(new Set(mixedIds).size, 2);
});

// ============================================================================
// 6. 一括削除の2段階確認
// ============================================================================
function bulkDeleteSandbox(words, selected) {
  const body = extractHandlerBody('elements.deleteSelectedButton?.addEventListener("click", () => {');
  const pieces = [
    ...COMMON,
    "const window = { setTimeout: () => 1, clearTimeout: () => {} };",
    `let appState = { words: ${JSON.stringify(words)}, deletions: {}, trash: [] };`,
    `const selectedIds = new Set(${JSON.stringify(selected)});`,
    "const elements = { deleteSelectedButton: { dataset: {}, textContent: '選んだ単語を削除' } };",
    "let currentQuiz = null; let __status = []; let __deleted = []; let __saved = 0;",
    "function setStatus(m) { __status.push(m); }",
    "function saveState() { __saved += 1; }",
    "function offerUndo() {}",
    "function snapshotState() { return JSON.parse(JSON.stringify(appState)); }",
    "function recordDeletion(word) { __deleted.push(word.id); }",
    "function dropWordFromReviewSession() {}",
    "function dropWordFromFlashcardSession() {}",
    extractFunction("disarmDangerButton"),
    extractFunction("armDangerButton"),
    `const handler = () => ${body};`,
    "globalThis.__b = { run: handler, selectedIds, deleted: () => __deleted, status: () => __status, saved: () => __saved, button: elements.deleteSelectedButton, words: () => appState.words };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "data-core-bulk-delete.js" }).runInNewContext(sandbox);
  return sandbox.__b;
}

test("一括削除: 確認したあとに選択を変えたら、確定ではなく確認のやり直しになる", () => {
  const b = bulkDeleteSandbox([W("a", "apple", "りんご", "d1"), W("b", "bank", "銀行", "d1")], ["a"]);
  b.run(); // 1回目: a を確認
  assert.equal(b.button.dataset.armed, "1");
  assert.equal(b.button.dataset.armedIds, "a");
  b.selectedIds.delete("a");
  b.selectedIds.add("b");
  b.run(); // 選択が b に変わった: 確定してはいけない
  assert.deepEqual(Array.from(b.deleted()), [], "確認文に無かった語を消してはいけない");
  assert.equal(b.button.dataset.armed, "1", "いまの対象で確認し直す");
  assert.equal(b.button.dataset.armedIds, "b");
  assert.match(b.status().at(-1), /選んだ 1件 を削除します/);
  b.run(); // 同じ対象で2回目: 確定
  assert.deepEqual(Array.from(b.deleted()), ["b"]);
  assert.equal(b.button.dataset.armedIds, undefined, "確定したら印を消す");
  assert.equal(b.saved(), 1);
});

test("一括削除: 対象が同じなら従来どおり2回目で確定する", () => {
  const b = bulkDeleteSandbox([W("a", "apple", "りんご", "d1"), W("b", "bank", "銀行", "d1")], ["b", "a"]);
  b.run();
  b.run();
  assert.deepEqual(Array.from(b.deleted()).sort(), ["a", "b"]);
  assert.equal(b.words().length, 0);
});

// ============================================================================
// 8. 「削除済み」から戻す／過去の版への復元
// ============================================================================
function restoreSandbox(state) {
  const pieces = [
    ...COMMON,
    `let appState = ${JSON.stringify(state)};`,
    "const selectedIds = new Set();",
    "let currentQuiz = null; let __status = []; let __saved = 0;",
    "function setStatus(m) { __status.push(m); }",
    "function saveState() { __saved += 1; }",
    "function deckName(id) { return appState.decks.find((d) => d.id === id)?.name || '単語帳'; }",
    "function focusTrashActionAfterRemoval() {}",
    extractFunction("reviveAgainstDeletion"),
    extractFunction("restoreTrashWord"),
    "globalThis.__t = { run: restoreTrashWord, state: () => appState, status: () => __status, saved: () => __saved };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "data-core-restore.js" }).runInNewContext(sandbox);
  return sandbox.__t;
}

test("削除済みから戻す: 未来の墓標があっても、それより新しい追加時刻にして墓標を消す", () => {
  const future = Date.now() + 60 * 1000;
  const t = restoreSandbox({
    decks: [{ id: "d1", name: "A" }],
    words: [],
    deletions: { "d1 apple": future, apple: future - 5 },
    trash: [{ id: "t1", word: W("a", "apple", "りんご", "d1"), deletedAt: NOW }],
  });
  t.run("t1");
  const a = t.state().words.find((w) => w.term === "apple");
  assert.ok(a, "戻っていない");
  assert.equal(Date.parse(a.addedAt), future + 1);
  assert.equal(a.progressUpdatedAt, 0, "学習の更新時刻は触らない");
  assert.deepEqual(Object.keys(t.state().deletions), []);
  assert.equal(t.state().trash.length, 0);
  assert.equal(t.saved(), 1);
});

test("削除済みから戻す: 手元に墓標が無ければ追加時刻を今にして戻す（例外なし）", () => {
  const t = restoreSandbox({
    decks: [{ id: "d1", name: "A" }],
    words: [],
    deletions: {},
    trash: [{ id: "t1", word: W("a", "apple", "りんご", "d1"), deletedAt: NOW }],
  });
  const before = Date.now();
  t.run("t1");
  const a = t.state().words.find((w) => w.term === "apple");
  assert.ok(a, "戻っていない");
  assert.ok(Date.parse(a.addedAt) >= before);
  assert.equal(t.state().trash.length, 0);
});

test("過去の版への復元: 取り消しの提示は置換・保存のあと（先に出すと復元直後の取り消しが拒否される）", () => {
  const body = extractFunction("restoreFromRevision");
  const offerAt = body.indexOf("offerUndo(localSnapshot);");
  const persistAt = body.indexOf("persistAppState();");
  const renderAt = body.indexOf("renderAll();");
  assert.ok(offerAt > 0 && persistAt > 0 && renderAt > 0);
  assert.ok(offerAt > persistAt && offerAt > renderAt, "offerUndo が置換・保存より前にある");
  // 他の置換系の経路も、置換・保存のあとで提示している
  for (const anchor of ['elements.importConfirmButton?.addEventListener("click", async () => {', 'elements.moveSelectedButton?.addEventListener("click", () => {', 'elements.deleteSelectedButton?.addEventListener("click", () => {']) {
    const h = extractHandlerBody(anchor);
    assert.ok(h.indexOf("offerUndo(snapshot);") > h.indexOf("saveState();"), `${anchor} で offerUndo が saveState より前`);
  }
});

test("JSON読み込み（確定）: 同名で別IDの単語帳は同じ単語帳とみなし、残っている語に墓標を付けない。既存の新しい墓標は下げない", () => {
  const body = extractHandlerBody('elements.importConfirmButton?.addEventListener("click", async () => {');
  const future = Date.now() + 60 * 1000;
  const current = {
    words: [W("k", "kept", "残る", "d1"), W("g", "gone", "消える", "d1")],
    decks: [{ id: "d1", name: "A", updatedAt: 0 }],
    deletions: { "d1 gone": future }, // ファイルより新しい墓標が手元にある（同期で受け取った未来時刻）
    trash: [],
  };
  const imported = {
    // 別端末で作った同名の単語帳（IDが違う）。kept はそこに残っている
    words: [W("k2", "kept", "残る", "d2")],
    decks: [{ id: "d2", name: " a ", updatedAt: 0 }],
    deletions: {},
    trash: [],
  };
  const pieces = [
    ...COMMON,
    `let appState = ${JSON.stringify(current)};`,
    `let pendingImport = ${JSON.stringify(imported)};`,
    "let pendingImportV2Credential = null;",
    "let importConfirmMode = 'replace';",
    "let currentQuiz = null;",
    "const elements = { importConfirmButton: { disabled: false, dataset: {} } };",
    "let __status = [];",
    "function setStatus(m) { __status.push(m); }",
    "function saveState() {}",
    // 1.0.121: 置き換えは保存を確かめ、ゴミ箱を引き継ぐ
    "async function persistAppStateChecked() { return true; }",
    "function mergeTrashEntries(sources) { return sources.flat(); }",
    "function clearUndo() {}",
    "function renderAll() {}",
    "function offerUndo() {}",
    "function snapshotState() { return JSON.parse(JSON.stringify(appState)); }",
    "function invalidatePersonalFactorCache() {}",
    "function trackUsage() {}",
    "function getActiveV2Credential() { return null; }",
    "function hideImportConfirmBar() {}",
    "function showImportedV2CredentialConfirm() { throw new Error('unexpected'); }",
    "async function connectImportedV2Credential() {}",
    extractFunction("reviveAgainstDeletion"),
    "let importConfirmBusy = false;",
    `const handler = async () => ${body};`,
    "globalThis.__j = { run: handler, state: () => appState };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "data-core-import-deckname.js" }).runInNewContext(sandbox);
  return sandbox.__j.run().then(() => {
    const st = sandbox.__j.state();
    assert.equal("d1 kept" in st.deletions, false, "同名の単語帳に残っている語へ墓標を付けてはいけない（次の同期で名前で読み替えられ、読み込んだ語が消える）");
    assert.equal("d2 kept" in st.deletions, false);
    // 引き継いだ墓標は読み込んだ側の単語帳ID（d2）で持ち、既にある新しい時刻を古い値で下げない
    assert.equal("d1 gone" in st.deletions, false, "旧IDのままの墓標を残さない");
    assert.equal(st.deletions["d2 gone"], future, "既にある新しい墓標を古い値で上書きしてはいけない");
  });
});

// ============================================================================
// 9. 単語帳IDの読み替え（同名別IDの単語帳）
// ============================================================================
test("単語帳IDの読み替え: 同じIDはそのまま、無ければ正規化した名前で対応（同名は先勝ち）、どちらも無ければ据え置き", () => {
  const m = moveSandbox(twoDecks());
  const remap = m.buildDeckIdRemap(
    [{ id: "d1", name: "A" }, { id: "x", name: " b " }, { id: "z", name: "Z" }],
    [{ id: "d1", name: "A" }, { id: "b1", name: "B" }, { id: "b2", name: "b" }],
  );
  assert.equal(remap("d1"), "d1");
  assert.equal(remap("x"), "b1", "名前は正規化して先勝ち（同期の addDeck と同じ）");
  assert.equal(remap("z"), "z");
  assert.equal(remap("unknown"), "unknown");
  assert.equal(m.remapDeletionKeyWith("x apple", remap), "b1 apple");
  assert.equal(m.remapDeletionKeyWith("apple", remap), "apple", "旧形式はそのまま");
});

test("移動の停止: 旧形式（語だけ）の墓標は、移動後にその語が1つの単語帳にしか無いときだけ効く（同期と同じ）", () => {
  const state = {
    decks: [{ id: "d1", name: "A" }, { id: "d2", name: "B" }, { id: "d3", name: "C" }],
    words: [W("a", "apple", "りんご", "d1"), W("c", "apple", "林檎", "d3")],
    deletions: { apple: NOW },
    trash: [],
  };
  const m = moveSandbox(state);
  assert.equal(m.deletionBlocksMove("d2", m.appState.words[0]), false, "他の単語帳にも同じ語があるなら旧墓標は効かない");
  m.appState.words = m.appState.words.filter((w) => w.id !== "c");
  assert.equal(m.deletionBlocksMove("d2", m.appState.words[0]), true, "1つの単語帳にしか無ければ効く");
});

test("JSON読み込み（確定）: 置換前の墓標は単語帳IDを読み替えて引き継ぎ、同名別IDの単語帳へ戻した語を救う", () => {
  const body = extractHandlerBody('elements.importConfirmButton?.addEventListener("click", async () => {');
  const current = {
    words: [],
    decks: [{ id: "d1", name: "A", updatedAt: 0 }],
    deletions: { "d1 apple": NOW }, // A で apple を削除した記録
    trash: [],
  };
  const imported = {
    // 別端末で作った同名の単語帳（ID が違う）に、削除前の apple が残っているバックアップ
    words: [W("p", "apple", "りんご", "d2")],
    decks: [{ id: "d2", name: "a", updatedAt: 0 }],
    deletions: {},
    trash: [],
  };
  const pieces = [
    ...COMMON,
    `let appState = ${JSON.stringify(current)};`,
    `let pendingImport = ${JSON.stringify(imported)};`,
    "let pendingImportV2Credential = null;",
    "let importConfirmMode = 'replace';",
    "let currentQuiz = null;",
    "const elements = { importConfirmButton: { disabled: false, dataset: {} } };",
    "function setStatus() {}",
    "function saveState() {}",
    // 1.0.121: 置き換えは保存を確かめ、ゴミ箱を引き継ぐ
    "async function persistAppStateChecked() { return true; }",
    "function mergeTrashEntries(sources) { return sources.flat(); }",
    "function clearUndo() {}",
    "function renderAll() {}",
    "function offerUndo() {}",
    "function snapshotState() { return JSON.parse(JSON.stringify(appState)); }",
    "function invalidatePersonalFactorCache() {}",
    "function trackUsage() {}",
    "function getActiveV2Credential() { return null; }",
    "function hideImportConfirmBar() {}",
    "function showImportedV2CredentialConfirm() { throw new Error('unexpected'); }",
    "async function connectImportedV2Credential() {}",
    extractFunction("reviveAgainstDeletion"),
    "let importConfirmBusy = false;",
    `const handler = async () => ${body};`,
    "globalThis.__j = { run: handler, state: () => appState };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "data-core-import-remap.js" }).runInNewContext(sandbox);
  return sandbox.__j.run().then(() => {
    const st = sandbox.__j.state();
    assert.equal("d1 apple" in st.deletions, false, "旧IDのままの墓標が残っている（同期で d2 apple に読み替えられ、戻した語が消える）");
    assert.equal("d2 apple" in st.deletions, false, "戻した語の墓標は消す");
    const apple = st.words.find((w) => w.term === "apple");
    assert.ok(Date.parse(apple.addedAt) > NOW, "墓標より新しい追加時刻にする");
  });
});

test("元に戻す: 現在の墓標を、戻す状態の単語帳ID（同名別ID）へ読み替えてから突き合わせる", async () => {
  const u = undoSandbox();
  // 戻す状態: 単語帳 d1/A に apple がある
  const before = { ...baseState(), decks: [{ id: "d1", name: "A", updatedAt: 0 }] };
  u.setState(before);
  const snapshot = u.snapshotState();
  // 強制取得などで、同名別IDの単語帳 d9/A に置き換わり、そこで apple を削除した記録がある
  u.setState({
    ...baseState(),
    words: [],
    decks: [{ id: "d9", name: "a", updatedAt: 0 }],
    deletions: { "d9 apple": NOW },
  });
  u.offerUndo(snapshot);
  await u.performUndo();
  const st = u.getState();
  const apple = st.words.find((w) => w.term === "apple");
  assert.ok(apple, "戻っていない");
  assert.ok(Date.parse(apple.addedAt) > NOW, "読み替えた墓標より新しい追加時刻にする");
  assert.equal("d1 apple" in st.deletions, false);
});

test("代表ID: 同名の単語帳が複数あれば先頭へ寄せる（同期の addDeck と同じ）。同名が無ければ恒等", () => {
  const m = moveSandbox(twoDecks());
  const canon = m.canonicalDeckIdMapper([{ id: "d2", name: "A" }, { id: "d3", name: " a " }, { id: "d4", name: "B" }]);
  assert.equal(canon("d2"), "d2");
  assert.equal(canon("d3"), "d2");
  assert.equal(canon("d4"), "d4");
  assert.equal(canon("zz"), "zz");
});

test("移動の停止: 新形式の墓標があれば旧形式は見ない（新形式が古く、旧形式だけ新しい場合は止めない）", () => {
  const state = twoDecks();
  const m = moveSandbox(state);
  const x = m.appState.words.find((w) => w.id === "x"); // apple, addedAt = NOW-10日
  m.appState.deletions["d2 apple"] = NOW - 20 * 86400000; // 新形式: 語の追加より古い
  m.appState.deletions["apple"] = NOW; // 旧形式: 新しいが、新形式があるので見ない
  assert.equal(m.deletionBlocksMove("d2", x), false);
  delete m.appState.deletions["d2 apple"];
  assert.equal(m.deletionBlocksMove("d2", x), true, "新形式が無ければ旧形式を見る（語が1つの単語帳にしか無い）");
});

test("JSON読み込み（確定）: 読み込んだ側に同名の単語帳が複数あっても、残っている語へ墓標を付けず、戻した語も救う", () => {
  const body = extractHandlerBody('elements.importConfirmButton?.addEventListener("click", async () => {');
  const current = {
    words: [W("k", "kept", "残る", "d1")],
    decks: [{ id: "d1", name: "A", updatedAt: 0 }],
    deletions: { "d1 apple": NOW },
    trash: [],
  };
  const imported = {
    // 同名の単語帳が2つ（同期のマージでは先頭 d2 に統合される）。kept と apple は後ろの d3 に入っている
    words: [W("k2", "kept", "残る", "d3"), W("p", "apple", "りんご", "d3")],
    decks: [{ id: "d2", name: "A", updatedAt: 0 }, { id: "d3", name: "a", updatedAt: 0 }],
    deletions: {},
    trash: [],
  };
  const pieces = [
    ...COMMON,
    `let appState = ${JSON.stringify(current)};`,
    `let pendingImport = ${JSON.stringify(imported)};`,
    "let pendingImportV2Credential = null;",
    "let importConfirmMode = 'replace';",
    "let currentQuiz = null;",
    "const elements = { importConfirmButton: { disabled: false, dataset: {} } };",
    "function setStatus() {}",
    "function saveState() {}",
    // 1.0.121: 置き換えは保存を確かめ、ゴミ箱を引き継ぐ
    "async function persistAppStateChecked() { return true; }",
    "function mergeTrashEntries(sources) { return sources.flat(); }",
    "function clearUndo() {}",
    "function renderAll() {}",
    "function offerUndo() {}",
    "function snapshotState() { return JSON.parse(JSON.stringify(appState)); }",
    "function invalidatePersonalFactorCache() {}",
    "function trackUsage() {}",
    "function getActiveV2Credential() { return null; }",
    "function hideImportConfirmBar() {}",
    "function showImportedV2CredentialConfirm() { throw new Error('unexpected'); }",
    "async function connectImportedV2Credential() {}",
    extractFunction("reviveAgainstDeletion"),
    "let importConfirmBusy = false;",
    `const handler = async () => ${body};`,
    "globalThis.__j = { run: handler, state: () => appState };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "data-core-import-canon.js" }).runInNewContext(sandbox);
  return sandbox.__j.run().then(() => {
    const st = sandbox.__j.state();
    assert.deepEqual(Array.from(st.decks, (d) => d.id), ["d2"], "同名の単語帳は先頭へ統合する（同期のマージと同じ）");
    assert.ok(st.words.every((w) => w.deckId === "d2"), "語の所属も統合先へ");
    assert.equal(Object.keys(st.deletions).some((k) => k.endsWith(" kept")), false, "残っている語に墓標を付けてはいけない");
    assert.equal(Object.keys(st.deletions).some((k) => k.endsWith(" apple")), false, "戻した語の墓標を消す");
    const apple = st.words.find((w) => w.term === "apple");
    assert.ok(Date.parse(apple.addedAt) > NOW, "墓標より新しい追加時刻にする");
    const kept = st.words.find((w) => w.id === "k2");
    assert.equal(kept.addedAt, imported.words[0].addedAt, "残っている語の追加時刻を触ってはいけない");
  });
});

test("同名の単語帳の統合: 先頭へ寄せ、語・削除記録（最大時刻）・削除済み・表示中の単語帳を読み替え、同じ語は mergeWord で1つに", () => {
  const m = moveSandbox(twoDecks());
  const state = {
    decks: [{ id: "d2", name: "A", updatedAt: 0 }, { id: "d3", name: " a ", updatedAt: 0 }, { id: "d4", name: "B", updatedAt: 0 }],
    words: [
      W("p", "apple", "りんご", "d2", { stats: { correct: 2, wrong: 0 }, history: [{ at: iso(NOW - 5000), correct: true }] }),
      W("q", "apple", "林檎", "d3", { stats: { correct: 0, wrong: 1 }, history: [{ at: iso(NOW - 4000), correct: false }] }),
      W("r", "bank", "銀行", "d3"),
    ],
    deletions: { "d3 cat": NOW, "d2 cat": NOW - 1000, "d4 dog": NOW, egg: NOW },
    trash: [{ id: "t1", word: W("z", "zebra", "シマウマ", "d3"), deletedAt: NOW }],
    activeDeckId: "d3",
  };
  const out = m.consolidateSameNameDecks(state);
  assert.deepEqual(Array.from(out.decks, (d) => d.id), ["d2", "d4"]);
  assert.ok(out.words.every((w) => w.deckId !== "d3"));
  const apples = out.words.filter((w) => w.term === "apple");
  assert.equal(apples.length, 1, "同じ単語帳に同じ語が2つ残ってはいけない（同期と同じく1つに）");
  assert.equal(apples[0].stats.correct, 2);
  assert.equal(apples[0].stats.wrong, 1, "履歴・成績は mergeWord で統合する");
  assert.equal(out.words.find((w) => w.id === "r").deckId, "d2");
  assert.equal(out.deletions["d2 cat"], NOW, "同じキーに寄る墓標は新しい時刻を採る");
  assert.equal("d3 cat" in out.deletions, false);
  assert.equal(out.deletions["d4 dog"], NOW);
  assert.equal(out.deletions.egg, NOW, "旧形式はそのまま");
  assert.equal(out.trash[0].word.deckId, "d2");
  assert.equal(out.activeDeckId, "d2");
  // 削除済みは、生きている語と重なる項目を除き、同じ語は新しい方だけ残す（同期のマージと同じ）
  const withTrash = m.consolidateSameNameDecks({
    decks: [{ id: "d2", name: "A" }, { id: "d3", name: "a" }],
    words: [W("p", "apple", "りんご", "d2")],
    deletions: {},
    trash: [
      { id: "t1", word: W("q", "apple", "林檎", "d3"), deletedAt: NOW }, // 生きている apple と重なる
      { id: "t2", word: W("r", "bank", "銀行", "d3"), deletedAt: NOW - 10 },
      { id: "t3", word: W("s", "bank", "土手", "d2"), deletedAt: NOW - 5 },
    ],
    activeDeckId: "all",
  });
  assert.deepEqual(Array.from(withTrash.trash, (e) => [e.word.term, e.word.deckId, e.word.meaning]), [["bank", "d2", "土手"]]);
  // 同名が無ければ何も変えない
  const plain = { decks: [{ id: "x", name: "X" }], words: [W("w", "w", "w", "x")], deletions: { "x w": 1 }, trash: [], activeDeckId: "all" };
  const same = m.consolidateSameNameDecks(plain);
  assert.equal(same, plain);
  assert.equal(same.decks.length, 1);
});

test("JSON読み込み（確定）: 読み込んだデータ自身の墓標が兄弟の単語帳IDにあっても、統合してから戻した語を救う", () => {
  const body = extractHandlerBody('elements.importConfirmButton?.addEventListener("click", async () => {');
  const imported = {
    words: [W("p", "apple", "りんご", "d2")], // 追加は NOW-10日、学習なし
    decks: [{ id: "d2", name: "A", updatedAt: 0 }, { id: "d3", name: "a", updatedAt: 0 }],
    deletions: { "d3 apple": NOW }, // 兄弟側の単語帳IDに、語の追加より新しい墓標
    trash: [],
  };
  const pieces = [
    ...COMMON,
    "let appState = { words: [], decks: [{ id: 'd1', name: 'Z', updatedAt: 0 }], deletions: {}, trash: [] };",
    `let pendingImport = ${JSON.stringify(imported)};`,
    "let pendingImportV2Credential = null;",
    "let importConfirmMode = 'replace';",
    "let currentQuiz = null;",
    "const elements = { importConfirmButton: { disabled: false, dataset: {} } };",
    "function setStatus() {}",
    "function saveState() {}",
    // 1.0.121: 置き換えは保存を確かめ、ゴミ箱を引き継ぐ
    "async function persistAppStateChecked() { return true; }",
    "function mergeTrashEntries(sources) { return sources.flat(); }",
    "function clearUndo() {}",
    "function renderAll() {}",
    "function offerUndo() {}",
    "function snapshotState() { return JSON.parse(JSON.stringify(appState)); }",
    "function invalidatePersonalFactorCache() {}",
    "function trackUsage() {}",
    "function getActiveV2Credential() { return null; }",
    "function hideImportConfirmBar() {}",
    "function showImportedV2CredentialConfirm() { throw new Error('unexpected'); }",
    "async function connectImportedV2Credential() {}",
    extractFunction("reviveAgainstDeletion"),
    "let importConfirmBusy = false;",
    `const handler = async () => ${body};`,
    "globalThis.__j = { run: handler, state: () => appState };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "data-core-import-own-tomb.js" }).runInNewContext(sandbox);
  return sandbox.__j.run().then(() => {
    const st = sandbox.__j.state();
    assert.equal(Object.keys(st.deletions).some((k) => k.endsWith(" apple")), false, "統合後のキー（d2 apple）で見つけて消す");
    const apple = st.words.find((w) => w.term === "apple");
    assert.equal(apple.deckId, "d2");
    assert.ok(Date.parse(apple.addedAt) > NOW, "墓標より新しい追加時刻にする（次の同期で消えない）");
  });
});

test("元に戻す: 戻す状態自身の墓標が兄弟の単語帳IDにあっても、統合してから戻した語を救う", async () => {
  const u = undoSandbox();
  const snapshotState = {
    ...baseState(),
    words: [W("p", "apple", "りんご", "d2")],
    decks: [{ id: "d2", name: "A", updatedAt: 0 }, { id: "d3", name: "a", updatedAt: 0 }],
    deletions: { "d3 apple": NOW },
  };
  u.setState(snapshotState);
  const snapshot = u.snapshotState();
  u.setState({ ...baseState(), words: [], decks: [{ id: "d2", name: "A", updatedAt: 0 }], deletions: {} });
  u.offerUndo(snapshot);
  await u.performUndo();
  const st = u.getState();
  assert.deepEqual(Array.from(st.decks, (d) => d.id), ["d2"]);
  const apple = st.words.find((w) => w.term === "apple");
  assert.ok(apple, "戻っていない");
  assert.ok(Date.parse(apple.addedAt) > NOW);
  assert.equal(Object.keys(st.deletions).some((k) => k.endsWith(" apple")), false);
});

test("同名の単語帳が現在の状態に残っていても（別端末での同時改名）、移動の判定は代表IDで行う", () => {
  const state = {
    decks: [{ id: "d1", name: "C" }, { id: "d2", name: "c" }, { id: "d3", name: "X" }],
    words: [W("a", "apple", "りんご", "d1"), W("x", "apple", "林檎", "d3"), W("y", "bank", "銀行", "d3")],
    deletions: { "d1 bank": NOW }, // 代表側（d1）に bank の新しい墓標
    trash: [],
  };
  const m = moveSandbox(state);
  // d2 は d1 と同名＝同じ単語帳なので、d2 への移動でも d1 の apple と重なる
  assert.equal(m.deckHasTerm("d2", "apple"), true);
  assert.equal(m.moveWordToDeck("x", "d2"), false);
  assert.match(m.status().at(-1), /もうあるため移動できません/);
  // d2 への移動でも、代表 d1 の墓標を見つけて止める
  const y = m.appState.words.find((w) => w.id === "y");
  assert.equal(m.deletionBlocksMove("d2", y), true, "同名の単語帳の墓標を見落としてはいけない");
  assert.equal(m.moveWordToDeck("y", "d2"), false);
  assert.match(m.status().at(-1), /以前に削除した記録が残っているため/);
});

test("一括移動: 同名の単語帳が現在の状態に残っていても、移動先の同じ語と「既にある」を代表IDで判定する", () => {
  const body = extractHandlerBody('elements.moveSelectedButton?.addEventListener("click", () => {');
  const state = {
    decks: [{ id: "d1", name: "C" }, { id: "d2", name: "c" }, { id: "d3", name: "X" }],
    words: [W("a", "apple", "りんご", "d1"), W("x", "apple", "林檎", "d3"), W("y", "bank", "銀行", "d3"), W("z", "cat", "猫", "d2")],
    deletions: {},
    trash: [],
  };
  const pieces = [
    ...COMMON,
    `const appState = ${JSON.stringify(state)};`,
    "const selectedIds = new Set(['x', 'y', 'z']);",
    "const elements = { moveSelectedButton: {}, moveSelectedDeckSelect: { value: 'd2' } };",
    "let __status = []; let __saved = 0;",
    "function setStatus(m) { __status.push(m); }",
    "function saveState() { __saved += 1; }",
    "function snapshotState() { return JSON.parse(JSON.stringify(appState)); }",
    "function offerUndo() {}",
    "function deckName(id) { return appState.decks.find((d) => d.id === id)?.name || '単語帳'; }",
    `function handler() ${body}`,
    "handler();",
    "globalThis.__r = { appState, status: __status, saved: __saved };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "data-core-bulk-move-canon.js" }).runInNewContext(sandbox);
  const byId = (id) => sandbox.__r.appState.words.find((w) => w.id === id);
  assert.equal(byId("x").deckId, "d3", "同名の d1 に apple があるので動かさない");
  assert.equal(byId("y").deckId, "d2");
  assert.equal(byId("z").deckId, "d2", "既に移動先（同名）にある語は触らない");
  assert.match(sandbox.__r.status.at(-1), /1件を単語帳「c」へ移動しました。1件（apple）は移動先に同じ語があるため残しました。/);
});

test("移動の停止: 同名の非代表側の単語帳にある墓標も見る（代表側へ移動するとき）", () => {
  const state = {
    decks: [{ id: "d1", name: "C" }, { id: "d2", name: "c" }, { id: "d3", name: "X" }],
    words: [W("y", "bank", "銀行", "d3")],
    deletions: { "d2 bank": NOW }, // 非代表側（d2）にだけ、語より新しい墓標
    trash: [],
  };
  const m = moveSandbox(state);
  const y = m.appState.words.find((w) => w.id === "y");
  assert.equal(m.deletionBlocksMove("d1", y), true, "同期は d2 bank を d1 bank に読み替えて消すので、d1 への移動も止める");
  assert.equal(m.moveWordToDeck("y", "d1"), false);
  // 学習が墓標より新しければ動かせる
  y.progressUpdatedAt = NOW + 1;
  assert.equal(m.deletionBlocksMove("d1", y), false);
});

test("元に戻す: 端末に保存できなければ戻す前の状態に返し、取り消しの控えは残す（もう一度押せる）（1.0.119）", async () => {
  const u = undoSandbox();
  u.setState(baseState());
  const snapshot = u.snapshotState();
  u.setState({ ...u.getState(), words: [u.getState().words[1]] }); // 1語削除した
  u.offerUndo(snapshot);
  u.setQuiz({ live: true });
  u.setPersistOk(false);
  await u.performUndo();
  assert.equal(u.getState().words.length, 1, "保存できなかったので削除後の状態のまま（メモリだけ戻して再読込で消えることを避ける）");
  assert.equal(u.hasUndo(), true, "控えは残す");
  assert.ok(u.quiz()?.live, "進行中のクイズも捨てない");
  assert.match(u.status().at(-1), /端末に保存できなかったため、元に戻せませんでした/);
  assert.ok(u.rendered() >= 1);
  // 空きができて、もう一度押したら戻る
  u.setPersistOk(true);
  await u.performUndo();
  assert.equal(u.getState().words.length, 2, "戻った");
  assert.equal(u.hasUndo(), false, "使い終えた控えは消す");
  assert.equal(u.quiz(), null);
  assert.equal(u.status().at(-1), "元に戻しました。");
});

test("候補の保存と採点: 保存前に取り消し・進行中クイズを捨てない／出題中の語が消えたら無言で止めない（1.0.119）", () => {
  const save = html.slice(html.indexOf('elements.saveParsedButton.addEventListener("click", async () => {'));
  const body = save.slice(0, save.indexOf("\n});\n"));
  const awaitAt = body.indexOf("await persistAppStateChecked()");
  assert.ok(awaitAt > 0);
  assert.equal(body.slice(0, awaitAt).includes("clearUndo()"), false, "保存を待つ前に取り消しを消さない");
  assert.equal(body.slice(0, awaitAt).includes("currentQuiz = null"), false, "保存を待つ前に進行中のクイズを捨てない");
  assert.match(body.slice(awaitAt), /currentQuiz = null;\s*clearUndo\(\);/, "保存できてから捨てる");
  const grade = extractFunction("gradeQuiz");
  assert.match(grade, /if \(!word\) \{[\s\S]*?setStatus\("出題中の単語が削除されたため、次の問題に進みます。"\);\s*renderQuiz\(\);\s*return;/);
  assert.match(extractFunction("performUndoOnce"), /invalidatePersonalFactorCache\(\);[\s\S]*?await persistAppStateChecked\(\)/, "丸ごと入れ替えるので派生キャッシュを捨てる");
});

test("元に戻す: 保存を待つ間に2回目を押しても、控えを消さず1回目の結果に従う（1.0.120）", async () => {
  const u = undoSandbox();
  u.setState(baseState());
  const snapshot = u.snapshotState();
  u.setState({ ...u.getState(), words: [u.getState().words[1]] });
  u.offerUndo(snapshot);
  u.setPersistOk(false);
  const first = u.performUndo();
  const second = u.performUndo(); // 保存待ちの間の2回目
  await Promise.all([first, second]);
  assert.equal(u.hasUndo(), true, "2回目が「変わった」と誤判定して控えを消してはいけない");
  assert.equal(u.getState().words.length, 1, "保存に失敗したので戻していない");
  assert.equal(u.status().filter((m) => /元に戻せませんでした。削除した単語は/.test(m)).length, 0, "誤った説明を出さない");
  u.setPersistOk(true);
  await u.performUndo();
  assert.equal(u.getState().words.length, 2);
});

test("単語帳をまたぐ移動の墓標判定: 全語の走査は旧形式の墓標があるときだけ（一括移動・単語帳削除で選択数×語数にしない）（1.0.120）", () => {
  const src = extractFunction("deletionBlocksMove");
  const scanAt = src.indexOf("appState.words.filter(");
  const legacyAt = src.indexOf("if (legacyTs) {");
  assert.ok(legacyAt > 0 && scanAt > legacyAt, "走査は旧形式の墓標がある分岐の中にある");
  assert.match(src, /let ts = 0;[\s\S]*?if \(!ts\) \{/, "新形式の墓標が見つかれば走査しない");
});

test("元に戻す: 保存を待つ間に同期の反映で状態が差し替わっていたら、保存に失敗しても差し替え後を残す（同期差分を捨てない）（1.0.120）", async () => {
  const u = undoSandbox();
  u.setState(baseState());
  const snapshot = u.snapshotState();
  u.setState({ ...u.getState(), words: [u.getState().words[1]] });
  u.offerUndo(snapshot);
  u.setPersistOk(false);
  // 保存待ちの間に同期が appState を丸ごと差し替える（他端末で cat が追加された）
  u.setDuringPersist(() => {
    u.setState({ ...u.getState(), words: [...u.getState().words, W("c", "cat", "猫", "d1")] });
  });
  await u.performUndo();
  assert.equal(u.getState().words.some((w) => w.id === "c"), true, "同期で入った語を捨ててはいけない");
  assert.equal(u.hasUndo(), false, "指紋が合わなくなった控えは消す");
  assert.match(u.status().at(-1), /同期の反映と重なったため/);
});

test("ストリーク: 未来日付の記録は解答時に「今日」へ丸めて確定し、翌日に連続日数が増える（1.0.121）", () => {
  const sandbox = { appState: { streak: { count: 3, last: "2999-01-01", best: 3 } }, renderStreakBadge() {} };
  new Script(
    [
      extractFunction("localDateString"),
      extractFunction("normalizeStreak"),
      extractFunction("updateStreakOnAnswer"),
      "globalThis.__s = { updateStreakOnAnswer, localDateString };",
    ].join("\n\n"),
    { filename: "streak.js" },
  ).runInNewContext(sandbox);
  sandbox.__s.updateStreakOnAnswer();
  const today = sandbox.__s.localDateString();
  assert.equal(sandbox.appState.streak.last, today, "未来日付を今日に丸めて書き戻す");
  assert.equal(sandbox.appState.streak.count, 3, "日数は捨てない");
  // 翌日（記録が昨日になった状態）に解くと連続日数が増える
  const y = new Date(); y.setDate(y.getDate() - 1);
  sandbox.appState.streak = { count: 3, last: sandbox.__s.localDateString(y), best: 3 };
  sandbox.__s.updateStreakOnAnswer();
  assert.equal(sandbox.appState.streak.count, 4);
  assert.equal(sandbox.appState.streak.last, today);
});

test("JSON の置き換え読み込み: ゴミ箱を引き継ぎ、保存を確かめてから成功と伝える。共有単語帳の書き出しは同名の別IDの語も含める（1.0.121）", () => {
  const start = html.indexOf('elements.importConfirmButton?.addEventListener("click", async () => {');
  const body = html.slice(start, html.indexOf("\n});\n", start));
  assert.match(body, /const previousTrash = appState\.trash \|\| \[\];/);
  assert.match(body, /appState\.trash = mergeTrashEntries\(\[appState\.trash \|\| \[\], previousTrash\], remapDeck\);/, "置換前のゴミ箱を墓標と同じ対応表で引き継ぐ");
  const awaitAt = body.indexOf("await persistAppStateChecked()");
  assert.ok(awaitAt > 0, "保存を確かめる");
  assert.match(body.slice(awaitAt), /if \(!persisted\) \{\s*appState = before;[\s\S]*?読み込みを取り消しました/, "失敗したら置き換え前へ返す");
  assert.match(body.slice(awaitAt), /clearUndo\(\);\s*renderAll\(\);\s*offerUndo\(snapshot\);/, "保存できてから取り消しを差し替える");
  assert.equal(body.includes("saveState();"), false, "投げっぱなしの保存は使わない");
  const share = extractFunction("deckSharePayload");
  assert.match(share, /const canon = canonicalDeckIdMapper\(appState\.decks\);[\s\S]*?\.filter\(\(word\) => canon\(word\.deckId\) === canon\(deckId\)\)/);
});

test("クイズ描画: 採点済みの問題は再描画で描き直さない（正誤の色と完成文を保つ）。例文モードの補充は語で重複排除する（1.0.122）", () => {
  assert.match(extractFunction("renderQuiz"), /if \(currentQuiz\.answered\) \{[\s\S]*?updateQuizControls\(\);\s*return;\s*\}\s*renderQuizPromptWord\(currentQuiz\);/);
  assert.match(extractFunction("renderReviewQuiz"), /if \(currentQuiz\.answered\) return;[\s\S]*?renderQuizPromptWord\(currentQuiz\);/);
  assert.match(extractFunction("buildContextChoices"), /pickDistractors\(basePool, answer, 3 - generated\.length, \[\], \{\s*preferDifferentPos: true,\s*dedupeBy: "term",\s*\}\)/);
});
