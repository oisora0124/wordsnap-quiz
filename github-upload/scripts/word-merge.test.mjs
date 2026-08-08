import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(scriptDir, "..", "publish", "index.html"), "utf8");

function sourceBetween(startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  assert.ok(start >= 0, `${startNeedle} が見つかること`);
  const end = html.indexOf(endNeedle, start);
  assert.ok(end > start, `${startNeedle} の終端が見つかること`);
  return html.slice(start, end);
}

// 波括弧の対応を取り、公開HTML内の関数をスタブへ置き換えず丸ごと実行する。
function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} が見つかること`);
  const bodyBrace = html.indexOf("{", html.indexOf(")", start));
  let depth = 0;
  for (let index = bodyBrace; index < html.length; index += 1) {
    if (html[index] === "{") depth += 1;
    if (html[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return html.slice(start, index + 1);
  }
  assert.fail(`function ${name} の終端が見つかること`);
}

function makeWordRuntime() {
  const pieces = [
    "const LEARNING_SCHEMA_VERSION = 1;",
    "const WORD_HISTORY_LIMIT = 50;",
    "const SRS_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60, 120];",
    "const SRS_DAY_MS = 24 * 60 * 60 * 1000;",
    "const SRS_MAX_FUTURE_DAYS = 400;",
    "const DAY_MS = 24 * 60 * 60 * 1000;",
    "const DELETION_TTL_MS = 90 * DAY_MS;",
    "const TRASH_TTL_MS = 30 * DAY_MS;",
    "const SAFE_CEFR_LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);",
    "const SAFE_POS_TAGS = new Set(['n', 'v', 'adj', 'adv']);",
    "const selectedIds = new Set();",
    "const clearSavedReviewProgress = () => false;",
    extractFunction("createId"),
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
    extractFunction("mergeStreaks"),
    extractFunction("sanitizeDeletions"),
    extractFunction("trashKeyForWord"),
    extractFunction("sanitizeTrash"),
    extractFunction("wordAddedMs"),
    extractFunction("wordProgressMs"),
    extractFunction("deletionKeyForWord"),
    extractFunction("defaultState"),
    extractFunction("normalizeState"),
    extractFunction("stateSignature"),
    extractFunction("mergeAppStates"),
    extractFunction("mergeTrashEntries"),
    extractFunction("mergeDeckPlacement"),
    extractFunction("mergeWord"),
    extractFunction("mergeHistory"),
    extractFunction("mergeEnrichData"),
    extractFunction("mergeLearningState"),
    extractFunction("minPositiveNumber"),
    extractFunction("learningEvidenceCount"),
    extractFunction("learningEvidence"),
    extractFunction("dominantLearningEvidence"),
    extractFunction("evidenceCoversWrongAnswers"),
    "globalThis.__wordRuntime = {" +
      " normalizeHistory, normalizeLearning, normalizeWord, normalizeState, stateSignature," +
      " mergeHistory, mergeLearningState, mergeEnrichData, mergeWord, mergeAppStates," +
      " evidenceCoversWrongAnswers, dominantLearningEvidence, learningEvidence," +
      " repairFarFutureReviewAt, normalizeStreak, mergeStreaks, mergeDeckPlacement, localDateString };",
  ];
  const context = {};
  vm.runInNewContext(pieces.join("\n\n"), context, { filename: "word-merge-runtime.js" });
  return context.__wordRuntime;
}

function makeLearningRuntime() {
  const schedulerSource = sourceBetween("function scheduleReview(", "\nfunction shuffle(");
  const pieces = [
    "const SRS_DAY_MS = 86400000;",
    "const SRS_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60, 120];",
    "const SLOW_ANSWER_MS = 5000;",
    "const MAX_TIMED_ANSWER_MS = 60000;",
    "const FAST_ANSWER_MS = 3000;",
    "const adaptiveSrsEnabled = () => false;",
    "const wordAccuracyFactor = () => 1;",
    "const personalAccuracyFactorCached = () => 1;",
    "const adaptiveSrsMultiplier = () => 1;",
    "const appState = { quizCounter: 10 };",
    extractFunction("nonNegativeNumber"),
    extractFunction("nonNegativeInteger"),
    "Math.random = () => 0.5;",
    schedulerSource,
    "globalThis.__learningRuntime = { applyLearningResult };",
  ];
  const context = {};
  vm.runInNewContext(pieces.join("\n\n"), context, { filename: "learning-update-runtime.js" });
  return context.__learningRuntime;
}

const runtime = makeWordRuntime();

function learning(overrides = {}) {
  return {
    status: "review",
    firstAttempted: true,
    reviewAt: 12,
    blockedUntil: 0,
    correctStreak: 1,
    srsStage: 2,
    nextReviewAt: Date.now() + 86_400_000,
    srsUpdatedAt: Date.now() - 10_000,
    lastSrsResult: "correct",
    ...overrides,
  };
}

function word(overrides = {}) {
  return {
    id: "word-1",
    term: "apple",
    meaning: "りんご",
    addedAt: "2026-07-01T00:00:00.000Z",
    deckId: "deck-1",
    cefr: { level: "A1", estimated: false },
    pos: { tag: "n", tags: ["n"] },
    enrich: {
      pronunciation: "/ˈæpəl/",
      collocations: null,
      examples: null,
      etymology: null,
      synonyms: null,
    },
    favorite: false,
    favoriteUpdatedAt: 0,
    progressUpdatedAt: Date.now() - 10_000,
    stats: { correct: 3, wrong: 1 },
    history: [
      { at: "2026-07-20T00:00:00.000Z", correct: true },
      { at: "2026-07-21T00:00:00.000Z", correct: false },
    ],
    learning: learning(),
    ...overrides,
  };
}

function state(words, deletions = {}) {
  return {
    learningSchemaVersion: 1,
    words,
    decks: [{ id: "deck-1", name: "単語帳1", updatedAt: 0 }],
    quizCounter: 0,
    activeDeckId: "all",
    savedAt: 0,
    deletions,
    trash: [],
    streak: { count: 0, last: "" },
  };
}

test("古い保存データのお気に入りと進捗の更新時刻は0として正規化する", () => {
  assert.equal(runtime.normalizeWord({ term: "apple", meaning: "りんご", favorite: true }).favoriteUpdatedAt, 0);
  assert.equal(runtime.normalizeWord({ favoriteUpdatedAt: -1 }).favoriteUpdatedAt, 0);
  assert.equal(runtime.normalizeWord({ favoriteUpdatedAt: 12.9 }).favoriteUpdatedAt, 12);
  assert.equal(runtime.normalizeWord({ term: "apple", meaning: "りんご" }).progressUpdatedAt, 0);
  assert.equal(runtime.normalizeWord({ progressUpdatedAt: -1 }).progressUpdatedAt, 0);
  assert.equal(runtime.normalizeWord({ progressUpdatedAt: 12.9 }).progressUpdatedAt, 12);
});

test("新しい端末のお気に入り追加と解除を時刻順に採用する", () => {
  const addedRemotely = runtime.mergeWord(
    word({ favorite: false, favoriteUpdatedAt: 100 }),
    word({ favorite: true, favoriteUpdatedAt: 200 }),
    "remote",
  );
  assert.equal(addedRemotely.favorite, true, "新しい追加を採用すること");
  assert.equal(addedRemotely.favoriteUpdatedAt, 200);

  const removedRemotely = runtime.mergeWord(
    word({ favorite: true, favoriteUpdatedAt: 300 }),
    word({ favorite: false, favoriteUpdatedAt: 400 }),
    "remote",
  );
  assert.equal(removedRemotely.favorite, false, "新しい解除を採用すること");
  assert.equal(removedRemotely.favoriteUpdatedAt, 400);
});

test("お気に入り更新時刻が同値またはローカルの方が新しければローカルを守る", () => {
  for (const remoteUpdatedAt of [500, 499, 0]) {
    const merged = runtime.mergeWord(
      word({ favorite: true, favoriteUpdatedAt: 500 }),
      word({ favorite: false, favoriteUpdatedAt: remoteUpdatedAt }),
      "remote",
    );
    assert.equal(merged.favorite, true, `時刻${remoteUpdatedAt}でローカルを維持すること`);
    assert.equal(merged.favoriteUpdatedAt, 500);
  }
});

test("更新時刻を持たない既存データ同士はローカルのお気に入りを維持する", () => {
  const local = runtime.normalizeWord(word({ favorite: true, favoriteUpdatedAt: undefined }));
  const remote = runtime.normalizeWord(word({ favorite: false, favoriteUpdatedAt: undefined }));
  const merged = runtime.mergeWord(local, remote, "remote");
  assert.equal(merged.favorite, true);
  assert.equal(merged.favoriteUpdatedAt, 0);
});

test("実コードの単語マージは成績・履歴・学習状態・補足情報を欠落させない", () => {
  const now = Date.now();
  const local = runtime.normalizeWord(word({
    stats: { correct: 7, wrong: 1 },
    history: [{ at: "2026-07-20T00:00:00.000Z", correct: true }],
    enrich: { pronunciation: "/local/", etymology: "local-origin" },
    learning: learning({
      status: "review",
      srsUpdatedAt: now - 2_000,
      lastSrsResult: "wrong",
    }),
  }));
  const remote = runtime.normalizeWord(word({
    stats: { correct: 4, wrong: 6 },
    history: [{ at: "2026-07-21T00:00:00.000Z", correct: false }],
    enrich: { examples: ["remote-example"], synonyms: ["remote-synonym"] },
    learning: learning({
      status: "mastered",
      correctStreak: 4,
      srsStage: 4,
      srsUpdatedAt: now - 1_000,
      lastSrsResult: "correct",
    }),
  }));
  const merged = runtime.mergeWord(local, remote, "remote");

  assert.deepEqual(
    { ...merged.stats },
    { correct: 7, wrong: 6 },
    "両端末の実回数を失わないこと",
  );
  assert.deepEqual(
    Array.from(merged.history, (entry) => ({ ...entry })),
    [
      { at: "2026-07-20T00:00:00.000Z", correct: true },
      { at: "2026-07-21T00:00:00.000Z", correct: false },
    ],
    "両端末の回答履歴を残すこと",
  );
  assert.equal(merged.learning.status, "mastered");
  assert.equal(merged.learning.srsStage, 4);
  assert.equal(merged.learning.lastSrsResult, "correct");
  assert.equal(merged.enrich.pronunciation, "/local/");
  assert.equal(merged.enrich.etymology, "local-origin");
  assert.deepEqual([...merged.enrich.examples], ["remote-example"]);
  assert.deepEqual([...merged.enrich.synonyms], ["remote-synonym"]);
});

test("回答時の進捗更新時刻は端末時計が戻っても巻き戻さない", () => {
  const { applyLearningResult } = makeLearningRuntime();
  const target = word({
    progressUpdatedAt: 2_000,
    learning: learning({ nextReviewAt: 0, srsUpdatedAt: 0 }),
  });

  applyLearningResult(target, true, false, 1_000, { responseMs: 1_000 });
  assert.equal(target.progressUpdatedAt, 2_000);
  applyLearningResult(target, false, false, 3_000, { responseMs: 1_000 });
  assert.equal(target.progressUpdatedAt, 3_000);
});

test("削除後に別端末で学習した単語は成績・履歴・SRS状態ごと残す", () => {
  const deletedAt = Date.now() - 20_000;
  const addedAt = new Date(deletedAt - 20_000).toISOString();
  const learnedAt = deletedAt + 5_000;
  const local = runtime.normalizeState(state([], {
    "deck-1 apple": deletedAt,
    "deck-1 orange": deletedAt,
    "deck-1 pear": deletedAt,
  }));
  const remote = runtime.normalizeState(state([
    word({
      term: "apple",
      addedAt,
      progressUpdatedAt: learnedAt,
      stats: { correct: 8, wrong: 3 },
      history: [{ at: new Date(learnedAt).toISOString(), correct: true }],
      learning: learning({
        status: "mastered",
        correctStreak: 3,
        srsUpdatedAt: learnedAt,
        lastSrsResult: "correct",
      }),
      enrich: { examples: ["kept"] },
    }),
    word({
      id: "word-2",
      term: "orange",
      meaning: "オレンジ",
      addedAt,
      progressUpdatedAt: undefined,
      stats: { correct: 2, wrong: 1 },
      history: [{ at: new Date(learnedAt + 1_000).toISOString(), correct: false }],
      learning: learning({ srsUpdatedAt: learnedAt + 1_000, lastSrsResult: "wrong" }),
    }),
    word({
      id: "word-3",
      term: "pear",
      meaning: "梨",
      addedAt,
      progressUpdatedAt: deletedAt - 1_000,
      history: [{ at: new Date(deletedAt - 1_000).toISOString(), correct: true }],
    }),
  ]));

  const merged = runtime.mergeAppStates(local, remote, { normalized: true });
  assert.deepEqual(
    Array.from(merged.words, (entry) => entry.term).sort(),
    ["apple", "orange"],
    "削除後に学習した語だけを残すこと",
  );
  const apple = merged.words.find((entry) => entry.term === "apple");
  assert.deepEqual({ ...apple.stats }, { correct: 8, wrong: 3 });
  assert.equal(apple.history.length, 1);
  assert.equal(apple.learning.status, "mastered");
  assert.deepEqual([...apple.enrich.examples], ["kept"]);
  assert.equal(
    merged.words.find((entry) => entry.term === "orange").progressUpdatedAt,
    0,
    "新フィールドが無い既存データは履歴の最新時刻で保護すること",
  );
});

// マージが収束しないと、端末は毎回「差分あり」と判断してPUTを送り続ける。
// 旧データ（進捗更新時刻を持たない）が履歴由来の値を得たあと、値が動かないことを固定する。
test("旧データのマージは1往復で収束し、以後は差分を出し続けない", () => {
  const legacyWord = (id, term) => {
    const entry = word({ id, term });
    delete entry.progressUpdatedAt;
    return entry;
  };
  const local = runtime.normalizeState(state([legacyWord("w1", "apple"), legacyWord("w2", "banana")]));
  const remote = runtime.normalizeState(state([legacyWord("w1", "apple"), legacyWord("w2", "banana")]));

  const first = runtime.mergeAppStates(local, remote, { normalized: true });
  const second = runtime.mergeAppStates(
    runtime.normalizeState(first),
    runtime.normalizeState(first),
    { normalized: true },
  );
  assert.equal(
    runtime.stateSignature(first),
    runtime.stateSignature(second),
    "2回目のマージで差分が出ないこと（収束）",
  );
  assert.ok(first.words[0].progressUpdatedAt > 0, "旧データにも履歴由来の進捗時刻が入ること");
});

test("マージは左右を入れ替えても同じ結果になる", () => {
  const a = runtime.normalizeState(state([word({ id: "w1" })]));
  const b = runtime.normalizeState(state([
    word({
      id: "w1",
      stats: { correct: 9, wrong: 0 },
      history: [{ at: "2026-07-25T00:00:00.000Z", correct: true }],
      progressUpdatedAt: Date.parse("2026-07-25T00:00:00.000Z"),
    }),
  ]));

  const ab = runtime.mergeAppStates(a, b, { normalized: true });
  const ba = runtime.mergeAppStates(b, a, { normalized: true });
  assert.deepEqual({ ...ab.words[0].stats }, { ...ba.words[0].stats }, "成績が順序に依存しないこと");
  assert.equal(
    ab.words[0].progressUpdatedAt,
    ba.words[0].progressUpdatedAt,
    "進捗の更新時刻が順序に依存しないこと",
  );
  assert.equal(
    ab.words[0].history.length,
    ba.words[0].history.length,
    "履歴の件数が順序に依存しないこと",
  );
});

// 単語帳の移動（単語帳の削除に伴う移動を含む）で単語が複製されないこと。
// ID一致の判定に単語帳まで含めると、移動前後の2件へ割れる。
test("単語帳を移動した単語は、未同期の端末と合流しても複製されない", () => {
  const twoDecks = (words) => ({
    ...state(words),
    decks: [
      { id: "deck-1", name: "単語帳1", updatedAt: 0 },
      { id: "deck-2", name: "単語帳2", updatedAt: 0 },
    ],
  });
  // 端末A: appleを単語帳2へ移動済み／端末B: 移動前のまま単語帳1
  const local = runtime.normalizeState(twoDecks([word({ deckId: "deck-2" })]));
  const remote = runtime.normalizeState(twoDecks([word({ deckId: "deck-1" })]));

  const merged = runtime.mergeAppStates(local, remote, { normalized: true });

  assert.equal(merged.words.length, 1, "移動した単語が2件へ複製されないこと");
  assert.equal(merged.words[0].deckId, "deck-2", "移動先の単語帳が残ること");
  assert.equal(
    new Set(merged.words.map((entry) => entry.id)).size,
    merged.words.length,
    "idが重複しないこと",
  );
});

test("重複IDの再採番順が逆でも成績を同じ単語にだけ結び付ける", () => {
  const now = Date.now();
  const local = runtime.normalizeState(state([
    word({
      id: "duplicate-id",
      term: "apple",
      stats: { correct: 4, wrong: 1 },
      history: [{ at: "2026-07-20T00:00:00.000Z", correct: true }],
      enrich: { pronunciation: "/apple-local/" },
      learning: learning({ status: "review", srsUpdatedAt: now - 4_000 }),
    }),
    word({
      id: "duplicate-id",
      term: "banana",
      meaning: "バナナ",
      stats: { correct: 1, wrong: 3 },
      history: [{ at: "2026-07-20T00:00:01.000Z", correct: false }],
      enrich: { pronunciation: "/banana-local/" },
      learning: learning({
        status: "review",
        srsUpdatedAt: now - 3_000,
        lastSrsResult: "wrong",
      }),
    }),
  ]));
  const remote = runtime.normalizeState(state([
    word({
      id: "duplicate-id",
      term: "banana",
      meaning: "バナナ",
      stats: { correct: 2, wrong: 9 },
      history: [{ at: "2026-07-21T00:00:01.000Z", correct: false }],
      enrich: { examples: ["banana-remote"] },
      learning: learning({
        status: "review",
        correctStreak: 0,
        srsStage: 1,
        srsUpdatedAt: now - 1_000,
        lastSrsResult: "wrong",
      }),
    }),
    word({
      id: "duplicate-id",
      term: "apple",
      stats: { correct: 8, wrong: 2 },
      history: [{ at: "2026-07-21T00:00:00.000Z", correct: true }],
      enrich: { examples: ["apple-remote"] },
      learning: learning({
        status: "mastered",
        correctStreak: 4,
        srsStage: 4,
        srsUpdatedAt: now - 2_000,
        lastSrsResult: "correct",
      }),
    }),
  ]));

  const merged = runtime.mergeAppStates(local, remote, { normalized: true });
  assert.equal(merged.words.length, 2);
  const apple = merged.words.find((entry) => entry.term === "apple");
  const banana = merged.words.find((entry) => entry.term === "banana");
  assert.deepEqual({ ...apple.stats }, { correct: 8, wrong: 2 });
  assert.deepEqual({ ...banana.stats }, { correct: 2, wrong: 9 });
  assert.deepEqual(
    Array.from(apple.history, (entry) => entry.at),
    ["2026-07-20T00:00:00.000Z", "2026-07-21T00:00:00.000Z"],
  );
  assert.deepEqual(
    Array.from(banana.history, (entry) => entry.at),
    ["2026-07-20T00:00:01.000Z", "2026-07-21T00:00:01.000Z"],
  );
  assert.equal(apple.learning.status, "mastered");
  assert.equal(banana.learning.lastSrsResult, "wrong");
  assert.deepEqual([...apple.enrich.examples], ["apple-remote"]);
  assert.deepEqual([...banana.enrich.examples], ["banana-remote"]);
});

test("順序が崩れた履歴も時刻順に並べてから最新50件を残す", () => {
  const base = Date.parse("2026-07-01T00:00:00.000Z");
  const unordered = Array.from({ length: 60 }, (_, index) => ({
    at: new Date(base + index * 1_000).toISOString(),
    correct: index % 2 === 0,
  })).reverse();
  const normalized = runtime.normalizeHistory(unordered);

  assert.equal(normalized.length, 50);
  assert.equal(normalized[0].at, new Date(base + 10_000).toISOString());
  assert.equal(normalized[49].at, new Date(base + 59_000).toISOString());
  assert.ok(
    normalized.every((entry, index) => index === 0 || normalized[index - 1].at <= entry.at),
    "保存された50件も時刻順であること",
  );
});

test("お気に入りのUI操作は値と更新時刻を同時に保存する", () => {
  const handlerSource = sourceBetween(
    '  const favoriteButton = event.target.closest("[data-favorite-word]");',
    "\n  const deleteButton",
  );
  const savedWord = word({ favorite: false, favoriteUpdatedAt: 0 });
  let saveCount = 0;
  const context = {
    appState: { words: [savedWord] },
    Date: { now: () => 987654321 },
    saveState: () => { saveCount += 1; },
    setStatus() {},
  };
  vm.runInNewContext(
    `globalThis.__handleFavorite = (event) => {\n${handlerSource}\n};`,
    context,
  );
  context.__handleFavorite({
    target: {
      closest: (selector) =>
        selector === "[data-favorite-word]"
          ? { dataset: { favoriteWord: "word-1" } }
          : null,
    },
  });
  assert.equal(savedWord.favorite, true);
  assert.equal(savedWord.favoriteUpdatedAt, 987654321);
  assert.equal(saveCount, 1);
});


// ---- 2026-08-02 機能レビュー（Codex指摘）で入れた修正の凍結ゲート ----

test("時計が未来にずれた端末の復習予定は取り込み時に0へ戻す", () => {
  const runtime = makeWordRuntime();
  const day = 24 * 60 * 60 * 1000;
  const farFuture = Date.now() + 4 * 365 * day;
  const repaired = runtime.normalizeLearning({
    learning: { status: "mastered", srsStage: 5, correctStreak: 2, nextReviewAt: farFuture },
  });
  // 0 は旧データと同じ「SRS未開始」。availableQuizWords の救済分岐に乗り、
  // 次に解いた時点で正しい時計から予定が引き直される。
  assert.equal(repaired.nextReviewAt, 0, "実現しえない未来の復習予定は0へ戻す");
  assert.equal(repaired.srsStage, 5, "段階（学習の積み上げ）は捨てない");
  assert.equal(repaired.status, "mastered", "習得済みの判定も捨てない");

  // 正常に付きうる範囲（最長120日×ばらつき×個人適応で約215日）はそのまま残す。
  const legit = Date.now() + 200 * day;
  const kept = runtime.normalizeLearning({
    learning: { status: "mastered", srsStage: 7, nextReviewAt: legit },
  });
  assert.equal(kept.nextReviewAt, legit, "正常な範囲の復習予定は書き換えない");
});

test("単語帳の移動は後から動かした方を採用し、旧データ同士ではローカルを守る", () => {
  const runtime = makeWordRuntime();
  const older = 1000;
  const newer = 2000;
  const remoteNewer = runtime.mergeDeckPlacement(
    { deckId: "d1", deckUpdatedAt: older },
    { deckId: "d2", deckUpdatedAt: newer },
    "remote",
  );
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(remoteNewer), { deckId: "d2", deckUpdatedAt: newer }, "新しい移動を採用する");

  // 左右を入れ替えても同じ結果になる（同期の収束に必要）。
  const swapped = runtime.mergeDeckPlacement(
    { deckId: "d2", deckUpdatedAt: newer },
    { deckId: "d1", deckUpdatedAt: older },
    "remote",
  );
  assert.deepEqual(plain(swapped), { deckId: "d2", deckUpdatedAt: newer }, "引数順で結果が変わらない");

  // 移動時刻を持たない旧データ同士は従来どおりローカル優先（既存の合流結果を変えない）。
  assert.deepEqual(
    plain(runtime.mergeDeckPlacement({ deckId: "d1", deckUpdatedAt: 0 }, { deckId: "d2", deckUpdatedAt: 0 }, "remote")),
    { deckId: "d1", deckUpdatedAt: 0 },
    "旧データ同士はローカルの所属を維持する",
  );

  // 時計が未来にずれた端末の移動時刻は「主張なし」として扱う。
  const future = Date.now() + 60 * 60 * 1000;
  assert.equal(
    runtime.mergeDeckPlacement({ deckId: "d1", deckUpdatedAt: 1000 }, { deckId: "d2", deckUpdatedAt: future }, "remote").deckId,
    "d1",
    "未来のタイムスタンプに移動の優先権を与えない",
  );
});

test("未来日付のストリークは今日へ丸め、同期のたびに連続日数が止まるのを防ぐ", () => {
  const runtime = makeWordRuntime();
  const today = runtime.localDateString(new Date());
  const far = "2030-01-01";

  const repaired = runtime.normalizeStreak({ count: 5, last: far, best: 9 });
  assert.equal(repaired.last, today, "未来日付は今日へ丸める");
  assert.equal(repaired.count, 5, "連続日数は捨てない");
  assert.equal(repaired.best, 9, "過去最高も残す");

  // 未来日付が文字列比較で常に勝ち、正しい日付の記録を負かし続けるのを止める。
  const merged = runtime.mergeStreaks({ count: 5, last: far, best: 9 }, { count: 3, last: today, best: 3 });
  assert.notEqual(merged.last, far, "未来日付をマージ結果に残さない");
  assert.equal(merged.last, today, "現実の日付へ収束する");
});

test("実コードのマージでも、後から動かした単語帳が採用される", () => {
  // mergeDeckPlacement 単体だけを見ていると、mergeWord 側の呼び出しを旧実装へ戻しても
  // 気づけない（2026-08-02の突然変異テストで実際に空振りした）。実経路で固定する。
  const runtime = makeWordRuntime();
  const base = { id: "wordone", term: "apple", meaning: "りんご", addedAt: "2026-01-01T00:00:00.000Z" };
  const inDeck1 = runtime.normalizeWord({ ...base, deckId: "deckone", deckUpdatedAt: 1000 });
  const inDeck2 = runtime.normalizeWord({ ...base, deckId: "decktwo", deckUpdatedAt: 2000 });

  assert.equal(runtime.mergeWord(inDeck1, inDeck2, "remote").deckId, "decktwo",
    "リモート側の新しい移動を採用する");
  assert.equal(runtime.mergeWord(inDeck2, inDeck1, "remote").deckId, "decktwo",
    "ローカル側が新しければローカルの移動を守る（引数順で結果が変わらない）");
  assert.equal(runtime.mergeWord(inDeck1, inDeck2, "remote").deckUpdatedAt, 2000,
    "採用した移動の時刻を残す（次の合流でも勝てるように）");

  // 移動時刻を持たない旧データ同士は従来どおりローカル維持。
  const legacy1 = runtime.normalizeWord({ ...base, deckId: "deckone" });
  const legacy2 = runtime.normalizeWord({ ...base, deckId: "decktwo" });
  assert.equal(runtime.mergeWord(legacy1, legacy2, "remote").deckId, "deckone",
    "旧データ同士は既存の合流結果を変えない");
});

// ---- 2端末の往復（実機同期の代わりに、実コードのマージで往復させる） ----

function twoDeviceWord(overrides) {
  return {
    id: "wordone",
    term: "apple",
    meaning: "りんご",
    addedAt: "2026-01-01T00:00:00.000Z",
    stats: { correct: 3, wrong: 1 },
    history: [{ at: "2026-07-01T00:00:00.000Z", correct: true }],
    learning: { status: "review", srsStage: 2, correctStreak: 1, firstAttempted: true, nextReviewAt: 0 },
    ...overrides,
  };
}

function twoDeviceState(runtime, word, extra) {
  return runtime.normalizeState({
    words: [word],
    decks: [{ id: "deckone", name: "A帳" }, { id: "decktwo", name: "B帳" }],
    activeDeckId: "all",
    ...(extra || {}),
  });
}

test("2端末の往復: 単語帳の移動が反映され、往復しても元へ戻らない", () => {
  const runtime = makeWordRuntime();
  const knowsNothing = twoDeviceState(runtime, twoDeviceWord({ deckId: "deckone", deckUpdatedAt: 0 }));
  const moved = twoDeviceState(runtime, twoDeviceWord({ deckId: "decktwo", deckUpdatedAt: 2000 }));

  // 端末Aが端末Bの状態を取り込む
  const a1 = runtime.mergeAppStates(knowsNothing, moved, { normalized: true });
  assert.equal(a1.words[0].deckId, "decktwo", "別端末での移動が反映される");

  // Aが押し戻し、Bが取り込む（ここで元へ戻っていたのが今回の不具合）
  const b1 = runtime.mergeAppStates(moved, a1, { normalized: true });
  assert.equal(b1.words[0].deckId, "decktwo", "往復しても移動が消えない");

  // もう1往復して両端末が一致する（収束する）
  const a2 = runtime.mergeAppStates(a1, b1, { normalized: true });
  assert.equal(
    runtime.stateSignature(a2),
    runtime.stateSignature(b1),
    "2往復で両端末の状態が一致する",
  );

  // 移動を運ぶために学習データを失っていないこと
  assert.equal(a2.words[0].stats.correct, 3, "成績を失わない");
  assert.equal(a2.words[0].stats.wrong, 1, "成績を失わない");
  assert.equal(a2.words[0].history.length, 1, "回答履歴を失わない");
  assert.equal(a2.words[0].learning.srsStage, 2, "SRSの段階を失わない");
  assert.equal(a2.words[0].learning.status, "review", "学習状態を失わない");
});

test("2端末の往復: 時計の狂った端末の値が、正常な端末の学習を壊さない", () => {
  const runtime = makeWordRuntime();
  const day = 24 * 60 * 60 * 1000;
  const healthy = twoDeviceState(
    runtime,
    twoDeviceWord({ deckId: "deckone", learning: { status: "mastered", srsStage: 5, correctStreak: 2, firstAttempted: true, nextReviewAt: Date.now() + 3 * day } }),
    { streak: { count: 4, last: runtime.localDateString(new Date()), best: 9 } },
  );
  // 時計を2030年に設定した端末が作った状態
  const skewed = twoDeviceState(
    runtime,
    twoDeviceWord({ deckId: "deckone", learning: { status: "mastered", srsStage: 5, correctStreak: 2, firstAttempted: true, nextReviewAt: Date.now() + 4 * 365 * day } }),
    { streak: { count: 1, last: "2030-01-01", best: 1 } },
  );

  // 危ないのは「壊れた値しか存在しない」語。両端末に同じ語があると
  // mergeLearningState が小さい方（正常値）を採るため、修復が無くても通ってしまう。
  // 実際の事故は、狂った端末にしか無い語や、自分の端末の保存値が狂っていた場合に起きる。
  const onlyOnSkewed = runtime.normalizeState({
    ...skewed,
    words: [
      ...skewed.words,
      twoDeviceWord({
        id: "wordtwo",
        term: "banana",
        meaning: "バナナ",
        deckId: "deckone",
        learning: { status: "mastered", srsStage: 5, correctStreak: 2, firstAttempted: true, nextReviewAt: Date.now() + 4 * 365 * day },
      }),
    ],
  });

  // 読み込みの時点（自分の保存値が狂っていた場合）で直っていること
  const lone = onlyOnSkewed.words.find((word) => word.id === "wordtwo");
  assert.equal(lone.learning.nextReviewAt, 0, "壊れた復習予定は読み込み時に0へ戻す");
  assert.equal(lone.learning.srsStage, 5, "段階は保つ");

  const merged = runtime.mergeAppStates(healthy, onlyOnSkewed, { normalized: true });
  const carried = merged.words.find((word) => word.id === "wordtwo");
  assert.ok(carried, "狂った端末にしかない語も失わない");
  assert.ok(
    carried.learning.nextReviewAt <= Date.now() + 400 * day,
    "未来へ飛んだ復習予定を同期で持ち込ませない（習得語が出題から消えない）",
  );
  assert.equal(carried.learning.srsStage, 5, "同期後も段階は保つ");
  assert.ok(
    merged.words[0].learning.nextReviewAt <= Date.now() + 400 * day,
    "両端末にある語も未来へ飛ばさない",
  );
  assert.notEqual(merged.streak.last, "2030-01-01", "未来日付のストリークを残さない");
  assert.ok(merged.streak.count > 0, "連続日数を0にはしない");

  // 逆順でも同じ結論になる（どちらが先に同期しても壊れない）
  const reversed = runtime.mergeAppStates(onlyOnSkewed, healthy, { normalized: true });
  const reversedCarried = reversed.words.find((word) => word.id === "wordtwo");
  assert.ok(
    reversedCarried.learning.nextReviewAt <= Date.now() + 400 * day,
    "取り込む向きが逆でも未来の復習予定を残さない",
  );
  assert.notEqual(reversed.streak.last, "2030-01-01", "向きが逆でも未来日付を残さない");
});

// ────────────────────────────────────────────────────────────────────────────
// 学習状態マージの因果判定（証拠ベクトル）。設計は docs/DESIGN-2026-08-08-srs-merge-evidence.md。
// srsUpdatedAt は端末の時計なので、時計が遅れた端末は解答が少なくても「新しい」と
// 主張して勝ててしまう（clampSrsTs は進んだ時計しか弾けない）。解答数は時計に
// 依存しないため、これで因果の前後を判定する。
// ────────────────────────────────────────────────────────────────────────────

// 解答 n 件ぶんの履歴。時刻は端末の時計（offsetMs）で刻む。
function answerHistory(count, { correct = true, startMs, stepMs = 60_000 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    at: new Date(startMs + index * stepMs).toISOString(),
    correct,
  }));
}

function evidenceWord(overrides) {
  const { learning, ...rest } = overrides || {};
  return {
    id: "wordone",
    term: "apple",
    meaning: "りんご",
    deckId: "deckone",
    addedAt: "2026-01-01T00:00:00.000Z",
    ...rest,
    learning: {
      status: "review",
      firstAttempted: true,
      reviewAt: 0,
      blockedUntil: 0,
      lastSrsResult: "correct",
      ...(learning || {}),
    },
  };
}

const EV_BASE = Date.UTC(2026, 6, 1);

test("解答数で勝つ側が、時計の遅れた新しい時刻に負けない（D2）", () => {
  const runtime = makeWordRuntime();
  // 進んだ端末。時計が1時間遅れているので srsUpdatedAt は古く見える。
  const advanced = evidenceWord({
    stats: { correct: 6, wrong: 0 },
    history: answerHistory(6, { startMs: EV_BASE }),
    progressUpdatedAt: EV_BASE - 3_600_000,
    learning: {
      status: "mastered", srsStage: 5, correctStreak: 6,
      nextReviewAt: EV_BASE + 30 * 86_400_000, srsUpdatedAt: EV_BASE - 3_600_000,
    },
  });
  // 長く同期していなかった端末。1回しか解いていないが時計は正常で新しい。
  const behind = evidenceWord({
    stats: { correct: 1, wrong: 0 },
    history: answerHistory(1, { startMs: EV_BASE + 7 * 86_400_000 }),
    progressUpdatedAt: EV_BASE,
    learning: {
      status: "review", srsStage: 1, correctStreak: 1,
      nextReviewAt: EV_BASE + 86_400_000, srsUpdatedAt: EV_BASE,
    },
  });

  for (const [left, right, label] of [
    [advanced, behind, "進んだ側から取り込む"],
    [behind, advanced, "遅れた側から取り込む"],
  ]) {
    const merged = runtime.mergeWord(
      runtime.normalizeWord(left),
      runtime.normalizeWord(right),
      "remote",
    );
    assert.equal(merged.learning.srsStage, 5, `${label}: 段階が巻き戻らない`);
    assert.equal(merged.learning.correctStreak, 6, `${label}: 連続正解数が巻き戻らない`);
    assert.equal(merged.learning.status, "mastered", `${label}: 習得状態が消えない`);
  }
});

test("誤答で正当に降格した新しい状態を、古い高段階が消さない", () => {
  const runtime = makeWordRuntime();
  // 同期済みの地点から、片方だけが「誤答→正解」と進んだ。lastSrsResult は correct のまま
  // 段階だけが低いので、時刻でも「正解では下がらない」不変条件でも区別できない形。
  const stale = evidenceWord({
    stats: { correct: 6, wrong: 0 },
    history: answerHistory(6, { startMs: EV_BASE }),
    progressUpdatedAt: EV_BASE + 5 * 60_000,
    learning: {
      status: "mastered", srsStage: 5, correctStreak: 6,
      nextReviewAt: EV_BASE + 30 * 86_400_000, srsUpdatedAt: EV_BASE + 5 * 60_000,
    },
  });
  const demoted = evidenceWord({
    stats: { correct: 7, wrong: 1 },
    history: [
      ...answerHistory(6, { startMs: EV_BASE }),
      { at: new Date(EV_BASE + 86_400_000).toISOString(), correct: false },
      { at: new Date(EV_BASE + 2 * 86_400_000).toISOString(), correct: true },
    ],
    progressUpdatedAt: EV_BASE + 2 * 86_400_000,
    learning: {
      status: "review", srsStage: 4, correctStreak: 1,
      nextReviewAt: EV_BASE + 3 * 86_400_000, srsUpdatedAt: EV_BASE + 2 * 86_400_000,
    },
  });

  for (const [left, right, label] of [
    [stale, demoted, "古い側から取り込む"],
    [demoted, stale, "降格した側から取り込む"],
  ]) {
    const merged = runtime.mergeWord(
      runtime.normalizeWord(left),
      runtime.normalizeWord(right),
      "remote",
    );
    assert.equal(merged.learning.srsStage, 4, `${label}: 正当な降格が残る`);
    assert.equal(merged.learning.status, "review", `${label}: 復習へ戻した状態が残る`);
  }
});

test("勝つ側が持っていない誤答があるときは、証拠判定を使わず取りこぼさない", () => {
  const runtime = makeWordRuntime();
  // 両端末とも誤答1件・別々の事象。正解数は左が多いので数の上では左が支配するが、
  // 右の誤答を左は見ていない。ここで左を採ると「忘れた語が復習に戻らない」ため落とす。
  const manyCorrect = evidenceWord({
    stats: { correct: 7, wrong: 1 },
    history: [
      { at: new Date(EV_BASE).toISOString(), correct: false },
      ...answerHistory(7, { startMs: EV_BASE + 60_000 }),
    ],
    progressUpdatedAt: EV_BASE + 8 * 60_000,
    learning: {
      status: "mastered", srsStage: 5, correctStreak: 5,
      nextReviewAt: EV_BASE + 30 * 86_400_000, srsUpdatedAt: EV_BASE + 8 * 60_000,
    },
  });
  const freshWrong = evidenceWord({
    stats: { correct: 5, wrong: 1 },
    history: [
      ...answerHistory(5, { startMs: EV_BASE + 60_000 }),
      { at: new Date(EV_BASE + 9 * 60_000).toISOString(), correct: false },
    ],
    progressUpdatedAt: EV_BASE + 9 * 60_000,
    learning: {
      status: "review", srsStage: 1, correctStreak: 0, lastSrsResult: "wrong",
      nextReviewAt: EV_BASE + 86_400_000, srsUpdatedAt: EV_BASE + 9 * 60_000,
    },
  });

  for (const [left, right, label] of [
    [manyCorrect, freshWrong, "正解の多い側から取り込む"],
    [freshWrong, manyCorrect, "誤答した側から取り込む"],
  ]) {
    const merged = runtime.mergeWord(
      runtime.normalizeWord(left),
      runtime.normalizeWord(right),
      "remote",
    );
    assert.equal(merged.learning.status, "review", `${label}: 誤答を取りこぼさない`);
    assert.ok(merged.learning.srsStage <= 1, `${label}: 段階を上げ直さない`);
  }
});

test("解答数が同じ（真に並行）なら従来どおり時刻と保守的マージで決める", () => {
  const runtime = makeWordRuntime();
  const base = {
    stats: { correct: 4, wrong: 0 },
    history: answerHistory(4, { startMs: EV_BASE }),
  };
  const older = evidenceWord({
    ...base,
    progressUpdatedAt: EV_BASE + 60_000,
    learning: {
      status: "mastered", srsStage: 5, correctStreak: 4,
      nextReviewAt: EV_BASE + 30 * 86_400_000, srsUpdatedAt: EV_BASE + 60_000,
    },
  });
  const newerWrong = evidenceWord({
    ...base,
    progressUpdatedAt: EV_BASE + 120_000,
    learning: {
      status: "review", srsStage: 3, correctStreak: 0, lastSrsResult: "wrong",
      nextReviewAt: EV_BASE + 86_400_000, srsUpdatedAt: EV_BASE + 120_000,
    },
  });
  const merged = runtime.mergeWord(
    runtime.normalizeWord(older),
    runtime.normalizeWord(newerWrong),
    "remote",
  );
  assert.equal(merged.learning.srsStage, 3, "解答数が同じなら新しい時刻の側を採る（従来どおり）");
  assert.equal(merged.learning.status, "review", "新しい誤答が古い習得に負けない（従来どおり）");
});

test("証拠を渡さない2引数呼び出しは従来と完全に同じ結果を返す", () => {
  const runtime = makeWordRuntime();
  const a = {
    status: "mastered", srsStage: 5, correctStreak: 4, firstAttempted: true,
    reviewAt: 0, blockedUntil: 0, nextReviewAt: EV_BASE + 30 * 86_400_000,
    srsUpdatedAt: EV_BASE + 60_000, lastSrsResult: "correct",
  };
  const b = {
    status: "review", srsStage: 1, correctStreak: 1, firstAttempted: true,
    reviewAt: 0, blockedUntil: 0, nextReviewAt: EV_BASE + 86_400_000,
    srsUpdatedAt: EV_BASE + 120_000, lastSrsResult: "correct",
  };
  // 証拠なし＝時刻LWW。新しい側（b）がそのまま採られる。
  const merged = runtime.mergeLearningState(a, b);
  assert.equal(merged.srsStage, 1, "証拠なしでは時刻の新しい側を採る");
  assert.equal(merged.correctStreak, 1, "証拠なしでは時刻の新しい側の連続正解数を採る");
  // 同じ入力に証拠を添えると、解答数の多い側が勝つ。
  const withEvidence = runtime.mergeLearningState(
    a, b,
    { correct: 6, wrong: 0, history: answerHistory(6, { startMs: EV_BASE }) },
    { correct: 1, wrong: 0, history: answerHistory(1, { startMs: EV_BASE + 86_400_000 }) },
  );
  assert.equal(withEvidence.srsStage, 5, "証拠ありでは解答数の多い側を採る");
});

test("証拠判定は左右対称で、往復しても振動しない", () => {
  const runtime = makeWordRuntime();
  const advanced = twoDeviceState(runtime, evidenceWord({
    stats: { correct: 6, wrong: 0 },
    history: answerHistory(6, { startMs: EV_BASE }),
    progressUpdatedAt: EV_BASE - 3_600_000,
    learning: {
      status: "mastered", srsStage: 5, correctStreak: 6,
      nextReviewAt: EV_BASE + 30 * 86_400_000, srsUpdatedAt: EV_BASE - 3_600_000,
    },
  }));
  const behind = twoDeviceState(runtime, evidenceWord({
    stats: { correct: 1, wrong: 0 },
    history: answerHistory(1, { startMs: EV_BASE + 7 * 86_400_000 }),
    progressUpdatedAt: EV_BASE,
    learning: {
      status: "review", srsStage: 1, correctStreak: 1,
      nextReviewAt: EV_BASE + 86_400_000, srsUpdatedAt: EV_BASE,
    },
  }));

  let a = advanced;
  let b = behind;
  const seen = [];
  for (let round = 0; round < 5; round += 1) {
    const nextA = runtime.mergeAppStates(a, b, { normalized: true });
    const nextB = runtime.mergeAppStates(b, nextA, { normalized: true });
    a = nextA;
    b = nextB;
    seen.push(runtime.stateSignature(a) + "|" + runtime.stateSignature(b));
  }
  assert.equal(seen[0], seen[seen.length - 1], "往復を重ねても状態が行き来しない");
  assert.equal(
    a.words[0].learning.srsStage,
    5,
    "収束先が進んだ側の段階になる",
  );
  assert.equal(
    runtime.stateSignature(a),
    runtime.stateSignature(b),
    "両端末が同じ状態になる",
  );
});

test("履歴から押し出された誤答は、証拠判定を止める", () => {
  const runtime = makeWordRuntime();
  // 履歴は直近50件しか残らない。何十回も解いた語では古い誤答が押し出され、
  // 履歴上は全件正解に見えるのに stats には誤答が残る。この「確かめられない誤答」を
  // 見逃すと、別々の誤答を同数持つ2端末で照合が空振りして通り、
  // 負けた側の復習状態が消える（レビュー3巡目の指摘）。
  const manyCorrect = {
    status: "mastered", srsStage: 7, correctStreak: 12, firstAttempted: true,
    reviewAt: 0, blockedUntil: 0, nextReviewAt: EV_BASE + 120 * 86_400_000,
    srsUpdatedAt: EV_BASE + 60_000, lastSrsResult: "correct",
  };
  const hadWrongs = {
    status: "review", srsStage: 3, correctStreak: 2, firstAttempted: true,
    reviewAt: 0, blockedUntil: 0, nextReviewAt: EV_BASE + 7 * 86_400_000,
    // 時刻を同じにして、判定が証拠だけで決まるようにする
    srsUpdatedAt: EV_BASE + 60_000, lastSrsResult: "correct",
  };
  // どちらの履歴も直近50件＝すべて正解。誤答は stats にしか残っていない。
  const trimmedHistory = answerHistory(50, { startMs: EV_BASE });

  // (1) 誤答数で劣る側は、正解数が多くても支配側にならない
  assert.equal(
    runtime.mergeLearningState(
      manyCorrect, hadWrongs,
      { correct: 60, wrong: 0, history: trimmedHistory },
      { correct: 58, wrong: 3, history: trimmedHistory },
    ).srsStage,
    3,
    "誤答数で相手に劣る側は支配側にならない",
  );

  // (2) 誤答数が同じでも、負けた側の誤答が履歴から消えていれば「見た」と言えない。
  //     ここを通してしまうのが3巡目に指摘された穴。
  assert.equal(
    runtime.mergeLearningState(
      manyCorrect, hadWrongs,
      { correct: 60, wrong: 3, history: trimmedHistory },
      { correct: 58, wrong: 3, history: trimmedHistory },
    ).srsStage,
    3,
    "確かめられない誤答があるうちは証拠判定を使わない",
  );

  // (3) 負けた側の誤答がすべて履歴に残っていて、勝った側もそれを持っているなら採用する
  //     （上の2つが過剰でないことの確認）
  const sharedWrongAt = new Date(EV_BASE + 5 * 60_000).toISOString();
  const withVisibleWrong = [
    ...answerHistory(5, { startMs: EV_BASE }),
    { at: sharedWrongAt, correct: false },
    ...answerHistory(4, { startMs: EV_BASE + 6 * 60_000 }),
  ];
  assert.equal(
    runtime.mergeLearningState(
      manyCorrect, hadWrongs,
      { correct: 9, wrong: 1, history: withVisibleWrong },
      { correct: 6, wrong: 1, history: withVisibleWrong.slice(0, 6) },
    ).srsStage,
    7,
    "誤答が履歴で照合できるなら、解答数の多い側を採る",
  );
});

test("向きを変えても学習状態が変わらない（ランダム1000通り）", () => {
  const runtime = makeWordRuntime();
  // 往復合流だけを見ていると、履歴の和集合が成績を押し上げて同点が崩れ、
  // 左右非対称な判定バグが隠れる（実際に隠れた）。単発の合流を直接比べる。
  // 乱数は固定種で、失敗したら同じ入力を再現できるようにする。
  let seed = 20260808;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const int = (max) => Math.floor(rnd() * max);
  const makeSide = (base) => {
    const correct = int(40);
    const wrong = int(10);
    const total = Math.min(50, correct + wrong);
    const wrongLeft = { n: wrong };
    return {
      ...evidenceWord({
        stats: { correct, wrong },
        history: Array.from({ length: total }, (_, index) => {
          const isWrong = wrongLeft.n > 0 && rnd() < 0.3;
          if (isWrong) wrongLeft.n -= 1;
          return {
            at: new Date(base + index * 3_600_000 + int(1000)).toISOString(),
            correct: !isWrong,
          };
        }),
        progressUpdatedAt: base + int(10) * 86_400_000,
      }),
      learning: {
        status: ["new", "review", "mastered"][int(3)],
        firstAttempted: true,
        reviewAt: int(5),
        blockedUntil: base + int(3) * 86_400_000,
        correctStreak: int(6),
        srsStage: int(8),
        nextReviewAt: base + int(60) * 86_400_000,
        srsUpdatedAt: base + int(20) * 86_400_000,
        lastSrsResult: ["correct", "wrong", ""][int(3)],
      },
    };
  };

  for (let trial = 0; trial < 1000; trial += 1) {
    const left = runtime.normalizeWord(makeSide(EV_BASE));
    const rightRaw = makeSide(EV_BASE + int(5) * 86_400_000);
    // 4割は成績を左とぴったり同じにする。支配関係が付かない「同点」は
    // 判定が従来ロジックへ落ちる分かれ道で、非対称なバグが出るならここ。
    // 完全なランダムだと同点は400回に1回しか起きず、検査にならない。
    if (rnd() < 0.4) rightRaw.stats = { ...left.stats };
    const right = runtime.normalizeWord(rightRaw);
    const forward = runtime.mergeWord(left, right, "remote").learning;
    const backward = runtime.mergeWord(right, left, "remote").learning;
    assert.deepEqual(
      forward,
      backward,
      `${trial}回目: 取り込む向きで学習状態が変わる\n` +
        `  左 ${JSON.stringify(left.stats)} ${JSON.stringify(left.learning)}\n` +
        `  右 ${JSON.stringify(right.stats)} ${JSON.stringify(right.learning)}`,
    );
  }
});

test("時計が先に進んだ端末は、相手の誤答を履歴の窓の外へ追い出せない", () => {
  const runtime = makeWordRuntime();
  // Codex の指摘。履歴が上限(WORD_HISTORY_LIMIT件)に達していない端末の履歴を
  // まるごと未来へずらすと、相手の正当な誤答が「最古エントリより古い」となって
  // 判定から外れ、誤答を持っていない側が証拠で勝ててしまっていた。
  // 上限未満の履歴は一度も切り詰められていないので、載っていない＝見ていない、と断定できる。
  //
  // 時計が進んだ端末は clampSrsTs で時刻の主張を失う（＝従来なら必ず負ける）。
  // それを再現するため、ここだけは実時刻を基準にする。
  const now = Date.now();
  const hour = 3_600_000;
  const skewedAhead = evidenceWord({
    stats: { correct: 6, wrong: 1 },
    // 7件すべてが1時間先。上限には遠く届かない＝切り詰めは起きていない。
    history: [
      { at: new Date(now + hour).toISOString(), correct: false },
      ...answerHistory(6, { startMs: now + hour + 60_000 }),
    ],
    progressUpdatedAt: now + hour,
    learning: {
      status: "mastered", srsStage: 5, correctStreak: 5,
      nextReviewAt: now + 30 * 86_400_000, srsUpdatedAt: now + hour,
    },
  });
  const justAnsweredWrong = evidenceWord({
    stats: { correct: 1, wrong: 1 },
    history: [
      ...answerHistory(1, { startMs: now - 120_000 }),
      { at: new Date(now - 60_000).toISOString(), correct: false },
    ],
    progressUpdatedAt: now - 60_000,
    learning: {
      status: "review", srsStage: 1, correctStreak: 0, lastSrsResult: "wrong",
      nextReviewAt: now + 86_400_000, srsUpdatedAt: now - 60_000,
    },
  });

  // 「履歴が上限50件に達していれば切り詰め済み」も証明にならない。ちょうど50問
  // 解いただけの端末は一度も切り詰められていない（Codex の2回目の指摘）。
  const skewedAtLimit = evidenceWord({
    stats: { correct: 49, wrong: 1 },
    history: [
      { at: new Date(now + hour).toISOString(), correct: false },
      ...answerHistory(49, { startMs: now + hour + 60_000 }),
    ],
    progressUpdatedAt: now + hour,
    learning: {
      status: "mastered", srsStage: 5, correctStreak: 40,
      nextReviewAt: now + 30 * 86_400_000, srsUpdatedAt: now + hour,
    },
  });

  for (const [left, right, label] of [
    [skewedAhead, justAnsweredWrong, "進んだ時計の側から取り込む（履歴7件）"],
    [justAnsweredWrong, skewedAhead, "誤答した側から取り込む（履歴7件）"],
    [skewedAtLimit, justAnsweredWrong, "進んだ時計の側から取り込む（履歴ちょうど50件）"],
    [justAnsweredWrong, skewedAtLimit, "誤答した側から取り込む（履歴ちょうど50件）"],
  ]) {
    const merged = runtime.mergeWord(
      runtime.normalizeWord(left),
      runtime.normalizeWord(right),
      "remote",
    );
    assert.equal(merged.learning.status, "review", `${label}: 誤答が握りつぶされない`);
    assert.ok(merged.learning.srsStage <= 1, `${label}: 習得へ戻さない`);
  }
});

test("検証を済ませた端末へ、相手の古い検証待ちマークを戻さない", () => {
  const runtime = makeWordRuntime();
  // 仮習得(masteryVerify)は「期限到来後の4択で確かめるまで本習得にしない」安全装置。
  // 両側のORで残すと、合流結果は両端末に保存されるため、検証するたびに相手側の
  // 古いマークが復活し、永久に本習得へ到達できなくなる（Codex の2回目の指摘）。
  // 検証は必ず正答数を1増やすので、検証した側は解答数でも時刻でも勝つ。
  // 勝った側だけを見れば検証結果が正しく伝わり、ループも起きない。
  const verified = evidenceWord({
    stats: { correct: 6, wrong: 0 },
    history: answerHistory(6, { startMs: EV_BASE }),
    progressUpdatedAt: EV_BASE + 6 * 60_000,
    learning: {
      status: "mastered", srsStage: 5, correctStreak: 3,
      nextReviewAt: EV_BASE + 30 * 86_400_000, srsUpdatedAt: EV_BASE + 6 * 60_000,
    },
  });
  const stillProvisional = evidenceWord({
    stats: { correct: 5, wrong: 0 },
    history: answerHistory(5, { startMs: EV_BASE }),
    progressUpdatedAt: EV_BASE + 5 * 60_000,
    learning: {
      status: "mastered", masteryVerify: "flashcard", srsStage: 5, correctStreak: 2,
      nextReviewAt: EV_BASE + 30 * 86_400_000, srsUpdatedAt: EV_BASE + 5 * 60_000,
    },
  });

  for (const [left, right, label] of [
    [verified, stillProvisional, "検証済みの側から取り込む"],
    [stillProvisional, verified, "仮習得の側から取り込む"],
  ]) {
    const merged = runtime.mergeWord(
      runtime.normalizeWord(left),
      runtime.normalizeWord(right),
      "remote",
    );
    assert.equal(
      Object.hasOwn(merged.learning, "masteryVerify"),
      false,
      `${label}: 検証済みの結果が残る（古いマークを戻さない）`,
    );
  }

  // 合流結果を両端末へ保存してから、もう一度合流させても復活しない（ループしない）。
  const first = runtime.mergeWord(
    runtime.normalizeWord(verified),
    runtime.normalizeWord(stillProvisional),
    "remote",
  );
  const again = runtime.mergeWord(first, runtime.normalizeWord(stillProvisional), "remote");
  assert.equal(
    Object.hasOwn(again.learning, "masteryVerify"),
    false,
    "往復してもマークが復活しない",
  );
});

test("仮習得の側が解答数で勝つときは、検証待ちマークを持ち越す", () => {
  const runtime = makeWordRuntime();
  // 上の裏返し。マークを持つ側が勝つ場合まで消してしまうと、
  // 未検証のまま本習得が確定して出題されなくなる。
  const provisionalAhead = evidenceWord({
    stats: { correct: 7, wrong: 0 },
    history: answerHistory(7, { startMs: EV_BASE }),
    progressUpdatedAt: EV_BASE + 7 * 60_000,
    learning: {
      status: "mastered", masteryVerify: "flashcard", srsStage: 5, correctStreak: 2,
      nextReviewAt: EV_BASE + 30 * 86_400_000, srsUpdatedAt: EV_BASE + 7 * 60_000,
    },
  });
  const fewer = evidenceWord({
    stats: { correct: 4, wrong: 0 },
    history: answerHistory(4, { startMs: EV_BASE }),
    progressUpdatedAt: EV_BASE + 4 * 60_000,
    learning: {
      status: "mastered", srsStage: 4, correctStreak: 3,
      nextReviewAt: EV_BASE + 14 * 86_400_000, srsUpdatedAt: EV_BASE + 4 * 60_000,
    },
  });
  for (const [left, right, label] of [
    [provisionalAhead, fewer, "仮習得の側から取り込む"],
    [fewer, provisionalAhead, "解答数の少ない側から取り込む"],
  ]) {
    const merged = runtime.mergeWord(
      runtime.normalizeWord(left),
      runtime.normalizeWord(right),
      "remote",
    );
    assert.equal(
      merged.learning.masteryVerify,
      "flashcard",
      `${label}: 検証待ちを持ち越す`,
    );
  }
});

test("実データ経路: 履歴から誤答が消えた端末の復習状態を、証拠判定で落とさない", () => {
  const runtime = makeWordRuntime();
  // レビュー3巡目の反例を、合成した learning ではなく単語まるごとで再現する。
  // 勝者 correct=60/wrong=1（直近50件は全部正解）、敗者 correct=58/wrong=1（同上）。
  // 誤答数が同じなので支配は成立するが、どちらの誤答も履歴に残っていないため
  // 「同じ誤答を見た」とは言えない。
  const trimmed = (count, startMs) => answerHistory(count, { startMs });
  const winner = evidenceWord({
    stats: { correct: 60, wrong: 1 },
    history: trimmed(50, EV_BASE),
    progressUpdatedAt: EV_BASE + 50 * 60_000,
    learning: {
      status: "mastered", srsStage: 7, correctStreak: 10,
      nextReviewAt: EV_BASE + 120 * 86_400_000, srsUpdatedAt: EV_BASE + 50 * 60_000,
    },
  });
  const forgot = evidenceWord({
    stats: { correct: 58, wrong: 1 },
    history: trimmed(50, EV_BASE + 60 * 60_000),
    progressUpdatedAt: EV_BASE + 60 * 60_000,
    learning: {
      status: "review", srsStage: 2, correctStreak: 0, lastSrsResult: "wrong",
      nextReviewAt: EV_BASE + 86_400_000, srsUpdatedAt: EV_BASE + 60 * 60_000,
    },
  });
  for (const [left, right, label] of [
    [winner, forgot, "習得側から取り込む"],
    [forgot, winner, "復習側から取り込む"],
  ]) {
    const merged = runtime.mergeWord(
      runtime.normalizeWord(left),
      runtime.normalizeWord(right),
      "remote",
    );
    assert.equal(merged.learning.status, "review", `${label}: 復習状態を失わない`);
    assert.ok(merged.learning.srsStage <= 2, `${label}: 習得側の段階へ寄せない`);
  }
});

test("日時を持たない解答は1件ずつ違う時刻に補い、別々の解答として残す", () => {
  const runtime = makeWordRuntime();
  // 補う時刻を全件で共有すると、mergeHistory の重複排除キー（日時＋正誤）が一致し、
  // 別々の解答が1件へ潰れて記録が消える。
  const repaired = runtime.normalizeHistory([
    { correct: false },
    { correct: false },
    { correct: true },
    { correct: true },
  ]);
  assert.equal(repaired.length, 4, "補った結果も4件のまま");
  assert.equal(new Set(repaired.map((entry) => entry.at)).size, 4, "日時が1件ずつ違う");
  assert.equal(
    runtime.mergeHistory(repaired, repaired).length,
    4,
    "同じ履歴同士を合流させても件数が変わらない",
  );

  // 別端末で正規化された「日時を持たない誤答」が偶然同じ時刻になっても、
  // 勝った側の最新の解答より新しいので照合は成立しない（＝誤答を握りつぶさない）。
  const sameMs = new Date(Date.now()).toISOString();
  const covered = runtime.evidenceCoversWrongAnswers(
    {
      correct: 6, wrong: 1,
      history: [
        { at: sameMs, correct: false },
        ...answerHistory(6, { startMs: EV_BASE }),
      ],
    },
    {
      correct: 1, wrong: 1,
      history: [
        ...answerHistory(1, { startMs: EV_BASE }),
        { at: sameMs, correct: false },
      ],
    },
  );
  assert.equal(covered, false, "補われた日時の一致を『見た』と数えない");
});

test("正解数が同じなら、誤答の多い側（＝より多く答えた側）が勝つ", () => {
  const runtime = makeWordRuntime();
  // 支配判定の「誤答数」の成分だけが効く形。正解数が同じで誤答数だけ違うとき、
  // 誤答を重ねた側のほうが多く答えている＝因果的に先にいる。
  // ここを落とすと、古い習得状態が新しい降格を時刻で押し流す（この変更の出発点の欠陥）。
  const shared = answerHistory(5, { startMs: EV_BASE });
  const staleMastered = evidenceWord({
    stats: { correct: 5, wrong: 0 },
    history: shared,
    progressUpdatedAt: EV_BASE + 10 * 60_000,
    learning: {
      status: "mastered", srsStage: 5, correctStreak: 5,
      nextReviewAt: EV_BASE + 30 * 86_400_000,
      // わざと新しい時刻にする。時刻だけで決めるとこちらが勝ってしまう。
      srsUpdatedAt: EV_BASE + 10 * 60_000,
    },
  });
  const demotedTwice = evidenceWord({
    stats: { correct: 5, wrong: 2 },
    history: [
      ...shared,
      { at: new Date(EV_BASE + 6 * 60_000).toISOString(), correct: false },
      { at: new Date(EV_BASE + 7 * 60_000).toISOString(), correct: false },
    ],
    progressUpdatedAt: EV_BASE + 7 * 60_000,
    learning: {
      status: "review", srsStage: 3, correctStreak: 0, lastSrsResult: "wrong",
      nextReviewAt: EV_BASE + 86_400_000, srsUpdatedAt: EV_BASE + 7 * 60_000,
    },
  });

  for (const [left, right, label] of [
    [staleMastered, demotedTwice, "習得側から取り込む"],
    [demotedTwice, staleMastered, "降格側から取り込む"],
  ]) {
    const merged = runtime.mergeWord(
      runtime.normalizeWord(left),
      runtime.normalizeWord(right),
      "remote",
    );
    assert.equal(merged.learning.status, "review", `${label}: 降格が残る`);
    assert.equal(merged.learning.srsStage, 3, `${label}: 降格後の段階が残る`);
  }
});
