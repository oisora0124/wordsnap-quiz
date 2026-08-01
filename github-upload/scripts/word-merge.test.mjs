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
    "globalThis.__wordRuntime = {" +
      " normalizeHistory, normalizeLearning, normalizeWord, normalizeState, stateSignature," +
      " mergeHistory, mergeLearningState, mergeEnrichData, mergeWord, mergeAppStates," +
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
