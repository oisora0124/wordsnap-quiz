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
  // 引数リストの括弧を数えて終わりを見つける。既定引数に Date.now() のような
  // 括弧が入ると、最初の ")" で切ると本体の開始位置を取り違える。
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
    // 学習結果の適用。フラッシュカードの自己申告(low/mid/high)の分岐を実コードで検査する。
    `const SLOW_ANSWER_MS = ${html.match(/const SLOW_ANSWER_MS = (\d+);/)[1]};`,
    `const FAST_ANSWER_MS = ${html.match(/const FAST_ANSWER_MS = (\d+);/)[1]};`,
    `const MAX_TIMED_ANSWER_MS = ${html.match(/const MAX_TIMED_ANSWER_MS = (\d+);/)[1]};`,
    `const WRONG_COOLDOWN_MS = ${html.match(/const WRONG_COOLDOWN_MS = ([^;]+);/)[1]};`,
    "const adaptiveSrsEnabled = () => false;", // 適応SRSはOFF＝従来の間隔で検査する
    "const personalAccuracyFactorCached = () => 1;",
    "const scheduleReview = () => {};",
    extractFunction("applyLearningResult"),
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
      " applyLearningResult," +
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

// --- ブランク復帰トリアージ -------------------------------------------
// 数百語の期限切れを全部見せる代わりに、少数の抜き取りで保持率を測って戻り方を決める。
// この機能は提示と順序づけだけを行い、回答していない語の学習状態は書き換えない。
function buildRecoverySandbox() {
  const pieces = [
    `const SRS_DAY_MS = ${html.match(/const SRS_DAY_MS = ([^;]+);/)[1]};`,
    extractConst("SRS_INTERVAL_DAYS"),
    `const RECOVERY_PROBE_SIZE = ${html.match(/const RECOVERY_PROBE_SIZE = (\d+);/)[1]};`,
    `const RECOVERY_DEFAULT_DAILY_CAP = ${html.match(/const RECOVERY_DEFAULT_DAILY_CAP = (\d+);/)[1]};`,
    `const RECOVERY_MIN_OVERDUE = ${html.match(/const RECOVERY_MIN_OVERDUE = (\d+);/)[1]};`,
    `const RECOVERY_MIN_DAYS_AWAY = ${html.match(/const RECOVERY_MIN_DAYS_AWAY = (\d+);/)[1]};`,
    extractFunction("recoveryOverdueDays"),
    extractFunction("recoveryStratumKey"),
    extractFunction("groupRecoveryStrata"),
    extractFunction("pickRecoveryProbe"),
    extractFunction("estimateStratumRetention"),
    extractFunction("buildRecoveryPlan"),
    extractFunction("shouldOfferRecovery"),
    "globalThis.__rec = { recoveryStratumKey, groupRecoveryStrata, pickRecoveryProbe," +
      " estimateStratumRetention, buildRecoveryPlan, shouldOfferRecovery," +
      " RECOVERY_PROBE_SIZE, RECOVERY_MIN_OVERDUE, RECOVERY_MIN_DAYS_AWAY };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "recovery-check.js" }).runInNewContext(sandbox);
  return sandbox.__rec;
}
const rec = buildRecoverySandbox();
const DAY = 86400000;
// stage と「期限を過ぎた日数」を指定して期限切れ語を作る。
const overdueWord = (id, stage, overdueDays, now) => ({
  id,
  term: `w${id}`,
  learning: { srsStage: stage, nextReviewAt: now - overdueDays * DAY },
});

test("復帰モードは、たまっていて かつ 空いているときだけ出す", () => {
  const big = rec.RECOVERY_MIN_OVERDUE;
  const away = rec.RECOVERY_MIN_DAYS_AWAY;
  assert.equal(rec.shouldOfferRecovery({ overdueCount: big, daysAway: away }), true);
  // 数が少なければ普通に復習すればよい。
  assert.equal(rec.shouldOfferRecovery({ overdueCount: big - 1, daysAway: away }), false);
  // 毎日やっている人の期限切れは「離脱からの復帰」ではない。
  assert.equal(rec.shouldOfferRecovery({ overdueCount: big, daysAway: away - 1 }), false);
});

test("層は SRS段階 × 期限超過日数 で切られる", () => {
  const now = 1_700_000_000_000;
  assert.equal(rec.recoveryStratumKey(overdueWord("a", 0, 3, now), now), "s01:d7");
  assert.equal(rec.recoveryStratumKey(overdueWord("b", 3, 20, now), now), "s23:d30");
  assert.equal(rec.recoveryStratumKey(overdueWord("c", 6, 90, now), now), "s4+:d31+");
});

test("抜き取りは全層から取り、指定数を超えない", () => {
  const now = 1_700_000_000_000;
  const words = [];
  // 大きい層と、1語しかない層を混ぜる。
  for (let i = 0; i < 300; i += 1) words.push(overdueWord(`big${i}`, 0, 3, now));
  for (let i = 0; i < 40; i += 1) words.push(overdueWord(`mid${i}`, 3, 20, now));
  words.push(overdueWord("tiny", 6, 90, now));
  const strata = rec.groupRecoveryStrata(words, now);
  const probe = rec.pickRecoveryProbe(strata, rec.RECOVERY_PROBE_SIZE);
  assert.equal(probe.length, rec.RECOVERY_PROBE_SIZE, "指定数ちょうど抜き取る");
  assert.equal(new Set(probe).size, probe.length, "同じ語を二度取らない");
  // 1語しかない層も落とさない。落とすとその層の保持率が推定できない。
  assert.ok(probe.includes("tiny"), "小さい層からも取る");
  const kinds = new Set(probe.map((id) => id.replace(/[0-9]+$/, "")));
  assert.deepEqual([...kinds].sort(), ["big", "mid", "tiny"], "全層から取る");
});

test("抜き取り数が総数を超えない（期限切れが少ないとき）", () => {
  const now = 1_700_000_000_000;
  const words = [overdueWord("a", 0, 3, now), overdueWord("b", 3, 20, now)];
  const probe = rec.pickRecoveryProbe(rec.groupRecoveryStrata(words, now), 20);
  assert.equal(probe.length, 2);
});

test("保持率は事前分布つきで、1語の結果で0%や100%にしない", () => {
  const r = rec.estimateStratumRetention([
    { stratum: "s01:d7", correct: true },
    { stratum: "s4+:d7", correct: false },
  ]);
  assert.ok(r.get("s01:d7") > 0.5 && r.get("s01:d7") < 1, `1問正解で100%にしない: ${r.get("s01:d7")}`);
  assert.ok(r.get("s4+:d7") > 0 && r.get("s4+:d7") < 0.5, `1問不正解で0%にしない: ${r.get("s4+:d7")}`);
});

test("計画は保持率の高い層から並べ、1日の上限で区切る", () => {
  const now = 1_700_000_000_000;
  const words = [];
  for (let i = 0; i < 30; i += 1) words.push(overdueWord(`low${i}`, 0, 90, now));   // s01:d31+
  for (let i = 0; i < 30; i += 1) words.push(overdueWord(`high${i}`, 6, 3, now));   // s4+:d7
  const strata = rec.groupRecoveryStrata(words, now);
  const retention = new Map([["s01:d31+", 0.2], ["s4+:d7", 0.9]]);
  const plan = rec.buildRecoveryPlan(strata, retention, 10);
  assert.equal(plan.orderedIds.length, 60);
  assert.ok(plan.orderedIds[0].startsWith("high"), "保持率の高い層が先");
  assert.ok(plan.orderedIds[59].startsWith("low"), "低い層が後");
  assert.equal(plan.days.length, 6, "60語を1日10語で6日に分ける");
  assert.equal(plan.days[0].length, 10);
  assert.deepEqual(
    plan.days.flat().length,
    plan.orderedIds.length,
    "分割で語が増減しない",
  );
});

test("復帰の計画は学習状態を書き換えない（純粋関数であること）", () => {
  const now = 1_700_000_000_000;
  const words = [overdueWord("a", 2, 40, now), overdueWord("b", 5, 10, now)];
  const before = JSON.parse(JSON.stringify(words));
  const strata = rec.groupRecoveryStrata(words, now);
  const probe = rec.pickRecoveryProbe(strata, 20);
  const retention = rec.estimateStratumRetention(
    probe.map((id) => ({ stratum: rec.recoveryStratumKey(words.find((w) => w.id === id), now), correct: true })),
  );
  rec.buildRecoveryPlan(strata, retention, 10);
  assert.deepEqual(
    JSON.parse(JSON.stringify(words)),
    before,
    "復帰の計算で単語の学習状態が変わってはいけない",
  );
});

// --- 復帰トリアージの通し動作 ------------------------------------------
// カード表示 → 抜き取り開始 → 回答 → 保持率推定 → 今日ぶんの提示 までを
// 実コードで通す。とくに「回答していない語の学習状態が変わらない」ことを固定する。
function buildRecoveryFlowSandbox(words) {
  const store = new Map();
  const sandbox = {
    __words: words,
    __started: [],
    __status: [],
    Date,
    console,
  };
  const pieces = [
    "const appState = { words: globalThis.__words, streak: { count: 3, last: '', best: 5 }, activeDeckId: 'all' };",
    "const localStorage = { getItem: (k) => globalThis.__store.get(k) ?? null," +
      " setItem: (k, v) => globalThis.__store.set(k, String(v))," +
      " removeItem: (k) => globalThis.__store.delete(k) };",
    `const SRS_DAY_MS = ${html.match(/const SRS_DAY_MS = ([^;]+);/)[1]};`,
    extractConst("SRS_INTERVAL_DAYS"),
    `const RECOVERY_KEY = ${JSON.stringify(html.match(/const RECOVERY_KEY = "([^"]+)"/)[1])};`,
    `const RECOVERY_MIN_OVERDUE = ${html.match(/const RECOVERY_MIN_OVERDUE = (\d+);/)[1]};`,
    `const RECOVERY_MIN_DAYS_AWAY = ${html.match(/const RECOVERY_MIN_DAYS_AWAY = (\d+);/)[1]};`,
    `const RECOVERY_PROBE_SIZE = ${html.match(/const RECOVERY_PROBE_SIZE = (\d+);/)[1]};`,
    `const RECOVERY_DEFAULT_DAILY_CAP = ${html.match(/const RECOVERY_DEFAULT_DAILY_CAP = (\d+);/)[1]};`,
    extractFunction("recoveryOverdueDays"),
    extractFunction("recoveryStratumKey"),
    extractFunction("groupRecoveryStrata"),
    extractFunction("pickRecoveryProbe"),
    extractFunction("estimateStratumRetention"),
    extractFunction("buildRecoveryPlan"),
    extractFunction("shouldOfferRecovery"),
    extractFunction("loadRecoveryState"),
    extractFunction("saveRecoveryState"),
    extractFunction("daysSinceLastStudy"),
    // 並び順の細部は検査対象でないので、期限順だけの単純版に置き換える。
    "const reviewPriority = () => 0;",
    extractFunction("eligibleSrsWords"),
    // 画面まわりは検査対象でないので最小限のスタブに置き換える。
    "const quizSelectedDeckWords = () => appState.words;",
    "const escapeHtml = (v) => String(v);",
    "const statsCardHeader = (a, b) => `<h3>${a}</h3><span>${b}</span>`;",
    // 実際の buildDailyActivity と同じ形（{answers, correct, terms}）。
    // 数値Mapに差し替えていたせいで、値の読み違いを検出できていなかった。
    "const localDateString = (d = new Date()) => new Date(d).toISOString().slice(0, 10);",
    "const buildDailyActivity = () => { const m = new Map();" +
      " for (let i = 0; i < 7; i += 1) { const k = localDateString(new Date(Date.now() - i * 86400000));" +
      " m.set(k, { answers: 25, correct: 20, terms: new Set() }); } return m; };",
    "const startReview = (...a) => startReviewStub(...a);",
    "const setStatus = (m) => { globalThis.__status.push(m); };",
    "const renderStatsCharts = () => {};",
    "let reviewSession = null;",
    "const startReviewStub = (ids, opts) => { globalThis.__started.push({ ids, opts });" +
      " reviewSession = { recoverySessionId: String(opts?.recoverySessionId || '') }; };",
    extractFunction("recentDailyAnswerCount"),
    `const RECOVERY_MIN_PROBE_ANSWERS = ${html.match(/const RECOVERY_MIN_PROBE_ANSWERS = (\d+);/)[1]};`,
    extractFunction("startRecoveryProbe"),
    extractFunction("recordRecoveryProbeAnswer"),
    extractFunction("finishRecoveryProbe"),
    extractFunction("startRecoveryToday"),
    extractFunction("statsRecoveryCard"),
    "globalThis.__f = { statsRecoveryCard, startRecoveryProbe, recordRecoveryProbeAnswer," +
      " finishRecoveryProbe, startRecoveryToday, loadRecoveryState, saveRecoveryState," +
      " recentDailyAnswerCount," +
      " setReviewSession: (v) => { reviewSession = v; } };",
  ];
  sandbox.__store = store;
  new Script(pieces.join("\n\n"), { filename: "recovery-flow-check.js" }).runInNewContext(sandbox);
  return { f: sandbox.__f, started: () => sandbox.__started, status: () => sandbox.__status };
}

// 25日前に学習し、200語が期限切れという状態を作る。
function makeLapsedWords(n = 200) {
  const now = Date.now();
  const past = new Date(now - 25 * DAY).toISOString();
  return Array.from({ length: n }, (_, i) => ({
    id: `lapse${i}`,
    term: `term${i}`,
    meaning: `意味${i}`,
    history: [{ at: past, correct: true }],
    learning: {
      status: "review",
      srsStage: i % 7,
      nextReviewAt: now - (5 + (i % 60)) * DAY,
    },
  }));
}

test("復帰: 離脱して戻ると、全件の数字より先に「まず20語」を出す", () => {
  const words = makeLapsedWords();
  const { f } = buildRecoveryFlowSandbox(words);
  const html1 = f.statsRecoveryCard();
  assert.ok(html1.includes("おかえりなさい"), "復帰カードが出る");
  assert.ok(html1.includes("recoveryStartButton"), "抜き取り開始ボタンがある");
  assert.ok(html1.includes("20語だけ"), "まず20語だけ、と伝える");
  assert.ok(!html1.includes("200語"), "たまった全件数を前面に出さない");
});

test("復帰: 抜き取りを始めても、単語の学習状態は変わらない", () => {
  const words = makeLapsedWords();
  const before = JSON.parse(JSON.stringify(words));
  const { f, started } = buildRecoveryFlowSandbox(words);
  f.startRecoveryProbe();
  assert.equal(started().length, 1, "復習セッションを1つ始める");
  assert.equal(started()[0].ids.length, 20, "20語を出題する");
  assert.deepEqual(
    JSON.parse(JSON.stringify(words)),
    before,
    "抜き取りを始めた時点では、どの単語の学習状態も変わっていない",
  );
  const state = f.loadRecoveryState();
  assert.equal(state.probeIds.length, 20);
  assert.equal(state.probeDone, false);
  assert.ok(state.dailyCap >= 10 && state.dailyCap <= 80, `1日の上限が妥当: ${state.dailyCap}`);
});

test("復帰: 抜き取りの結果から保持率を出し、今日ぶんだけを提示する", () => {
  const words = makeLapsedWords();
  const { f } = buildRecoveryFlowSandbox(words);
  f.startRecoveryProbe();
  const state = f.loadRecoveryState();
  // 抜き取り対象を「解いた」ことにする（半分正解）。実際の回答経路と同じく、
  // 回答のたびに recordRecoveryProbeAnswer を呼ぶ。
  state.probeIds.forEach((id, i) => f.recordRecoveryProbeAnswer(id, i % 2 === 0));
  f.finishRecoveryProbe();
  const after = f.loadRecoveryState();
  assert.equal(after.probeDone, true, "抜き取り完了として記録する");
  assert.ok(after.retention.size > 0, "層ごとの保持率が出る");
  for (const rate of after.retention.values()) {
    assert.ok(rate > 0 && rate < 1, `保持率が0%や100%に振り切れない: ${rate}`);
  }
  const card = f.statsRecoveryCard();
  assert.ok(card.includes("復帰プラン"), "計画カードに切り替わる");
  assert.ok(card.includes("recoveryTodayButton"), "今日のぶんを始めるボタンが出る");
  assert.ok(card.includes("あと"), "残り日数を見せる");
  assert.ok(
    card.includes("まだ解いていない単語の学習記録は変わりません"),
    "書き換えないことを画面で明示する",
  );
});

test("復帰: 今日ぶんは1日の上限を超えず、未回答語の状態も変えない", () => {
  const words = makeLapsedWords();
  const { f, started } = buildRecoveryFlowSandbox(words);
  f.startRecoveryProbe();
  const state = f.loadRecoveryState();
  state.probeIds.forEach((id, i) => f.recordRecoveryProbeAnswer(id, i % 3 !== 0));
  f.finishRecoveryProbe();
  const snapshot = JSON.parse(JSON.stringify(words.map((w) => w.learning)));
  f.startRecoveryToday();
  const last = started()[started().length - 1];
  assert.ok(last.ids.length <= f.loadRecoveryState().dailyCap, "1日の上限を超えない");
  assert.ok(last.ids.length > 0, "今日ぶんが空にならない");
  assert.deepEqual(
    JSON.parse(JSON.stringify(words.map((w) => w.learning))),
    snapshot,
    "計画を出しただけでは、どの単語の学習状態も変わらない",
  );
});

test("復帰: たまっていない・空けていないときは出さない", () => {
  const now = Date.now();
  // 期限切れは多いが、今日も学習している人。
  const active = makeLapsedWords(200).map((w) => ({
    ...w,
    history: [{ at: new Date(now - 3600000).toISOString(), correct: true }],
  }));
  assert.equal(buildRecoveryFlowSandbox(active).f.statsRecoveryCard(), "", "離脱していなければ出さない");
  // 長く空けたが期限切れは少ない人。
  const few = makeLapsedWords(10);
  assert.equal(buildRecoveryFlowSandbox(few).f.statsRecoveryCard(), "", "少なければ普通に復習すればよい");
});

// --- 「知っている英語で言うと」 -----------------------------------------
// 類義語のうち習得済みのものだけを説明に使う。日本語は必ず残す
// （英語だけにすると、その類義語がうろ覚えだったとき確かめる手段が無くなる）。
function buildKnownSynSandbox(words) {
  const pieces = [
    "const appState = { words: globalThis.__words };",
    `const KNOWN_SYNONYM_MIN_STAGE = ${html.match(/const KNOWN_SYNONYM_MIN_STAGE = (\d+);/)[1]};`,
    extractFunction("normalizeTerm"),
    extractFunction("isKnownEnoughToExplain"),
    extractFunction("knownTermSet"),
    extractFunction("knownSynonyms"),
    "globalThis.__k = { isKnownEnoughToExplain, knownTermSet, knownSynonyms," +
      " MIN_STAGE: KNOWN_SYNONYM_MIN_STAGE };",
  ];
  const sandbox = { __words: words };
  new Script(pieces.join("\n\n"), { filename: "known-syn-check.js" }).runInNewContext(sandbox);
  return sandbox.__k;
}
// 習得済みで期限内の語。status と nextReviewAt も持たせる（実データと同じ形）。
const wordAt = (term, stage, recent, extra = {}) => ({
  id: term,
  term,
  learning: {
    srsStage: stage,
    status: extra.status ?? "mastered",
    nextReviewAt: extra.nextReviewAt ?? Date.now() + 7 * 86400000,
  },
  history: recent.map((c) => ({ at: "2026-08-01T00:00:00.000Z", correct: c })),
});

test("説明に使うのは、段階が進んでいて直近も正解している語だけ", () => {
  const k = buildKnownSynSandbox([]);
  assert.equal(k.isKnownEnoughToExplain(wordAt("tough", 5, [true, true, true])), true);
  // 段階が浅い語は、覚えたばかりで説明には使えない。
  assert.equal(k.isKnownEnoughToExplain(wordAt("tough", k.MIN_STAGE - 1, [true, true, true])), false);
  // 直近に1回でも落としている語は危うい。
  assert.equal(k.isKnownEnoughToExplain(wordAt("tough", 5, [true, false, true])), false);
  // 履歴が無い語は判断材料が無い。
  assert.equal(k.isKnownEnoughToExplain(wordAt("tough", 5, [])), false);
  // 復習中(review)の語はまだ揺れているので説明の土台にしない。
  assert.equal(
    k.isKnownEnoughToExplain(wordAt("tough", 5, [true, true, true], { status: "review" })),
    false,
    "習得(mastered)まで来ていない語は使わない",
  );
  // 復習期限を過ぎている語は、いま思い出せるか分からない。
  assert.equal(
    k.isKnownEnoughToExplain(
      wordAt("tough", 5, [true, true, true], { nextReviewAt: Date.now() - 86400000 }),
    ),
    false,
    "期限超過の語は使わない",
  );
});

test("類義語のうち習得済みのものだけを取り出す", () => {
  const words = [
    wordAt("tough", 5, [true, true, true]),   // 習得済み
    wordAt("hardy", 1, [true]),                // まだ
  ];
  const k = buildKnownSynSandbox(words);
  const items = [
    { word: "hardy", ja: "丈夫な" },
    { word: "Tough", ja: "たくましい" }, // 大文字でも拾う
    { word: "sturdy", ja: "頑丈な" },    // 手元に無い
  ];
  // サンドboxの配列はプロトタイプが違うので、値を取り出して比べる。
  const got = [...k.knownSynonyms(items, k.knownTermSet(words))].map((i) => i.word);
  assert.deepEqual(got, ["Tough"], "習得済みの語だけ");
});

test("習得済みの類義語が無ければ何も出さない（日本語表示のまま）", () => {
  const words = [wordAt("hardy", 1, [true])];
  const k = buildKnownSynSandbox(words);
  assert.equal([...k.knownSynonyms([{ word: "hardy" }], k.knownTermSet(words))].length, 0);
  assert.equal([...k.knownSynonyms([{ word: "sturdy" }], new Set())].length, 0);
});

test("「知っている英語で言うと」を出しても日本語を消さない", () => {
  // 表示側の不変条件。英語チップに和訳を併記し、通常の類義語リストも残す。
  const src = html.slice(html.indexOf('if (type === "synonyms") {'));
  const body = src.slice(0, src.indexOf("\n  }\n"));
  assert.ok(body.includes("known-syn-box"), "習得済みの類義語を先頭に出す");
  assert.ok(
    body.includes("item.ja ? `<small>") || body.includes("item.ja ?"),
    "英語チップに和訳を併記する",
  );
  assert.ok(body.includes("return list;"), "習得済みが無ければ従来の表示に戻す");
  assert.ok(
    body.trimEnd().endsWith("list\n    );") || body.includes("` +\n      list"),
    "通常の類義語リストも消さずに残す",
  );
});

// --- 復帰トリアージ: レビュー指摘の回帰固定 ----------------------------
// いずれも実装時に実在したバグ。テストのスタブが実データと形が違ったせいで
// 最初は素通りしていたので、実際の値の形と実際の呼び出し経路で固定する。

test("復帰: 誤答の再挑戦で保持率が100%に化けない（最初の回答だけを数える）", () => {
  const words = makeLapsedWords();
  const { f } = buildRecoveryFlowSandbox(words);
  f.startRecoveryProbe();
  const state = f.loadRecoveryState();
  // 実際の復習では誤答は再出題される。最初は全問落として、その後に全問正解した想定。
  for (const id of state.probeIds) f.recordRecoveryProbeAnswer(id, false);
  for (const id of state.probeIds) f.recordRecoveryProbeAnswer(id, true);
  f.finishRecoveryProbe();
  const after = f.loadRecoveryState();
  assert.equal(after.probeDone, true);
  for (const [key, rate] of after.retention) {
    assert.ok(rate < 0.5, `最初に落とした層の保持率が高く出てはいけない: ${key}=${rate}`);
  }
});

test("復帰: 通常の復習で同じ語に答えても、抜き取りの結果に混ざらない", () => {
  const words = makeLapsedWords();
  const { f } = buildRecoveryFlowSandbox(words);
  f.startRecoveryProbe();
  const ids = f.loadRecoveryState().probeIds;

  // 通常の復習セッション（復帰の印を持たない）に切り替えて、同じ語に答える。
  f.setReviewSession({ recoverySessionId: "" });
  for (const id of ids) f.recordRecoveryProbeAnswer(id, true);
  assert.equal(
    Object.keys(f.loadRecoveryState().probeAnswers).length,
    0,
    "抜き取り以外のセッションの回答を数えてはいけない",
  );

  // 別の復帰セッション（IDが違う）の回答も数えない。
  f.setReviewSession({ recoverySessionId: "rp-other" });
  for (const id of ids) f.recordRecoveryProbeAnswer(id, true);
  assert.equal(Object.keys(f.loadRecoveryState().probeAnswers).length, 0, "別セッションも数えない");

  // 正しいセッションなら数える。
  f.setReviewSession({ recoverySessionId: f.loadRecoveryState().sessionId });
  f.recordRecoveryProbeAnswer(ids[0], true);
  assert.equal(Object.keys(f.loadRecoveryState().probeAnswers).length, 1, "自セッションは数える");
});

test("復帰: 1語だけ答えて中断しても確定せず、続きから再開できる", () => {
  const words = makeLapsedWords();
  const { f } = buildRecoveryFlowSandbox(words);
  f.startRecoveryProbe();
  const state = f.loadRecoveryState();
  f.recordRecoveryProbeAnswer(state.probeIds[0], true);
  f.finishRecoveryProbe({ force: true }); // 中断に相当
  const after = f.loadRecoveryState();
  assert.equal(after.probeDone, false, "1語で確定してはいけない");
  const card = f.statsRecoveryCard();
  assert.ok(card.includes("recoveryResumeProbeButton"), "続きを解く導線が残る");
  assert.ok(card.includes("あと19語"), `残り語数を出す: ${card.match(/あと\d+語/)?.[0]}`);
});

test("復帰: 十分な数を答えてから中断すれば、その結果で計画を作る", () => {
  const words = makeLapsedWords();
  const { f } = buildRecoveryFlowSandbox(words);
  f.startRecoveryProbe();
  const state = f.loadRecoveryState();
  state.probeIds.slice(0, 12).forEach((id, i) => f.recordRecoveryProbeAnswer(id, i % 2 === 0));
  f.finishRecoveryProbe({ force: true });
  assert.equal(f.loadRecoveryState().probeDone, true, "十分な数がそろえば確定してよい");
});

test("復帰: 1日の上限が実際の学習量に追従する（値の読み違いを防ぐ）", () => {
  const words = makeLapsedWords();
  const { f } = buildRecoveryFlowSandbox(words);
  // スタブの buildDailyActivity は 1日25問。既定値40ではなく25が採られるべき。
  assert.equal(f.recentDailyAnswerCount(), 25, "answers を読めている");
  f.startRecoveryProbe();
  assert.equal(f.loadRecoveryState().dailyCap, 25, "上限が実際の学習量になる");
});

test("復帰: 抜き取り対象が全部消えたら、復帰の記録ごと捨てる", () => {
  const words = makeLapsedWords();
  const { f } = buildRecoveryFlowSandbox(words);
  f.startRecoveryProbe();
  words.length = 0; // 同期で全削除された想定
  assert.equal(f.statsRecoveryCard(), "", "古い『確認中』カードが残らない");
  assert.equal(f.loadRecoveryState(), null, "状態も捨てる");
});

test("復帰: 期限切れが0件になっても例外にならない", () => {
  const words = makeLapsedWords();
  const { f } = buildRecoveryFlowSandbox(words);
  f.startRecoveryProbe();
  const state = f.loadRecoveryState();
  state.probeIds.forEach((id) => f.recordRecoveryProbeAnswer(id, true));
  f.finishRecoveryProbe();
  // 別タブや同期で期限切れが解消された想定。
  for (const w of words) w.learning.nextReviewAt = Date.now() + 86400000;
  assert.doesNotThrow(() => f.startRecoveryToday(), "実行時例外を出さない");
  assert.doesNotThrow(() => f.statsRecoveryCard(), "カード描画も落ちない");
});

// --- フラッシュカードの確信度（設定・既定オフ） -------------------------
// 「あやふや」を素の正解として流すと、2回で correctStreak が2に達し
// masteryVerify の付かない本習得ができてしまう（仮習得の仕組みをすり抜ける）。
// 既存の「遅い正解」と同じ扱いに合流させることでこれを防いでいる。
function applyLearning(word, isCorrect, opts = {}) {
  const now = opts.now ?? Date.now();
  return q.applyLearningResult(word, isCorrect, opts.srsDueAtStart ?? false, now, {
    promptMode: opts.promptMode ?? "flashcard",
    selfAssessment: opts.selfAssessment,
    responseMs: opts.responseMs ?? 1000,
    skipSpeedGate: opts.skipSpeedGate,
  });
}
const freshWord = () => ({
  id: "w1",
  term: "resilient",
  meaning: "回復力のある",
  stats: { correct: 0, wrong: 0 },
  history: [],
  progressUpdatedAt: 0,
  learning: {
    status: "new",
    firstAttempted: false,
    reviewAt: 0,
    blockedUntil: 0,
    correctStreak: 0,
    srsStage: 0,
    nextReviewAt: 0,
    srsUpdatedAt: 0,
    lastSrsResult: "",
  },
});

test("確信度: 「あやふや」を2回続けても習得にならない", () => {
  const word = freshWord();
  applyLearning(word, true, { selfAssessment: "mid" });
  applyLearning(word, true, { selfAssessment: "mid" });
  assert.notEqual(word.learning.status, "mastered", "あやふや2回で習得にしてはいけない");
  assert.equal(word.learning.masteryVerify, undefined, "検証マークも付かない");
  assert.ok(word.learning.correctStreak < 2, `連続正解が2に達しない: ${word.learning.correctStreak}`);
});

test("確信度: 「確実」2回は従来どおり仮習得になる", () => {
  const word = freshWord();
  applyLearning(word, true, { selfAssessment: "high" });
  applyLearning(word, true, { selfAssessment: "high" });
  assert.equal(word.learning.status, "mastered");
  assert.equal(word.learning.masteryVerify, "flashcard", "フラッシュカード由来は検証待ちにする");
});

test("確信度: 「あやふや」は正解として数え、段階は進めない", () => {
  const word = freshWord();
  word.learning.srsStage = 3;
  word.learning.nextReviewAt = Date.now() - 86400000;
  const before = word.learning.srsStage;
  applyLearning(word, true, { selfAssessment: "mid", srsDueAtStart: true });
  assert.equal(word.learning.lastSrsResult, "correct", "正解として記録する");
  assert.equal(word.learning.srsStage, before, "段階は進めない");
});

test("確信度: 「知らない」は従来の不正解と完全に同じ", () => {
  const a = freshWord();
  const b = freshWord();
  a.learning.srsStage = 4;
  b.learning.srsStage = 4;
  const now = 1_700_000_000_000;
  applyLearning(a, false, { selfAssessment: "low", now });
  applyLearning(b, false, { now }); // 申告なし＝従来の不正解
  assert.deepEqual(
    JSON.parse(JSON.stringify(a.learning)),
    JSON.parse(JSON.stringify(b.learning)),
    "lowは従来の不正解と同じ結果になるべき",
  );
});

test("確信度: 4択では自己申告が学習結果に影響しない", () => {
  // selfAssessment は4択経路には渡さない設計。渡っても mid の分岐に入らないこと。
  const withMid = freshWord();
  const plain = freshWord();
  const now = 1_700_000_000_000;
  applyLearning(withMid, true, { promptMode: "meaning-choice", selfAssessment: undefined, now });
  applyLearning(plain, true, { promptMode: "meaning-choice", now });
  assert.deepEqual(
    JSON.parse(JSON.stringify(withMid.learning)),
    JSON.parse(JSON.stringify(plain.learning)),
  );
});

test("確信度: 設定は既定オフで、オンのときだけUIが切り替わる", () => {
  // 既定オフ＝これまでフラッシュカードを使ってきた人の操作感が変わらない。
  assert.ok(
    /localStorage\.getItem\(FLASHCARD_CONFIDENCE_KEY\) === "1"/.test(html),
    "キーが無ければ false（既定オフ）",
  );
  const grade = html.slice(html.indexOf("function gradeFlashcardConfidence("));
  const body = grade.slice(0, grade.indexOf("\n}"));
  // 進行中のセッションはセッション開始時のモードで判断する（途中の設定変更で流れが変わらない）。
  assert.ok(body.includes("if (!flashcardSessionConfidenceMode()) return;"), "オフなら動かない");
  assert.ok(
    body.includes("flashcardRevealed) return;"),
    "意味を見た後には申告できない（見る前の申告であることを守る）",
  );
  // 裏返す操作は確信度モードでは無効（裏返せると申告が「答えを見た後」になる）
  const flip = html.slice(html.indexOf("function flipFlashcard()"));
  assert.ok(
    flip.slice(0, 300).includes("if (flashcardSessionConfidenceMode()) return;"),
    "確信度モードでは裏返し操作を無効にする",
  );
});

test("確信度: 検証は意味4択だけ。例文やフラッシュカードでは数えない", () => {
  const verify = html.slice(html.indexOf("function verifyConfidenceOnAnswer("));
  const body = verify.slice(0, verify.indexOf("\n}"));
  assert.ok(
    body.includes('if (promptMode !== "meaning-choice") return;'),
    "意味4択以外は検証に使わない",
  );
  assert.ok(body.includes("delete store.pending[id];"), "1つの申告は1回だけ検証する");
  // 呼び出し側でフラッシュカード自身を除外している
  const call = html.slice(html.indexOf("verifyConfidenceOnAnswer(\n"));
  assert.ok(
    html.includes("if (!currentQuiz.flashcard) {\n    verifyConfidenceOnAnswer("),
    "フラッシュカードの回答では検証しない",
  );
});

test("確信度: 較正の表示は未検証件数を隠さない", () => {
  const card = html.slice(html.indexOf("function statsConfidenceCard()"));
  const body = card.slice(0, card.indexOf("\n}\n"));
  assert.ok(body.includes("まだ確かめていない"), "未検証の件数を併記する");
  assert.ok(body.includes("CONFIDENCE_MIN_SAMPLES"), "少数のときは割合を出さない");
  assert.ok(body.includes("データ不足"), "少数のときの表示がある");
});

test("確信度: 完了画面で「あやふや」を「知ってる」に数えない", () => {
  const fn = html.slice(html.indexOf("function finishFlashcardSession()"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(
    body.includes("session.unknownIds.length - midCount"),
    "あやふやを知ってるから差し引く",
  );
});

// --- フラッシュカード描画の実動作 --------------------------------------
// ソース文字列の検査だけでは、宣言順（TDZ）や実行時の分岐は捕まらない。
// 実際に renderFlashcard() を動かして、投げないこと・表示の出し分けを固定する。
function buildFlashcardRenderSandbox({ confidenceOn, revealed }) {
  const el = (id) => ({ id, hidden: false, textContent: "", dataset: {}, _attrs: {},
    setAttribute(k, v) { this._attrs[k] = v; }, focus() {} });
  const elements = {
    flashcardStage: el("stage"),
    flashcardTerm: el("term"),
    flashcardMeaning: el("meaning"),
    flashcardHint: el("hint"),
    flashcardActions: el("actions"),
    flashcardConfidenceActions: el("confActions"),
    flashcardNextRow: el("nextRow"),
    flashcardFlipButton: el("flip"),
    flashcardSpeakButton: el("speak"),
    flashcardKnownButton: el("known"),
    choices: { replaceChildren() {} },
    quizFeedback: el("feedback"),
    quizProgress: el("progress"),
  };
  const store = new Map();
  if (confidenceOn) store.set("wordsnap-flashcard-confidence:v1", "1");
  const sandbox = {
    __elements: elements,
    __store: store,
    console,
  };
  const pieces = [
    "const elements = globalThis.__elements;",
    "const localStorage = { getItem: (k) => globalThis.__store.get(k) ?? null," +
      " setItem: (k, v) => globalThis.__store.set(k, v), removeItem: (k) => globalThis.__store.delete(k) };",
    `const FLASHCARD_CONFIDENCE_KEY = ${JSON.stringify(html.match(/const FLASHCARD_CONFIDENCE_KEY = "([^"]+)"/)[1])};`,
    extractFunction("flashcardConfidenceEnabled"),
    "let flashcardConfidence = null;",
    extractFunction("flashcardConfidenceLabel"),
    `let flashcardRevealed = ${revealed ? "true" : "false"};`,
    `let flashcardSession = { index: 0, order: ['a'], allIds: ['a'], confidenceMode: ${confidenceOn} };`,
    extractFunction("flashcardSessionConfidenceMode"),
    "let currentQuiz = { flashcard: true, answered: false, answer: { id: 'a', term: 'resilient', meaning: '回復力のある' } };",
    "const autoSpeakCurrentQuiz = () => {};",
    "const appState = { words: [{ id: 'a', term: 'resilient', meaning: '回復力のある' }] };",
    "const document = { querySelector: () => null, getElementById: () => null };",
    "const escapeHtml = (v) => String(v);",
    extractFunction("renderFlashcard"),
    "globalThis.__r = { renderFlashcard, elements };",
  ];
  new Script(pieces.join("\n\n"), { filename: "flashcard-render-check.js" }).runInNewContext(sandbox);
  return sandbox.__r;
}

test("描画: 確信度オフでもオンでも renderFlashcard が例外を出さない", () => {
  for (const confidenceOn of [false, true]) {
    for (const revealed of [false, true]) {
      const r = buildFlashcardRenderSandbox({ confidenceOn, revealed });
      assert.doesNotThrow(
        () => r.renderFlashcard(),
        `confidenceOn=${confidenceOn} revealed=${revealed} で描画が落ちる`,
      );
    }
  }
});

test("描画: 確信度オフのときは従来のボタンだけが出る", () => {
  const back = buildFlashcardRenderSandbox({ confidenceOn: false, revealed: true });
  back.renderFlashcard();
  assert.equal(back.elements.flashcardActions.hidden, false, "従来の仕分けボタンが出る");
  assert.equal(back.elements.flashcardConfidenceActions.hidden, true, "確信度ボタンは出ない");
  assert.equal(back.elements.flashcardNextRow.hidden, true, "次へも出ない");

  const front = buildFlashcardRenderSandbox({ confidenceOn: false, revealed: false });
  front.renderFlashcard();
  assert.equal(front.elements.flashcardActions.hidden, true, "裏返す前はボタンを出さない");
});

test("描画: 確信度オンのときは、意味を見る前に3択・見た後に次へ", () => {
  const front = buildFlashcardRenderSandbox({ confidenceOn: true, revealed: false });
  front.renderFlashcard();
  assert.equal(front.elements.flashcardConfidenceActions.hidden, false, "申告の3択が出る");
  assert.equal(front.elements.flashcardActions.hidden, true, "従来のボタンは出さない");
  assert.equal(front.elements.flashcardNextRow.hidden, true, "次へはまだ出さない");
  assert.equal(front.elements.flashcardMeaning.hidden, true, "意味はまだ見せない");

  const back = buildFlashcardRenderSandbox({ confidenceOn: true, revealed: true });
  back.renderFlashcard();
  assert.equal(back.elements.flashcardConfidenceActions.hidden, true, "申告後は3択を消す");
  assert.equal(back.elements.flashcardNextRow.hidden, false, "次へを出す");
  assert.equal(back.elements.flashcardActions.hidden, true, "従来のボタンは出さない");
  assert.equal(back.elements.flashcardMeaning.hidden, false, "意味を見せる");
});

// --- 確信度サイドカーの掃除 --------------------------------------------
test("確信度: 失効した申告と、消えた単語の記録を捨てる", () => {
  const store = new Map();
  const sandbox = { __store: store, __words: [{ id: "alive" }] };
  const pieces = [
    "const localStorage = { getItem: (k) => globalThis.__store.get(k) ?? null," +
      " setItem: (k, v) => globalThis.__store.set(k, String(v)), removeItem: (k) => globalThis.__store.delete(k) };",
    "const appState = { words: globalThis.__words };",
    `const CONFIDENCE_STORE_KEY = ${JSON.stringify(html.match(/const CONFIDENCE_STORE_KEY = "([^"]+)"/)[1])};`,
    `const CONFIDENCE_MAX_PENDING = ${html.match(/const CONFIDENCE_MAX_PENDING = (\d+);/)[1]};`,
    `const CONFIDENCE_PENDING_TTL_MS = ${html.match(/const CONFIDENCE_PENDING_TTL_MS = ([^;]+);/)[1]};`,
    extractFunction("loadConfidenceStore"),
    extractFunction("saveConfidenceStore"),
    extractFunction("pruneConfidenceStore"),
    "globalThis.__c = { loadConfidenceStore, saveConfidenceStore, pruneConfidenceStore };",
  ];
  new Script(pieces.join("\n\n"), { filename: "confidence-prune-check.js" }).runInNewContext(sandbox);
  const c = sandbox.__c;

  const now = Date.now();
  c.saveConfidenceStore({
    pending: {
      alive: now,                       // 残る
      stale: now - 200 * 86400000,      // 失効（90日超）
      deleted: now,                     // 単語が無い
    },
    tally: { low: 0, mid: 0, high: 3 },
    verified: { correct: 1, wrong: 1 },
    overconfident: ["alive", "deleted"],
  });
  c.pruneConfidenceStore();
  const after = c.loadConfidenceStore();
  assert.deepEqual(Object.keys(after.pending).sort(), ["alive"], "生きている申告だけ残す");
  assert.deepEqual([...after.overconfident], ["alive"], "消えた単語は解き直し対象から外す");
  assert.equal(after.verified.correct, 1, "検証済みの集計は消さない");
});

test("確信度: 較正カードは掃除してから数える", () => {
  const card = html.slice(html.indexOf("function statsConfidenceCard()"));
  const body = card.slice(0, card.indexOf("\n}\n"));
  assert.ok(body.includes("pruneConfidenceStore();"), "描くたびに掃除する");
  assert.ok(
    body.includes("appState.words.some((w) => w.id === id)"),
    "未検証件数に、もう無い単語を数えない",
  );
});

// --- 確信度: レビュー指摘の回帰固定（実動作） ---------------------------
test("確信度: 結果画面で「あやふや」を「知ってる」に数えない", () => {
  // renderReviewResult の計算部だけを取り出して確かめる。
  const src = html.slice(html.indexOf("function renderReviewResult()"));
  const line = src.split("\n").find((l) => l.includes("const correct = Math.max"));
  assert.ok(line, "正解数の計算行が見つからない");
  const calc = new Function(
    "result",
    `${line.trim()} return correct;`,
  );
  // 10語中: 知らない2、あやふや3 → 「知ってる」は5であるべき
  assert.equal(calc({ total: 10, missedCount: 2, midCount: 3 }), 5, "あやふやを差し引く");
  // midCount が無い旧データでも従来どおり動く
  assert.equal(calc({ total: 10, missedCount: 2 }), 8, "旧データは従来の計算");
});

test("確信度: 未採点のカードは「次へ」で飛ばせない", () => {
  const sandbox = { __calls: [] };
  const pieces = [
    "let flashcardSession = { index: 0, order: ['a', 'b'], allIds: ['a', 'b'] };",
    "let currentQuiz = { answered: false };",
    "let flashcardRevealed = true;",
    "let flashcardConfidence = 'high';",
    "const finishFlashcardSession = () => { globalThis.__calls.push('finish'); };",
    "const renderQuiz = () => { globalThis.__calls.push('render'); };",
    extractFunction("advanceFlashcard"),
    "globalThis.__a = { advanceFlashcard, state: () => ({ index: flashcardSession.index })," +
      " answer: () => { currentQuiz.answered = true; } };",
  ];
  new Script(pieces.join("\n\n"), { filename: "advance-check.js" }).runInNewContext(sandbox);
  const a = sandbox.__a;

  a.advanceFlashcard();
  assert.equal(a.state().index, 0, "未採点なら進めない");
  assert.equal(sandbox.__calls.length, 0, "描画も走らない");

  a.answer();
  a.advanceFlashcard();
  assert.equal(a.state().index, 1, "採点済みなら進む");
});

test("確信度: 進行中のセッションは、途中の設定変更に影響されない", () => {
  const build = (sessionMode, settingOn) => {
    const store = new Map();
    if (settingOn) store.set("wordsnap-flashcard-confidence:v1", "1");
    const sandbox = { __store: store };
    const pieces = [
      "const localStorage = { getItem: (k) => globalThis.__store.get(k) ?? null," +
        " setItem: () => {}, removeItem: () => {} };",
      `const FLASHCARD_CONFIDENCE_KEY = ${JSON.stringify(html.match(/const FLASHCARD_CONFIDENCE_KEY = "([^"]+)"/)[1])};`,
      extractFunction("flashcardConfidenceEnabled"),
      sessionMode === null
        ? "let flashcardSession = null;"
        : `let flashcardSession = { confidenceMode: ${sessionMode} };`,
      extractFunction("flashcardSessionConfidenceMode"),
      "globalThis.__m = flashcardSessionConfidenceMode;",
    ];
    new Script(pieces.join("\n\n"), { filename: "mode-check.js" }).runInNewContext(sandbox);
    return sandbox.__m;
  };
  // セッション中は開始時のモードを使う（設定を切り替えても変わらない）
  assert.equal(build(true, false)(), true, "オンで始めたセッションは、設定を切ってもオンのまま");
  assert.equal(build(false, true)(), false, "オフで始めたセッションは、設定を入れてもオフのまま");
  // セッション外は現在の設定を見る（次に始めるときから反映される）
  assert.equal(build(null, true)(), true);
  assert.equal(build(null, false)(), false);
});
