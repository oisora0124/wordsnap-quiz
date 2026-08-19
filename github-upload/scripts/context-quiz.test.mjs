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
    "let contextFallbackNote = '';",
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
    // 空所補充の選択肢作りは差し替え可能にする。実物は「言い切れる誤答が作れない」ときだけ
    // 自分で contextFallbackNote を立てて [] を返すので、その挙動も再現できるようにする。
    "let __contextChoices = () => [];",
    "function buildContextChoices(answer, item) { return __contextChoices(answer, item); }",
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
      " setContextChoices: (fn) => { __contextChoices = fn; }," +
      " setFallbackNote: (t) => { contextFallbackNote = t; }," +
      " getFeedback: () => elements.quizFeedback.textContent," +
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

// ============================================================================
// 5. フォールバックの理由表示（1.0.83）
//    黙って形式が変わると「例文モードのはずなのになぜ単語が出るのか」が分からない。
//    通常出題へ落ちる3経路すべてで理由を出す。
// ============================================================================

const FALLBACK_WORDS = () => [
  W("a1", "gather", "集める"),
  W("p1", "wisdom", "知恵"),
  W("p2", "urban", "都会の"),
  W("p3", "fragile", "もろい"),
];

test("フォールバック理由: 例文を用意できなかった語は、その理由を表示する", () => {
  const p = buildPendingSandbox();
  p.setWords(FALLBACK_WORDS());
  p.setAttempted("a1"); // 生成を試したが例文なし
  p.setSession(contextSession(["a1"]));

  const quiz = p.buildReviewQuiz();

  assert.equal(quiz.context, null, "通常出題へ落ちる");
  assert.match(
    p.getFeedback(),
    /例文を用意できなかった/,
    "無言で形式を変えず、理由を伝える",
  );
});

test("フォールバック理由: 誤答候補が足りなかった語は、そう伝える", () => {
  const p = buildPendingSandbox();
  p.setWords(FALLBACK_WORDS());
  p.setItem("a1", { en: "They ___ data.", ja: null, src: "ai" });
  // 正解1つしか作れなかった（2未満なので空所補充にできない）
  p.setContextChoices(() => [{ id: "a1", label: "gather" }]);
  p.setSession(contextSession(["a1"]));

  const quiz = p.buildReviewQuiz();

  assert.equal(quiz.context, null, "通常出題へ落ちる");
  assert.match(p.getFeedback(), /誤答を十分に用意できなかった/);
});

test("フォールバック理由: 「言い切れる誤答が作れない」理由は上書きしない（既存の説明を残す）", () => {
  const p = buildPendingSandbox();
  p.setWords(FALLBACK_WORDS());
  p.setItem("a1", { en: "They ___ data.", ja: null, src: "ai" });
  // 実物の buildContextChoices と同じく、自分で理由を立てて [] を返す
  p.setContextChoices(() => {
    p.setFallbackNote("この単語は「空所に入らない」と言い切れる誤答を用意できなかったため、根拠のない出題を避けて通常の単語出題にしました。");
    return [];
  });
  p.setSession(contextSession(["a1"]));

  p.buildReviewQuiz();

  assert.match(p.getFeedback(), /言い切れる誤答を用意できなかった/, "より具体的な理由が残る");
  assert.doesNotMatch(p.getFeedback(), /十分に用意できなかった/, "後から一般的な文言で上書きしない");
});

test("フォールバック理由: 理由は次の問題へ持ち越さない", () => {
  const p = buildPendingSandbox();
  p.setWords(FALLBACK_WORDS());
  p.setAttempted("a1");
  p.setSession(contextSession(["a1"]));
  p.buildReviewQuiz();
  assert.match(p.getFeedback(), /例文を用意できなかった/);

  // 通常出題を明示選択した回では、表示後に理由が消えていて再表示されない
  p.setSession(contextSession(["a1"], { context: false, contextAmount: "none" }));
  p.buildReviewQuiz();
  assert.doesNotMatch(
    p.getFeedback(),
    /例文を用意できなかった/,
    "前の語の切り替え理由が次の問題に残ってはいけない",
  );
});

test("フォールバック理由: 通常出題を明示選択した回は、残っている理由を持ち込まない", () => {
  // 例文の成功パスや生成待ちパスは理由を消さずに return するため、直前の理由が
  // 残ったまま通常出題の回に入ることがありうる。その持ち越しを断つガードを固定する。
  const p = buildPendingSandbox();
  p.setWords(FALLBACK_WORDS());
  p.setFallbackNote("この単語は例文を用意できなかったため、通常の単語出題にしました。");
  // 例文を使わない回（mixFormat で通常出題に割り当てられた語と同じ状態）
  p.setSession(contextSession(["a1"], { context: false, contextAmount: "none" }));

  p.buildReviewQuiz();

  assert.doesNotMatch(
    p.getFeedback(),
    /例文を用意できなかった/,
    "例文を出そうとしていない回に、無関係な切り替え理由を出してはいけない",
  );
});

test("フォールバック理由: 仮習得の検証待ちでは理由を出さない（失敗ではないため）", () => {
  const p = buildPendingSandbox();
  const answer = W("a1", "gather", "集める");
  answer.learning.status = "mastered";
  answer.learning.masteryVerify = "flashcard";
  answer.learning.nextReviewAt = Date.now() - 1000;
  p.setWords([answer, W("p1", "wisdom", "知恵"), W("p2", "urban", "都会の"), W("p3", "fragile", "もろい")]);
  p.setSession(contextSession(["a1"]));

  p.buildReviewQuiz();

  assert.doesNotMatch(p.getFeedback(), /例文を用意できなかった|誤答を十分に/);
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

// ============================================================================
// 6. 誤答の選び方（1.0.85）
//    以前は「誤答を選んでから4択全体を every で検査」していた。1つでも根拠を欠くと
//    問題が丸ごと破棄されるため、実測で TOEIC 2.3% / 中学 0.3% しか空所補充が
//    出題されず、「例文で解く」を選んでもほぼ通常出題になっていた。
//    根拠のある候補だけを選ぶように変え、判定基準そのものは変えていない。
// ============================================================================

// buildContextChoices は依存が多い。定数はHTML内の出現順に並べないと
// 「初期化前アクセス」で落ちるため、位置でソートしてから連結する。
function buildContextChoicesSandbox() {
  const consts = [
    "IRREGULAR_INFLECTION_GROUPS", "AMBIGUOUS_DERIVATIONAL_SUFFIXES", "DERIVATIONAL_SUFFIXES",
    "IRREGULAR_COMPARISON_GROUPS", "BUILTIN_POS_GROUPS", "BUILTIN_POS_MULTI_GROUPS",
    "BUILTIN_POS_MULTI", "BUILTIN_POS", "BUILTIN_POS_NOUN_AND_VERB",
  ].sort((a, b) => html.indexOf(`const ${a} `) - html.indexOf(`const ${b} `));
  const fns = [
    "normalizeTerm", "normalizeMeaning", "meaningsTooClose", "spellingDistance", "shuffle",
    "pickDistractors", "termWordRegex", "sentenceContainsTerm", "derivationStem",
    "hasDerivationalSuffix", "wordsShareGroup", "regularInflectionForms", "isInflectionOf",
    "regularComparativeDegree", "comparativeFormDegree", "isUnsafeComparativeDistractor",
    "isAmbiguousDerivationPair", "builtinPosTags", "posTagsFor",
    "isContextDistractorSafe", "contextDistractorHasBasis", "aiSelfCheckedTerms",
    "contextDistractorAdmissible", "contextChoicesHaveBasis", "buildContextChoices",
  ];
  const pieces = [
    ...consts.map((n) => extractConst(n)),
    "let contextFallbackNote = '';",
    "const appState = { words: [] };",
    "function quizSelectedDeckWords() { return appState.words; }",
    ...fns.map((n) => extractFunction(n)),
    "globalThis.__b = {" +
      " setWords: (w) => { appState.words = w; }," +
      " getNote: () => contextFallbackNote," +
      " contextDistractorAdmissible," +
      " buildContextChoices };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "context-quiz-choices-check.js" }).runInNewContext(sandbox);
  return sandbox.__b;
}

// `const NAME = ...;` を対応する括弧の末尾まで切り出す（reverse-quiz.test.mjs と同じ実装）
function extractConst(name) {
  const start = html.indexOf(`const ${name} `);
  if (start < 0) throw new Error(`const ${name} not found`);
  let depth = 0;
  let seen = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      seen = true;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
    } else if (ch === ";" && depth === 0 && seen) {
      return html.slice(start, i + 1);
    } else if (ch === "\n" && depth === 0 && seen) {
      return html.slice(start, i);
    }
  }
  throw new Error(`could not terminate const ${name}`);
}

// 実在の英単語で語彙を作る（品詞判定は組み込み表を引くため、造語では検証にならない）
const REAL_VOCAB = [
  ["abolition", "廃止"], ["celebrate", "祝う"], ["purchase", "購入する"], ["outcome", "結果"],
  ["immediate", "即座の"], ["innovation", "革新"], ["luggage", "荷物"], ["criterion", "基準"],
  ["series", "連続"], ["demonstration", "実演"], ["innovative", "革新的な"], ["obtain", "得る"],
].map(([term, meaning], i) => ({
  id: "v" + i, term, meaning, pos: null,
  stats: { correct: 0, wrong: 0 }, history: [],
  learning: { status: "review", srsStage: 1, nextReviewAt: 0, blockedUntil: 0, correctStreak: 0 },
}));

const ANSWER = {
  id: "A", term: "abolish", meaning: "廃止する", pos: { tag: "v" },
  stats: { correct: 0, wrong: 0 }, history: [],
  learning: { status: "review", srsStage: 1, nextReviewAt: 0, blockedUntil: 0, correctStreak: 0 },
};
const EN = "The government decided to abolish the outdated rule last year.";

test("誤答の選び方: 誤答の供給が無くても、登録語彙から空所補充を組める", () => {
  const b = buildContextChoicesSandbox();
  b.setWords([ANSWER, ...REAL_VOCAB]);
  const choices = b.buildContextChoices(ANSWER, { en: EN, distractors: [], src: "dict" });
  assert.ok(choices.length >= 2, "以前はここが空になり、ほぼ全問が通常出題へ落ちていた");
  assert.ok(choices.some((c) => c.id === ANSWER.id), "正解が入っている");
});

test("誤答の選び方: 供給が1つだけでも、補充した誤答が根拠を持つので破棄されない", () => {
  const b = buildContextChoicesSandbox();
  b.setWords([ANSWER, ...REAL_VOCAB]);
  const choices = b.buildContextChoices(ANSWER, { en: EN, distractors: ["abolition"], src: "dict" });
  assert.ok(choices.length >= 2);
  assert.ok(
    choices.some((c) => c.label.toLowerCase() === "abolition"),
    "供給された派生形はそのまま使う",
  );
});

test("誤答の選び方: 供給の一部が根拠を欠いても、その語だけ落として出題を続ける", () => {
  const b = buildContextChoicesSandbox();
  b.setWords([ANSWER, ...REAL_VOCAB]);
  // abolitionist は組み込み表に品詞が無く根拠なし。以前はこの1語で4択全体が消えていた。
  const choices = b.buildContextChoices(ANSWER, {
    en: EN, distractors: ["abolition", "abolitionist", "abolishment"], src: "dict",
  });
  assert.ok(choices.length >= 2, "1語の巻き添えで問題ごと捨てない");
  assert.ok(
    !choices.some((c) => c.label.toLowerCase() === "abolitionist"),
    "根拠を欠く語は誤答に採用しない（基準は緩めていない）",
  );
});

test("誤答の選び方: 採用された誤答は全て根拠を持つ", () => {
  const b = buildContextChoicesSandbox();
  b.setWords([ANSWER, ...REAL_VOCAB]);
  const item = { en: EN, distractors: [], src: "dict" };
  const choices = b.buildContextChoices(ANSWER, item);
  for (const choice of choices) {
    if (choice.id === ANSWER.id) continue;
    assert.equal(
      b.contextDistractorAdmissible(ANSWER, item, choice.label),
      true,
      `根拠のない誤答が混ざっている: ${choice.label}`,
    );
  }
});

test("誤答の選び方: AIが自己検証した同品詞の誤答は採用する", () => {
  const b = buildContextChoicesSandbox();
  b.setWords([ANSWER, ...REAL_VOCAB]);
  // プロンプトは (b)(c) で「出題語と同じ品詞」の誤答を明示的に要求している。
  // AIが4語すべてを fit で自己検証していれば、それが根拠になる。
  const choices = b.buildContextChoices(ANSWER, {
    en: EN,
    distractors: ["abolition", "celebrate", "purchase"],
    fit: ["abolish"],
    integratedChoices: ["abolish", "abolition", "celebrate", "purchase"],
    src: "ai",
  });
  const labels = choices.map((c) => c.label.toLowerCase());
  assert.ok(labels.includes("celebrate") && labels.includes("purchase"),
    "AI検証済みの同品詞誤答が捨てられている（AI経路が機能しない）");
});

test("誤答の選び方: 自己検証が無ければ同品詞の誤答は採用しない（基準を緩めていない）", () => {
  const b = buildContextChoicesSandbox();
  b.setWords([ANSWER, ...REAL_VOCAB]);
  const choices = b.buildContextChoices(ANSWER, {
    en: EN, distractors: ["celebrate", "purchase"], src: "dict", // fit も integratedChoices も無い
  });
  const labels = choices.map((c) => c.label.toLowerCase());
  assert.ok(!labels.includes("celebrate"), "検証の裏付けなく同品詞を誤答にしてはいけない");
  assert.ok(!labels.includes("purchase"));
});

test("誤答の選び方: 根拠のある誤答が1つも作れなければ空所補充にしない", () => {
  const b = buildContextChoicesSandbox();
  // 同じ品詞(v)の語しか無い語彙にする＝根拠のある誤答が存在しない
  const verbsOnly = [["celebrate", "祝う"], ["obtain", "得る"], ["decide", "決める"]]
    .map(([term, meaning], i) => ({ id: "x" + i, term, meaning, pos: null,
      stats: { correct: 0, wrong: 0 }, history: [],
      learning: { status: "review", srsStage: 1, nextReviewAt: 0, blockedUntil: 0, correctStreak: 0 } }));
  b.setWords([ANSWER, ...verbsOnly]);
  const choices = b.buildContextChoices(ANSWER, { en: EN, distractors: [], src: "dict" });
  assert.ok(choices.length < 2, "根拠が無いなら従来どおり通常出題へ落とす");
});

test("誤答の選び方: 根拠のある語が十分あれば、毎回4択が埋まる（50回引いても）", () => {
  const b = buildContextChoicesSandbox();
  b.setWords([ANSWER, ...REAL_VOCAB]);
  // 補充元を絞らずに pickDistractors へ渡すと、選ばれた語をこの後のループで
  // 落とすことになり、選択肢が減る。pickDistractors の preferDifferentPos は
  // 保存済みの品詞タグを見るため、タグの無い語（大多数）では効かない。
  for (let i = 0; i < 50; i += 1) {
    const choices = b.buildContextChoices(ANSWER, { en: EN, distractors: [], src: "dict" });
    assert.equal(choices.length, 4, `${i}回目で4択が埋まらなかった（選択肢数が引くたびに変わる）`);
  }
});

test("誤答の選び方: fit の無いAI応答は自己検証済みとみなさない", () => {
  const b = buildContextChoicesSandbox();
  b.setWords([ANSWER, ...REAL_VOCAB]);
  const choices = b.buildContextChoices(ANSWER, {
    en: EN,
    distractors: ["celebrate", "purchase"],
    // integratedChoices はあるが fit が無い＝AIが自己検証を返せなかった応答
    integratedChoices: ["abolish", "celebrate", "purchase"],
    src: "ai",
  });
  const labels = choices.map((c) => c.label.toLowerCase());
  assert.ok(!labels.includes("celebrate"), "検証結果が無いのに検証済み扱いしてはいけない");
  assert.ok(!labels.includes("purchase"));
});

test("誤答の選び方: 1.0.84以前に焼き付いた記録（誤答0件・choicesFinal）を救済する", () => {
  const b = buildContextChoicesSandbox();
  b.setWords([ANSWER, ...REAL_VOCAB]);
  // 旧コードは「誤答を選んでから4択全体を検査」したため、候補が空のまま
  // choicesFinal:true で保存された。例文そのものは無事なので、作り直さずに使う。
  const choices = b.buildContextChoices(ANSWER, {
    en: EN, distractors: [], choicesFinal: true, choiceValidation: "ai", src: "ai",
  });
  assert.ok(choices.length >= 2, "例文があるのに出題できない状態が残ってはいけない");
});

test("誤答の選び方: 誤答が残っていれば choicesFinal は従来どおり補充を止める", () => {
  const b = buildContextChoicesSandbox();
  b.setWords([ANSWER, ...REAL_VOCAB]);
  const choices = b.buildContextChoices(ANSWER, {
    en: EN, distractors: ["abolition"], choicesFinal: true, src: "ai",
  });
  assert.equal(choices.length, 2, "AIが用意した誤答があるなら登録語で水増ししない");
  assert.ok(choices.some((c) => c.label.toLowerCase() === "abolition"));
});

// ============================================================================
// 7. 辞書の失敗の分類（1.0.86）
//    429・5xx・通信断・タイムアウトを「例文なし」と同じ扱いにすると、その語は
//    次に作り直されるまで（最大6時間）例文モードから外れる。時間をおけば直る失敗は
//    15分で取り直せるように区別する。
// ============================================================================

function buildDictionarySandbox({ status = 200, body = [], throwKind = null } = {}) {
  const pieces = [
    `const CONTEXT_GEN_TIMEOUT_MS = ${html.match(/const CONTEXT_GEN_TIMEOUT_MS = (\d+);/)[1]};`,
    "const appState = { words: [] };",
    "function setTimeout(fn, ms) { return 0; }",
    "function clearTimeout() {}",
    "function AbortController() { this.signal = {}; this.abort = () => {}; }",
    throwKind === "abort"
      ? "function fetch() { const e = new Error('aborted'); e.name = 'AbortError'; return Promise.reject(e); }"
      : throwKind === "network"
        ? "function fetch() { return Promise.reject(new TypeError('Failed to fetch')); }"
        : `function fetch() { return Promise.resolve({ ok: ${status === 200}, status: ${status},` +
          ` json: () => Promise.resolve(${JSON.stringify(body)}) }); }`,
    extractFunction("termWordRegex"),
    extractFunction("sentenceLikeExamples"),
    extractFunction("pickExample"),
    // extractFunction は "function 名(" から切り出すため async が落ちる。付け直す。
    "async " + extractFunction("fetchContextFromDictionary"),
    "globalThis.__d = { fetchContextFromDictionary };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "context-quiz-dictionary-check.js" }).runInNewContext(sandbox);
  return sandbox.__d;
}

const WORD = { id: "w1", term: "abolish", meaning: "廃止する", pos: null };

test("辞書の失敗: 404（項目が無い）は作り直しても変わらないので、そのまま諦める", async () => {
  const d = buildDictionarySandbox({ status: 404 });
  const item = await d.fetchContextFromDictionary(WORD);
  assert.equal(item, null, "例外にせず null を返す（＝恒久的に例文なし）");
});

test("辞書の失敗: 429（レート制限）は一時的な失敗として投げる", async () => {
  const d = buildDictionarySandbox({ status: 429 });
  await assert.rejects(
    () => d.fetchContextFromDictionary(WORD),
    (error) => error?.transient === true,
    "混んでいるだけの語を「例文なし」として扱ってはいけない",
  );
});

test("辞書の失敗: 5xx も一時的な失敗として投げる", async () => {
  for (const status of [500, 502, 503]) {
    const d = buildDictionarySandbox({ status });
    await assert.rejects(
      () => d.fetchContextFromDictionary(WORD),
      (error) => error?.transient === true,
      `HTTP ${status}`,
    );
  }
});

test("辞書の失敗: 通信断・タイムアウトはそのまま例外として伝わる（呼び出し側が一時失敗と判定する）", async () => {
  const offline = buildDictionarySandbox({ throwKind: "network" });
  await assert.rejects(
    () => offline.fetchContextFromDictionary(WORD),
    // vm内で作られた TypeError は別realmなので instanceof では比較できない
    (error) => error?.name === "TypeError",
  );

  const timeout = buildDictionarySandbox({ throwKind: "abort" });
  await assert.rejects(
    () => timeout.fetchContextFromDictionary(WORD),
    (error) => error?.name === "AbortError",
  );
});

test("辞書の成功: 例文にその語がそのままの形で出てくるものだけ使う", async () => {
  const d = buildDictionarySandbox({
    status: 200,
    body: [{ meanings: [{ partOfSpeech: "verb", definitions: [
      { example: "Slavery was abolished in the nineteenth century." }, // 活用形なので不採用
      { example: "They want to abolish the rule." },                   // これを使う
    ] }] }],
  });
  const item = await d.fetchContextFromDictionary(WORD);
  assert.ok(item, "例文が取れている");
  assert.match(item.en, /\babolish\b/, "空所化できる形（そのままの形）でなければ答えが露出する");
});

test("辞書の失敗: 一時失敗を retryAt へつなぐ配線が ensureContextItem に残っている", () => {
  // ensureContextItem は依存が非常に多く、丸ごと動かすと配線以外の理由で壊れやすい。
  // reverse-quiz.test.mjs の「gradeQuiz本体を正しく切り出せている」と同じ流儀で、
  // 3か所の配線が揃っていることを本体の字面で固定する（どれか1つ消えると効果が出ない）。
  const body = extractFunction("ensureContextItem");

  assert.match(
    body,
    /error\?\.transient \|\| error\?\.name === "AbortError" \|\| error instanceof TypeError/,
    "辞書側の一時失敗（429・5xx／タイムアウト／通信断）を拾う判定が消えている",
  );
  assert.match(
    body,
    /dictTransientFailure = true/,
    "拾った一時失敗を記録していない",
  );
  assert.match(
    body,
    /aiTransientFailure \|\| \(!item && dictTransientFailure\)/,
    "一時失敗を retryAt につないでいない／例文が取れた回にも印を付けている",
  );
  // 辞書呼び出しは2か所（先読みと本呼び出し）あり、両方が同じ経路を通る必要がある
  assert.equal(
    (body.match(/runDictionary\(\)/g) || []).length,
    2,
    "辞書呼び出しの一部が一時失敗を拾わない経路のまま残っている",
  );
});

// ============================================================================
// 7. AIの自己検証で「空所に入る」とされた語を誤答にしない（1.0.93）
//    fit は「空所に入れて自然な文になる語」。誤答にすると正解が2つある問題になる。
//    後段の applyContextValidation も fit を除外するが、そちらは fit が候補全体を
//    覆えた回にしか走らない。覆えなかった回にここを素通りさせると、空所に入る語が
//    誤答として焼き付く。
// ============================================================================

test("AI検証: fit に挙がった語は誤答に採用しない（正解が2つある問題を作らない）", () => {
  const b = buildContextChoicesSandbox();
  b.setWords([ANSWER, ...REAL_VOCAB]);
  const item = {
    en: EN,
    // AIが「celebrate も空所に入る」と自己申告した応答
    distractors: ["abolition", "celebrate", "purchase"],
    fit: ["abolish", "celebrate"],
    integratedChoices: ["abolish", "abolition", "celebrate", "purchase"],
    src: "ai",
  };
  assert.equal(
    b.contextDistractorAdmissible(ANSWER, item, "celebrate"),
    false,
    "空所に入ると申告された語を誤答にしてはいけない",
  );
  const labels = b.buildContextChoices(ANSWER, item).map((c) => c.label.toLowerCase());
  assert.ok(!labels.includes("celebrate"), "選択肢にも入ってはいけない");
});

test("AI検証: fit に入っていない語は、これまでどおり採用する", () => {
  const b = buildContextChoicesSandbox();
  b.setWords([ANSWER, ...REAL_VOCAB]);
  const item = {
    en: EN,
    distractors: ["abolition", "celebrate", "purchase"],
    fit: ["abolish"], // 正解だけが入る＝通常の応答
    integratedChoices: ["abolish", "abolition", "celebrate", "purchase"],
    src: "ai",
  };
  const labels = b.buildContextChoices(ANSWER, item).map((c) => c.label.toLowerCase());
  assert.ok(labels.includes("celebrate") && labels.includes("purchase"), "AI経路が機能しなくなる");
});

test("AI検証: fit が候補を覆えなかった回でも、空所に入る語は弾く", () => {
  const b = buildContextChoicesSandbox();
  b.setWords([ANSWER, ...REAL_VOCAB]);
  // integratedChoices が候補を覆っていない＝choiceValidation は "local-only" になる回。
  // この経路では後段の fit 除外が走らないので、ここで弾けないと焼き付く。
  const item = {
    en: EN,
    distractors: ["celebrate"],
    fit: ["abolish", "celebrate"],
    integratedChoices: ["abolish", "celebrate"],
    src: "ai",
  };
  assert.equal(b.contextDistractorAdmissible(ANSWER, item, "celebrate"), false);
});
