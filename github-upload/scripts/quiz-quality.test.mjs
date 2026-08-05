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
    extractConst("BUILTIN_POS_MULTI_GROUPS"),
    extractConst("BUILTIN_POS_MULTI"),
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
    extractFunction("normalizeSpeechRate"),
    extractFunction("normalizeSpeechVoiceUri"),
    extractFunction("buildFlashcardOrder"),
    extractFunction("sliceWordsByQuizRange"),
    extractFunction("isMasteryVerificationDue"),
    extractFunction("flashcardEligibleIds"),
    extractConst("CEFR_ORDER"),
    extractFunction("cefrRankOfLevel"),
    extractConst("DAILY_GOAL_CHOICES"),
    extractFunction("normalizeDailyGoal"),
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
    // 取り込み経路。サンプル単語集が実際に1行=1候補として読めることを確かめるために使う。
    extractFunction("normalizeTerm"),
    `const JP_CHAR = ${html.match(/const JP_CHAR = (\/.+\/);/)[1]};`,
    `const POS_HEAD = ${html.match(/const POS_HEAD = (\/.+\/);/)[1]};`,
    `const IPA_CHARS = ${html.match(/const IPA_CHARS = (\/.+\/);/)[1]};`,
    `const SENTENCE_END_CHARS = ${html.match(/const SENTENCE_END_CHARS = (\/.+\/);/)[1]};`,
    extractFunction("stripNoise"),
    extractFunction("cleanTermText"),
    extractFunction("firstMeaning"),
    extractFunction("looksLikeHeadword"),
    extractFunction("validPair"),
    extractFunction("parseVocabulary"),
    "globalThis.__q = { appStateRef: () => appState, setWords: (w) => { appState.words = w; }," +
      " builtinPosTag, builtinPosTags, posTagsFor, contextDistractorHasBasis, meaningsTooClose, pickDistractors, normalizeMeaning, spellingDistance," +
      " normalizeQuizTimeLimit, cefrRankOfLevel, normalizeDailyGoal," +
      " normalizeSpeechRate, normalizeSpeechVoiceUri, buildFlashcardOrder," +
      " sliceWordsByQuizRange, isMasteryVerificationDue, flashcardEligibleIds," +
      " wordAccuracyFactor, personalAccuracyFactor, adaptiveSrsMultiplier, srsIntervalMs, SRS_INTERVAL_DAYS, SRS_DAY_MS," +
      " parseVocabulary, validPair, firstMeaning };",
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
  // 内蔵表に載っていないことが要点なので、実在しない綴りを使う（実在語だと
  // 品詞表が育ったときに前提が崩れる）。
  const term = "zzzcustomword";
  // deepEqual はサンドボックス側の配列とプロトタイプが違って落ちるので、要素数で見る。
  assert.equal([...q.builtinPosTags(term)].length, 0, "前提: この語は内蔵表に無い");
  const word = { term, pos: { tag: "v", tags: ["v", "n"] } };
  assert.deepEqual([...q.posTagsFor(term, word)].sort(), ["n", "v"]);
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

test("speech settings normalize valid values and fall back safely", () => {
  for (const ok of [0.5, 0.75, 1, 1.25, 1.5, "1.05"]) {
    assert.equal(q.normalizeSpeechRate(ok), Number(ok));
  }
  for (const bad of [0.49, 1.51, -1, Infinity, NaN, null, undefined, "", "fast"]) {
    assert.equal(q.normalizeSpeechRate(bad), 1, `invalid rate ${String(bad)} should use 1.0`);
  }
  assert.equal(q.normalizeSpeechVoiceUri("  com.example.voice  "), "com.example.voice");
  for (const bad of [null, undefined, 12, "", "  ", "bad\u0000voice", "x".repeat(513)]) {
    assert.equal(q.normalizeSpeechVoiceUri(bad), "", "invalid voice URI should use the default voice");
  }
});

test("flashcard order preserves source order or performs a deterministic shuffle", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual([...q.buildFlashcardOrder(ids, false)], ids);
  assert.deepEqual([...q.buildFlashcardOrder(["a", "a", "", "b", null], false)], ["a", "b"]);
  // random=0 のFisher-Yates: dを先頭へ移し、以後の先頭交換で [b,c,d,a] になる。
  assert.deepEqual([...q.buildFlashcardOrder(ids, true, () => 0)], ["b", "c", "d", "a"]);
  assert.deepEqual(ids, ["a", "b", "c", "d"], "the input array must not be mutated");
});

test("flashcard range count uses the same open range as the actual session", () => {
  const words = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  assert.deepEqual([...q.sliceWordsByQuizRange(words, false, "2", "3")], words,
    "a closed range means the whole selected deck");
  assert.deepEqual([...q.sliceWordsByQuizRange(words, true, "", "")], words,
    "blank open bounds mean the whole selected deck");
  assert.deepEqual([...q.sliceWordsByQuizRange(words, true, "2", "3")], [words[1], words[2]]);
  for (const [from, to] of [["0", "2"], ["3", "2"], ["1", "5"], ["x", "2"]]) {
    assert.deepEqual([...q.sliceWordsByQuizRange(words, true, from, to)], [],
      `invalid range ${from}-${to} must not advertise startable cards`);
  }
  assert.deepEqual([...q.sliceWordsByQuizRange([words[0]], true, "1", "1")], [words[0]],
    "a one-word flashcard range remains valid");
});

test("deleting pending flashcards removes them from progress and replay without erasing answered cards", () => {
  const pieces = [
    "let flashcardSession = {" +
      " order: ['a', 'b', 'c'], allIds: ['a', 'b', 'c'], index: 1," +
      " knownIds: ['a'], unknownIds: [] };",
    extractFunction("dropWordFromFlashcardSession"),
    "dropWordFromFlashcardSession('a');",
    "const afterAnswered = JSON.parse(JSON.stringify(flashcardSession));",
    "dropWordFromFlashcardSession('b');",
    "const afterCurrent = JSON.parse(JSON.stringify(flashcardSession));",
    "dropWordFromFlashcardSession('c');",
    "globalThis.__state = { afterAnswered, afterCurrent, final: flashcardSession };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "flashcard-delete-check.js" }).runInNewContext(sandbox);
  assert.deepEqual([...sandbox.__state.afterAnswered.order], ["a", "b", "c"]);
  assert.deepEqual([...sandbox.__state.afterCurrent.order], ["a", "c"]);
  assert.deepEqual([...sandbox.__state.afterCurrent.allIds], ["a", "c"]);
  assert.deepEqual([...sandbox.__state.final.order], ["a"]);
  assert.deepEqual([...sandbox.__state.final.allIds], ["a"]);
});

test("due provisional mastery is excluded from flashcards but remains eligible before its due time", () => {
  const NOW = 1_700_000_000_000;
  const due = {
    id: "due",
    learning: {
      status: "mastered",
      masteryVerify: "flashcard",
      nextReviewAt: NOW - 1,
    },
  };
  const future = {
    id: "future",
    learning: {
      status: "mastered",
      masteryVerify: "flashcard",
      nextReviewAt: NOW + 1,
    },
  };
  const ordinary = {
    id: "ordinary",
    learning: { status: "mastered", nextReviewAt: NOW - 1 },
  };
  assert.equal(q.isMasteryVerificationDue(due, NOW), true);
  assert.equal(q.isMasteryVerificationDue(future, NOW), false);
  assert.equal(q.isMasteryVerificationDue(ordinary, NOW), false);
  assert.deepEqual(
    [...q.flashcardEligibleIds(["due", "future", "ordinary"], [due, future, ordinary], NOW)],
    ["future", "ordinary"],
  );
});

test("due provisional mastery bypasses context formats in the actual review quiz builder", () => {
  const build = (session) => {
    const answer = {
      id: "answer",
      term: "answer",
      meaning: "答え",
      learning: {
        status: "mastered",
        masteryVerify: "flashcard",
        nextReviewAt: 1,
      },
    };
    const distractors = [
      { id: "d1", term: "one", meaning: "一" },
      { id: "d2", term: "two", meaning: "二" },
      { id: "d3", term: "three", meaning: "三" },
    ];
    const pieces = [
      `const appState = { words: ${JSON.stringify([answer, ...distractors])} };`,
      `const reviewSession = ${JSON.stringify({
        allIds: [answer.id, ...distractors.map((word) => word.id)],
        queue: [answer.id],
        ...session,
      })};`,
      "const elements = { quizFeedback: { textContent: '' } };",
      "let contextBasisFallbackNote = '';",
      "const mixedFormatUsesContext = () => { throw new Error('due verification must short-circuit mixed context'); };",
      "const contextItemFor = () => { throw new Error('due verification must not load a context item'); };",
      "const contextAttempted = () => false;",
      "const ensureContextItem = () => Promise.resolve(null);",
      "const prefetchNextContextItem = () => {};",
      "const buildContextChoices = () => [];",
      "const pickDistractors = (pool) => pool.slice(0, 3);",
      "const shuffle = (items) => items;",
      "const choiceCountNote = () => '';",
      extractFunction("isMasteryVerificationDue"),
      extractFunction("buildReviewQuiz"),
      "globalThis.__quiz = buildReviewQuiz();",
    ];
    const sandbox = {};
    new Script(pieces.join("\n\n"), { filename: "mastery-review-format-check.js" })
      .runInNewContext(sandbox);
    return sandbox.__quiz;
  };

  const allContext = build({ context: true, mixFormat: false });
  assert.equal(allContext.context, null);
  assert.equal(allContext.choices.length, 4);

  const mixedContext = build({ context: false, mixFormat: true });
  assert.equal(mixedContext.context, null);
  assert.equal(mixedContext.choices.length, 4);

  const easyOrder = build({ context: false, mixFormat: false, easyOrder: true, label: "やさしい順" });
  assert.equal(easyOrder.context, null);
  assert.equal(easyOrder.choices.length, 4,
    "the shared easy-order review builder must still force a meaning choice when verification is due");

  const rangeQuiz = build({ context: false, mixFormat: false, label: "単語帳・1〜4番" });
  assert.equal(rangeQuiz.context, null);
  assert.equal(rangeQuiz.choices.length, 4,
    "the range-review path must still force a meaning choice when verification is due");
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

function buildLearningPersistenceSandbox() {
  const pieces = [
    "const SRS_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60, 120];",
    "const SRS_DAY_MS = 24 * 60 * 60 * 1000;",
    "const SRS_MAX_FUTURE_DAYS = 400;",
    extractFunction("nonNegativeNumber"),
    extractFunction("nonNegativeInteger"),
    extractFunction("repairFarFutureReviewAt"),
    extractFunction("normalizeLearning"),
    extractFunction("minPositiveNumber"),
    extractFunction("mergeLearningState"),
    "globalThis.__p = { normalizeLearning, mergeLearningState, repairFarFutureReviewAt };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "learning-persistence-check.js" }).runInNewContext(sandbox);
  return sandbox.__p;
}

test("provisional mastery survives normalize/save/reload while legacy learning stays field-free", () => {
  const P = buildLearningPersistenceSandbox();
  const raw = {
    learning: {
      status: "mastered",
      masteryVerify: "flashcard",
      firstAttempted: true,
      correctStreak: 2,
      srsStage: 2,
      nextReviewAt: 1_700_086_400_000,
      srsUpdatedAt: 1_700_000_000_000,
      lastSrsResult: "correct",
    },
  };
  const first = P.normalizeLearning(raw);
  const reloaded = P.normalizeLearning({ learning: JSON.parse(JSON.stringify(first)) });
  assert.equal(reloaded.masteryVerify, "flashcard",
    "the optional marker must survive the old-data read/save/reload path");

  const legacy = P.normalizeLearning({
    learning: { ...raw.learning, masteryVerify: undefined },
  });
  assert.equal(Object.hasOwn(legacy, "masteryVerify"), false,
    "learning without the marker must keep the existing field-free shape");
  const invalid = P.normalizeLearning({
    learning: { ...raw.learning, masteryVerify: "unknown" },
  });
  assert.equal(Object.hasOwn(invalid, "masteryVerify"), false,
    "unknown marker values must not enter saved learning state");
});

test("learning merge preserves the marker and does not re-propagate it over a newer verified state", () => {
  const P = buildLearningPersistenceSandbox();
  const now = Date.now();
  const marked = {
    status: "mastered",
    masteryVerify: "flashcard",
    firstAttempted: true,
    correctStreak: 2,
    srsStage: 2,
    nextReviewAt: now + 86_400_000,
    srsUpdatedAt: now - 2_000,
    lastSrsResult: "correct",
  };
  const sameUpdate = P.mergeLearningState(marked, { ...marked });
  assert.equal(sameUpdate.masteryVerify, "flashcard",
    "normal synchronization must not drop a pending verification");

  const verifiedNewer = {
    ...marked,
    srsUpdatedAt: now - 1_000,
  };
  delete verifiedNewer.masteryVerify;
  const verifiedMerge = P.mergeLearningState(marked, verifiedNewer);
  assert.equal(Object.hasOwn(verifiedMerge, "masteryVerify"), false,
    "an older pending marker must not spread back over a newer verified answer");

  const ordinaryA = { ...marked };
  const ordinaryB = { ...marked };
  delete ordinaryA.masteryVerify;
  delete ordinaryB.masteryVerify;
  const ordinaryMerge = P.mergeLearningState(ordinaryA, ordinaryB);
  assert.equal(Object.hasOwn(ordinaryMerge, "masteryVerify"), false,
    "two ordinary mastered states must not acquire a marker during merge");
});

test("flashcard promotion is provisional and its next due meaning-choice verifies or demotes it", () => {
  const L = buildLearningSandbox();
  const NOW = 1_700_000_000_000;
  const learning = (over = {}) => ({
    status: "new",
    firstAttempted: false,
    reviewAt: 0,
    blockedUntil: 0,
    correctStreak: 0,
    srsStage: 0,
    nextReviewAt: 0,
    srsUpdatedAt: 0,
    lastSrsResult: "",
    ...over,
  });

  const promoted = { learning: learning(), history: [] };
  L.applyLearningResult(promoted, true, false, NOW, {
    responseMs: 1000,
    skipSpeedGate: true,
    promptMode: "flashcard",
  });
  const firstDueAt = promoted.learning.nextReviewAt;
  assert.equal(promoted.learning.status, "review");
  assert.equal(promoted.learning.correctStreak, 1);
  assert.equal(firstDueAt, NOW + 86_400_000);

  L.applyLearningResult(promoted, true, false, NOW + 1000, {
    responseMs: 1000,
    skipSpeedGate: true,
    promptMode: "flashcard",
  });
  assert.equal(promoted.learning.status, "mastered");
  assert.equal(promoted.learning.masteryVerify, "flashcard",
    "the second consecutive flashcard self-report must mark mastery as provisional");
  assert.equal(promoted.learning.nextReviewAt, firstDueAt,
    "promotion before the SRS due time must keep the existing next review date");

  const verified = {
    learning: structuredClone(promoted.learning),
    history: [],
  };
  verified.learning.nextReviewAt = NOW - 1;
  L.applyLearningResult(verified, true, true, NOW + 1000, {
    responseMs: 1000,
    promptMode: "meaning-choice",
  });
  assert.equal(verified.learning.status, "mastered");
  assert.equal(Object.hasOwn(verified.learning, "masteryVerify"), false,
    "a correct due meaning-choice must confirm full mastery");

  const demoted = {
    learning: { ...structuredClone(promoted.learning), srsStage: 5, nextReviewAt: NOW - 1 },
    history: [],
  };
  L.applyLearningResult(demoted, false, true, NOW + 2000, {
    responseMs: 1000,
    promptMode: "meaning-choice",
  });
  assert.equal(demoted.learning.status, "review");
  assert.equal(demoted.learning.srsStage, 3);
  assert.equal(demoted.learning.nextReviewAt, NOW + 2000 + 86_400_000);
  assert.equal(demoted.learning.correctStreak, 0);
  assert.equal(Object.hasOwn(demoted.learning, "masteryVerify"), false,
    "a wrong verification must clear provisional mastery while using the existing wrong path");
});

test("ordinary meaning-choice mastery keeps the legacy path and never gains a marker", () => {
  const L = buildLearningSandbox();
  const NOW = 1_700_000_000_000;
  const word = {
    learning: {
      status: "review",
      firstAttempted: true,
      reviewAt: 0,
      blockedUntil: 0,
      correctStreak: 1,
      srsStage: 1,
      nextReviewAt: NOW - 1,
      srsUpdatedAt: NOW - 10,
      lastSrsResult: "correct",
    },
    history: [],
  };
  L.applyLearningResult(word, true, true, NOW, {
    responseMs: 1000,
    promptMode: "meaning-choice",
  });
  assert.equal(word.learning.status, "mastered");
  assert.equal(word.learning.correctStreak, 2);
  assert.equal(Object.hasOwn(word.learning, "masteryVerify"), false);
});

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
    ["仮習得の検証正解", freshLearning({ status: "mastered", masteryVerify: "flashcard", srsStage: 3, nextReviewAt: NOW - 1000, correctStreak: 2 }), true, true, { responseMs: 1000, promptMode: "meaning-choice" }, true],
    ["仮習得の検証誤答", freshLearning({ status: "mastered", masteryVerify: "flashcard", srsStage: 5, nextReviewAt: NOW - 1000, correctStreak: 2 }), false, true, { responseMs: 1000, promptMode: "meaning-choice" }, false],
  ];
  const MULT = 1.2 * 1.1 * 1.1; // スタブ係数×速い正解
  for (const [label, base, isCorrect, dueAtStart, options, advances] of scenarios) {
    const run = (adaptive) => {
      L.setAdaptive(adaptive);
      const word = { learning: structuredClone(base), history: [] };
      const res = L.applyLearningResult(word, isCorrect, dueAtStart, NOW, { ...options });
      return { learning: word.learning, res };
    };
    const offRun = run(false);
    const onRun = run(true);
    const off = offRun.learning;
    const on = onRun.learning;
    // 戻り値の advanced フラグは前進シナリオと一致し、ON/OFFで変わらない
    assert.equal(offRun.res.advanced, advances, `${label}: advanced flag (OFF)`);
    assert.equal(onRun.res.advanced, advances, `${label}: advanced flag (ON)`);
    // 保護フィールド: 倍率が何であれ一致しなければならない
    for (const key of ["status", "masteryVerify", "srsStage", "correctStreak", "reviewAt", "firstAttempted", "lastSrsResult", "blockedUntil"]) {
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
    SAMPLE_TEXT: 1500,
    SAMPLE_TEXT_JHS: 1500,
    SAMPLE_TEXT_EIKEN: 1500,
    SAMPLE_TEXT_SOUKEI: 1500,
    SAMPLE_TEXT_TOEIC: 1500,
    SAMPLE_TEXT_IELTS: 1500,
  };
  for (const [name, expected] of Object.entries(sets)) {
    const lines = extractTemplate(name).split("\n").filter(Boolean);
    assert.equal(lines.length, expected, `${name} should have ${expected} lines, got ${lines.length}`);
    const seen = new Set();
    const seenMeaning = new Set();
    for (const line of lines) {
      const m = line.match(/^([a-z]+) (\S.*)$/);
      assert.ok(m, `${name}: malformed line "${line}"`);
      assert.ok(!seen.has(m[1]), `${name}: duplicate word "${m[1]}"`);
      seen.add(m[1]);
      // 同じ集に同じ訳が2つあると四択で正解が2つになり、問題として成立しない。
      assert.ok(!seenMeaning.has(m[2]), `${name}: duplicate meaning "${m[2]}"`);
      seenMeaning.add(m[2]);
    }
  }
});

test("built-in sample rows survive the real parseVocabulary path", () => {
  // 語数だけ数えても「読み取れない行」は見つからない。実際の取り込み経路に通して、
  // 1500行がそのまま1500件の候補になることを確かめる。
  const extractTemplate = (name) => {
    const start = html.indexOf(`const ${name} = \``);
    const open = html.indexOf("`", start);
    const close = html.indexOf("`;", open + 1);
    return html.slice(open + 1, close);
  };
  for (const name of [
    "SAMPLE_TEXT",
    "SAMPLE_TEXT_JHS",
    "SAMPLE_TEXT_EIKEN",
    "SAMPLE_TEXT_SOUKEI",
    "SAMPLE_TEXT_TOEIC",
    "SAMPLE_TEXT_IELTS",
  ]) {
    const text = extractTemplate(name);
    const result = q.parseVocabulary(text, null);
    assert.equal(
      result.candidates.length,
      1500,
      `${name}: parseVocabulary should yield 1500 candidates, got ${result.candidates.length}`,
    );
    assert.equal(
      result.unreadableLines.length,
      0,
      `${name}: unreadable lines ${JSON.stringify(result.unreadableLines.slice(0, 5))}`,
    );
  }
});

test("daily goal setting is clamped to the allowed choices (invalid -> off)", () => {
  for (const ok of [0, 10, 20, 30, 50]) {
    assert.equal(q.normalizeDailyGoal(ok), ok);
    assert.equal(q.normalizeDailyGoal(String(ok)), ok);
  }
  for (const bad of [5, 15, -10, 999, NaN, null, undefined, "abc", ""]) {
    assert.equal(q.normalizeDailyGoal(bad), 0, `invalid ${String(bad)} should fall back to 0`);
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

// --- 候補一覧のCEFRバッジ取得予算 ---------------------------------------
// 文字列一致だけのゲートでは「上限があるように見えて実は効かない」書き換えを
// 見逃す。実コードをサンドボックスで動かし、問い合わせ回数そのものを数える。
function buildCefrSandbox() {
  const pieces = [
    extractConst("cefrInFlight"),
    `const CEFR_BADGE_LOOKUP_LIMIT = ${
      html.match(/const CEFR_BADGE_LOOKUP_LIMIT = (\d+);/)[1]
    };`,
    // resolveCefrOnce が使う window.Cefr と、バッジ描画はテスト側で差し替える。
    "let lookups = 0;",
    "const cache = new Map();",
    "const window = { Cefr: {" +
      " key: (t) => String(t || '').trim().toLowerCase()," +
      " peek: (t) => cache.get(String(t || '').trim().toLowerCase()) || null," +
      " resolve: async (t) => { lookups += 1; return { level: 'B1', estimated: true }; } } };",
    "function updateCefrBadge(badge, result) { badge.result = result; }",
    extractFunction("resolveCefrOnce"),
    // extractFunction は "function 名(" から切り出すので async が落ちる。ここで補う。
    `async ${extractFunction("resolveCefrBadges")}`,
    "globalThis.__c = { resolveCefrBadges, resolveCefrOnce, CEFR_BADGE_LOOKUP_LIMIT," +
      " lookups: () => lookups, reset: () => { lookups = 0; cache.clear(); cefrInFlight.clear(); }," +
      " prime: (t, r) => cache.set(t, r) };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "cefr-budget-check.js" }).runInNewContext(sandbox);
  return sandbox.__c;
}

const makeBadges = (terms) => {
  const badges = terms.map((term) => ({ dataset: { cefrTerm: term }, isConnected: true }));
  return { badges, container: { querySelectorAll: () => badges } };
};

test("候補一覧のCEFR取得は上限で止まる（1500語で外部APIを叩き切らない）", async () => {
  const c = buildCefrSandbox();
  c.reset();
  const terms = Array.from({ length: 1500 }, (_, i) => `w${i}`);
  await c.resolveCefrBadges(makeBadges(terms).container);
  assert.equal(
    c.lookups(),
    c.CEFR_BADGE_LOOKUP_LIMIT,
    `1500件でも問い合わせは上限(${c.CEFR_BADGE_LOOKUP_LIMIT})で止まるべき`,
  );
});

test("キャッシュ済みの語は取得予算を消費しない", async () => {
  const c = buildCefrSandbox();
  c.reset();
  // 先頭1000語はキャッシュ済み。予算は残り500語に対して使われる。
  const terms = Array.from({ length: 1500 }, (_, i) => `w${i}`);
  for (let i = 0; i < 1000; i += 1) c.prime(`w${i}`, { level: "A1", estimated: false });
  const { badges, container } = makeBadges(terms);
  await c.resolveCefrBadges(container);
  assert.equal(c.lookups(), c.CEFR_BADGE_LOOKUP_LIMIT, "未取得の語に予算を使い切るべき");
  // 予算を使った先頭60件（＝w1000..w1059）に結果が入る。キャッシュ済みは対象外。
  assert.ok(badges[1000].result, "予算内の未取得語にはバッジが入る");
  assert.ok(!badges[999].result, "キャッシュ済みの語は問い合わせないので更新もしない");
});

test("上限に達した語も、次の描画で取得し直せる（永久に未判定のまま残らない）", async () => {
  const c = buildCefrSandbox();
  c.reset();
  const terms = Array.from({ length: 100 }, (_, i) => `x${i}`);
  await c.resolveCefrBadges(makeBadges(terms).container);
  assert.equal(c.lookups(), c.CEFR_BADGE_LOOKUP_LIMIT);
  // 予算切れで取れなかった残り40語だけを次に描画すると、今度は取得できる。
  const rest = terms.slice(c.CEFR_BADGE_LOOKUP_LIMIT);
  const { badges, container } = makeBadges(rest);
  await c.resolveCefrBadges(container);
  assert.ok(badges[0].result, "前回あぶれた語も、次の描画では取得される");
});

// --- CEFRの取得失敗をキャッシュに焼き付けない ---------------------------
// HTTPエラー(429/5xx)を「判定済みの未知」として保存すると、peek() が既知として返し、
// その語は二度と再取得されない。サンプルが1集1500語になり429を踏む機会が増えたため、
// ここが焼き付くと大量の語が恒久的に未判定のまま残る。
function buildCefrModuleSandbox() {
  const store = new Map();
  const sandbox = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    setTimeout,
    clearTimeout,
    AbortController,
    calls: [],
    responses: [],
    window: {},
  };
  sandbox.fetch = async (url) => {
    sandbox.calls.push(url);
    const next = sandbox.responses.shift();
    if (next === "throw") throw new Error("offline");
    return next;
  };
  const pieces = [extractConst("Cefr"), "window.Cefr = Cefr;", "globalThis.__m = Cefr;"];
  new Script(pieces.join("\n\n"), { filename: "cefr-module-check.js" }).runInNewContext(sandbox);
  return { cefr: sandbox.__m, sandbox };
}

const okBody = (word, freq) => ({
  ok: true,
  json: async () => [{ word, tags: [`f:${freq}`] }],
});

test("CEFRはHTTPエラーをキャッシュせず、次回に取得し直せる", async () => {
  const { cefr, sandbox } = buildCefrModuleSandbox();
  sandbox.responses = [{ ok: false, status: 429, json: async () => null }];
  assert.equal(await cefr.resolve("zzzratelimited"), null, "429では結果を確定させない");
  assert.equal(cefr.peek("zzzratelimited"), null, "429をキャッシュに焼き付けてはいけない");

  sandbox.responses = [okBody("zzzratelimited", 12)];
  const second = await cefr.resolve("zzzratelimited");
  assert.ok(second && second.level, "復旧後は取得できる");
  assert.equal(sandbox.calls.length, 2, "再取得のために2回問い合わせている");
});

test("CEFRはAPIが応答したうえでの『判定不能』はキャッシュする（無駄な再問い合わせを避ける）", async () => {
  const { cefr, sandbox } = buildCefrModuleSandbox();
  // 200だが該当語なし＝判定済みの「不明」。これは保存してよい。
  sandbox.responses = [{ ok: true, json: async () => [] }];
  const first = await cefr.resolve("zzznosuchword");
  assert.ok(first && first.level === null, "応答があれば未判定として確定する");
  assert.ok(cefr.peek("zzznosuchword"), "確定した未判定はキャッシュされる");
  await cefr.resolve("zzznosuchword");
  assert.equal(sandbox.calls.length, 1, "キャッシュ済みなら再問い合わせしない");
});

// --- 内蔵の品詞表 -------------------------------------------------------
// 誤った品詞は空所補充の「品詞が違うから空所に入らない」という根拠を壊し、
// 正解が2つある問題を作ってしまう。表の不変条件をここで固定する。
test("多品詞語は取り得る品詞をすべて返す（単一品詞に丸めない）", () => {
  // access は名詞でも動詞でも使う。片方だけ返すと、もう片方の空所で
  // 「品詞が違うから入らない」と誤った根拠を作ってしまう。
  const tags = [...q.builtinPosTags("access")].sort();
  assert.deepEqual(tags, ["n", "v"]);
  // 代表の品詞は先頭（訳から導出したもの）。
  assert.ok(["n", "v"].includes(q.builtinPosTag("access")));
});

test("多品詞語は空所補充の根拠にならない（品詞が重なるため）", () => {
  q.setWords([]);
  // 答えが名詞のとき、名詞にもなる語は空所に入り得るので根拠にできない。
  assert.equal(q.contextDistractorHasBasis(W("poverty", "貧困", "n"), "access"), false);
  // 品詞が重ならない語は根拠になる。
  assert.equal(q.contextDistractorHasBasis(W("poverty", "貧困", "n"), "abolish"), true);
});

test("品詞表は単一品詞と多品詞で語が重複しない", () => {
  // 両方に載ると、どちらが効くかが読み手にも実装にも曖昧になる。
  const single = new Set();
  for (const m of html.matchAll(/^\s+(n|v|adj): "([^"]+)",$/gm)) {
    for (const w of m[2].split(" ")) single.add(w);
  }
  const multiSrc = /const BUILTIN_POS_MULTI_GROUPS = \{([\s\S]*?)\n\};/.exec(html)[1];
  const overlap = [];
  for (const m of multiSrc.matchAll(/^\s+"[^"]+": "([^"]+)",$/gm)) {
    for (const w of m[1].split(" ")) if (single.has(w)) overlap.push(w);
  }
  assert.deepEqual(overlap, [], `単一品詞と多品詞に重複: ${overlap.slice(0, 10).join(" ")}`);
});

test("品詞表の語はすべて英小文字のみ、品詞名も既定の4種のみ", () => {
  const bad = [];
  for (const m of html.matchAll(/^\s+(n|v|adj): "([^"]+)",$/gm)) {
    for (const w of m[2].split(" ")) if (!/^[a-z]+$/.test(w)) bad.push(w);
  }
  const multiSrc = /const BUILTIN_POS_MULTI_GROUPS = \{([\s\S]*?)\n\};/.exec(html)[1];
  const badTag = [];
  for (const m of multiSrc.matchAll(/^\s+"([^"]+)": "([^"]+)",$/gm)) {
    for (const t of m[1].split(" ")) if (!["n", "v", "adj", "adv"].includes(t)) badTag.push(t);
    for (const w of m[2].split(" ")) if (!/^[a-z]+$/.test(w)) bad.push(w);
  }
  assert.deepEqual(bad, [], `品詞表に不正な語: ${bad.slice(0, 10).join(" ")}`);
  assert.deepEqual(badTag, [], `品詞表に不正な品詞名: ${badTag.slice(0, 10).join(" ")}`);
});

test("サンプル単語の過半に品詞が付いている（付かないと空所補充が通常出題に落ちる）", () => {
  const extract = (name) => {
    const start = html.indexOf(`const ${name} = \``);
    const open = html.indexOf("`", start);
    return html.slice(open + 1, html.indexOf("`;", open + 1));
  };
  const terms = new Set();
  for (const n of ["SAMPLE_TEXT", "SAMPLE_TEXT_JHS", "SAMPLE_TEXT_EIKEN",
    "SAMPLE_TEXT_SOUKEI", "SAMPLE_TEXT_TOEIC", "SAMPLE_TEXT_IELTS"]) {
    for (const line of extract(n).split("\n").filter(Boolean)) {
      terms.add(line.slice(0, line.indexOf(" ")).toLowerCase());
    }
  }
  let covered = 0;
  for (const t of terms) if ([...q.builtinPosTags(t)].length > 0) covered += 1;
  const ratio = covered / terms.size;
  assert.ok(
    ratio >= 0.8,
    `サンプル${terms.size}語のうち品詞が付いているのは${covered}語 (${(ratio * 100).toFixed(1)}%)`,
  );
});

// resolvePos は内蔵表で早期に返る。ここで tags を落とすと、保存後の単語が
// 「この品詞だけ」の語として扱われ、空所補充の根拠を誤って作ってしまう。
test("resolvePos は内蔵表の多品詞語について tags も返す", async () => {
  const pieces = [
    extractConst("BUILTIN_POS_GROUPS"),
    extractConst("BUILTIN_POS"),
    extractConst("BUILTIN_POS_MULTI_GROUPS"),
    extractConst("BUILTIN_POS_MULTI"),
    extractConst("BUILTIN_POS_NOUN_AND_VERB"),
    extractFunction("builtinPosTag"),
    extractFunction("builtinPosTags"),
    // 内蔵表で早期に返るので fetch には到達しない。到達したら通信した証拠として落とす。
    "const fetch = () => { throw new Error('内蔵表にある語で通信した'); };",
    "const AbortController = function () { this.signal = null; this.abort = () => {}; };",
    "const setTimeout = () => 0; const clearTimeout = () => {};",
    `async ${extractFunction("resolvePos")}`,
    "globalThis.__r = { resolvePos };",
  ];
  const sb = {};
  new Script(pieces.join("\n\n"), { filename: "resolve-pos-check.js" }).runInNewContext(sb);

  const multi = await sb.__r.resolvePos("access"); // n と v の両方を取る語
  assert.ok(multi.tag, "代表の品詞を返す");
  assert.deepEqual([...(multi.tags || [])].sort(), ["n", "v"], "取り得る品詞をすべて返す");

  const single = await sb.__r.resolvePos("poverty"); // 名詞だけの語
  assert.equal(single.tag, "n");
  assert.deepEqual([...(single.tags || [])], ["n"]);
});

// --- 内蔵のCEFR表 -------------------------------------------------------
// 実行時にDatamuseへ引かせると、1集1500語では「保存した単語」画面を何度も
// めくらない限りほとんど未判定のまま残る。ビルド時に焼きこんだ表が効いて
// いることを、実コードの peek() を動かして確かめる。
function buildCefrModuleSandboxNoNet() {
  const store = new Map();
  const sandbox = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    setTimeout,
    clearTimeout,
    AbortController,
    // 内蔵表で返るはずなので、通信したら失敗させる。
    fetch: () => {
      throw new Error("内蔵表にある語で通信した");
    },
    window: {},
  };
  new Script([extractConst("Cefr"), "globalThis.__m = Cefr;"].join("\n\n"), {
    filename: "cefr-builtin-check.js",
  }).runInNewContext(sandbox);
  return sandbox.__m;
}

test("サンプル単語のCEFRは通信せずに判定できる", () => {
  const cefr = buildCefrModuleSandboxNoNet();
  const extract = (name) => {
    const start = html.indexOf(`const ${name} = \``);
    const open = html.indexOf("`", start);
    return html.slice(open + 1, html.indexOf("`;", open + 1));
  };
  const terms = new Set();
  for (const n of ["SAMPLE_TEXT", "SAMPLE_TEXT_JHS", "SAMPLE_TEXT_EIKEN",
    "SAMPLE_TEXT_SOUKEI", "SAMPLE_TEXT_TOEIC", "SAMPLE_TEXT_IELTS"]) {
    for (const line of extract(n).split("\n").filter(Boolean)) {
      terms.add(line.slice(0, line.indexOf(" ")).toLowerCase());
    }
  }
  let covered = 0;
  for (const t of terms) if (cefr.peek(t)?.level) covered += 1;
  const ratio = covered / terms.size;
  assert.ok(
    ratio >= 0.95,
    `サンプル${terms.size}語のうち通信なしでCEFRが付くのは${covered}語 (${(ratio * 100).toFixed(1)}%)`,
  );
});

test("CEFR表のレベルは A1〜C2 のみ、語は英小文字のみ", () => {
  const src = /const BUILTIN_LEVEL_GROUPS = \{([\s\S]*?)\n  \};/.exec(html)[1];
  const levels = [];
  const bad = [];
  for (const m of src.matchAll(/^\s+(\w+): "([^"]+)",$/gm)) {
    levels.push(m[1]);
    for (const w of m[2].split(" ")) if (!/^[a-z]+$/.test(w)) bad.push(w);
  }
  assert.deepEqual(levels, ["A1", "A2", "B1", "B2", "C1", "C2"]);
  assert.deepEqual(bad, [], `CEFR表に不正な語: ${bad.slice(0, 10).join(" ")}`);
});

test("手書きのCEFR上書きは内蔵表より優先される", () => {
  const cefr = buildCefrModuleSandboxNoNet();
  // OVERRIDES は人が確かめた値なので estimated=false のまま返る。
  const r = cefr.peek("ubiquitous");
  assert.equal(r.level, "C2");
  assert.equal(r.estimated, false, "手書きの値は推定扱いにしない");
  // 内蔵表だけの語は推定扱い。
  const b = cefr.peek("aberrant");
  assert.ok(b && b.level, "内蔵表の語はレベルが付く");
  assert.equal(b.estimated, true);
});

test("「保存した単語」のバックフィルは表示中の行ではなく単語帳の全語を対象にする", () => {
  // 表示中の100行だけを対象にしていた頃は、1500語の単語帳で「さらに表示」を
  // 14回押さないと埋まらなかった。DOMを見に行く実装へ戻っていないことを固定する。
  const src = html.slice(html.indexOf("function savedWordsInScope()"));
  const body = src.slice(0, src.indexOf("\n}"));
  assert.ok(body.includes("scopedWords()"), "単語帳の全語を返すべき");
  assert.ok(
    !body.includes("querySelectorAll"),
    "DOMの行数に対象を絞ってはいけない",
  );
  assert.ok(!html.includes("savedWordsInDom"), "旧実装が残っている");
  // 画面を開いているときだけ動く、という条件は維持する（送信のきっかけは変えない）。
  for (const fn of ["backfillSavedCefr", "backfillSavedPos"]) {
    const f = html.slice(html.indexOf(`function ${fn}()`));
    assert.ok(
      f.slice(0, 200).includes('activeStepId !== "library"'),
      `${fn} はライブラリ画面でだけ動くべき`,
    );
  }
});

// 「保存した単語」のバックフィルを実際に動かし、表示中の行数ではなく
// 単語帳の全語が埋まることを確かめる。文字列一致だけでは、対象の絞り方を
// 変えられても気づけない。
test("バックフィルは単語帳の全語を埋め切る（表示中の100行で止まらない）", async () => {
  const words = Array.from({ length: 300 }, (_, i) => ({
    id: `w${i}`,
    term: `zzext${i}`,
    meaning: `外部語${i}`,
    cefr: null,
  }));
  const pieces = [
    "let activeStepId = 'library';",
    "let cefrBackfillRunning = false;",
    "let libraryMetadataGeneration = 0;",
    `const METADATA_IDLE_BATCH_SIZE = ${html.match(/const METADATA_IDLE_BATCH_SIZE = (\d+);/)[1]};`,
    "const appState = { words: globalThis.__words, activeDeckId: 'all' };",
    "let persisted = 0;",
    "const persistAppState = () => { persisted += 1; };",
    "const lookups = [];",
    "const resolveCefrOnce = async (t) => { lookups.push(t); return { level: 'B2', estimated: true }; };",
    // アイドル待ちは即時実行に置き換える（待ち方は検査対象ではない）。
    "const scheduleIdleTask = (cb) => { setTimeout(cb, 0); };",
    "const elements = { savedList: { querySelector: () => null, querySelectorAll: () => [] } };",
    "const window = { Cefr: { key: (t) => String(t).toLowerCase() } };",
    "const updateCefrBadge = () => {};",
    "const normalizeTerm = (t) => String(t).trim().toLowerCase();",
    extractFunction("scopedWords"),
    extractFunction("libraryMetadataWorkIsCurrent"),
    extractFunction("savedWordsInScope"),
    extractFunction("backfillSavedCefr"),
    "globalThis.__b = { backfillSavedCefr, lookups: () => lookups, persisted: () => persisted };",
  ];
  const sandbox = { setTimeout, __words: words };
  new Script(pieces.join("\n\n"), { filename: "backfill-check.js" }).runInNewContext(sandbox);

  sandbox.__b.backfillSavedCefr();
  // 全語が処理されるまで待つ（4語ずつなので300語で75回）。
  for (let i = 0; i < 400 && sandbox.__b.lookups().length < 300; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.equal(
    sandbox.__b.lookups().length,
    300,
    `単語帳の300語すべてを対象にすべき（実際は${sandbox.__b.lookups().length}語で止まった）`,
  );
  assert.equal(words.filter((w) => w.cefr?.level).length, 300, "全語にレベルが入る");
  // 最後のバッチのあと、空振り1回を経て finish() が保存する。
  for (let i = 0; i < 20 && sandbox.__b.persisted() === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.ok(sandbox.__b.persisted() > 0, "埋めた結果を保存する");
});

// --- 取り込み直後の先読み ---------------------------------------------
// 保存した分だけをその場で埋める。保存済み全体を勝手に埋めに行くと、
// 「保存した単語」画面を開かない利用者の語彙まで外部へ送ることになる。
function buildPrefetchSandbox(words) {
  const pieces = [
    `const PREFETCH_BATCH_SIZE = ${html.match(/const PREFETCH_BATCH_SIZE = (\d+);/)[1]};`,
    "let prefetchRunning = false;",
    "const prefetchQueue = [];",
    "const appState = { words: globalThis.__words };",
    "const elements = { prefetchAllStatus: null };",
    "let persisted = 0; const persistAppState = () => { persisted += 1; };",
    "const cefrLookups = []; const posLookups = [];",
    "const resolveCefrOnce = async (t) => { cefrLookups.push(t); return { level: 'B1', estimated: true }; };",
    "const resolvePosOnce = async (t) => { posLookups.push(t); return { tag: 'n', tags: ['n'] }; };",
    "const scheduleIdleTask = (cb) => { setTimeout(cb, 0); };",
    "const normalizeTerm = (t) => String(t).trim().toLowerCase();",
    "const localStorageStub = new Map();",
    "const localStorage = { getItem: (k) => localStorageStub.get(k) ?? null," +
      " setItem: (k, v) => localStorageStub.set(k, v), removeItem: (k) => localStorageStub.delete(k) };",
    extractFunction("queueMetadataPrefetch"),
    `async ${extractFunction("runMetadataPrefetchBatch")}`,
    `const PREFETCH_ALL_KEY = ${JSON.stringify(html.match(/const PREFETCH_ALL_KEY = "([^"]+)"/)[1])};`,
    extractFunction("prefetchAllEnabled"),
    extractFunction("updatePrefetchAllStatus"),
    extractFunction("startPrefetchAllIfEnabled"),
    "globalThis.__p = { queueMetadataPrefetch, startPrefetchAllIfEnabled, localStorageStub," +
      " cefr: () => cefrLookups, pos: () => posLookups, persisted: () => persisted };",
  ];
  const sandbox = { setTimeout, __words: words };
  new Script(pieces.join("\n\n"), { filename: "prefetch-check.js" }).runInNewContext(sandbox);
  return sandbox.__p;
}

const mkWords = (n, prefix = "zzp") =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, term: `${prefix}word${i}`, cefr: null, pos: null }));

const settle = async (p, want) => {
  for (let i = 0; i < 600 && p.cefr().length < want; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
};

test("保存直後の先読みは、渡された単語だけを埋める", async () => {
  const saved = mkWords(20, "new");
  const old = mkWords(50, "old");
  const p = buildPrefetchSandbox([...old, ...saved]);
  p.queueMetadataPrefetch(saved);
  await settle(p, 20);
  assert.equal(p.cefr().length, 20, "保存した20語だけを引く");
  assert.equal(p.pos().length, 20);
  assert.equal(saved.filter((w) => w.cefr?.level).length, 20, "保存分は埋まる");
  assert.equal(old.filter((w) => w.cefr).length, 0, "以前からある単語には触れない");
});

test("先読みは判定済みの項目を引き直さない", async () => {
  const words = mkWords(8, "mix");
  for (const w of words) w.cefr = { level: "A1", estimated: false }; // CEFRだけ済み
  const p = buildPrefetchSandbox(words);
  p.queueMetadataPrefetch(words);
  for (let i = 0; i < 200 && p.pos().length < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
  assert.equal(p.pos().length, 8, "品詞は引く");
  assert.equal(p.cefr().length, 0, "判定済みのCEFRは引き直さない");
});

test("消えた単語には書き戻さない（応答待ちの間の削除・同期に追随する）", async () => {
  const words = mkWords(8, "gone");
  const p = buildPrefetchSandbox(words);
  const removed = words.splice(0, 4); // 待っている間に消えた想定
  p.queueMetadataPrefetch([...removed, ...words]);
  await settle(p, 4);
  for (let i = 0; i < 200; i += 1) await new Promise((r) => setTimeout(r, 0));
  assert.equal(removed.filter((w) => w.cefr).length, 0, "消えた単語には書かない");
  assert.equal(words.filter((w) => w.cefr?.level).length, 4, "残った単語は埋まる");
});

test("「起動中に先読み」は既定オフで、オンのときだけ全語を対象にする", async () => {
  const words = mkWords(12, "all");
  const p = buildPrefetchSandbox(words);
  p.startPrefetchAllIfEnabled();
  for (let i = 0; i < 100; i += 1) await new Promise((r) => setTimeout(r, 0));
  assert.equal(p.cefr().length, 0, "既定オフでは1語も送らない");

  p.localStorageStub.set("wordsnap-prefetch-all:v1", "1");
  p.startPrefetchAllIfEnabled();
  await settle(p, 12);
  assert.equal(p.cefr().length, 12, "オンにすると保存済みの全語を対象にする");
});
