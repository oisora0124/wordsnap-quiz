// クイズ本体の自己レビュー（1.0.105）で直した3点を、実コードのまま固定する。
//
// 1. 「▶ 再開」が復帰の抜き取り（recoverySessionId）とやさしい順（easyOrder）を落とさない。
//    落とすと、再開後の回答が抜き取りに数えられず「続きを解く」が残り続ける。
// 2. 出題範囲（復習セッション／単語帳）の語だけでは誤答が1つも作れないとき、全単語から
//    選び直す。範囲内で1つ以上作れたときは従来どおり（選択肢の中身を変えない）。
// 3. 名言バナーは本文も名前も省略しない（nowrap＋ellipsis を使わない）。
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

const W = (id, term, meaning, tag = "v") => ({
  id,
  term,
  meaning,
  pos: { tag },
  stats: { correct: 0, wrong: 0 },
  history: [],
  learning: { status: "new", nextReviewAt: 0 },
  addedAt: "2026-01-01T00:00:00.000Z",
});

// ============================================================================
// 1. 再開（persistReviewProgress → resumeSavedReview）が抜き取りの印を保つ
// ============================================================================
const QUIZ_RESUME_KEY_LITERAL = html.match(/const QUIZ_RESUME_KEY = "([^"]+)";/)?.[1];

function resumeSandbox() {
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
    "let flashcardSession = null;",
    "let flashcardRevealed = false;",
    "const appState = { words: [], quizCounter: 0 };",
    "const elements = { quizWord: { closest: () => ({ scrollIntoView() {} }) } };",
    "function setStatus() {}",
    "function updateResumeButton() {}",
    "function renderQuiz() {}",
    "function setActiveStep() {}",
    "function clearAutoNextTimer() {}",
    "function prefersReducedMotion() { return true; }",
    "function resolveQuizReverse() { return false; }",
    "function orderIdsByPriority(ids) { return ids.slice(); }",
    "function shuffle(items) { return items; }",
    extractFunction("normalizeQuizContextAmount"),
    extractFunction("startReview"),
    extractFunction("persistReviewProgress"),
    extractFunction("readSavedReviewProgress"),
    extractFunction("resumeSavedReview"),
    "globalThis.__r = {" +
      " setWords: (w) => { appState.words = w; }," +
      " getSession: () => reviewSession," +
      " dropSession: () => { reviewSession = null; }," +
      " startReview, resumeSavedReview," +
      " savedRaw: () => JSON.parse(__store[QUIZ_RESUME_KEY] || 'null')," +
      " primeRawStorage: (obj) => { __store[QUIZ_RESUME_KEY] = JSON.stringify(obj); } };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "quiz-session-resume.js" }).runInNewContext(sandbox);
  return sandbox.__r;
}

test("再開: 復帰の抜き取り（recoverySessionId）が保存され、再開後のセッションにも付く", () => {
  const r = resumeSandbox();
  r.setWords([W("a", "alter", "変える"), W("b", "gather", "集める"), W("c", "wisdom", "知恵", "n")]);
  r.startReview(["a", "b", "c"], {
    label: "どれくらい覚えているか確認",
    shuffle: false,
    recoverySessionId: "rp-abc123",
  });
  assert.equal(r.getSession().recoverySessionId, "rp-abc123");
  assert.equal(r.savedRaw().recoverySessionId, "rp-abc123", "スナップショットに印が入っていない");
  r.dropSession(); // 閉じて開き直した状態
  r.resumeSavedReview();
  const restored = r.getSession();
  assert.ok(restored, "再開できていない");
  assert.equal(
    restored.recoverySessionId,
    "rp-abc123",
    "再開後の回答が recordRecoveryProbeAnswer で抜き取りに数えられなくなる",
  );
});

test("再開: やさしい順（easyOrder）が保存され、再開後も進捗欄のレベル表示に使える", () => {
  const r = resumeSandbox();
  r.setWords([W("a", "alter", "変える"), W("b", "gather", "集める")]);
  r.startReview(["a", "b"], { label: "やさしい順", shuffle: false, easyOrder: true });
  assert.equal(r.savedRaw().easyOrder, true);
  r.dropSession();
  r.resumeSavedReview();
  assert.equal(r.getSession().easyOrder, true);
});

test("再開: 通常のセッションは印が空文字で、旧いスナップショット（項目なし）も空文字に戻る", () => {
  const r = resumeSandbox();
  r.setWords([W("a", "alter", "変える"), W("b", "gather", "集める")]);
  r.startReview(["a", "b"], { label: "復習" });
  assert.equal(r.getSession().recoverySessionId, "");
  assert.equal(r.savedRaw().recoverySessionId, "");
  assert.equal(r.savedRaw().easyOrder, false);

  r.dropSession();
  r.primeRawStorage({ allIds: ["a", "b"], queue: ["b"], total: 2, label: "復習", savedAt: Date.now() });
  r.resumeSavedReview();
  const restored = r.getSession();
  assert.equal(typeof restored.recoverySessionId, "string");
  assert.equal(restored.recoverySessionId, "", "旧データは通常の復習として続く");
  assert.equal(restored.easyOrder, false);
});

// ============================================================================
// 2. 範囲内の語だけで誤答が作れないときは全単語から選び直す
// ============================================================================
function distractorSandbox() {
  const pieces = [
    "const shuffle = (items) => items.slice();",
    extractFunction("normalizeMeaning"),
    extractFunction("meaningsTooClose"),
    extractFunction("spellingDistance"),
    extractFunction("normalizeTerm"),
    extractFunction("pickDistractors"),
    extractFunction("pickDistractorsWithFallback"),
    "globalThis.__d = { pickDistractors, pickDistractorsWithFallback };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "quiz-session-distractor.js" }).runInNewContext(sandbox);
  return sandbox.__d;
}

// 範囲内はすべて正解と同じ訳（同じ語の別訳・同義）＝誤答にできない
const answer = W("ans", "acquire", "取得する");
const sameMeaning = [W("s1", "obtain", "取得する"), W("s2", "get", "取得する"), W("s3", "acquire", "獲得する")];
const wide = [W("w1", "wisdom", "知恵", "n"), W("w2", "gather", "集める"), W("w3", "alter", "変える")];

test("誤答の補充: 範囲内で0件なら全単語から選び直し、4択が成立する", () => {
  const d = distractorSandbox();
  assert.equal(d.pickDistractors(sameMeaning, answer, 3).length, 0, "前提: 範囲内では作れない");
  const picked = d.pickDistractorsWithFallback(sameMeaning, [...sameMeaning, ...wide], answer, false);
  assert.equal(picked.length, 3);
  for (const word of picked) assert.ok(wide.some((w) => w.id === word.id), `範囲外の語で埋まるべき: ${word.id}`);
});

test("誤答の補充: 範囲内で1件でも作れたときは補充しない（従来の選択肢のまま）", () => {
  const d = distractorSandbox();
  const pool = [...sameMeaning, W("p1", "wisdom", "知恵", "n")];
  const picked = d.pickDistractorsWithFallback(pool, [...pool, ...wide], answer, false);
  assert.deepEqual(
    Array.from(picked, (w) => w.id), // vm の別レルム配列なので Array.from で揃える
    ["p1"],
    "範囲内で作れた誤答だけを使う（4択に満たなくても補充しない）",
  );
});

test("誤答の補充: 逆方向（日→英）は term で重複排除したまま補充する", () => {
  const d = distractorSandbox();
  const fallback = [...sameMeaning, ...wide, W("dup", "wisdom", "英知", "n")];
  const picked = d.pickDistractorsWithFallback(sameMeaning, fallback, answer, true);
  const terms = picked.map((w) => w.term);
  assert.equal(picked.length, 3);
  assert.equal(new Set(terms).size, terms.length, "同じ英単語が2つ並んではいけない");
  assert.ok(!picked.some((w) => w.term === "acquire"), "正解と同じ見出し語は誤答にしない");
});

test("誤答の補充: 範囲が全単語そのもの（補充先が同じ配列）なら二度探さない", () => {
  const d = distractorSandbox();
  let calls = 0;
  const wrapped = new Proxy(sameMeaning, {
    get(target, prop, receiver) {
      if (prop === "length") calls += 1;
      return Reflect.get(target, prop, receiver);
    },
  });
  const picked = d.pickDistractorsWithFallback(wrapped, wrapped, answer, false);
  assert.equal(picked.length, 0);
  assert.ok(calls > 0);
});

test("配線: buildReviewQuiz と buildQuiz は補充つきの選び方を通す", () => {
  const review = extractFunction("buildReviewQuiz");
  const normal = extractFunction("buildQuiz");
  assert.match(review, /pickDistractorsWithFallback\(pool, others, answer, reverse\)/);
  assert.match(normal, /pickDistractorsWithFallback\(basePool, others, answer, reverse\)/);
  assert.doesNotMatch(review, /pickDistractors\(pool, answer/, "直接呼ぶと補充が効かない");
  assert.doesNotMatch(normal, /pickDistractors\(basePool, answer/, "直接呼ぶと補充が効かない");
  // 復習側は Set で範囲判定する（allIds.includes を毎語に回さない）
  assert.match(review, /new Set\(reviewSession\.allIds\)/);
  assert.doesNotMatch(review, /allIds\.includes\(word\.id\)/);
});

test("実配線: 同じ訳だけの復習セッションでも、他の語があれば復習が終了せず4択になる", () => {
  const pieces = [
    "let quizEmptyReason = '';",
    "let contextFallbackNote = '';",
    "const elements = { quizFeedback: { textContent: '' } };",
    `const appState = { words: ${JSON.stringify([answer, ...sameMeaning, ...wide])} };`,
    `const reviewSession = ${JSON.stringify({
      allIds: [answer.id, ...sameMeaning.map((w) => w.id)],
      queue: [answer.id],
      context: false,
      mixFormat: false,
      reverse: false,
    })};`,
    "const mixedFormatUsesContext = () => false;",
    "const contextItemFor = () => null;",
    "const contextAttempted = () => true;",
    "const ensureContextItem = () => Promise.resolve(null);",
    "const prefetchNextContextItem = () => {};",
    "const buildContextChoices = () => [];",
    "const shuffle = (items) => items.slice();",
    "const choiceCountNote = () => '';",
    "const isMasteryVerificationDue = () => false;",
    extractFunction("normalizeMeaning"),
    extractFunction("meaningsTooClose"),
    extractFunction("spellingDistance"),
    extractFunction("normalizeTerm"),
    extractFunction("pickDistractors"),
    extractFunction("pickDistractorsWithFallback"),
    extractFunction("buildReviewQuiz"),
    extractFunction("quizSrsSnapshot"),
    extractFunction("effectiveSrsDueAtStart"),
    "globalThis.__quiz = buildReviewQuiz();",
    "globalThis.__reason = quizEmptyReason;",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "quiz-session-review-wiring.js" }).runInNewContext(sandbox);
  assert.ok(sandbox.__quiz, "復習が「単語が足りません」で終了してはいけない");
  assert.equal(sandbox.__reason, "");
  assert.equal(sandbox.__quiz.choices.length, 4);
  assert.equal(sandbox.__quiz.answer.id, "ans");
});

// ============================================================================
// 3. 名言バナーは省略しない
// ============================================================================
function cssBlock(selector) {
  const start = html.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`css rule ${selector} not found`);
  const end = html.indexOf("}", start);
  return html.slice(start, end);
}

test("名言バナー: 本文と名前は省略記号で切らず、全文を折り返して出す", () => {
  const text = cssBlock(".learning-quote .quote-text");
  const author = cssBlock(".learning-quote .quote-author");
  const figure = cssBlock(".learning-quote");
  assert.doesNotMatch(text, /text-overflow|white-space:\s*nowrap|overflow:\s*hidden/);
  assert.doesNotMatch(author, /text-overflow|overflow:\s*hidden|max-width/);
  assert.match(figure, /flex-wrap:\s*wrap/, "名前が横に入らないときは次の行へ送る");
  assert.match(figure, /max-width:\s*100%/, "親幅は超えない（横スクロールを出さない）");
});
