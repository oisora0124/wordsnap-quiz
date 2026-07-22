// クイズ品質の純粋関数を、公開HTML内の実コードから抽出して固定入力で検査する。
// これらは過去に「誤答が正解になる」「多品詞語を取りこぼす」等の回帰を繰り返した箇所で、
// 不変条件をここで固定して将来の変更が静かに壊さないようにする。アプリHTMLは変更しない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Script } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

// 波括弧の対応をとって関数本体を丸ごと切り出す（次の宣言に頼らないので配置変更に強い）。
function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const bodyBrace = html.indexOf("{", html.indexOf(")", start));
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

// `const NAME = ...;`（IIFEや配列/Setを含む）を、対応する括弧の末尾＋セミコロンまで切り出す。
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
      // 単一行 const（括弧の対応が閉じた直後の改行）で終端
      return html.slice(start, i);
    }
  }
  throw new Error(`could not terminate const ${name}`);
}

// 依存順に組み立てたサンドボックス。appState はテストごとに書き換える。
function buildSandbox() {
  const pieces = [
    "const appState = { words: [] };",
    "Math.random = () => 0.5;", // shuffle を決定論化
    extractConst("BUILTIN_POS_GROUPS"),
    extractConst("BUILTIN_POS"),
    extractConst("BUILTIN_POS_NOUN_AND_VERB"),
    extractConst("DERIVATIONAL_SUFFIXES"),
    extractFunction("builtinPosTag"),
    extractFunction("builtinPosTags"),
    extractFunction("posTagsFor"),
    extractFunction("derivationStem"),
    extractFunction("hasDerivationalSuffix"),
    extractFunction("contextDistractorHasBasis"),
    extractFunction("normalizeMeaning"),
    extractFunction("meaningsTooClose"),
    extractFunction("spellingDistance"),
    extractFunction("shuffle"),
    extractFunction("pickDistractors"),
    extractConst("QUIZ_TIME_LIMIT_CHOICES"),
    extractFunction("normalizeQuizTimeLimit"),
    extractConst("CEFR_ORDER"),
    extractFunction("cefrRankOfLevel"),
    // 個人適応SRSの純関数群。スカラー定数は括弧を含まず extractConst が使えないため、
    // HTMLから正規表現で値を取り出して同じ値を注入する（乖離したらここで気づける）。
    `const SRS_DAY_MS = ${html.match(/const SRS_DAY_MS = ([^;]+);/)[1]};`,
    `const ADAPTIVE_MIN_MULTIPLIER = ${html.match(/const ADAPTIVE_MIN_MULTIPLIER = ([0-9.]+);/)[1]};`,
    `const ADAPTIVE_MAX_MULTIPLIER = ${html.match(/const ADAPTIVE_MAX_MULTIPLIER = ([0-9.]+);/)[1]};`,
    extractConst("SRS_INTERVAL_DAYS"),
    extractFunction("wordAccuracyFactor"),
    extractFunction("personalAccuracyFactor"),
    extractFunction("adaptiveSrsMultiplier"),
    extractFunction("srsIntervalMs"),
    "globalThis.__q = { appStateRef: () => appState, setWords: (w) => { appState.words = w; }," +
      " builtinPosTags, posTagsFor, contextDistractorHasBasis, meaningsTooClose, pickDistractors, normalizeMeaning, spellingDistance," +
      " normalizeQuizTimeLimit, cefrRankOfLevel," +
      " wordAccuracyFactor, personalAccuracyFactor, adaptiveSrsMultiplier, srsIntervalMs, SRS_INTERVAL_DAYS, SRS_DAY_MS };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "quiz-quality-check.js" }).runInNewContext(sandbox);
  return sandbox.__q;
}

const q = buildSandbox();
const W = (term, meaning, tag) => ({ id: term, term, meaning, pos: { tag } });

test("built-in noun/verb words expose both parts of speech", () => {
  // 代表品詞1つで判定すると多品詞語(attempt/impact/decline)を誤って除外根拠にしてしまう回帰の固定。
  assert.deepEqual([...q.builtinPosTags("attempt")].sort(), ["n", "v"]);
  assert.deepEqual([...q.builtinPosTags("impact")].sort(), ["n", "v"]);
  assert.deepEqual([...q.builtinPosTags("accurate")], ["adj"]);
  assert.deepEqual([...q.builtinPosTags("zzznotaword")], []);
});

test("posTagsFor unions the built-in table with saved tags", () => {
  q.setWords([]);
  // 表に無い語でも、保存済みの複数タグがあれば両方返す（Datamuseが返す全品詞を捨てない）。
  const word = { term: "custom", pos: { tag: "v", tags: ["v", "n"] } };
  assert.deepEqual([...q.posTagsFor("custom", word)].sort(), ["n", "v"]);
});

test("a distractor has basis only when parts of speech do not overlap", () => {
  q.setWords([]);
  // 品詞が1つでも重なれば空所に入り得るので根拠にならない（=false）。
  assert.equal(q.contextDistractorHasBasis(W("decline"), "impact"), false); // 両方 n,v
  assert.equal(q.contextDistractorHasBasis(W("decline"), "accurate"), true); // v,n vs adj
  assert.equal(q.contextDistractorHasBasis(W("accurate"), "impact"), true); // adj vs n,v
  assert.equal(q.contextDistractorHasBasis(W("observe"), "structure"), false); // v vs n,v (重なる)
  assert.equal(q.contextDistractorHasBasis(W("observe"), "poverty"), true); // v vs n
  assert.equal(q.contextDistractorHasBasis(W("observe"), "zzznotaword"), false); // 品詞不明は根拠にしない
});

test("derived forms of the answer are a valid basis regardless of the built-in table", () => {
  q.setWords([]);
  // 出題語の名詞化などは品詞が違うので空所に入らない＝根拠あり。
  assert.equal(q.contextDistractorHasBasis(W("decide", "決める", "v"), "decision"), true);
});

test("meaningsTooClose rejects containment, not merely equality", () => {
  assert.equal(q.meaningsTooClose("変える", "部分的に変える"), true);
  assert.equal(q.meaningsTooClose("重要な", "極めて重要な"), true);
  assert.equal(q.meaningsTooClose("分配する", "減少する"), false);
  assert.equal(q.meaningsTooClose("な", "危険な"), false); // 短すぎる語で過剰除外しない
});

test("pickDistractors keeps at most one spelling-confusable choice", () => {
  const answer = W("affect", "影響を与える", "v");
  const pool = [
    W("afflict", "苦しめる", "v"), W("affix", "貼り付ける", "v"), W("effect", "効果", "n"),
    W("gather", "集める", "v"), W("wisdom", "知恵", "n"), W("urban", "都会の", "adj"),
  ];
  // 綴りが近い(距離1-2)語は最大1つまで。300回試行しても超えない。
  let worst = 0;
  for (let i = 0; i < 300; i += 1) {
    const picked = q.pickDistractors(pool, answer, 3);
    const confusable = picked.filter((w) => { const d = q.spellingDistance(answer.term, w.term); return d > 0 && d <= 2; }).length;
    if (confusable > worst) worst = confusable;
  }
  assert.ok(worst <= 1, `confusable distractors must stay <= 1, saw ${worst}`);
});

test("pickDistractors never repeats the answer meaning and stays within count", () => {
  const answer = W("large", "大きい", "adj");
  const pool = [
    W("big", "大きい", "adj"), // 意味重複 → 除外されるべき
    W("small", "小さい", "adj"), W("fast", "速い", "adj"), W("slow", "遅い", "adj"),
  ];
  const picked = q.pickDistractors(pool, answer, 3);
  assert.ok(picked.length <= 3);
  assert.ok(!picked.some((w) => q.normalizeMeaning(w.meaning) === q.normalizeMeaning(answer.meaning)),
    "a distractor must not share the answer meaning");
});

test("cloze mode prefers distractors of a different part of speech", () => {
  const answer = W("accurate", "正確な", "adj");
  const pool = [
    W("vague", "曖昧な", "adj"), W("rigid", "硬直した", "adj"),
    W("infer", "推論する", "v"), W("factor", "要因", "n"), W("gather", "集める", "v"),
  ];
  // preferDifferentPos=true では同品詞(adj)を避け、別品詞を優先する。
  let sameAdj = 0;
  for (let i = 0; i < 200; i += 1) {
    const picked = q.pickDistractors(pool, answer, 3, [], { preferDifferentPos: true });
    sameAdj += picked.filter((w) => w.pos.tag === "adj").length;
  }
  assert.equal(sameAdj, 0, "cloze distractors should avoid the answer's part of speech when alternatives exist");
});

test("quiz time-limit setting is clamped to the allowed choices (invalid -> off)", () => {
  // 許容値はそのまま、範囲外・不正値・null は 0（オフ）に丸める。
  for (const ok of [0, 5, 10, 15, 20, 30]) {
    assert.equal(q.normalizeQuizTimeLimit(ok), ok);
    assert.equal(q.normalizeQuizTimeLimit(String(ok)), ok, "string form is accepted");
  }
  for (const bad of [7, 3, 999, -5, NaN, null, undefined, "abc", ""]) {
    assert.equal(q.normalizeQuizTimeLimit(bad), 0, `invalid ${String(bad)} should fall back to 0`);
  }
});

test("adaptive SRS: word accuracy factor is a bounded step function (neutral under 3 tries)", () => {
  const hist = (correct, wrong) =>
    [...Array(correct).fill({ at: "2026-07-01T00:00:00Z", correct: true }),
     ...Array(wrong).fill({ at: "2026-07-01T00:00:00Z", correct: false })];
  assert.equal(q.wordAccuracyFactor([]), 1.0);
  assert.equal(q.wordAccuracyFactor(hist(2, 0)), 1.0, "under 3 tries stays neutral");
  assert.equal(q.wordAccuracyFactor(hist(10, 0)), 1.2);
  assert.equal(q.wordAccuracyFactor(hist(8, 2)), 1.1);
  assert.equal(q.wordAccuracyFactor(hist(6, 4)), 1.0);
  assert.equal(q.wordAccuracyFactor(hist(4, 6)), 0.85);
  assert.equal(q.wordAccuracyFactor(hist(1, 9)), 0.7);
});

test("adaptive SRS: personal factor uses only the most recent 100 answers", () => {
  const at = (daysAgo) => new Date(Date.parse("2026-07-22T00:00:00Z") - daysAgo * 86400000).toISOString();
  const word = (entries) => ({ history: entries });
  // 20件未満は中立
  assert.equal(q.personalAccuracyFactor([word([{ at: at(1), correct: false }])]), 1.0);
  // 直近100件が全問不正解・それ以前の100件が全問正解 → 直近だけ見るので 0.8
  const recentWrong = Array.from({ length: 100 }, (_, i) => ({ at: at(i / 24), correct: false }));
  const oldCorrect = Array.from({ length: 100 }, (_, i) => ({ at: at(30 + i / 24), correct: true }));
  assert.equal(q.personalAccuracyFactor([word(recentWrong), word(oldCorrect)]), 0.8);
  // 全問正解なら 1.1
  const allCorrect = Array.from({ length: 50 }, (_, i) => ({ at: at(i / 24), correct: true }));
  assert.equal(q.personalAccuracyFactor([word(allCorrect)]), 1.1);
});

test("adaptive SRS: combined multiplier is clamped to [0.5, 1.6]", () => {
  assert.equal(q.adaptiveSrsMultiplier({ wordFactor: 0.01, personalFactor: 1, fastCorrect: false }), 0.5);
  assert.equal(q.adaptiveSrsMultiplier({ wordFactor: 99, personalFactor: 1, fastCorrect: true }), 1.6);
  assert.equal(q.adaptiveSrsMultiplier({ wordFactor: 1, personalFactor: 1, fastCorrect: false }), 1.0);
  // 代表的な組み合わせ: 1.2 * 1.1 * 1.1 = 1.452（丸めなし領域）
  const v = q.adaptiveSrsMultiplier({ wordFactor: 1.2, personalFactor: 1.1, fastCorrect: true });
  assert.ok(Math.abs(v - 1.452) < 1e-9);
  // 不正な係数（0・負・無限大・NaN・未指定）は中立(1)として扱う
  for (const bad of [0, -1, Infinity, NaN, undefined, null, "x"]) {
    assert.equal(q.adaptiveSrsMultiplier({ wordFactor: bad, personalFactor: bad, fastCorrect: false }), 1.0,
      `invalid factor ${String(bad)} must fall back to neutral`);
  }
});

test("adaptive SRS: multiplier=1 keeps legacy intervals exactly; scaling shifts them", () => {
  // Math.random は 0.5 に固定済み → jitter = 1.0 で決定論比較できる
  for (let stage = 0; stage < q.SRS_INTERVAL_DAYS.length; stage += 1) {
    const days = q.SRS_INTERVAL_DAYS[stage];
    assert.equal(q.srsIntervalMs(stage, 1), days * q.SRS_DAY_MS, `stage ${stage} must equal legacy`);
    assert.equal(q.srsIntervalMs(stage), days * q.SRS_DAY_MS, "default arg must equal legacy");
  }
  // 7日×0.5=3.5日 / 7日×1.6=11.2日
  assert.equal(q.srsIntervalMs(3, 0.5), Math.round(3.5 * q.SRS_DAY_MS));
  assert.equal(q.srsIntervalMs(3, 1.6), Math.round(11.2 * q.SRS_DAY_MS));
  // 不正値は1として扱う
  assert.equal(q.srsIntervalMs(3, NaN), 7 * q.SRS_DAY_MS);
  assert.equal(q.srsIntervalMs(3, 0), 7 * q.SRS_DAY_MS);
});

// 学習スケジューラ本体（scheduleReview〜applyLearningResult）を、切替可能な
// 個人適応フラグ付きで丸ごと実行するサンドボックス。係数は固定スタブにして
// 「倍率の通り道」だけを検証する（係数関数自体の検証は上の純関数テストが担う）。
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
    "let __adaptive = false;",
    "const adaptiveSrsEnabled = () => __adaptive;",
    "const wordAccuracyFactor = () => 1.2;",
    "const personalAccuracyFactorCached = () => 1.1;",
    "const adaptiveSrsMultiplier = ({ wordFactor, personalFactor, fastCorrect }) =>" +
      " Math.min(1.6, Math.max(0.5, wordFactor * personalFactor * (fastCorrect ? 1.1 : 1)));",
    "const appState = { quizCounter: 10 };",
    "Math.random = () => 0.5;",
    html.slice(start, end),
    "globalThis.__l = { applyLearningResult, setAdaptive: (v) => { __adaptive = v; } };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "adaptive-learning-check.js" }).runInNewContext(sandbox);
  return sandbox.__l;
}

test("adaptive SRS ON/OFF: only nextReviewAt scales; status/stage/streak are identical", () => {
  const L = buildLearningSandbox();
  const NOW = 1_700_000_000_000;
  const freshLearning = (over = {}) => ({
    status: "new", firstAttempted: false, reviewAt: 0, blockedUntil: 0,
    correctStreak: 0, srsStage: 0, nextReviewAt: 0, srsUpdatedAt: 0, lastSrsResult: "", ...over,
  });
  // シナリオ: [説明, learning初期値, isCorrect, srsDueAtStart, options, 前進(倍率が効く)か]
  const scenarios = [
    ["未開始の速い正解", freshLearning(), true, false, { responseMs: 1000 }, true],
    ["期限到来の速い正解", freshLearning({ srsStage: 2, nextReviewAt: NOW - 1000, status: "review" }), true, true, { responseMs: 1000 }, true],
    ["期限前の正解(前進なし)", freshLearning({ srsStage: 2, nextReviewAt: NOW + 9e9, status: "review", correctStreak: 1 }), true, false, { responseMs: 1000 }, false],
    ["遅い正解(固定1日)", freshLearning({ srsStage: 2, nextReviewAt: NOW - 1000, status: "review" }), true, true, { responseMs: 9000 }, false],
    ["誤答(固定1日・2段階降格)", freshLearning({ srsStage: 5, nextReviewAt: NOW - 1000, status: "review" }), false, true, { responseMs: 1000 }, false],
    ["習得済みの前進", freshLearning({ status: "mastered", srsStage: 3, nextReviewAt: NOW - 1000, correctStreak: 2 }), true, true, { responseMs: 1000 }, true],
  ];
  const MULT = 1.2 * 1.1 * 1.1; // スタブ係数×速い正解
  for (const [label, base, isCorrect, dueAtStart, options, advances] of scenarios) {
    const run = (adaptive) => {
      L.setAdaptive(adaptive);
      const word = { learning: structuredClone(base), history: [] };
      L.applyLearningResult(word, isCorrect, dueAtStart, NOW, { ...options });
      return word.learning;
    };
    const off = run(false);
    const on = run(true);
    // 保護フィールド: 倍率が何であれ一致しなければならない
    for (const key of ["status", "srsStage", "correctStreak", "reviewAt", "firstAttempted", "lastSrsResult", "blockedUntil"]) {
      assert.deepEqual(on[key], off[key], `${label}: ${key} must not differ by adaptive mode`);
    }
    if (advances) {
      // 前進シナリオだけ、期日がちょうど倍率分だけ伸びる（jitterは0.5固定=1.0）
      const offDelta = off.nextReviewAt - NOW;
      const onDelta = on.nextReviewAt - NOW;
      assert.ok(offDelta > 0, `${label}: legacy must schedule a future review`);
      assert.equal(onDelta, Math.round(offDelta * MULT), `${label}: adaptive must scale interval by the multiplier`);
    } else {
      assert.equal(on.nextReviewAt, off.nextReviewAt, `${label}: non-advance paths must not scale`);
    }
  }
});

test("built-in sample word sets are well-formed (format, no dups, expected size)", () => {
  // サンプルは教材品質の対象。行形式「英単語 訳」・セット内重複なし・語数を固定して回帰を防ぐ。
  const extractTemplate = (name) => {
    const start = html.indexOf(`const ${name} = \``);
    if (start < 0) throw new Error(`${name} not found`);
    const open = html.indexOf("`", start);
    const close = html.indexOf("`;", open + 1);
    return html.slice(open + 1, close);
  };
  const sets = {
    SAMPLE_TEXT: 300,
    SAMPLE_TEXT_JHS: 300,
    SAMPLE_TEXT_EIKEN: 300,
    SAMPLE_TEXT_SOUKEI: 300,
    SAMPLE_TEXT_TOEIC: 300,
    SAMPLE_TEXT_IELTS: 300,
  };
  for (const [name, expected] of Object.entries(sets)) {
    const lines = extractTemplate(name).split("\n").filter(Boolean);
    assert.equal(lines.length, expected, `${name} should have ${expected} lines, got ${lines.length}`);
    const seen = new Set();
    for (const line of lines) {
      const m = line.match(/^([a-z]+) (\S.*)$/);
      assert.ok(m, `${name}: malformed line "${line}"`);
      assert.ok(!seen.has(m[1]), `${name}: duplicate word "${m[1]}"`);
      seen.add(m[1]);
    }
  }
});

test("CEFR easy-first order ranks A1<A2<...<C2, unknown/invalid last", () => {
  // A1→C2 が昇順、未判定・不明・null はすべて最後（=6）に回る。
  assert.equal(q.cefrRankOfLevel("A1"), 0);
  assert.equal(q.cefrRankOfLevel("A2"), 1);
  assert.equal(q.cefrRankOfLevel("C2"), 5);
  assert.ok(q.cefrRankOfLevel("A1") < q.cefrRankOfLevel("B1"));
  assert.ok(q.cefrRankOfLevel("B2") < q.cefrRankOfLevel("C1"));
  for (const unknown of [null, undefined, "", "Z9", "a1"]) {
    assert.equal(q.cefrRankOfLevel(unknown), 6, `${String(unknown)} should sort last`);
  }
  // 実際に並べ替えると A1..C2..未判定 の順になる。
  const levels = ["C1", null, "A1", "B1", "A2", "C2", "B2"];
  const sorted = levels.slice().sort((a, b) => q.cefrRankOfLevel(a) - q.cefrRankOfLevel(b));
  assert.deepEqual(sorted, ["A1", "A2", "B1", "B2", "C1", "C2", null]);
});
