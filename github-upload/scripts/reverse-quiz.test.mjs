// 逆方向出題（日本語→英語）の純粋関数を、公開HTML内の実コードから抽出して固定入力で検査する。
// 流儀は scripts/quiz-quality.test.mjs と同じ：node:vm でサンドボックス実行し、実関数を
// アプリHTMLから一切書き換えずに検証する。名前なしのイベントハンドラは
// scripts/bulk-move-deck.test.mjs / scripts/a11y-dialog.test.mjs と同じく、目印の文字列から
// 波括弧の対応を数えて本体を切り出す方式にする。
//
// 固定する不変条件（タスク仕様より）:
//   1. 逆方向の選択肢に「意味が近すぎる単語」が混ざらない（50回引いても）
//   2. 逆方向の選択肢に同じtermが2つ並ばない
//   3. 逆方向の解答は promptMode: "term-choice" として扱われ、masteryVerify を解除しない。
//      これを gradeQuiz() 本体を実際に動かして、確信度検証・学習結果適用・ログ記録の
//      3経路すべてで検証する（currentQuizPromptMode/applyLearningResultの個別呼び出しだけでは
//      gradeQuiz内の配線が壊れても検出できないため）
//   4. 既定値は英→日で、設定を触らない限り現行と同一の問題が出る（後方互換）。
//      choices の並び・answer・Math.random() の消費回数まで完全一致することを固定する
//   5. 設定の保存と復元（localStorageが壊れていても例外を漏らさない）
//   6. 設定selectのchangeハンドラが、選んだ値を実際にlocalStorageへ保存する
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Script } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

// 波括弧の対応をとって関数本体を丸ごと切り出す（quiz-quality.test.mjsと同じ実装）。
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

// `const NAME = ...;`（配列/Setを含む）を対応する括弧の末尾＋セミコロンまで切り出す。
function extractConst(name) {
  const start = html.indexOf(`const ${name} `);
  if (start < 0) throw new Error(`const ${name} not found`);
  let depth = 0;
  let seen = false;
  for (let i = start; i < html.length; i += 1) {
    const c = html[i];
    if (c === "(" || c === "[" || c === "{") {
      depth += 1;
      seen = true;
    } else if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
    } else if (c === ";" && depth === 0 && seen) {
      return html.slice(start, i + 1);
    } else if (c === "\n" && depth === 0 && seen) {
      return html.slice(start, i);
    }
  }
  throw new Error(`could not terminate const ${name}`);
}

// 名前付き関数を持たない `elements.X?.addEventListener("change", () => { ... });` の
// アロー本体（ブロック）だけを、目印の文字列から括弧の対応を数えて切り出す
// （手本: scripts/bulk-move-deck.test.mjs の extractMoveHandlerBody）。
function extractArrowHandlerBody(anchor) {
  const start = html.indexOf(anchor);
  if (start < 0) throw new Error(`handler anchor not found: ${anchor}`);
  const bodyBrace = start + anchor.length - 1; // アロー本体の開き "{"
  let depth = 0;
  for (let i = bodyBrace; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(bodyBrace, i + 1);
    }
  }
  throw new Error(`handler body braces are unbalanced for anchor: ${anchor}`);
}

// QUIZ_DIRECTION_KEYはプレーンな文字列定数で括弧を含まずextractConstが使えないため、
// 正規表現でHTMLから値を取り出して同じ値を注入する（乖離したらここで気づける）。
const QUIZ_DIRECTION_KEY_LITERAL = html.match(/const QUIZ_DIRECTION_KEY = "([^"]+)";/)?.[1];

// ---------- サンドボックス1: buildQuiz / pickDistractors / 出題の向き設定 ----------
// availableQuizWords/quizSelectedDeckWordsは本来SRS期日等に依存する重い候補選定だが、
// このテストの対象（向き設定・重複排除・後方互換）には無関係なので、appState.wordsを
// そのまま返す単純な実装に差し替える（buildQuiz自体・pickDistractors自体は実コードのまま）。
function buildQuizSandbox() {
  if (!QUIZ_DIRECTION_KEY_LITERAL) throw new Error("QUIZ_DIRECTION_KEY not found");
  const pieces = [
    "let __store = {};",
    "let __storageThrows = false;",
    "const localStorage = {" +
      " getItem: (k) => { if (__storageThrows) throw new Error('blocked'); return Object.hasOwn(__store, k) ? __store[k] : null; }," +
      " setItem: (k, v) => { if (__storageThrows) throw new Error('blocked'); __store[k] = String(v); }," +
      " removeItem: (k) => { delete __store[k]; } };",
    "let __randCalls = 0;",
    "let __randValue = 0.5;",
    "Math.random = () => { __randCalls += 1; return __randValue; };",
    "let quizEmptyReason = '';",
    "let normalQuizQuestionNumber = 0;",
    "let currentQuiz = null;",
    "const elements = { quizFeedback: { textContent: '' } };",
    "const appState = { words: [] };",
    "const quizSelectedDeckWords = () => appState.words;",
    "const availableQuizWords = () => appState.words;",
    extractFunction("chooseNextWord"),
    // 仮習得の検証待ち判定。逆方向を強制的に英→日へ戻すガードが使う
    // （本習得への確定は意味4択の正解が条件なので、日→英では永久に確定しない）。
    extractFunction("isMasteryVerificationDue"),
    extractFunction("shuffle"),
    extractFunction("normalizeMeaning"),
    extractFunction("meaningsTooClose"),
    extractFunction("spellingDistance"),
    extractFunction("normalizeTerm"),
    extractFunction("choiceCountNote"),
    `const QUIZ_DIRECTION_KEY = ${JSON.stringify(QUIZ_DIRECTION_KEY_LITERAL)};`,
    extractConst("QUIZ_DIRECTION_CHOICES"),
    extractFunction("normalizeQuizDirection"),
    extractFunction("quizDirectionSetting"),
    extractFunction("resolveQuizReverse"),
    extractFunction("pickDistractors"),
    extractFunction("buildQuiz"),
    "globalThis.__b = {" +
      " setWords: (w) => { appState.words = w; currentQuiz = null; }," +
      " setDirection: (v) => { __store[QUIZ_DIRECTION_KEY] = v; }," +
      " setStorageThrows: (v) => { __storageThrows = v; }," +
      " setRandom: (v) => { __randValue = v; }," +
      " randomCalls: () => __randCalls," +
      " resetRandomCalls: () => { __randCalls = 0; }," +
      " buildQuiz, pickDistractors, normalizeTerm, spellingDistance, normalizeMeaning, meaningsTooClose," +
      " quizDirectionSetting, resolveQuizReverse, normalizeQuizDirection," +
      " getFeedback: () => elements.quizFeedback.textContent," +
      " getCurrentQuiz: () => currentQuiz," +
      " setCurrentQuiz: (q) => { currentQuiz = q; } };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "reverse-quiz-buildquiz-check.js" }).runInNewContext(sandbox);
  return sandbox.__b;
}

const W = (id, term, meaning, tag) => ({
  id,
  term,
  meaning,
  pos: { tag },
  learning: { status: "new", nextReviewAt: 0 },
  addedAt: "2026-01-01T00:00:00.000Z",
});

// ---------- 1. 逆方向の選択肢に「意味が近すぎる単語」が混ざらない ----------
test("reverse: pickDistractors(dedupeBy=term) never includes a meaning-too-close word (50 draws)", () => {
  const b = buildQuizSandbox();
  const answer = W("a1", "alter", "変える", "v");
  const pool = [
    W("p1", "modify", "部分的に変える", "v"), // 意味が「変える」を包含 → 除外されるべき
    W("p2", "gather", "集める", "v"),
    W("p3", "wisdom", "知恵", "n"),
    W("p4", "urban", "都会の", "adj"),
    W("p5", "settle", "解決する", "v"),
  ];
  for (let i = 0; i < 50; i += 1) {
    const picked = b.pickDistractors(pool, answer, 3, [], { dedupeBy: "term" });
    assert.ok(
      !picked.some((w) => w.id === "p1"),
      `meaning-too-close distractor leaked through on draw ${i}`,
    );
  }
});

// ---------- 2. 逆方向の選択肢に同じtermが2つ並ばない ----------
test("reverse: pickDistractors(dedupeBy=term) never repeats the same displayed term (50 draws)", () => {
  const b = buildQuizSandbox();
  const answer = W("a1", "large", "大きい", "adj");
  const pool = [
    W("p1", "Big", "大きめの", "adj"), // termが"big"と大文字違いで衝突する
    W("p2", "big", "巨大な", "adj"),
    W("p3", "small", "小さい", "adj"),
    W("p4", "fast", "速い", "adj"),
    W("p5", "slow", "遅い", "adj"),
  ];
  for (let i = 0; i < 50; i += 1) {
    const picked = b.pickDistractors(pool, answer, 3, [], { dedupeBy: "term" });
    const terms = picked.map((w) => b.normalizeTerm(w.term));
    assert.equal(
      new Set(terms).size,
      terms.length,
      `duplicate displayed term among distractors on draw ${i}: ${terms.join(",")}`,
    );
  }
});

// ---------- 4. 既定値は英→日で、設定を触らない限り現行と同一の問題が出る ----------
test("forward (default): buildQuiz keeps the legacy shape — real word references, no reverse flag", () => {
  const b = buildQuizSandbox();
  const wordsArr = [
    W("a1", "alter", "変える", "v"),
    W("a2", "gather", "集める", "v"),
    W("a3", "wisdom", "知恵", "n"),
    W("a4", "urban", "都会の", "adj"),
  ];
  b.setWords(wordsArr);
  // 設定を一切保存していない状態（未設定）＝既定は英→日。
  b.resetRandomCalls();
  const quiz = b.buildQuiz();
  assert.equal(b.quizDirectionSetting(), "forward", "no saved setting must default to forward");
  assert.equal(quiz.reverse, false, "forward quizzes must not carry the reverse flag as true");
  // answerはappState.words内の実データそのものへの参照（コピーやラップをしていない）。
  // vmサンドボックス境界を越えても素のオブジェクト参照は同一性を保つので、===で照合できる。
  const sameRefInPool = wordsArr.some((w) => w === quiz.answer);
  assert.ok(sameRefInPool, "answer must be the exact same object reference passed via setWords, not a copy");
  // choicesも実データそのもの（{id,label}へ包み直されていない）。renderChoicesの
  // 「choice.label || choice.meaning」フォールバックが従来どおり意味を拾えることを保証する。
  for (const choice of quiz.choices) {
    assert.equal(Object.hasOwn(choice, "label"), false, "forward choices must not gain a label wrapper");
    assert.ok(choice.meaning, "forward choices must keep their real meaning field");
    assert.ok(wordsArr.some((w) => w === choice), "each forward choice must be the exact word reference, not a copy");
  }
});

test("explicit forward setting behaves identically to the unset default (choices, answer, and random-draw count all match)", () => {
  const words = () => [
    W("a1", "alter", "変える", "v"),
    W("a2", "gather", "集める", "v"),
    W("a3", "wisdom", "知恵", "n"),
    W("a4", "urban", "都会の", "adj"),
  ];
  const bUnset = buildQuizSandbox();
  bUnset.setWords(words());
  bUnset.setRandom(0.5);
  bUnset.resetRandomCalls();
  const quizUnset = bUnset.buildQuiz();
  const unsetRandomCalls = bUnset.randomCalls();

  const bForward = buildQuizSandbox();
  bForward.setWords(words());
  bForward.setDirection("forward");
  bForward.setRandom(0.5);
  bForward.resetRandomCalls();
  const quizForward = bForward.buildQuiz();
  const forwardRandomCalls = bForward.randomCalls();

  assert.equal(quizUnset.answer.id, quizForward.answer.id, "the drawn answer word must be identical");
  // vmサンドボックス側の配列は別レルムのArrayなのでdeepEqualがreference-equalでない
  // と判定してしまう。Array.from()でホスト側の配列に変換してから比較する。
  assert.deepEqual(
    Array.from(quizUnset.choices, (c) => c.id),
    Array.from(quizForward.choices, (c) => c.id),
    "explicit forward must draw exactly the same question (same choice order) as the unset default",
  );
  assert.equal(
    unsetRandomCalls,
    forwardRandomCalls,
    "both paths must consume the exact same number of Math.random() draws",
  );
  assert.ok(unsetRandomCalls > 0, "sanity check: buildQuiz must draw random numbers via shuffle() in both cases");
});

test("reverse: buildQuiz wraps choices as {id,label=term} while answer stays the real word reference", () => {
  const b = buildQuizSandbox();
  const wordsArr = [
    W("a1", "alter", "変える", "v"),
    W("a2", "gather", "集める", "v"),
    W("a3", "wisdom", "知恵", "n"),
    W("a4", "urban", "都会の", "adj"),
  ];
  b.setWords(wordsArr);
  b.setDirection("reverse");
  const quiz = b.buildQuiz();
  assert.equal(quiz.reverse, true);
  assert.equal(quiz.answer.term, "alter", "answer must remain the actual word object (unchanged data)");
  assert.ok(wordsArr.some((w) => w === quiz.answer), "answer must be the exact same object reference, not a copy");
  for (const choice of quiz.choices) {
    assert.equal(typeof choice.label, "string", "reverse choices must carry a term label");
    assert.equal(Object.hasOwn(choice, "meaning"), false, "reverse wrapper choices must not carry meaning");
  }
  const terms = quiz.choices.map((c) => c.label);
  assert.equal(new Set(terms).size, terms.length, "reverse choices must not repeat a term");
});

test("mix: resolves to forward or reverse per question without mutating the saved setting", () => {
  const b = buildQuizSandbox();
  b.setWords([
    W("a1", "alter", "変える", "v"),
    W("a2", "gather", "集める", "v"),
    W("a3", "wisdom", "知恵", "n"),
    W("a4", "urban", "都会の", "adj"),
  ]);
  b.setDirection("mix");
  b.setRandom(0.1); // < 0.5 → reverse
  assert.equal(b.resolveQuizReverse(), true);
  b.setRandom(0.9); // >= 0.5 → forward
  assert.equal(b.resolveQuizReverse(), false);
  assert.equal(b.quizDirectionSetting(), "mix", "resolving a direction must not overwrite the saved setting");
});

// direction resolutionそのものが乱数を消費するかどうか（forward/reverseは固定、mixだけ引く）
test("resolveQuizReverse only consumes Math.random() for the mix setting", () => {
  const b = buildQuizSandbox();
  b.setDirection("forward");
  b.resetRandomCalls();
  b.resolveQuizReverse();
  assert.equal(b.randomCalls(), 0, "forward must not draw a random number");

  b.setDirection("reverse");
  b.resetRandomCalls();
  b.resolveQuizReverse();
  assert.equal(b.randomCalls(), 0, "reverse must not draw a random number");

  b.setDirection("mix");
  b.resetRandomCalls();
  b.resolveQuizReverse();
  assert.equal(b.randomCalls(), 1, "mix must draw exactly one random number per question");
});

// ---------- 5. 設定の保存と復元（localStorageが壊れていても例外を漏らさない） ----------
test("quiz direction setting normalizes invalid values and survives a broken localStorage", () => {
  const b = buildQuizSandbox();
  for (const ok of ["forward", "reverse", "mix"]) {
    assert.equal(b.normalizeQuizDirection(ok), ok);
  }
  for (const bad of [null, undefined, "", "backward", "REVERSE", 123, {}]) {
    assert.equal(b.normalizeQuizDirection(bad), "forward", `invalid ${String(bad)} must fall back to forward`);
  }
  b.setDirection("reverse");
  assert.equal(b.quizDirectionSetting(), "reverse");
  b.setStorageThrows(true);
  assert.doesNotThrow(() => b.quizDirectionSetting());
  assert.equal(b.quizDirectionSetting(), "forward", "a broken localStorage must fail safe to forward");
  assert.doesNotThrow(() => b.resolveQuizReverse());
});

// ---------- 6. 設定selectのchangeハンドラが、選んだ値を実際にlocalStorageへ保存する ----------
// setDirection()がモックストアを直接書くだけでは、本物のchangeリスナーの配線が壊れても
// 検出できない。リスナー本体そのものを実コードから切り出して動かす（手本: bulk-move-deck.test.mjs）。
const DIRECTION_CHANGE_ANCHOR = 'elements.quizDirectionSelect?.addEventListener("change", () => {';
const directionHandlerBody = extractArrowHandlerBody(DIRECTION_CHANGE_ANCHOR);

test("quizDirectionSelectのchangeハンドラを正しく切り出せている（目印の行を含む）", () => {
  // 切り出しに失敗して空文字や別のハンドラを拾っていないことを、検査自体で確かめる。
  assert.ok(directionHandlerBody.startsWith("{") && directionHandlerBody.endsWith("}"));
  assert.ok(
    directionHandlerBody.includes("localStorage.setItem(QUIZ_DIRECTION_KEY"),
    "localStorage.setItem呼び出しが見当たらない＝切り出し失敗",
  );
  assert.ok(directionHandlerBody.includes('playSound("tap")'), "playSound呼び出しが見当たらない＝切り出し失敗");
});

function buildDirectionListenerSandbox() {
  if (!QUIZ_DIRECTION_KEY_LITERAL) throw new Error("QUIZ_DIRECTION_KEY not found");
  const pieces = [
    "let __store = {};",
    "let __storageThrows = false;",
    "const localStorage = {" +
      " getItem: (k) => { if (__storageThrows) throw new Error('blocked'); return Object.hasOwn(__store, k) ? __store[k] : null; }," +
      " setItem: (k, v) => { if (__storageThrows) throw new Error('blocked'); __store[k] = String(v); }," +
      " removeItem: (k) => { delete __store[k]; } };",
    "const __soundCalls = [];",
    "function playSound(name) { __soundCalls.push(name); }",
    `const QUIZ_DIRECTION_KEY = ${JSON.stringify(QUIZ_DIRECTION_KEY_LITERAL)};`,
    extractConst("QUIZ_DIRECTION_CHOICES"),
    extractFunction("normalizeQuizDirection"),
    "const elements = { quizDirectionSelect: { value: 'forward' } };",
    `function quizDirectionChangeHandler() ${directionHandlerBody}`,
    "globalThis.__d = {" +
      " elements," +
      " run: quizDirectionChangeHandler," +
      " setStorageThrows: (v) => { __storageThrows = v; }," +
      " getStored: () => __store[QUIZ_DIRECTION_KEY]," +
      " getSoundCalls: () => __soundCalls };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "reverse-quiz-direction-listener-check.js" }).runInNewContext(
    sandbox,
  );
  return sandbox.__d;
}

test("quizDirectionSelect changeハンドラ: 選んだ値をそのままlocalStorageへ保存する", () => {
  const d = buildDirectionListenerSandbox();
  d.elements.quizDirectionSelect.value = "reverse";
  d.run();
  assert.equal(d.getStored(), "reverse");
  assert.deepEqual(Array.from(d.getSoundCalls()), ["tap"]);
});

test("quizDirectionSelect changeハンドラ: 想定外の値は保存前にforwardへ丸められる", () => {
  const d = buildDirectionListenerSandbox();
  d.elements.quizDirectionSelect.value = "backward"; // <select>からは出ない値だが、防御的に確認する
  d.run();
  assert.equal(d.getStored(), "forward");
});

test("quizDirectionSelect changeハンドラ: localStorageが書けなくても例外を漏らさず、効果音は鳴る", () => {
  const d = buildDirectionListenerSandbox();
  d.setStorageThrows(true);
  d.elements.quizDirectionSelect.value = "mix";
  assert.doesNotThrow(() => d.run());
  assert.deepEqual(Array.from(d.getSoundCalls()), ["tap"]);
});

// ---------- 3. promptMode "term-choice" は masteryVerify を解除しない ----------
// まずcurrentQuizPromptMode（採点・SRS・確信度検証・ログの全経路が通る一元判定）を直接検査する。
function promptModeSandbox() {
  const pieces = [extractFunction("currentQuizPromptMode"), "globalThis.__pm = currentQuizPromptMode;"];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "reverse-quiz-promptmode-check.js" }).runInNewContext(sandbox);
  return sandbox.__pm;
}

test("currentQuizPromptMode maps a reverse quiz to term-choice (distinct from meaning-choice)", () => {
  const promptModeOf = promptModeSandbox();
  assert.equal(promptModeOf({ flashcard: true, context: null, reverse: false }), "flashcard");
  assert.equal(promptModeOf({ flashcard: false, context: { en: "x" }, reverse: false }), "context-choice");
  assert.equal(promptModeOf({ flashcard: false, context: null, reverse: true }), "term-choice");
  assert.equal(promptModeOf({ flashcard: false, context: null, reverse: false }), "meaning-choice");
});

// applyLearningResultは学習スケジューラ本体。quiz-quality.test.mjsのbuildLearningSandboxと
// 同じ流儀で、係数はスタブにして「promptModeの通り道」だけを検証する。
function buildLearningSandbox() {
  const start = html.indexOf("function scheduleReview(");
  const end = html.indexOf("\nfunction shuffle(", start);
  if (start < 0 || end <= start) throw new Error("learning scheduler source not found");
  const pieces = [
    "const SRS_DAY_MS = 86400000;",
    "const SRS_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60, 120];",
    "const SLOW_ANSWER_MS = 5000;",
    "const MAX_TIMED_ANSWER_MS = 60000;",
    "const FAST_ANSWER_MS = 3000;",
    "const adaptiveSrsEnabled = () => false;",
    "const wordAccuracyFactor = () => 1.2;",
    "const personalAccuracyFactorCached = () => 1.1;",
    "const adaptiveSrsMultiplier = () => 1;",
    "const appState = { quizCounter: 10 };",
    "Math.random = () => 0.5;",
    html.slice(start, end),
    "globalThis.__l = { applyLearningResult };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "reverse-quiz-learning-check.js" }).runInNewContext(sandbox);
  return sandbox.__l;
}

test("term-choice (reverse) answers never confirm a provisional flashcard mastery, even when due", () => {
  const L = buildLearningSandbox();
  const NOW = 1_700_000_000_000;
  // フラッシュカードで仮習得(masteryVerify="flashcard")かつ、期日到来(srsDueAtStart=true)の語。
  // meaning-choiceで正解すればここでmasteryVerifyが消えるはずの状況を、term-choiceで再現する。
  const word = {
    learning: {
      status: "mastered",
      masteryVerify: "flashcard",
      firstAttempted: true,
      correctStreak: 2,
      srsStage: 3,
      nextReviewAt: NOW - 1,
      srsUpdatedAt: NOW - 10_000,
      lastSrsResult: "correct",
    },
    history: [],
  };
  L.applyLearningResult(word, true, true, NOW, {
    responseMs: 1000,
    promptMode: "term-choice",
  });
  assert.equal(word.learning.status, "mastered");
  assert.equal(
    word.learning.masteryVerify,
    "flashcard",
    "a correct due term-choice (reverse) answer must NOT verify/clear the provisional flashcard mastery",
  );

  // 対照: 同じ状況でmeaning-choiceなら検証されてmasteryVerifyが消えることを確認する
  // （term-choiceの効果が「常に何もしない」のではなく、正しくmeaning-choiceとだけ区別されていることの確認）。
  const verified = {
    learning: { ...word.learning, masteryVerify: "flashcard" },
    history: [],
  };
  L.applyLearningResult(verified, true, true, NOW, {
    responseMs: 1000,
    promptMode: "meaning-choice",
  });
  assert.equal(Object.hasOwn(verified.learning, "masteryVerify"), false,
    "control: a due meaning-choice correct answer must still confirm full mastery as before");
});

test("term-choice (reverse) wrong answers still use the existing wrong-answer path (no special casing)", () => {
  const L = buildLearningSandbox();
  const NOW = 1_700_000_000_000;
  const word = {
    learning: {
      status: "mastered",
      masteryVerify: "flashcard",
      firstAttempted: true,
      correctStreak: 2,
      srsStage: 5,
      nextReviewAt: NOW - 1,
      srsUpdatedAt: NOW - 10_000,
      lastSrsResult: "correct",
    },
    history: [],
  };
  L.applyLearningResult(word, false, true, NOW, {
    responseMs: 1000,
    promptMode: "term-choice",
  });
  assert.equal(word.learning.status, "review", "a wrong answer must demote status regardless of direction");
  assert.equal(Object.hasOwn(word.learning, "masteryVerify"), false,
    "a wrong answer must still clear the provisional marker via the existing wrong path");
});

// ---------- 3(続き). gradeQuiz()を実際に動かして、3経路すべてにterm-choiceが伝わることを固定する ----------
// currentQuizPromptModeやapplyLearningResultを個別に直接呼ぶテストだけでは、gradeQuiz内で
// 実際に正しい引数が渡されているか（配線）は検証できない。gradeQuiz本体をサンドボックスで
// 動かし、確信度検証・学習結果適用・ログ記録の3呼び出しをレコーダースタブに差し替えて
// 受け取ったpromptModeを直接観測する。
function buildGradeQuizSandbox() {
  const pieces = [
    // gradeQuizが直接読み書きするミュータブルな外側の状態
    "let currentQuiz = null;",
    "let reviewSession = null;",
    "let quizEmptyReason = '';",
    "let quizStarted = true;",
    "let quizSessionStats = { answered: 0, correct: 0 };",
    "const appState = { words: [], quizCounter: 0 };",
    "const elements = { quizFeedback: { textContent: '' }, quizScope: { textContent: '' } };",
    `const WRONG_COOLDOWN_MS = ${html.match(/const WRONG_COOLDOWN_MS = ([^;]+);/)[1]};`,
    "const window = {};",
    // 検証対象の3経路：受け取ったpromptModeをそのまま記録するレコーダースタブ
    "const calls = { verifyConfidence: [], applyLearning: [], reviewEvent: [] };",
    "function verifyConfidenceOnAnswer(wordId, isCorrect, promptMode) { calls.verifyConfidence.push(promptMode); }",
    "function applyLearningResult(word, isCorrect, srsDueAtStart, now, options) {" +
      " calls.applyLearning.push(options.promptMode);" +
      " return { advanced: false, multiplier: 1, nextReviewAt: 0 };" +
      " }",
    "function recordReviewEvent(details) { calls.reviewEvent.push(details.promptMode); }",
    // それ以外の副作用（描画・保存・通知・音・振動・読み上げ）はpromptModeの伝播に無関係なのでno-op
    "function playSound() {}",
    "function vibrateFeedback() {}",
    "function trackUsage() {}",
    "function updateStreakOnAnswer() {}",
    "function bumpTodayAnswerCount() {}",
    "function recordRecoveryProbeAnswer() {}",
    "function highlightChoices() {}",
    "function highlightTermInSentence() { return ''; }",
    "function autoSpeakEnabled() { return false; }",
    "function speakWord() {}",
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
    "function clearSavedReviewProgress() {}",
    "function renderQuizEmpty() {}",
    "function renderQuiz() {}",
    extractFunction("currentQuizPromptMode"),
    extractFunction("gradeQuiz"),
    "globalThis.__g = {" +
      " calls," +
      " setCurrentQuiz: (q) => { currentQuiz = q; }," +
      " setWords: (w) => { appState.words = w; }," +
      " gradeQuiz };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "reverse-quiz-gradequiz-check.js" }).runInNewContext(sandbox);
  return sandbox.__g;
}

test("gradeQuiz本体を正しく切り出せている（目印の行を含む）", () => {
  const body = extractFunction("gradeQuiz");
  assert.ok(body.startsWith("function gradeQuiz(") && body.endsWith("}"));
  // 3経路すべてでcurrentQuizPromptMode(currentQuiz)を経由していることを確認する
  // （個別ハードコードの"meaning-choice"に戻す変異が入っていないかの下地）。
  const occurrences = body.split("currentQuizPromptMode(currentQuiz)").length - 1;
  assert.equal(occurrences, 3, "gradeQuiz must route all three call sites through currentQuizPromptMode");
});

function makeGradableWord(id) {
  return {
    id,
    stats: { correct: 0, wrong: 0 },
    history: [],
    learning: { status: "review", srsStage: 1, nextReviewAt: 0, blockedUntil: 0, correctStreak: 0 },
  };
}

test("gradeQuiz: reverse (term-choice) correct answers propagate promptMode='term-choice' to all three call sites", () => {
  const g = buildGradeQuizSandbox();
  const word = makeGradableWord("a1");
  g.setWords([word]);
  g.setCurrentQuiz({
    answer: { id: "a1", term: "alter", meaning: "変える" },
    choices: [
      { id: "a1", label: "alter" },
      { id: "b1", label: "gather" },
    ],
    answered: false,
    shownAt: Date.now() - 500,
    srsDueAtStart: false,
    reverse: true,
  });
  g.gradeQuiz("a1"); // 正解を選ぶ
  assert.deepEqual(Array.from(g.calls.verifyConfidence), ["term-choice"]);
  assert.deepEqual(Array.from(g.calls.applyLearning), ["term-choice"]);
  assert.deepEqual(Array.from(g.calls.reviewEvent), ["term-choice"]);
});

test("gradeQuiz: reverse (term-choice) wrong answers also propagate promptMode='term-choice' to all three call sites", () => {
  const g = buildGradeQuizSandbox();
  const word = makeGradableWord("a1");
  g.setWords([word]);
  g.setCurrentQuiz({
    answer: { id: "a1", term: "alter", meaning: "変える" },
    choices: [
      { id: "a1", label: "alter" },
      { id: "b1", label: "gather" },
    ],
    answered: false,
    shownAt: Date.now() - 500,
    srsDueAtStart: false,
    reverse: true,
  });
  g.gradeQuiz("b1"); // 誤答を選ぶ
  assert.deepEqual(Array.from(g.calls.verifyConfidence), ["term-choice"]);
  assert.deepEqual(Array.from(g.calls.applyLearning), ["term-choice"]);
  assert.deepEqual(Array.from(g.calls.reviewEvent), ["term-choice"]);
});

test("gradeQuiz: forward (meaning-choice) still propagates meaning-choice through the same three call sites (control)", () => {
  const g = buildGradeQuizSandbox();
  const word = makeGradableWord("a1");
  g.setWords([word]);
  g.setCurrentQuiz({
    answer: { id: "a1", term: "alter", meaning: "変える" },
    choices: [
      { id: "a1", meaning: "変える" },
      { id: "b1", meaning: "集める" },
    ],
    answered: false,
    shownAt: Date.now() - 500,
    srsDueAtStart: false,
    reverse: false,
  });
  g.gradeQuiz("a1");
  assert.deepEqual(Array.from(g.calls.verifyConfidence), ["meaning-choice"]);
  assert.deepEqual(Array.from(g.calls.applyLearning), ["meaning-choice"]);
  assert.deepEqual(Array.from(g.calls.reviewEvent), ["meaning-choice"]);
});

// ============================================================================
// ここから: 復習/範囲クイズ（buildReviewQuiz）でも逆方向出題が効くことを固定する
// ============================================================================
// これまで出題の向きは buildQuiz()（おまかせクイズ）だけに効いていた。今回の実装で
// 次の3箇所に広げた：
//   1. startReview(): reviewSession に reverse: resolveQuizReverse() を追加し、
//      セッション開始時に一度だけ決めて固定する（formatSeedと同じ考え方）
//   2. buildReviewQuiz(): reviewSession.reverse を読んで、通常4択パスの
//      dedupeBy / 選択肢の{id,label}包み直し / 戻り値のreverseフラグに反映する
//   3. persistReviewProgress / 復元(resumeSavedReview): reverse を保存・復元する。
//      旧い保存データには無いので Boolean(saved.reverse) で false にフォールバックする
// 固定する不変条件:
//   1. reverse:true のとき、選択肢が {id,label=term} 形式になる
//   2. 同じとき、選択肢のtermが重複しない（dedupeBy:"term"、50回引いても）
//   3. 同じとき、意味が近すぎる語が混ざらない（meaningsTooClose除外は向き非依存、50回引いても）
//   4. reverse:false（既定）のとき、選択肢は実データ参照のまま（label不所持・meaning所持）
//   5. 戻り値にreverseフラグが乗る（true/false両方）
//   6. セッション単位で固定される：同じreviewSessionから複数問生成しても全問同じ向き
//      （buildReviewQuizSandboxにはresolveQuizReverseを一切含めていないため、もし
//      buildReviewQuizが1問ごとに再計算する変異が入ればReferenceErrorで即座に検出できる）
//   7. persistReviewProgress→resumeSavedReviewの往復でreverseが保たれ、
//      reverseを持たない旧い保存データはfalseにフォールバックする（後方互換）
//   3'. startReview()がresolveQuizReverse()の結果を実際にreviewSession.reverseへ渡している
//      こと自体も、startReview本体を動かして直接固定する

// ---------- サンドボックス2: buildReviewQuiz 単体 ----------
// reviewSession / appState.words / quizEmptyReason / contextBasisFallbackNote は
// module-level の可変状態なので、setSession/setWordsで直接注入する。
// 例文（context）分岐に入らないよう、テストでは常に context:false, mixFormat:false を渡す
// （その場合 mixedFormatUsesContext は先頭のガードで即falseを返すため、
// contextGenMode 等の周辺関数を一切スタブしなくても安全に呼べる）。
function buildReviewQuizSandbox() {
  const pieces = [
    "let quizEmptyReason = '';",
    "let contextBasisFallbackNote = '';",
    "let reviewSession = null;",
    "let currentQuiz = null;",
    "const appState = { words: [] };",
    "const elements = { quizFeedback: { textContent: '' } };",
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
    "globalThis.__rq = {" +
      " setWords: (w) => { appState.words = w; }," +
      " setSession: (s) => { reviewSession = s; }," +
      " getSession: () => reviewSession," +
      " getFeedback: () => elements.quizFeedback.textContent," +
      " normalizeTerm," +
      " buildReviewQuiz };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "reverse-quiz-buildreviewquiz-check.js" }).runInNewContext(sandbox);
  return sandbox.__rq;
}

// ---------- 1. reverse:true のとき、選択肢が {id,label=term} 形式になる ----------
test("review reverse: buildReviewQuiz wraps choices as {id,label=term} while answer stays the real word reference", () => {
  const b = buildReviewQuizSandbox();
  const answer = W("a1", "alter", "変える", "v");
  const distractors = [
    W("p1", "gather", "集める", "v"),
    W("p2", "wisdom", "知恵", "n"),
    W("p3", "urban", "都会の", "adj"),
  ];
  const words = [answer, ...distractors];
  b.setWords(words);
  b.setSession({
    allIds: words.map((w) => w.id),
    queue: [answer.id],
    reverse: true,
    context: false,
    mixFormat: false,
    label: "テスト",
  });
  const quiz = b.buildReviewQuiz();
  assert.ok(quiz, "quiz must be produced");
  assert.equal(quiz.reverse, true);
  assert.equal(quiz.answer.term, "alter", "answer must remain the actual word object (unchanged data)");
  assert.ok(words.some((w) => w === quiz.answer), "answer must be the exact same object reference, not a copy");
  for (const choice of quiz.choices) {
    assert.equal(typeof choice.label, "string", "reverse choices must carry a term label");
    assert.equal(Object.hasOwn(choice, "meaning"), false, "reverse wrapper choices must not carry meaning");
  }
});

// ---------- 2. reverse:true のとき、選択肢のtermが重複しない（50回引いても） ----------
test("review reverse: distractor terms never repeat across 50 draws (dedupeBy=term)", () => {
  const b = buildReviewQuizSandbox();
  const answer = W("a1", "large", "大きい", "adj");
  const pool = [
    W("p1", "Big", "大きめの", "adj"), // termが"big"と大文字違いで衝突する
    W("p2", "big", "巨大な", "adj"),
    W("p3", "small", "小さい", "adj"),
    W("p4", "fast", "速い", "adj"),
    W("p5", "slow", "遅い", "adj"),
  ];
  const words = [answer, ...pool];
  b.setWords(words);
  const allIds = words.map((w) => w.id);
  for (let i = 0; i < 50; i += 1) {
    b.setSession({ allIds, queue: [answer.id], reverse: true, context: false, mixFormat: false, label: "テスト" });
    const quiz = b.buildReviewQuiz();
    const terms = quiz.choices.map((c) => b.normalizeTerm(c.label));
    assert.equal(
      new Set(terms).size,
      terms.length,
      `duplicate displayed term among reverse choices on draw ${i}: ${terms.join(",")}`,
    );
  }
});

// ---------- 3. reverse:true のとき、意味が近すぎる語が混ざらない（50回引いても） ----------
test("review reverse: meaning-too-close words never leak into distractors across 50 draws", () => {
  const b = buildReviewQuizSandbox();
  const answer = W("a1", "alter", "変える", "v");
  const pool = [
    W("p1", "modify", "部分的に変える", "v"), // 意味が「変える」を包含 → 除外されるべき
    W("p2", "gather", "集める", "v"),
    W("p3", "wisdom", "知恵", "n"),
    W("p4", "urban", "都会の", "adj"),
    W("p5", "settle", "解決する", "v"),
  ];
  const words = [answer, ...pool];
  b.setWords(words);
  const allIds = words.map((w) => w.id);
  for (let i = 0; i < 50; i += 1) {
    b.setSession({ allIds, queue: [answer.id], reverse: true, context: false, mixFormat: false, label: "テスト" });
    const quiz = b.buildReviewQuiz();
    assert.ok(
      !quiz.choices.some((c) => c.id === "p1"),
      `meaning-too-close distractor leaked through on draw ${i}`,
    );
  }
});

// ---------- 4. reverse:false（既定）のとき、選択肢は実データ参照のまま ----------
test("review forward (reverse:false, default): buildReviewQuiz keeps the legacy shape — real word references, no label wrapper", () => {
  const b = buildReviewQuizSandbox();
  const answer = W("a1", "alter", "変える", "v");
  const distractors = [
    W("p1", "gather", "集める", "v"),
    W("p2", "wisdom", "知恵", "n"),
    W("p3", "urban", "都会の", "adj"),
  ];
  const words = [answer, ...distractors];
  b.setWords(words);
  b.setSession({
    allIds: words.map((w) => w.id),
    queue: [answer.id],
    reverse: false,
    context: false,
    mixFormat: false,
    label: "テスト",
  });
  const quiz = b.buildReviewQuiz();
  assert.equal(quiz.reverse, false, "forward review quizzes must not carry the reverse flag as true");
  assert.ok(words.some((w) => w === quiz.answer), "answer must be the exact same object reference, not a copy");
  for (const choice of quiz.choices) {
    assert.equal(Object.hasOwn(choice, "label"), false, "forward choices must not gain a label wrapper");
    assert.ok(choice.meaning, "forward choices must keep their real meaning field");
    assert.ok(words.some((w) => w === choice), "each forward choice must be the exact word reference, not a copy");
  }
});

test("review: reviewSession.reverse being absent (undefined) defaults to forward, same as explicit false", () => {
  const b = buildReviewQuizSandbox();
  const answer = W("a1", "alter", "変える", "v");
  const distractors = [
    W("p1", "gather", "集める", "v"),
    W("p2", "wisdom", "知恵", "n"),
    W("p3", "urban", "都会の", "adj"),
  ];
  const words = [answer, ...distractors];
  b.setWords(words);
  // reverseフィールドを省略（旧いresumeパス以外でも起こりうる防御的なケース）
  b.setSession({ allIds: words.map((w) => w.id), queue: [answer.id], context: false, mixFormat: false, label: "テスト" });
  const quiz = b.buildReviewQuiz();
  assert.equal(quiz.reverse, false, "missing reverse must be treated as false via Boolean(reviewSession.reverse)");
});

// ---------- 6. セッション単位で固定される（1問ごとに引き直さない） ----------
test("review reverse: direction stays fixed across multiple questions drawn from the same session", () => {
  const b = buildReviewQuizSandbox();
  const words = [
    W("a1", "alter", "変える", "v"),
    W("a2", "gather", "集める", "v"),
    W("a3", "wisdom", "知恵", "n"),
    W("a4", "urban", "都会の", "adj"),
    W("a5", "settle", "解決する", "v"),
  ];
  b.setWords(words);
  const allIds = words.map((w) => w.id);
  const session = { allIds, queue: allIds.slice(), reverse: true, context: false, mixFormat: false, label: "テスト" };
  b.setSession(session);
  for (let i = 0; i < allIds.length; i += 1) {
    const quiz = b.buildReviewQuiz();
    assert.equal(quiz.reverse, true, `question ${i} must stay reverse`);
    assert.ok(
      quiz.choices.every((c) => typeof c.label === "string"),
      `question ${i} choices must stay term-labeled`,
    );
    // 本来はgradeQuiz側の役目だが、ここではqueueだけ手動で進めて次の語を引く
    session.queue.shift();
  }
});

// ---------- 3'. startReview()がresolveQuizReverse()の結果を実際に渡している ----------
function buildStartReviewSandbox() {
  if (!QUIZ_DIRECTION_KEY_LITERAL) throw new Error("QUIZ_DIRECTION_KEY not found");
  if (!QUIZ_RESUME_KEY_LITERAL) throw new Error("QUIZ_RESUME_KEY not found");
  const pieces = [
    "let __store = {};",
    "const localStorage = {" +
      " getItem: (k) => (Object.hasOwn(__store, k) ? __store[k] : null)," +
      " setItem: (k, v) => { __store[k] = String(v); }," +
      " removeItem: (k) => { delete __store[k]; } };",
    `const QUIZ_DIRECTION_KEY = ${JSON.stringify(QUIZ_DIRECTION_KEY_LITERAL)};`,
    `const QUIZ_RESUME_KEY = ${JSON.stringify(QUIZ_RESUME_KEY_LITERAL)};`,
    extractConst("QUIZ_DIRECTION_CHOICES"),
    extractFunction("normalizeQuizDirection"),
    extractFunction("quizDirectionSetting"),
    extractFunction("resolveQuizReverse"),
    extractFunction("normalizeQuizContextAmount"),
    "let flashcardSession = null;",
    "let flashcardRevealed = false;",
    "let reviewSession = null;",
    "let reviewResult = null;",
    "let quizEmptyReason = '';",
    "let currentQuiz = null;",
    "const appState = { words: [] };",
    "const elements = { quizWord: { closest: () => ({ scrollIntoView() {} }) } };",
    "function setActiveStep() {}",
    "function renderQuiz() {}",
    "function setStatus() {}",
    "function prefersReducedMotion() { return true; }",
    extractFunction("persistReviewProgress"),
    extractFunction("startReview"),
    "globalThis.__sr = {" +
      " setWords: (w) => { appState.words = w; }," +
      " setDirection: (v) => { __store[QUIZ_DIRECTION_KEY] = v; }," +
      " getSession: () => reviewSession," +
      " startReview };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "reverse-quiz-startreview-check.js" }).runInNewContext(sandbox);
  return sandbox.__sr;
}

test("review start: startReview() derives reviewSession.reverse from resolveQuizReverse() (tracks the saved direction setting)", () => {
  const s = buildStartReviewSandbox();
  const words = [W("a1", "alter", "変える", "v"), W("a2", "gather", "集める", "v")];
  s.setWords(words);

  s.setDirection("reverse");
  s.startReview(["a1", "a2"], { shuffle: false, label: "テスト" });
  assert.equal(s.getSession()?.reverse, true, "startReview must resolve reverse=true when the setting is reverse");

  s.setDirection("forward");
  s.startReview(["a1", "a2"], { shuffle: false, label: "テスト" });
  assert.equal(s.getSession()?.reverse, false, "startReview must resolve reverse=false when the setting is forward");
});

// ---------- 7. persistReviewProgress → resumeSavedReview の往復 ----------
const QUIZ_RESUME_KEY_LITERAL = html.match(/const QUIZ_RESUME_KEY = "([^"]+)";/)?.[1];

function buildReviewResumeSandbox() {
  if (!QUIZ_RESUME_KEY_LITERAL) throw new Error("QUIZ_RESUME_KEY not found");
  const pieces = [
    "let __store = {};",
    "const localStorage = {" +
      " getItem: (k) => (Object.hasOwn(__store, k) ? __store[k] : null)," +
      " setItem: (k, v) => { __store[k] = String(v); }," +
      " removeItem: (k) => { delete __store[k]; } };",
    `const QUIZ_RESUME_KEY = ${JSON.stringify(QUIZ_RESUME_KEY_LITERAL)};`,
    "let reviewSession = null;",
    "let reviewResult = null;",
    "let quizEmptyReason = '';",
    "let currentQuiz = null;",
    "let __status = '';",
    "const appState = { words: [] };",
    "const elements = { quizWord: { closest: () => ({ scrollIntoView() {} }) } };",
    "function setStatus(msg) { __status = msg; }",
    "function updateResumeButton() {}",
    "function renderQuiz() {}",
    "function prefersReducedMotion() { return true; }",
    extractFunction("normalizeQuizContextAmount"),
    extractFunction("persistReviewProgress"),
    extractFunction("readSavedReviewProgress"),
    extractFunction("resumeSavedReview"),
    "globalThis.__rr = {" +
      " setWords: (w) => { appState.words = w; }," +
      " setSession: (s) => { reviewSession = s; }," +
      " getSession: () => reviewSession," +
      " persistReviewProgress," +
      " resumeSavedReview," +
      " primeRawStorage: (obj) => { __store[QUIZ_RESUME_KEY] = JSON.stringify(obj); }," +
      " getStatus: () => __status };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "reverse-quiz-review-resume-check.js" }).runInNewContext(sandbox);
  return sandbox.__rr;
}

test("review resume: persisting a reverse session and resuming it keeps reverse=true", () => {
  const r = buildReviewResumeSandbox();
  const words = [
    W("a1", "alter", "変える", "v"),
    W("a2", "gather", "集める", "v"),
    W("a3", "wisdom", "知恵", "n"),
  ];
  r.setWords(words);
  r.setSession({
    allIds: ["a1", "a2", "a3"],
    queue: ["a2", "a3"],
    total: 3,
    label: "復習",
    context: false,
    contextAmount: "none",
    mixFormat: false,
    formatSeed: "seed123",
    reverse: true,
    missedIds: [],
  });
  r.persistReviewProgress();
  r.setSession(null); // 中断してセッションを失った状態を再現
  r.resumeSavedReview();
  const restored = r.getSession();
  assert.ok(restored, "resumeSavedReview must restore a session");
  assert.equal(restored.reverse, true, "reverse must survive a persist -> resume round trip");
});

test("review resume: legacy saved data without a reverse field falls back to false (backward compatibility)", () => {
  const r = buildReviewResumeSandbox();
  const words = [W("a1", "alter", "変える", "v"), W("a2", "gather", "集める", "v")];
  r.setWords(words);
  r.primeRawStorage({
    allIds: ["a1", "a2"],
    queue: ["a2"],
    total: 2,
    label: "復習",
    // reverseフィールドが無い旧スナップショット（このタスクの実装より前に保存されたもの）
    savedAt: Date.now(),
  });
  r.resumeSavedReview();
  const restored = r.getSession();
  assert.ok(restored, "resumeSavedReview must restore the legacy session");
  assert.equal(restored.reverse, false, "legacy data without reverse must fail safe to forward (false)");
});

// ============================================================================
// 仮習得（masteryVerify）の検証待ち語は、逆方向設定でも必ず英→日で出す
// ============================================================================
// フラッシュカードで習得した語には masteryVerify:"flashcard" が付き、
// 「SRS期限が来た回の意味4択に正解する」ことで本習得へ確定する
// （applyLearningResult の verifiesFlashcardMastery が promptMode === "meaning-choice"
//  を要求する）。日→英は term-choice 扱いなのでこの条件を満たさない。
// ガードが無いと、逆方向を使っている間その語は永久に仮習得のまま残り、
// flashcardEligibleIds からも外れ続けて「どこにも出ないが確定もしない」状態になる。
// 既存コードが同じ語に対して例文形式を抑止しているのと同じ理由・同じ対象。

function verificationDueWord(id, term, meaning) {
  return {
    id,
    term,
    meaning,
    stats: { correct: 3, wrong: 0 },
    history: [],
    learning: {
      status: "mastered",
      masteryVerify: "flashcard",
      nextReviewAt: Date.now() - 1000, // 期限到来済み
      srsStage: 3,
      correctStreak: 2,
      firstAttempted: true,
      reviewAt: 0,
      blockedUntil: 0,
      srsUpdatedAt: Date.now() - 1000,
      lastSrsResult: "correct",
    },
  };
}

test("復習: 仮習得の検証待ち語は、セッションが逆方向でも英→日で出す", () => {
  const r = buildReviewQuizSandbox();
  const target = verificationDueWord("m1", "alter", "変える");
  r.setWords([
    target,
    W("m2", "gather", "集める", "v"),
    W("m3", "wisdom", "知恵", "n"),
    W("m4", "urban", "都会の", "adj"),
  ]);
  r.setSession({
    allIds: ["m1", "m2", "m3", "m4"],
    queue: ["m1"],
    total: 4,
    label: "復習",
    context: false,
    mixFormat: false,
    reverse: true, // セッションは逆方向
    missedIds: [],
  });
  const quiz = r.buildReviewQuiz();
  assert.ok(quiz, "問題が作られること");
  assert.equal(
    quiz.reverse,
    false,
    "検証待ちの語は逆方向にしてはいけない（term-choiceでは本習得へ確定できない）",
  );
  // 選択肢も英→日の形（実データ参照・labelを持たない）に戻っていること
  for (const choice of quiz.choices) {
    assert.equal(Object.hasOwn(choice, "label"), false, "英→日の選択肢にlabelが生えている");
    assert.ok(choice.meaning, "英→日の選択肢が意味を持っていない");
  }
});

test("復習: 検証待ちでない語は、セッションが逆方向なら逆方向のまま（対照）", () => {
  const r = buildReviewQuizSandbox();
  const plain = W("m1", "alter", "変える", "v"); // masteryVerify なし
  r.setWords([
    plain,
    W("m2", "gather", "集める", "v"),
    W("m3", "wisdom", "知恵", "n"),
    W("m4", "urban", "都会の", "adj"),
  ]);
  r.setSession({
    allIds: ["m1", "m2", "m3", "m4"],
    queue: ["m1"],
    total: 4,
    label: "復習",
    context: false,
    mixFormat: false,
    reverse: true,
    missedIds: [],
  });
  const quiz = r.buildReviewQuiz();
  assert.equal(quiz.reverse, true, "通常の語は逆方向のままであること");
  for (const choice of quiz.choices) {
    assert.ok(Object.hasOwn(choice, "label"), "日→英の選択肢がlabelを持っていない");
  }
});

test("おまかせ: 仮習得の検証待ち語は、設定が日→英でも英→日で出す", () => {
  const b = buildQuizSandbox();
  const target = verificationDueWord("m1", "alter", "変える");
  b.setWords([
    target,
    W("m2", "gather", "集める", "v"),
    W("m3", "wisdom", "知恵", "n"),
    W("m4", "urban", "都会の", "adj"),
  ]);
  b.setDirection("reverse");
  // chooseNextWord は期限到来済みの語を最優先で返すので、target が選ばれる
  const quiz = b.buildQuiz();
  assert.ok(quiz, "問題が作られること");
  assert.equal(quiz.answer.id, "m1", "期限到来済みの検証待ち語が選ばれること（前提の確認）");
  assert.equal(
    quiz.reverse,
    false,
    "検証待ちの語は逆方向にしてはいけない（term-choiceでは本習得へ確定できない）",
  );
});
