// 例文（空所補充）クイズの経路を、公開HTML内の実コードから抽出して検査する。
// 流儀は scripts/reverse-quiz.test.mjs / scripts/quiz-quality.test.mjs と同じ：
// node:vm でサンドボックス実行し、アプリHTMLを一切書き換えずに実関数を動かす。
//
// 既存テストは例文クイズについて「誤答候補の質」と「仮習得は例文を回避する」しか
// 押さえておらず、次の4つは無防備だった。いずれも壊れても画面上は普通に動いて見え、
// 静かに品質だけが落ちる種類のもの。
//
//   1. 読み上げの答え漏れ
//      空所補充は「英文の空所に入る英単語」を4択で選ぶ形式。解答前に正解の term を
//      読み上げると答えを声で言ってしまう。画面は blankOutTermInSentence で空所化して
//      いるのに、音声だけ素通しになっていた（本テスト追加時に発見・修正）。
//   2. 生成待ち中の採点でセッションが消える
//      生成待ちは choices:[] のプレースホルダ。表示側で塞いでいるが、そこが壊れて
//      gradeQuiz に到達すると1択ガードが「出題不能」の後始末として復習セッションと
//      再開データを破棄する。数秒の生成待ちで進行中の復習が消える。
//   3. 生成完了コールバックが、表示中の別の問題を壊す
//      作り直しの発火条件は「同じセッション・生成待ちのまま・同じ語」の3つ。どれか
//      1つ欠けると、別セッションや別の語の生成完了が currentQuiz を捨てて解答中の
//      問題を消す。
//   4. 例文を作れなかった語のフォールバック
//      通常4択へ落ちる際の出題の向き（1.0.81で追加）と、仮習得の検証待ちガード。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Script } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

// 波括弧の対応をとって関数本体を丸ごと切り出す（quiz-quality.test.mjs と同じ実装）。
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

// テスト用の単語。実データと同じ形（normalizeWord 済みを想定）にそろえる。
function W(id, term, meaning, pos = "n") {
  return {
    id,
    term,
    meaning,
    pos,
    stats: { correct: 0, wrong: 0 },
    history: [],
    learning: {
      status: "review",
      srsStage: 1,
      nextReviewAt: 0,
      blockedUntil: 0,
      correctStreak: 0,
    },
  };
}

// ============================================================================
// 1. 読み上げの答え漏れ（autoSpeakCurrentQuiz）
// ============================================================================

// autoSpeakCurrentQuiz は currentQuiz と設定だけを見る小さな関数なので、
// speakWord をレコーダーに差し替えて「何を読み上げたか」を直接観測する。
function buildAutoSpeakSandbox({ enabled = true, hasSpeech = true } = {}) {
  const pieces = [
    "let currentQuiz = null;",
    "const spoken = [];",
    `function autoSpeakEnabled() { return ${enabled ? "true" : "false"}; }`,
    "function speakWord(term) { spoken.push(term); }",
    // "speechSynthesis" in window の判定に実際に効かせる
    hasSpeech ? "const window = { speechSynthesis: {} };" : "const window = {};",
    extractFunction("autoSpeakCurrentQuiz"),
    "globalThis.__as = {" +
      " spoken," +
      " setCurrentQuiz: (q) => { currentQuiz = q; }," +
      " getCurrentQuiz: () => currentQuiz," +
      " autoSpeakCurrentQuiz };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "context-quiz-autospeak-check.js" }).runInNewContext(sandbox);
  return sandbox.__as;
}

// 空所補充の問題オブジェクト（buildReviewQuiz の成功パスが返す形と同じ）
function contextQuiz(overrides = {}) {
  return {
    answer: { id: "a1", term: "gather", meaning: "集める" },
    choices: [
      { id: "a1", label: "gather" },
      { id: "p1", label: "wisdom" },
      { id: "p2", label: "urban" },
      { id: "p3", label: "fragile" },
    ],
    answered: false,
    shownAt: Date.now(),
    context: { en: "They ___ data every week.", ja: null, src: "ai" },
    srsDueAtStart: false,
    ...overrides,
  };
}

test("読み上げ: 空所補充では解答前に正解の英単語を読み上げない（答えの音声漏れ）", () => {
  const a = buildAutoSpeakSandbox();
  a.setCurrentQuiz(contextQuiz());
  a.autoSpeakCurrentQuiz();
  assert.deepEqual(
    Array.from(a.spoken),
    [],
    "空所補充は英単語そのものを選ばせる形式なので、解答前の読み上げは答えを漏らす",
  );
});

test("読み上げ: 空所補充では autoSpoken の印も立てない（設定変更後に鳴らないのを防ぐ）", () => {
  const a = buildAutoSpeakSandbox();
  const quiz = contextQuiz();
  a.setCurrentQuiz(quiz);
  a.autoSpeakCurrentQuiz();
  assert.equal(
    quiz.autoSpoken,
    undefined,
    "早期returnより後で印を立てているため、空所補充では印が付かない",
  );
});

test("読み上げ: 例文の生成待ち中も読み上げない", () => {
  const a = buildAutoSpeakSandbox();
  a.setCurrentQuiz({
    answer: { id: "a1", term: "gather", meaning: "集める" },
    choices: [],
    answered: false,
    shownAt: 0,
    context: null,
    contextPending: true,
    srsDueAtStart: false,
  });
  a.autoSpeakCurrentQuiz();
  assert.deepEqual(Array.from(a.spoken), []);
});

test("読み上げ: 日→英（逆方向）も解答前は読み上げない（1.0.79の既存動作）", () => {
  const a = buildAutoSpeakSandbox();
  a.setCurrentQuiz({
    answer: { id: "a1", term: "gather", meaning: "集める" },
    choices: [
      { id: "a1", label: "gather" },
      { id: "p1", label: "wisdom" },
    ],
    answered: false,
    shownAt: Date.now(),
    context: null,
    reverse: true,
    srsDueAtStart: false,
  });
  a.autoSpeakCurrentQuiz();
  assert.deepEqual(Array.from(a.spoken), []);
});

test("読み上げ: 通常の英→日は従来どおり1回だけ読み上げる（後方互換）", () => {
  const a = buildAutoSpeakSandbox();
  const quiz = {
    answer: { id: "a1", term: "gather", meaning: "集める" },
    choices: [
      { id: "a1", term: "gather", meaning: "集める" },
      { id: "p1", term: "wisdom", meaning: "知恵" },
    ],
    answered: false,
    shownAt: Date.now(),
    context: null,
    srsDueAtStart: false,
  };
  a.setCurrentQuiz(quiz);
  a.autoSpeakCurrentQuiz();
  a.autoSpeakCurrentQuiz(); // 再描画を模す：2回目は鳴らない
  assert.deepEqual(Array.from(a.spoken), ["gather"]);
  assert.equal(quiz.autoSpoken, true);
});

test("読み上げ: 解答済み・設定OFF・音声非対応ではいずれも読み上げない（既存ガード）", () => {
  const answered = buildAutoSpeakSandbox();
  answered.setCurrentQuiz({ ...contextQuiz({ context: null }), answered: true });
  answered.autoSpeakCurrentQuiz();
  assert.deepEqual(Array.from(answered.spoken), [], "解答済み");

  const off = buildAutoSpeakSandbox({ enabled: false });
  off.setCurrentQuiz(contextQuiz({ context: null }));
  off.autoSpeakCurrentQuiz();
  assert.deepEqual(Array.from(off.spoken), [], "設定OFF");

  const noSpeech = buildAutoSpeakSandbox({ hasSpeech: false });
  noSpeech.setCurrentQuiz(contextQuiz({ context: null }));
  noSpeech.autoSpeakCurrentQuiz();
  assert.deepEqual(Array.from(noSpeech.spoken), [], "speechSynthesis 非対応");
});

// ============================================================================
// 2. 生成待ち中の採点（gradeQuiz）
// ============================================================================

// gradeQuiz を実コードのまま動かし、生成待ちの問題を渡したときに
// 「何も起きない」ことと「復習セッションが残る」ことを直接観測する。
function buildGradeQuizSandbox() {
  const pieces = [
    "let currentQuiz = null;",
    "let reviewSession = null;",
    "let quizEmptyReason = '';",
    "let quizStarted = true;",
    "let quizSessionStats = { answered: 0, correct: 0 };",
    "const appState = { words: [], quizCounter: 0 };",
    // 空所補充は採点後に quizWord へ完成文を差し込むため、その受け皿も要る
    "const elements = { quizFeedback: { textContent: '' }, quizScope: { textContent: '' }," +
      " quizWord: { innerHTML: '', textContent: '' } };",
    `const WRONG_COOLDOWN_MS = ${html.match(/const WRONG_COOLDOWN_MS = ([^;]+);/)[1]};`,
    "const window = { speechSynthesis: {} };",
    // 観測対象：学習データを触る3経路と、セッション破棄・読み上げ
    "const calls = { applyLearning: [], reviewEvent: [], verifyConfidence: [], spoken: [], cleared: 0 };",
    "function verifyConfidenceOnAnswer(wordId, isCorrect, promptMode) { calls.verifyConfidence.push(promptMode); }",
    "function applyLearningResult(word, isCorrect, srsDueAtStart, now, options) {" +
      " calls.applyLearning.push(options.promptMode);" +
      " return { advanced: false, multiplier: 1, nextReviewAt: 0 };" +
      " }",
    "function recordReviewEvent(details) { calls.reviewEvent.push(details.promptMode); }",
    "function clearSavedReviewProgress() { calls.cleared += 1; }",
    "function speakWord(term) { calls.spoken.push(term); }",
    "function autoSpeakEnabled() { return true; }",
    // 残りの副作用は本テストの観測対象ではないので no-op
    "function playSound() {}",
    "function vibrateFeedback() {}",
    "function trackUsage() {}",
    "function updateStreakOnAnswer() {}",
    "function bumpTodayAnswerCount() {}",
    "function recordRecoveryProbeAnswer() {}",
    "function highlightChoices() {}",
    "function highlightTermInSentence() { return '完成文'; }",
    "function renderDailyGoalChip() {}",
    "function maybeCelebrateDailyGoal() {}",
    "function adaptiveSrsEnabled() { return false; }",
    "function adaptiveScheduleNote() { return ''; }",
    "function persistAppState() {}",
    "function renderAccuracy() {}",
    "function updateSavedWordRow() {}",
    "function renderDeckStats() {}",
    "function updateQuizControls() {}",
    "function scheduleAutoNextIfNeeded() {}",
    "function persistReviewProgress() {}",
    "function reviewScopeText() { return ''; }",
    "function renderQuizProgress() {}",
    "function renderQuizEmpty() {}",
    "function renderQuiz() {}",
    extractFunction("currentQuizPromptMode"),
    extractFunction("gradeQuiz"),
    "globalThis.__g = {" +
      " calls," +
      " setCurrentQuiz: (q) => { currentQuiz = q; }," +
      " getCurrentQuiz: () => currentQuiz," +
      " setWords: (w) => { appState.words = w; }," +
      " getWords: () => appState.words," +
      " setSession: (s) => { reviewSession = s; }," +
      " getSession: () => reviewSession," +
      " gradeQuiz };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "context-quiz-gradequiz-check.js" }).runInNewContext(sandbox);
  return sandbox.__g;
}

function pendingQuiz() {
  return {
    answer: { id: "a1", term: "gather", meaning: "集める" },
    choices: [],
    answered: false,
    shownAt: 0,
    context: null,
    contextPending: true,
    srsDueAtStart: false,
  };
}

test("生成待ち: 採点しても復習セッションと再開データが残る（数秒の待ちで復習が消えない）", () => {
  const g = buildGradeQuizSandbox();
  const word = W("a1", "gather", "集める");
  g.setWords([word]);
  const session = { allIds: ["a1"], queue: ["a1"], total: 1, label: "テスト", missedIds: [] };
  g.setSession(session);
  g.setCurrentQuiz(pendingQuiz());

  g.gradeQuiz("a1");

  assert.equal(g.getSession(), session, "生成待ちの採点で復習セッションを破棄してはいけない");
  assert.equal(g.calls.cleared, 0, "再開データを消してはいけない");
  assert.deepEqual(g.getSession().queue, ["a1"], "キューも動かさない");
});

test("生成待ち: 採点しても学習データを一切更新しない", () => {
  const g = buildGradeQuizSandbox();
  const word = W("a1", "gather", "集める");
  g.setWords([word]);
  g.setSession({ allIds: ["a1"], queue: ["a1"], total: 1, label: "テスト", missedIds: [] });
  g.setCurrentQuiz(pendingQuiz());

  g.gradeQuiz("a1");

  assert.deepEqual(word.stats, { correct: 0, wrong: 0 }, "成績を動かさない");
  assert.deepEqual(word.history, [], "履歴を積まない");
  assert.deepEqual(Array.from(g.calls.applyLearning), [], "SRSを更新しない");
  assert.deepEqual(Array.from(g.calls.reviewEvent), [], "ログも残さない");
  assert.equal(g.getCurrentQuiz().answered, false, "解答済みにしない");
});

test("生成待ち: 「わからない」でも同じく何も起きない", () => {
  const g = buildGradeQuizSandbox();
  const word = W("a1", "gather", "集める");
  g.setWords([word]);
  const session = { allIds: ["a1"], queue: ["a1"], total: 1, label: "テスト", missedIds: [] };
  g.setSession(session);
  g.setCurrentQuiz(pendingQuiz());

  g.gradeQuiz(null, true);

  assert.equal(g.getSession(), session);
  assert.deepEqual(word.stats, { correct: 0, wrong: 0 });
  assert.deepEqual(Array.from(g.calls.applyLearning), []);
});

test("採点後: 空所補充は正解の英単語を1回だけ読み上げる（読み上げ機能を失わせない）", () => {
  const g = buildGradeQuizSandbox();
  const word = W("a1", "gather", "集める");
  g.setWords([word]);
  g.setSession({ allIds: ["a1"], queue: ["a1"], total: 1, label: "テスト", missedIds: [] });
  g.setCurrentQuiz(contextQuiz());

  g.gradeQuiz("a1");

  assert.deepEqual(
    Array.from(g.calls.spoken),
    ["gather"],
    "解答前は黙り、採点確定後にだけ読み上げる（逆方向と同じ扱い）",
  );
});

test("採点後: 空所補充は promptMode='context-choice' のまま（向きの影響を受けない）", () => {
  const g = buildGradeQuizSandbox();
  const word = W("a1", "gather", "集める");
  g.setWords([word]);
  g.setSession({ allIds: ["a1"], queue: ["a1"], total: 1, label: "テスト", missedIds: [] });
  // 逆方向セッション由来で reverse が立っていても、例文は context-choice が優先される
  g.setCurrentQuiz(contextQuiz({ reverse: true }));

  g.gradeQuiz("a1");

  assert.deepEqual(Array.from(g.calls.applyLearning), ["context-choice"]);
  assert.deepEqual(Array.from(g.calls.reviewEvent), ["context-choice"]);
  assert.deepEqual(Array.from(g.calls.verifyConfidence), ["context-choice"]);
});

test("採点後: 通常出題の読み上げは従来どおり起きない（採点後に鳴るのは逆方向と例文だけ）", () => {
  const g = buildGradeQuizSandbox();
  const word = W("a1", "gather", "集める");
  g.setWords([word]);
  g.setSession({ allIds: ["a1"], queue: ["a1"], total: 1, label: "テスト", missedIds: [] });
  g.setCurrentQuiz({
    answer: { id: "a1", term: "gather", meaning: "集める" },
    choices: [
      { id: "a1", term: "gather", meaning: "集める" },
      { id: "p1", term: "wisdom", meaning: "知恵" },
    ],
    answered: false,
    shownAt: Date.now() - 500,
    context: null,
    srsDueAtStart: false,
  });

  g.gradeQuiz("a1");

  assert.deepEqual(
    Array.from(g.calls.spoken),
    [],
    "通常出題は出題時に読み上げ済みなので、採点後には鳴らさない",
  );
});

// ============================================================================
// 3. 生成完了コールバックの3条件（buildReviewQuiz の生成待ちパス）
// ============================================================================

// buildReviewQuiz の生成待ちパスを実コードのまま動かす。ensureContextItem を
// 手動で解決できる Promise に差し替え、解決後に currentQuiz が捨てられたかを観測する。
function buildPendingSandbox() {
  const pieces = [
    "let quizEmptyReason = '';",
    "let contextBasisFallbackNote = '';",
    "let reviewSession = null;",
    "let currentQuiz = null;",
    "const appState = { words: [] };",
    "const elements = { quizFeedback: { textContent: '' } };",
    "const calls = { renderQuiz: 0, ensure: [], prefetch: 0 };",
    // 例文はまだ無く、生成も未試行 → 生成待ちパスへ入る
    "let __items = {};",
    "let __attempted = {};",
    "function contextItemFor(word) { return __items[word.id] || null; }",
    "function contextAttempted(word) { return Boolean(__attempted[word.id]); }",
    "let __resolve = null;",
    "function ensureContextItem(word) {" +
      " calls.ensure.push(word.id);" +
      " return new Promise((res) => { __resolve = res; });" +
      " }",
    "function prefetchNextContextItem() { calls.prefetch += 1; }",
    "function renderQuiz() { calls.renderQuiz += 1; }",
    "function buildContextChoices() { return []; }",
    "function isContextDistractorSafe() { return true; }",
    "function quizSelectedDeckWords() { return appState.words; }",
    "function contextGenMode() { return 'off'; }",
    "function contextNetworkConsented() { return true; }",
    "function contextSourceLabel() { return ''; }",
    extractFunction("shuffle"),
    extractFunction("normalizeMeaning"),
    extractFunction("meaningsTooClose"),
    extractFunction("spellingDistance"),
    extractFunction("normalizeTerm"),
    extractFunction("choiceCountNote"),
    extractFunction("pickDistractors"),
    extractFunction("isMasteryVerificationDue"),
    extractFunction("mixedFormatUsesContext"),
    extractFunction("buildReviewQuiz"),
    "globalThis.__p = {" +
      " calls," +
      " setWords: (w) => { appState.words = w; }," +
      " setSession: (s) => { reviewSession = s; }," +
      " getSession: () => reviewSession," +
      " setCurrentQuiz: (q) => { currentQuiz = q; }," +
      " getCurrentQuiz: () => currentQuiz," +
      " setItem: (id, item) => { __items[id] = item; }," +
      " setAttempted: (id) => { __attempted[id] = true; }," +
      " resolveGeneration: () => { if (__resolve) __resolve(null); }," +
      " buildReviewQuiz };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "context-quiz-pending-check.js" }).runInNewContext(sandbox);
  return sandbox.__p;
}

function contextSession(ids, overrides = {}) {
  return {
    allIds: ids,
    queue: ids.slice(),
    total: ids.length,
    label: "テスト",
    context: true,
    contextAmount: "all",
    mixFormat: false,
    formatSeed: "seed1234",
    reverse: false,
    missedIds: [],
    ...overrides,
  };
}

// Promise の解決コールバックを流し切る
const flush = () => new Promise((r) => setImmediate(r));

test("生成待ち: 例文が未生成なら choices:[] のプレースホルダを返し、生成を1回だけ start する", () => {
  const p = buildPendingSandbox();
  const words = [W("a1", "gather", "集める"), W("p1", "wisdom", "知恵"), W("p2", "urban", "都会の"), W("p3", "fragile", "もろい")];
  p.setWords(words);
  p.setSession(contextSession(["a1"]));

  const quiz = p.buildReviewQuiz();

  assert.equal(quiz.contextPending, true);
  assert.deepEqual(Array.from(quiz.choices), [], "生成待ちは選択肢を持たない");
  assert.equal(quiz.shownAt, 0, "待ち時間を回答時間に含めない");
  assert.deepEqual(Array.from(p.calls.ensure), ["a1"]);
});

test("生成完了: 同じセッション・同じ語・生成待ちのままなら、問題を作り直す", async () => {
  const p = buildPendingSandbox();
  const words = [W("a1", "gather", "集める"), W("p1", "wisdom", "知恵"), W("p2", "urban", "都会の"), W("p3", "fragile", "もろい")];
  p.setWords(words);
  p.setSession(contextSession(["a1"]));
  const quiz = p.buildReviewQuiz();
  p.setCurrentQuiz(quiz);

  p.resolveGeneration();
  await flush();

  assert.equal(p.getCurrentQuiz(), null, "作り直すために currentQuiz を捨てる");
  assert.equal(p.calls.renderQuiz, 1, "作り直しの再描画は1回");
});

test("生成完了: 別セッションに切り替わっていたら、表示中の問題を壊さない", async () => {
  const p = buildPendingSandbox();
  const words = [W("a1", "gather", "集める"), W("p1", "wisdom", "知恵"), W("p2", "urban", "都会の"), W("p3", "fragile", "もろい")];
  p.setWords(words);
  p.setSession(contextSession(["a1"]));
  const quiz = p.buildReviewQuiz();
  p.setCurrentQuiz(quiz);

  // ユーザーが別の復習を始めた（reviewSession が別オブジェクトになる）
  p.setSession(contextSession(["a1"]));
  const otherQuiz = { answer: words[0], choices: [], answered: false, contextPending: true };
  p.setCurrentQuiz(otherQuiz);

  p.resolveGeneration();
  await flush();

  assert.equal(p.getCurrentQuiz(), otherQuiz, "前のセッションの生成完了で今の問題を消してはいけない");
  assert.equal(p.calls.renderQuiz, 0);
});

test("生成完了: 表示中の問題が別の語なら、壊さない", async () => {
  const p = buildPendingSandbox();
  const words = [W("a1", "gather", "集める"), W("b1", "vivid", "鮮やかな"), W("p1", "wisdom", "知恵"), W("p2", "urban", "都会の"), W("p3", "fragile", "もろい")];
  p.setWords(words);
  p.setSession(contextSession(["a1"]));
  const quiz = p.buildReviewQuiz();
  p.setCurrentQuiz(quiz);

  // 同じセッションのまま、別の語の生成待ちを表示している状態にする
  const otherQuiz = { answer: words[1], choices: [], answered: false, contextPending: true };
  p.setCurrentQuiz(otherQuiz);

  p.resolveGeneration();
  await flush();

  assert.equal(p.getCurrentQuiz(), otherQuiz, "別の語の生成完了で今の問題を消してはいけない");
  assert.equal(p.calls.renderQuiz, 0);
});

test("生成完了: 表示中の問題がもう生成待ちでないなら、壊さない（解答中の問題を消さない）", async () => {
  const p = buildPendingSandbox();
  const words = [W("a1", "gather", "集める"), W("p1", "wisdom", "知恵"), W("p2", "urban", "都会の"), W("p3", "fragile", "もろい")];
  p.setWords(words);
  p.setSession(contextSession(["a1"]));
  const quiz = p.buildReviewQuiz();
  p.setCurrentQuiz(quiz);

  // 生成待ちが解けて、すでに解答可能な問題が表示されている
  const answerable = {
    answer: words[0],
    choices: [{ id: "a1", label: "gather" }, { id: "p1", label: "wisdom" }],
    answered: false,
    contextPending: false,
  };
  p.setCurrentQuiz(answerable);

  p.resolveGeneration();
  await flush();

  assert.equal(p.getCurrentQuiz(), answerable, "解答中の問題を消してはいけない");
  assert.equal(p.calls.renderQuiz, 0);
});

test("生成完了: 復習をやめた後（reviewSession=null）でも壊れない", async () => {
  const p = buildPendingSandbox();
  const words = [W("a1", "gather", "集める"), W("p1", "wisdom", "知恵"), W("p2", "urban", "都会の"), W("p3", "fragile", "もろい")];
  p.setWords(words);
  p.setSession(contextSession(["a1"]));
  const quiz = p.buildReviewQuiz();
  p.setCurrentQuiz(quiz);

  p.setSession(null); // 「復習をやめる」
  p.resolveGeneration();
  await flush();

  assert.equal(p.calls.renderQuiz, 0, "終了済みセッションの生成完了で再描画してはいけない");
});

// ============================================================================
// 4. 例文を作れなかった語のフォールバック
// ============================================================================

test("フォールバック: 生成済みで例文が無い語は、通常の4択に落ちる（生成待ちに戻らない）", () => {
  const p = buildPendingSandbox();
  const words = [W("a1", "gather", "集める"), W("p1", "wisdom", "知恵"), W("p2", "urban", "都会の"), W("p3", "fragile", "もろい")];
  p.setWords(words);
  p.setAttempted("a1"); // 生成は試したが例文を作れなかった
  p.setSession(contextSession(["a1"]));

  const quiz = p.buildReviewQuiz();

  assert.ok(quiz, "問題は作られる");
  assert.notEqual(quiz.contextPending, true, "試行済みなら生成待ちに戻さない");
  assert.equal(quiz.context, null, "空所補充にはならない");
  assert.ok(quiz.choices.length >= 2, "通常の4択として成立する");
  assert.deepEqual(Array.from(p.calls.ensure), [], "再生成を仕掛けない");
});

test("フォールバック: 逆方向セッションでは、落ちた先の通常出題も日→英になる（1.0.81）", () => {
  const p = buildPendingSandbox();
  const words = [W("a1", "gather", "集める"), W("p1", "wisdom", "知恵"), W("p2", "urban", "都会の"), W("p3", "fragile", "もろい")];
  p.setWords(words);
  p.setAttempted("a1");
  p.setSession(contextSession(["a1"], { reverse: true }));

  const quiz = p.buildReviewQuiz();

  assert.equal(quiz.reverse, true, "セッションの向きはフォールバック先にも効く");
  for (const choice of quiz.choices) {
    assert.equal(typeof choice.label, "string", "日→英の選択肢は英単語のラベルを持つ");
  }
});

test("フォールバック: 仮習得の検証待ちは、逆方向セッションでも英→日に戻す（1.0.81のガード）", () => {
  const p = buildPendingSandbox();
  const answer = W("a1", "gather", "集める");
  // フラッシュカード由来の仮習得 + 期限到来
  answer.learning.status = "mastered";
  answer.learning.masteryVerify = "flashcard";
  answer.learning.nextReviewAt = Date.now() - 1000;
  const words = [answer, W("p1", "wisdom", "知恵"), W("p2", "urban", "都会の"), W("p3", "fragile", "もろい")];
  p.setWords(words);
  p.setSession(contextSession(["a1"], { reverse: true }));

  const quiz = p.buildReviewQuiz();

  assert.equal(quiz.reverse, false, "検証待ちは意味4択でしか確定できないため英→日に戻す");
  assert.equal(quiz.context, null, "同じ理由で空所補充にもしない");
  assert.notEqual(quiz.contextPending, true, "生成待ちにも入らない");
  assert.deepEqual(Array.from(p.calls.ensure), [], "検証待ちの語で例文生成を始めない");
});

test("形式の割り当ては決定的：同じ種と語IDなら何度呼んでも同じ結果", () => {
  const pieces = [
    "function contextGenMode() { return 'off'; }",
    "function contextNetworkConsented() { return true; }",
    extractFunction("mixedFormatUsesContext"),
    "globalThis.__m = { mixedFormatUsesContext };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "context-quiz-mixformat-check.js" }).runInNewContext(sandbox);
  const { mixedFormatUsesContext } = sandbox.__m;

  const session = { mixFormat: true, formatSeed: "seed1234" };
  const ids = ["a1", "b2", "c3", "d4", "e5", "f6", "g7", "h8"];
  const first = ids.map((id) => mixedFormatUsesContext(session, id));
  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual(ids.map((id) => mixedFormatUsesContext(session, id)), first, "再描画で形式が入れ替わってはいけない");
  }
  // 種が変われば割り当ても変わる（種が効いていないと固定値になってしまう）
  const other = ids.map((id) => mixedFormatUsesContext({ mixFormat: true, formatSeed: "seed9999" }, id));
  assert.notDeepEqual(other, first, "種を変えたら割り当ても変わるべき");
  // mixFormat が立っていなければ常に false
  assert.equal(mixedFormatUsesContext({ mixFormat: false, formatSeed: "seed1234" }, "a1"), false);
});
