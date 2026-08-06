// 単語数が増えたときに、同期の中核処理が「二次」へ落ちないことを固定する。
//
// なぜ要るか:
//   内蔵の単語帳だけで6種×1500語ある。全部入れれば9000語で、
//   自分で取り込む人はさらに増える。ここで O(n²) を踏むと、
//   語数が2倍になるたびに待ち時間が4倍になり、**ある日突然使えなくなる**。
//   しかも症状は「同期のたびに固まる」であって、機能は正しく動いているので、
//   テストも目視もすり抜ける。
//
// 何を見るか:
//   絶対時間ではなく**1語あたりの時間の増え方**を見る。実行環境の速さに依存しないため。
//   線形なら1語あたりは一定、二次なら規模に比例して増える。
//   2000語と16000語（8倍）で比べ、1.5倍未満を合格にする。
//   （比＝「Nを2倍にしたら何倍か」で見る方式は、係数の小さい二次項を取り逃した。
//     経緯は docs/scale-guard.md に書いてある。）
//
// 測り方:
//   各サイズを複数回まわして**最小値**を採る。CPU負荷のばらつきは常に
//   「遅い方向」にしか出ないので、最小値がいちばん安定した推定になる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(scriptDir, "..", "publish", "index.html"), "utf8");

/** 波括弧の対応を取り、公開HTML内の関数を丸ごと切り出す。 */
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

// word-merge.test.mjs と同じ依存順で組み立てる（スタブへ差し替えない）。
function makeRuntime() {
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
    ...[
      "createId", "sanitizeId", "normalizeTerm", "nonNegativeNumber", "nonNegativeInteger",
      "emptyEnrich", "normalizeEnrich", "safeCefrLevel", "normalizeCefr", "normalizePos",
      "normalizeHistory", "repairFarFutureReviewAt", "normalizeLearning", "normalizeWord",
      "localDateString", "normalizeStreak", "isNextDayString", "mergeStreaks",
      "sanitizeDeletions", "trashKeyForWord", "sanitizeTrash", "wordAddedMs", "wordProgressMs",
      "deletionKeyForWord", "defaultState", "normalizeState", "stateSignature", "mergeAppStates",
      "mergeTrashEntries", "mergeDeckPlacement", "mergeWord", "mergeHistory", "mergeEnrichData",
      "mergeLearningState", "minPositiveNumber",
    ].map(extractFunction),
    "globalThis.__rt = { normalizeState, stateSignature, mergeAppStates };",
  ];
  const context = {};
  vm.runInNewContext(pieces.join("\n\n"), context, { filename: "scale-runtime.js" });
  return context.__rt;
}

const rt = makeRuntime();

/**
 * 「保存した単語」画面の絞り込み・並び替えを動かすための別ランタイム。
 * こちらは画面の状態（単語帳・お気に入り・CEFR・検索語・並び順）を
 * 外から書き換えたいので、コンテキストのプロパティとして持たせる。
 * DOM は使わない部分だけを対象にしている（描画そのものは node では測れない）。
 */
function makeLibraryRuntime() {
  const context = {
    appState: { words: [], decks: [], activeDeckId: "all" },
    wordSortMode: "accuracy",
    favoritesOnly: false,
    libraryCefrLevel: "all",
    wordSearchQuery: "",
    // cefrMatches は保存済みの値が無いとき window.Cefr を見る。
    window: { Cefr: { peek: () => null } },
  };
  vm.runInNewContext(
    [
      "scopedWords", "wordMatchesQuery", "cefrMatches", "wordAccuracy",
      "sortWordsForList", "visibleSavedWords",
    ].map(extractFunction).join("\n\n") +
      "\nglobalThis.__lib = { visibleSavedWords };",
    context,
    { filename: "library-runtime.js" },
  );
  return { context, visibleSavedWords: context.__lib.visibleSavedWords };
}

const lib = makeLibraryRuntime();

const BASE_MS = 1700000000000;
const DECK_COUNT = 6; // 内蔵の単語帳と同じ数

/**
 * 現実に近い形の単語をN件作る。
 *
 * 合成データが本番の形とずれていると、**測っているつもりで何も測っていない**
 * 状態になる。実際、最初は単語帳を `deck` という名前で入れていたが、
 * 本番が読むのは `deckId` で、単語帳の突き合わせが1度も走っていなかった。
 * seed で差を付けるフィールドも `updatedAt` にしていたが、これは
 * `normalizeWord` が保持しないため、正規化後の local と remote がほぼ同一になり、
 * マージがほとんど仕事をしていなかった。
 */
function makeWords(count, seed) {
  return Array.from({ length: count }, (_, i) => ({
    id: `w${i}`,
    term: `term${i}`,
    meaning: `意味${i}`,
    deckId: `deck${i % DECK_COUNT}`,
    // 正規化を通っても残るフィールドで差を付ける（seed=1 側を「新しい端末」にする）。
    deckUpdatedAt: BASE_MS + i + seed * 5000,
    addedAt: BASE_MS + i,
    learning: {
      status: "review",
      srsStage: (i + seed) % 6,
      nextReviewAt: BASE_MS + i * 1000 + seed * 60000,
      correctStreak: (i + seed) % 4,
      updatedAt: BASE_MS + i + seed * 5000,
    },
    // 片側だけ回答が進んでいる状態にして、履歴のマージを実際に走らせる。
    history: Array.from({ length: 8 + seed * 4 }, (_, h) => ({
      at: new Date(BASE_MS + i * 1000 + h * 10 + seed).toISOString(),
      correct: (h + seed) % 2 === 0,
    })),
  }));
}

const makeDecks = (seed) =>
  Array.from({ length: DECK_COUNT }, (_, i) => ({
    id: `deck${i}`,
    name: `単語帳${i}`,
    updatedAt: BASE_MS + i + seed * 1000,
  }));

// 削除記録は90日、ゴミ箱は30日でTTL切れとして捨てられる。
// 固定の過去日時にすると全部落ちて「入れたつもりで空」になるので、現在時刻を基準にする。
const RECENT_MS = Date.now() - 60000;

/** 削除記録とゴミ箱も現実的な量を入れる（どちらも正規化・突き合わせの対象）。 */
const makeDeletions = (count, seed) =>
  Object.fromEntries(
    Array.from({ length: Math.floor(count / 20) }, (_, i) => [
      `deleted${i}`,
      RECENT_MS - i - seed,
    ]),
  );

const makeTrash = (count, seed) =>
  Array.from({ length: Math.floor(count / 40) }, (_, i) => ({
    deletedAt: RECENT_MS - i - seed,
    word: {
      id: `t${i}`,
      term: `trashed${i}`,
      meaning: `捨てた意味${i}`,
      deckId: `deck${i % DECK_COUNT}`,
      addedAt: BASE_MS + i,
    },
  }));

const makeState = (count, seed) => ({
  words: makeWords(count, seed),
  decks: makeDecks(seed),
  deletions: makeDeletions(count, seed),
  trash: makeTrash(count, seed),
});

/** 最小所要時間（ms）。ばらつきは遅い方向にしか出ないので最小値が最も安定する。 */
function fastest(runs, fn) {
  fn(); // ウォームアップ（JITの初回コストを測定から外す）
  let best = Infinity;
  for (let i = 0; i < runs; i += 1) {
    const start = process.hrtime.bigint();
    fn();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (ms < best) best = ms;
  }
  return best;
}

/**
 * **1語あたりの所要時間**を、規模の小さい方と大きい方で比べる。
 *
 * 比（2倍にしたら何倍か）で見ると、係数の小さい二次項を取り逃す。
 * 実測: わざと二次のループを注入しても、2000→4000語の比は 2.39 にしかならず、
 * 「線形なら約2倍」の判定をすり抜けた。
 *
 * 1語あたりで見ると、線形なら一定・二次なら規模に比例して増えるので、はっきり分かれる。
 * 実測（mergeAppStates、2000語→16000語）:
 *   いまの実装: 44.5µs/語 → 39.3µs/語（0.88倍。ほぼ一定）
 *   二次を注入: 57.8µs/語 → 158.6µs/語（2.74倍）
 * 閾値 1.5 なら、両方から十分に離れている。
 */
function assertLinearish(label, run, repeat = 1) {
  // 1回が速すぎると測定の分解能に埋もれて比が意味を持たない。
  // repeat 回まとめて測れば、両方の規模に同じ倍率がかかるので比は変わらない。
  const perWord = (n) => fastest(2, () => { for (let i = 0; i < repeat; i += 1) run(n); }) / (n * repeat);
  const small = perWord(SMALL);
  const large = perWord(LARGE);
  const detail = `${SMALL}語=${(small * 1000).toFixed(1)}µs/語, ${LARGE}語=${(large * 1000).toFixed(1)}µs/語`;

  // 速すぎると分解能の問題で比が意味を持たない。
  assert.ok(small * SMALL * repeat > 1, `${label}: 基準が速すぎて比較できない（${detail}）`);
  assert.ok(
    large / small < 1.5,
    `${label}: 1語あたりの時間が ${(large / small).toFixed(2)}倍に増えている。` +
      `線形なら約1倍、二次なら規模に比例して増える（${detail}）`,
  );
}

const SMALL = 2000;
const LARGE = 16000;

test("normalizeState は語数に対して線形（読み込み・同期のたびに全語を通る）", () => {
  const states = new Map([SMALL, LARGE].map((n) => [n, makeState(n, 0)]));
  assertLinearish("normalizeState", (n) => rt.normalizeState(states.get(n)));
});

test("mergeAppStates は語数に対して線形（同期のたびに両側の全語を突き合わせる）", () => {
  const pairs = new Map(
    [SMALL, LARGE].map((n) => [n, [rt.normalizeState(makeState(n, 0)), rt.normalizeState(makeState(n, 1))]]),
  );
  assertLinearish("mergeAppStates", (n) => {
    const [local, remote] = pairs.get(n);
    rt.mergeAppStates(local, remote, {});
  });
});

test("stateSignature は語数に対して線形（差分判定のたびに全語を通る）", () => {
  const states = new Map([SMALL, LARGE].map((n) => [n, rt.normalizeState(makeState(n, 0))]));
  assertLinearish("stateSignature", (n) => rt.stateSignature(states.get(n)));
});

test("一覧の絞り込み・並び替えは語数に対して線形（画面を開くたびに全語を通る）", () => {
  // 「保存した単語」は表示するDOMの数を絞っているが、
  // どれを表示するかを決める絞り込みと並び替え自体は毎回**全語**を走査する。
  // 実測では16000語でも約2msと軽いが、ここに全語×全語の処理が紛れ込むと
  // 画面を開くたびに固まるようになる。
  const words = new Map(
    [SMALL, LARGE].map((n) => [n, rt.normalizeState(makeState(n, 0)).words]),
  );
  // お気に入りとCEFRを散らして、絞り込みの分岐を実際に通す。
  for (const list of words.values()) {
    list.forEach((word, i) => {
      word.favorite = i % 7 === 0;
      word.cefr = { level: ["A1", "A2", "B1", "B2", "C1", "C2"][i % 6], estimated: false };
    });
  }
  lib.context.wordSortMode = "accuracy"; // 並び替えが実際に走る設定
  lib.context.wordSearchQuery = "term1";
  assertLinearish(
    "visibleSavedWords",
    (n) => {
      lib.context.appState.words = words.get(n);
      lib.visibleSavedWords();
    },
    20, // 1回が0.1msほどなので、まとめて測る
  );
});

test("一覧の絞り込みは、条件どおりの結果を返す（速度だけを見ない）", () => {
  const list = rt.normalizeState(makeState(600, 0)).words;
  list.forEach((word, i) => {
    word.favorite = i % 7 === 0;
    word.cefr = { level: ["A1", "A2", "B1", "B2", "C1", "C2"][i % 6], estimated: false };
  });
  lib.context.appState.words = list;
  lib.context.wordSortMode = "added";

  lib.context.favoritesOnly = false;
  lib.context.libraryCefrLevel = "all";
  lib.context.wordSearchQuery = "";
  assert.equal(lib.visibleSavedWords().length, 600, "条件なしで全件返っていない");

  lib.context.favoritesOnly = true;
  const favorites = lib.visibleSavedWords();
  assert.equal(favorites.length, Math.ceil(600 / 7), "お気に入りの絞り込みが効いていない");
  assert.ok(favorites.every((w) => w.favorite), "お気に入り以外が混ざっている");

  lib.context.favoritesOnly = false;
  lib.context.libraryCefrLevel = "B1";
  const b1 = lib.visibleSavedWords();
  assert.equal(b1.length, 100, "CEFRの絞り込みが効いていない");
  assert.ok(b1.every((w) => w.cefr.level === "B1"), "他のレベルが混ざっている");

  lib.context.libraryCefrLevel = "all";
  lib.context.wordSearchQuery = "term42";
  const searched = lib.visibleSavedWords();
  assert.ok(searched.length > 0 && searched.every((w) => w.term.includes("term42")),
    "検索の絞り込みが効いていない");

  // 後続のテストへ状態を持ち越さない。
  lib.context.wordSearchQuery = "";
  lib.context.libraryCefrLevel = "all";
  lib.context.favoritesOnly = false;
});

test("マージ結果は語数によらず正しい（速度だけを見て中身を見落とさない）", () => {
  // 速度の検査だけだと、中身が壊れていても通ってしまう。
  // local と remote は、正規化を通っても残るフィールドで差を付けてある
  // （そうしないと両者が同一になり、マージが仕事をしないまま通る）。
  const local = rt.normalizeState(makeState(2000, 0));
  const remote = rt.normalizeState(makeState(2000, 1));

  // 前提の確認: 差が正規化で消えていないこと。ここが崩れると以下は無意味になる。
  assert.notEqual(
    rt.stateSignature(local),
    rt.stateSignature(remote),
    "local と remote が正規化後に同一。マージが何も突き合わせていない",
  );

  const merged = rt.mergeAppStates(local, remote, {});
  assert.equal(merged.words.length, 2000, "マージで語数が変わっている");
  const ids = new Set(merged.words.map((w) => w.id));
  assert.equal(ids.size, 2000, "マージで重複または欠落が出ている");
  assert.equal(merged.decks.length, DECK_COUNT, "単語帳が増減している");

  const remoteById = new Map(remote.words.map((w) => [w.id, w]));
  for (const word of merged.words) {
    assert.ok(word.history.length > 0, `履歴が消えている: ${word.id}`);
    assert.ok(word.learning && word.learning.status, `学習状態が消えている: ${word.id}`);
    assert.ok(word.deckId, `単語帳の割り当てが消えている: ${word.id}`);
    // remote 側の方が回答が進んでいるので、履歴は remote 以上の長さになるはず。
    const fromRemote = remoteById.get(word.id);
    assert.ok(
      word.history.length >= fromRemote.history.length,
      `remote 側の履歴を取り込めていない: ${word.id}`,
    );
  }
  // 削除記録とゴミ箱も、両側のぶんが残ること。
  assert.ok(Object.keys(merged.deletions).length > 0, "削除記録が消えている");
  assert.ok(merged.trash.length > 0, "ゴミ箱が消えている");
});

test("同期1回ぶんの処理が、9000語でも現実的な時間で終わる", () => {
  // 比だけを見ていると、線形のまま定数倍が10倍悪化しても通ってしまう。
  // 内蔵単語帳を全部入れた規模で、絶対時間にも緩い上限を置く。
  // ここが落ちたときは「計算量」ではなく「重くなった」を疑う。
  const local = makeState(9000, 0);
  const remote = makeState(9000, 1);
  const ms = fastest(1, () => {
    const merged = rt.mergeAppStates(local, remote, {});
    rt.stateSignature(merged);
  });
  assert.ok(ms < 5000, `9000語の同期1回ぶんに ${ms.toFixed(0)}ms かかっている`);
});
