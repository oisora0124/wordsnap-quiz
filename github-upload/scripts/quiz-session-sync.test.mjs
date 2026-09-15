// クイズ本体の Codex レビュー（1.0.106）で直した点を、実コードのまま固定する。
//
// 1. 同期で消えた未回答語は、復習セッションの残り数・total・結果から取り除く
//    （reconcileReviewSessionWords / buildReviewQuiz の消えた語の扱い）。
// 2. 表示中に同期で同じ語の学習進捗が変わっていたら、作問時の「期限到来」を使わない
//    （quizSrsSnapshot / effectiveSrsDueAtStart）。別端末で進んだ段階からもう一段進むのを防ぐ。
// 3. 復帰の抜き取りの完了判定は「残っている語を全部答えたか」（finishRecoveryProbe）。
// 4. セッションの開始・終了で自動送りのタイマーを止める。
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

const W = (id, term, meaning, learning = {}) => ({
  id,
  term,
  meaning,
  pos: { tag: "v" },
  stats: { correct: 0, wrong: 0 },
  history: [],
  learning: { status: "new", nextReviewAt: 0, ...learning },
  progressUpdatedAt: 0,
  addedAt: "2026-01-01T00:00:00.000Z",
});

// ============================================================================
// 1. 同期で消えた未回答語の帳尻合わせ
// ============================================================================
function reconcileSandbox() {
  const pieces = [
    "let reviewSession = null;",
    "let currentQuiz = null;",
    "let __persisted = 0;",
    "let __ended = [];",
    "let __scope = '';",
    "const appState = { words: [] };",
    "const elements = { quizScope: { textContent: '' }, quizWord: { textContent: '' }, choices: { innerHTML: '' }, quizFeedback: { textContent: '' } };",
    "function persistReviewProgress() { __persisted += 1; }",
    "function endReview(message) { __ended.push(message); reviewSession = null; currentQuiz = null; }",
    "function wordCefrLevel() { return null; }",
    "function renderQuizPromptWord() {}",
    "function renderChoices() {}",
    "function autoSpeakCurrentQuiz() {}",
    "function clearSavedReviewProgress() {}",
    "function renderQuizEmpty() {}",
    "let quizEmptyReason = '';",
    "let reviewResult = null;",
    "let quizStarted = false;",
    "let __built = null;",
    "function buildReviewQuiz() { return __built; }",
    extractFunction("dropWordFromReviewSession"),
    extractFunction("reconcileReviewSessionWords"),
    extractFunction("reviewScopeText"),
    extractFunction("renderReviewQuiz"),
    "globalThis.__s = {" +
      " setWords: (w) => { appState.words = w; }," +
      " setSession: (s) => { reviewSession = s; }," +
      " getSession: () => reviewSession," +
      " setCurrentQuiz: (q) => { currentQuiz = q; }," +
      " getCurrentQuiz: () => currentQuiz," +
      " setBuilt: (q) => { __built = q; }," +
      " reconcileReviewSessionWords, renderReviewQuiz," +
      " persisted: () => __persisted, ended: () => __ended," +
      " scope: () => elements.quizScope.textContent };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "quiz-session-sync-reconcile.js" }).runInNewContext(sandbox);
  return sandbox.__s;
}

const session = (over = {}) => ({
  allIds: ["a", "b", "c", "d"],
  queue: ["b", "c", "d"], // a は正解済み（キューにない）
  total: 4,
  label: "復習",
  missedIds: ["c"],
  ...over,
});

test("帳尻合わせ: 同期で消えた未回答語は queue・allIds・missedIds・total から外れる", () => {
  const s = reconcileSandbox();
  // c と d が同期で消えた。a（回答済み）も消えたが、それは計上済みなので触らない
  s.setWords([W("b", "bring", "持ってくる")]);
  s.setSession(session());
  const removed = s.reconcileReviewSessionWords();
  const after = s.getSession();
  assert.equal(removed, 2);
  assert.deepEqual(Array.from(after.queue), ["b"]);
  assert.deepEqual(Array.from(after.allIds), ["a", "b"], "回答済みの a は残す");
  assert.deepEqual(Array.from(after.missedIds), []);
  assert.equal(after.total, 2, "未回答で消えた2語ぶん減る（a は計上済み）");
  assert.ok(s.persisted() >= 1, "再開スナップショットも更新する");
});

test("帳尻合わせ: 消えた語が無ければ何も変えない（0を返す）", () => {
  const s = reconcileSandbox();
  s.setWords(["a", "b", "c", "d"].map((id) => W(id, id, id)));
  s.setSession(session());
  assert.equal(s.reconcileReviewSessionWords(), 0);
  assert.equal(s.getSession().total, 4);
  assert.equal(s.persisted(), 0);
});

test("帳尻合わせ: 表示中（未回答）の問題の語が消えていたら作り直す。回答済みなら残す", () => {
  const s = reconcileSandbox();
  s.setWords([W("b", "bring", "持ってくる")]);
  s.setSession(session({ queue: ["b"], allIds: ["b"], total: 1, missedIds: [] }));
  s.setCurrentQuiz({ answer: { id: "zzz" }, answered: false, choices: [] });
  s.reconcileReviewSessionWords();
  assert.equal(s.getCurrentQuiz(), null, "解答しても何も起きない幽霊の問題を残さない");
  s.setCurrentQuiz({ answer: { id: "zzz" }, answered: true, choices: [] });
  s.reconcileReviewSessionWords();
  assert.ok(s.getCurrentQuiz(), "回答済みの結果表示は消さない");
});

test("配線: renderReviewQuiz は先に帳尻を合わせ、残り数の表示が実態になる", () => {
  const s = reconcileSandbox();
  s.setWords([W("b", "bring", "持ってくる"), W("a", "alter", "変える")]);
  s.setSession(session());
  s.setBuilt({ answer: { id: "b" }, answered: false, choices: [] });
  s.renderReviewQuiz();
  assert.equal(s.scope(), "復習 残り 1/2");
  assert.deepEqual(Array.from(s.ended()), []); // vm の別レルム配列
});

test("配線: 未回答語しか無かったセッションの語が同期で全部消えたら、空の結果を出さず終了する", () => {
  const s = reconcileSandbox();
  s.setWords([W("x", "other", "別の語")]);
  s.setSession(session({ allIds: ["c", "d"], queue: ["c", "d"], total: 2, missedIds: [] }));
  s.renderReviewQuiz();
  assert.equal(s.getSession(), null);
  assert.equal(s.ended().length, 1);
  assert.match(s.ended()[0], /同期/);
});

test("配線: 回答済みの語が残っていれば、残りが全部消えても終了せず完了表示へ進める", () => {
  const s = reconcileSandbox();
  s.setWords([W("a", "alter", "変える")]);
  s.setSession(session({ queue: ["c", "d"] })); // a,b は回答済み扱い（b は消えたが計上済み）
  s.renderReviewQuiz();
  assert.ok(s.getSession(), "total>0 なら結果画面へ進む");
  assert.equal(s.getSession().total, 2);
  assert.deepEqual(Array.from(s.ended()), []); // vm の別レルム配列
});

test("buildReviewQuiz: 消えた語を dropWordFromReviewSession で total ごと取り除く（「次の問題」は render より先に build する）", () => {
  const body = extractFunction("buildReviewQuiz");
  assert.match(body, /dropWordFromReviewSession\(reviewSession\.queue\[0\]\)/);
  assert.doesNotMatch(body, /reviewSession\.queue\.shift\(\);\s*continue;/);
  const pieces = [
    "let quizEmptyReason = '';",
    "let contextFallbackNote = '';",
    "let __persisted = 0;",
    "function persistReviewProgress() { __persisted += 1; }",
    "const elements = { quizFeedback: { textContent: '' } };",
    `const appState = { words: ${JSON.stringify([W("b", "bring", "持ってくる"), W("x1", "one", "一"), W("x2", "two", "二"), W("x3", "three", "三")])} };`,
    "let reviewSession = { allIds: ['gone', 'b'], queue: ['gone', 'b'], total: 2, missedIds: ['gone'], context: false, mixFormat: false, reverse: false };",
    "const mixedFormatUsesContext = () => false;",
    "const contextItemFor = () => null;",
    "const contextAttempted = () => true;",
    "const ensureContextItem = () => Promise.resolve(null);",
    "const prefetchNextContextItem = () => {};",
    "const buildContextChoices = () => [];",
    "const shuffle = (items) => items.slice();",
    "const choiceCountNote = () => '';",
    "const isMasteryVerificationDue = () => false;",
    "const pickDistractorsWithFallback = (pool) => pool.slice(0, 3);",
    extractFunction("quizSrsSnapshot"),
    extractFunction("dropWordFromReviewSession"),
    extractFunction("buildReviewQuiz"),
    "globalThis.__quiz = buildReviewQuiz();",
    "globalThis.__session = reviewSession;",
    "globalThis.__persisted = __persisted;",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "quiz-session-sync-build.js" }).runInNewContext(sandbox);
  assert.equal(sandbox.__quiz.answer.id, "b");
  assert.equal(sandbox.__session.total, 1);
  assert.deepEqual(Array.from(sandbox.__session.allIds), ["b"]);
  assert.deepEqual(Array.from(sandbox.__session.missedIds), []);
  assert.equal(sandbox.__persisted, 1);
});

// ============================================================================
// 2. 表示中に同期で学習進捗が変わった語の「期限到来」
// ============================================================================
function srsSandbox() {
  const pieces = [
    extractFunction("quizSrsSnapshot"),
    extractFunction("effectiveSrsDueAtStart"),
    "globalThis.__q = { quizSrsSnapshot, effectiveSrsDueAtStart };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "quiz-session-sync-srs.js" }).runInNewContext(sandbox);
  return sandbox.__q;
}

const NOW = 1_800_000_000_000;

test("作問時の印: 期限到来かどうかと progressUpdatedAt を控える", () => {
  const q = srsSandbox();
  const due = W("a", "alter", "変える", { nextReviewAt: NOW - 1000 });
  due.progressUpdatedAt = 123456;
  assert.deepEqual({ ...q.quizSrsSnapshot(due, NOW) }, { srsDueAtStart: true, progressStamp: 123456 }); // vm の別レルム
  const notDue = W("b", "bring", "持ってくる", { nextReviewAt: NOW + 1000 });
  assert.deepEqual({ ...q.quizSrsSnapshot(notDue, NOW) }, { srsDueAtStart: false, progressStamp: 0 });
  const unstarted = W("c", "cut", "切る", { nextReviewAt: 0 });
  assert.equal(q.quizSrsSnapshot(unstarted, NOW).srsDueAtStart, false, "SRS未開始は期限到来ではない");
});

test("採点時: 進捗の印が同じなら作問時の期限到来をそのまま使う（考えている間に期限を過ぎても変えない）", () => {
  const q = srsSandbox();
  const word = W("a", "alter", "変える", { nextReviewAt: NOW + 5000 });
  word.progressUpdatedAt = 777;
  const quiz = { srsDueAtStart: true, progressStamp: 777 };
  assert.equal(q.effectiveSrsDueAtStart(quiz, word, NOW), true);
  const quiz2 = { srsDueAtStart: false, progressStamp: 777 };
  assert.equal(q.effectiveSrsDueAtStart(quiz2, word, NOW + 10000), false, "表示中に期限が来ても、その回は前進させない（従来どおり）");
});

test("採点時: 別端末の解答が同期で入っていたら（印が違う）、今の学習状態で判定し直す", () => {
  const q = srsSandbox();
  // 作問時は期限到来（stamp 777）。同期で別端末の解答が入り、次回が未来になった
  const word = W("a", "alter", "変える", { nextReviewAt: NOW + 3 * 86400000, srsStage: 3 });
  word.progressUpdatedAt = 999;
  assert.equal(
    q.effectiveSrsDueAtStart({ srsDueAtStart: true, progressStamp: 777 }, word, NOW),
    false,
    "別端末で進んだ段階からもう一段進めてはいけない",
  );
  // 同期後もまだ期限到来のまま（別端末で誤答して翌日に戻った等）なら true
  const stillDue = W("b", "bring", "持ってくる", { nextReviewAt: NOW - 10 });
  stillDue.progressUpdatedAt = 999;
  assert.equal(q.effectiveSrsDueAtStart({ srsDueAtStart: false, progressStamp: 1 }, stillDue, NOW), true);
});

test("採点時: 印を持たない問題（古い形・テストのスタブ）は従来どおり作問時の値を使う", () => {
  const q = srsSandbox();
  const word = W("a", "alter", "変える", { nextReviewAt: NOW + 5000 });
  word.progressUpdatedAt = 999;
  assert.equal(q.effectiveSrsDueAtStart({ srsDueAtStart: true }, word, NOW), true);
  assert.equal(q.effectiveSrsDueAtStart({ srsDueAtStart: false }, word, NOW), false);
});

test("配線: 3つの出題経路すべてが quizSrsSnapshot を使い、採点は effectiveSrsDueAtStart を通す", () => {
  assert.match(extractFunction("buildQuiz"), /\.\.\.quizSrsSnapshot\(answer\)/);
  assert.match(extractFunction("buildCurrentFlashcard"), /\.\.\.quizSrsSnapshot\(answer\)/);
  const review = extractFunction("buildReviewQuiz");
  assert.match(review, /const srs = quizSrsSnapshot\(answer\)/);
  assert.equal((review.match(/\.\.\.srs\b/g) || []).length, 3, "生成待ち・例文・通常の3つの返り値すべてに付ける");
  const grade = extractFunction("gradeQuiz");
  assert.match(grade, /const srsDueAtStart = effectiveSrsDueAtStart\(currentQuiz, word, answeredAt\);/);
  assert.match(grade, /applyLearningResult\(word, isCorrect, srsDueAtStart, answeredAt, \{/);
  assert.doesNotMatch(grade, /Boolean\(currentQuiz\.srsDueAtStart\)/);
  // 作問時の値を捨てる判断は progressUpdatedAt だけで行う（採点のたびに他の項目を見ない）
  assert.doesNotMatch(html, /nextReviewAt[^\n]*!==[^\n]*progressStamp/);
});

// ============================================================================
// 3. 復帰の抜き取りの完了判定
// ============================================================================
function recoverySandbox() {
  const pieces = [
    "let __store = {};",
    "const localStorage = {" +
      " getItem: (k) => (Object.hasOwn(__store, k) ? __store[k] : null)," +
      " setItem: (k, v) => { __store[k] = String(v); }," +
      " removeItem: (k) => { delete __store[k]; } };",
    `const RECOVERY_KEY = ${JSON.stringify(html.match(/const RECOVERY_KEY = "([^"]+)"/)[1])};`,
    `const RECOVERY_DEFAULT_DAILY_CAP = ${html.match(/const RECOVERY_DEFAULT_DAILY_CAP = (\d+);/)[1]};`,
    `const RECOVERY_MIN_PROBE_ANSWERS = ${html.match(/const RECOVERY_MIN_PROBE_ANSWERS = (\d+);/)[1]};`,
    "const appState = { words: [] };",
    extractFunction("loadRecoveryState"),
    extractFunction("saveRecoveryState"),
    extractFunction("estimateStratumRetention"),
    extractFunction("finishRecoveryProbe"),
    "globalThis.__r = {" +
      " setWords: (w) => { appState.words = w; }," +
      " save: saveRecoveryState, load: loadRecoveryState, finish: finishRecoveryProbe };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "quiz-session-sync-recovery.js" }).runInNewContext(sandbox);
  return sandbox.__r;
}

function probeState(ids, answeredIds) {
  const probeStrata = {};
  const probeAnswers = {};
  for (const id of ids) probeStrata[id] = "s1:0";
  for (const id of answeredIds) probeAnswers[id] = true;
  return {
    startedAt: 1,
    sessionId: "rp1",
    probeIds: ids,
    probeStrata,
    probeAnswers,
    probeDone: false,
    retention: new Map(),
    dailyCap: 40,
    totalAtStart: 100,
  };
}

test("抜き取りの完了: 答えた語を削除して件数が合っても、まだ答えていない語が残っていれば完了にしない", () => {
  const r = recoverySandbox();
  const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
  const answered = ids.slice(0, 10); // p0〜p9 に答えた
  r.save(probeState(ids, answered));
  // 答えた p0, p1 を削除 → 残っている語は10、答えた数も10で件数は一致するが p10, p11 は未回答
  r.setWords(ids.filter((id) => id !== "p0" && id !== "p1").map((id) => ({ id })));
  r.finish();
  assert.equal(r.load().probeDone, false, "未回答の語が残っているのに完了にしてはいけない");
  // 途中終了（force）なら、答えた数が閾値以上なので従来どおり確定する
  r.finish({ force: true });
  assert.equal(r.load().probeDone, true);
});

test("抜き取りの完了: 残っている語を全部答えていれば完了。削除した語の回答も推定に含める", () => {
  const r = recoverySandbox();
  const ids = ["p0", "p1", "p2", "p3"];
  const state = probeState(ids, ids);
  state.probeAnswers.p3 = false; // p3 だけ思い出せなかった。あとで p3 を削除する
  r.save(state);
  r.setWords(["p0", "p1", "p2"].map((id) => ({ id })));
  r.finish();
  const after = r.load();
  assert.equal(after.probeDone, true);
  // Beta(1,1): (3正解+1)/(4語+2) = 0.667。削除した p3 の誤答も観測として数える
  assert.ok(Math.abs(after.retention.get("s1:0") - 4 / 6) < 1e-9, `retention=${after.retention.get("s1:0")}`);
});

test("抜き取りの完了: 対象が全部消えていたら記録ごと捨てる（従来どおり）", () => {
  const r = recoverySandbox();
  r.save(probeState(["p0", "p1"], ["p0"]));
  r.setWords([]);
  r.finish();
  assert.equal(r.load(), null);
});

// ============================================================================
// 4. 自動送りのタイマー
// ============================================================================
test("セッションの開始（startReview）と終了（endReview）で自動送りのタイマーを止める", () => {
  const start = extractFunction("startReview");
  const end = extractFunction("endReview");
  assert.match(start, /if \(valid\.length === 0\) \{[\s\S]*?return;\s*\}\s*\n\s*\/\/[^\n]*\n\s*clearAutoNextTimer\(\);/);
  assert.match(end, /^function endReview\(message\) \{\n\s*clearAutoNextTimer\(\);/);
});
