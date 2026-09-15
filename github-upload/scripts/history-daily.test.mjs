// 学習履歴の「日別への畳み込み」（historyDaily）の挙動を、公開HTMLの実コードで確かめる。
//
// 生の履歴は容量と同期の都合で1語あたり直近50件しか残せない。その切り捨てを
// そのまま行うと、よく解いた語の古い解答がカレンダー・連続記録から消える。
// ここでは「捨てる前に日別の回数へ畳み込む」「二重に数えない」「何度通しても増えない」
// という、データ保全に直結する性質だけを対象にしている。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(scriptDir, "..", "publish", "index.html"), "utf8");

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

function makeRuntime() {
  const pieces = [
    "const LEARNING_SCHEMA_VERSION = 1;",
    "const SRS_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60, 120];",
    "const SRS_DAY_MS = 24 * 60 * 60 * 1000;",
    "const SRS_MAX_FUTURE_DAYS = 400;",
    "const SAFE_CEFR_LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);",
    "const SAFE_POS_TAGS = new Set(['n', 'v', 'adj', 'adv']);",
    "const HISTORY_RAW_MAX = 50;",
    "const HISTORY_DAILY_MAX_DAYS = 730;",
    // buildDailyActivity・deckSharePayload が参照する状態。テストから差し替える。
    "const appState = { words: [], decks: [], activeDeckId: 'all' };",
    extractFunction("createId"),
    extractFunction("sanitizeId"),
    extractFunction("nonNegativeNumber"),
    extractFunction("nonNegativeInteger"),
    extractFunction("emptyEnrich"),
    extractFunction("normalizeEnrich"),
    extractFunction("safeCefrLevel"),
    extractFunction("normalizeCefr"),
    extractFunction("normalizePos"),
    extractFunction("localDateString"),
    extractFunction("normalizeHistoryEntries"),
    extractFunction("emptyHistoryDaily"),
    extractFunction("trimHistoryDailyDays"),
    extractFunction("normalizeHistoryDaily"),
    extractFunction("foldHistoryIntoDaily"),
    extractFunction("repairFarFutureReviewAt"),
    extractFunction("normalizeLearning"),
    extractFunction("normalizeWord"),
    extractFunction("wordProgressMs"),
    extractFunction("mergeDeckPlacement"),
    extractFunction("mergeHistoryEntries"),
    extractFunction("mergeHistoryDaily"),
    extractFunction("mergeEnrichData"),
    extractFunction("mergeLearningState"),
    extractFunction("minPositiveNumber"),
    extractFunction("mergeWord"),
    extractFunction("buildDailyActivity"),
    extractFunction("canonicalDeckIdMapper"),
    extractFunction("deckSharePayload"),
    "globalThis.__rt = {" +
      " localDateString, normalizeHistoryDaily, foldHistoryIntoDaily, mergeHistoryDaily," +
      " mergeHistoryEntries, normalizeWord, mergeWord, buildDailyActivity, deckSharePayload," +
      " setState: (words, decks) => { appState.words = words; appState.decks = decks; } };",
  ];
  const context = {};
  vm.runInNewContext(pieces.join("\n\n"), context, { filename: "history-daily-runtime.js" });
  return context.__rt;
}

const rt = makeRuntime();

const HOUR_MS = 60 * 60 * 1000;
const BASE_MS = Date.parse("2026-07-01T03:00:00.000Z");
// 畳み込まれる側の解答は30日前に置く。時差に関わらず「日別にしか残らない日」を作れるので、
// 生の履歴との合算とを区別して数えられる。
const OLD_MS = BASE_MS - 30 * 24 * HOUR_MS;

// 1時間おきの解答を作る（偶数番を正解にする）。
function answersFrom(startMs, count) {
  return Array.from({ length: count }, (_, index) => ({
    at: new Date(startMs + index * HOUR_MS).toISOString(),
    correct: index % 2 === 0,
  }));
}

// 古い解答 count 件＋新しい50件。畳み込みで落ちるのは必ず古い側の count 件。
function historyWithOverflow(count) {
  return [...answersFrom(OLD_MS, count), ...answersFrom(BASE_MS, 50)];
}

// 日キーは端末の時差に依存しないUTC日付（ISO文字列の先頭10文字）。
const OLD_DAY = new Date(OLD_MS).toISOString().slice(0, 10);
// 表示側は「その日の12:00Z」をローカル日付へ寄せる。
const OLD_DAY_LOCAL = rt.localDateString(new Date(`${OLD_DAY}T12:00:00Z`));

// vm の中で作られたオブジェクトは realm が違い deepStrictEqual を通らないので、
// 素のJSON値に直してから比べる。
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// 日別の合計解答数（複数日にまたがるので、日ごとの値を足して確かめる）。
function totalAnswers(daily) {
  return Object.values(daily.days).reduce((sum, counts) => sum + counts[0], 0);
}

test("50件以下の履歴は畳み込まれず、日別も空のまま", () => {
  const folded = rt.foldHistoryIntoDaily(answersFrom(BASE_MS, 50), null);

  assert.equal(folded.history.length, 50);
  assert.deepEqual(plain(folded.historyDaily), { days: {}, foldedThrough: "" });
});

test("60件の履歴は古い10件が日別へ畳み込まれ、水位はその10件目の時刻になる", () => {
  const history = historyWithOverflow(10);
  const folded = rt.foldHistoryIntoDaily(history, null);

  assert.equal(folded.history.length, 50);
  assert.equal(folded.history[0].at, history[10].at, "残るのは新しい50件");
  assert.deepEqual(plain(folded.historyDaily.days), { [OLD_DAY]: [10, 5] }, "落とした10件が日別に残ること");
  assert.equal(folded.historyDaily.foldedThrough, history[9].at, "水位は落とした最後の時刻");
});

test("入力は変異させない（純関数）", () => {
  const history = historyWithOverflow(10);
  const daily = { days: { [OLD_DAY]: [3, 1] }, foldedThrough: "" };
  const historyCopy = plain(history);
  const dailyCopy = plain(daily);

  rt.foldHistoryIntoDaily(history, daily);

  assert.deepEqual(history, historyCopy, "渡した履歴を書き換えないこと");
  assert.deepEqual(daily, dailyCopy, "渡した日別を書き換えないこと");
});

test("同じ履歴を2回畳み込んでも回数は増えない（冪等）", () => {
  const history = historyWithOverflow(10);
  const once = rt.foldHistoryIntoDaily(history, null);
  // 同期で受け取った生の履歴（60件）を、畳み込み済みの日別へもう一度通す。
  const twice = rt.foldHistoryIntoDaily(history, once.historyDaily);

  assert.deepEqual(plain(twice.historyDaily), plain(once.historyDaily));
  // 畳み込み後の履歴（50件）を通し直しても同じ。
  const again = rt.foldHistoryIntoDaily(once.history, once.historyDaily);
  assert.deepEqual(plain(again.historyDaily), plain(once.historyDaily));
});

test("水位より前の解答は、落ちても日別に足さない（二重計上の防止）", () => {
  const history = historyWithOverflow(10);
  const daily = { days: {}, foldedThrough: history[59].at };

  const folded = rt.foldHistoryIntoDaily(history, daily);

  assert.equal(folded.history.length, 50);
  assert.deepEqual(plain(folded.historyDaily.days), {}, "畳み込み済みの解答は数え直さないこと");
  assert.equal(folded.historyDaily.foldedThrough, history[59].at, "水位は戻らないこと");
});

test("日別の形が壊れていれば捨てる（数え間違いを持ち回らない）", () => {
  const daily = rt.normalizeHistoryDaily({
    days: {
      "2026-07-01": [4, 2],
      "2026-07-02": [3, 99], // 正解数が解答数を超える壊れた値
      "07-03": [5, 1], // 日付ではないキー
      "2026-07-04": "3", // 配列ではない
      "2026-07-05": [0, 0], // 解答0件は残す意味がない
    },
    foldedThrough: "2026-07-02T00:00:00.000Z",
  });

  assert.deepEqual(plain(daily.days), { "2026-07-01": [4, 2], "2026-07-02": [3, 3] });
  assert.equal(daily.foldedThrough, "2026-07-02T00:00:00.000Z");
  assert.deepEqual(plain(rt.normalizeHistoryDaily(null)), { days: {}, foldedThrough: "" });
  assert.equal(rt.normalizeHistoryDaily({ foldedThrough: "こわれた時刻" }).foldedThrough, "");
});

test("日別のマージは日ごとに大きい方を採り、水位は進んだ方を採る", () => {
  const a = {
    days: { "2026-07-01": [10, 6], "2026-07-02": [4, 1] },
    foldedThrough: "2026-07-02T00:00:00.000Z",
  };
  const b = {
    days: { "2026-07-01": [7, 7], "2026-07-03": [2, 2] },
    foldedThrough: "2026-07-01T00:00:00.000Z",
  };

  const merged = rt.mergeHistoryDaily(a, b);

  assert.deepEqual(plain(merged.days), {
    "2026-07-01": [10, 7],
    "2026-07-02": [4, 1],
    "2026-07-03": [2, 2],
  });
  assert.equal(merged.foldedThrough, "2026-07-02T00:00:00.000Z");
  // 左右を入れ替えても同じ（収束のため）
  assert.deepEqual(plain(rt.mergeHistoryDaily(b, a)), plain(merged));
});

test("片方が空の日別でも、もう片方の記録を失わない", () => {
  const a = { days: { "2026-07-01": [10, 6] }, foldedThrough: "2026-07-01T09:00:00.000Z" };

  assert.deepEqual(plain(rt.mergeHistoryDaily(a, null)), a);
  assert.deepEqual(plain(rt.mergeHistoryDaily(undefined, a)), a);
  assert.deepEqual(plain(rt.mergeHistoryDaily(null, undefined)), { days: {}, foldedThrough: "" });
});

test("畳み込み済みの端末と未畳み込みの端末をマージしても、解答が二重にならない", () => {
  const history = historyWithOverflow(10);
  // 端末A: 一度読み込んで畳み込み済み（生50件＋日別10件）
  const deviceA = rt.normalizeWord({ id: "w1", term: "apple", meaning: "りんご", history });
  // 端末B: 同じ60件をまだ生のまま持っている（旧クライアント相当）
  const deviceB = { ...deviceA, history, historyDaily: undefined };

  const merged = rt.mergeWord(deviceA, deviceB, "remote");

  assert.equal(merged.history.length, 50);
  assert.equal(
    merged.history.length + totalAnswers(merged.historyDaily),
    60,
    "生＋日別の合計が元の解答数を超えないこと",
  );
  // もう一度マージしても増えない（同期は何度も走る）
  const again = rt.mergeWord(merged, deviceB, "remote");
  assert.equal(again.history.length + totalAnswers(again.historyDaily), 60);
  assert.deepEqual(plain(again.historyDaily), plain(merged.historyDaily));
});

test("カレンダーの集計は生の履歴と日別を合算し、その日の単語として数える", () => {
  const folded = rt.foldHistoryIntoDaily(historyWithOverflow(10), null);
  const word = {
    term: "apple",
    history: folded.history,
    historyDaily: folded.historyDaily,
  };

  const byDay = rt.buildDailyActivity([word]);
  const total = [...byDay.values()].reduce((sum, day) => sum + day.answers, 0);

  assert.equal(total, 60, "畳み込んだ分もカレンダーに残ること");
  // 生の履歴には1件も残っていない日でも、回数と学習した語が残る
  assert.equal(byDay.get(OLD_DAY_LOCAL).answers, 10);
  assert.equal(byDay.get(OLD_DAY_LOCAL).correct, 5);
  assert.ok(byDay.get(OLD_DAY_LOCAL).terms.has("apple"), "日別だけの日にも単語が入ること");
});

test("日別を持たない旧データも、正規化で空の日別を得て古い解答を畳み込む", () => {
  const legacy = rt.normalizeWord({
    id: "w1",
    term: "apple",
    meaning: "りんご",
    history: historyWithOverflow(5),
  });

  assert.equal(legacy.history.length, 50);
  assert.deepEqual(plain(legacy.historyDaily.days), { [OLD_DAY]: [5, 3] }, "溢れた5件が日別に残ること");

  const untouched = rt.normalizeWord({
    id: "w2",
    term: "banana",
    meaning: "バナナ",
    history: answersFrom(BASE_MS, 10),
  });
  assert.deepEqual(plain(untouched.historyDaily), { days: {}, foldedThrough: "" });
});

test("単語帳の共有には学習の記録（日別を含む）を載せない", () => {
  const word = rt.normalizeWord({
    id: "w1",
    term: "apple",
    meaning: "りんご",
    deckId: "deckone",
    history: historyWithOverflow(10),
  });
  rt.setState([word], [{ id: "deckone", name: "単語帳", updatedAt: 0 }]);

  const payload = rt.deckSharePayload("deckone");

  assert.deepEqual(Object.keys(payload).sort(), ["deck", "exportedAt", "kind", "version", "words"]);
  assert.deepEqual(Object.keys(payload.words[0]).sort(), ["cefr", "meaning", "pos", "term"]);
  assert.doesNotMatch(JSON.stringify(payload), /history/, "学習の記録が混ざっていないこと");
});

test("履歴の上限値はHTMLの定数とテストの前提が一致している", () => {
  // 砂場では定数を手書きしているので、本体だけ変わったときに気付けるようにする。
  assert.match(html, /const HISTORY_RAW_MAX = 50;/);
  assert.match(html, /const HISTORY_DAILY_MAX_DAYS = 730;/);
});

test("採点で51件目を積むと、押し出された1件が日別に残る", () => {
  const folded = rt.foldHistoryIntoDaily(answersFrom(BASE_MS, 51), null);

  assert.equal(folded.history.length, 50);
  assert.deepEqual(plain(folded.historyDaily.days), {
    [new Date(BASE_MS).toISOString().slice(0, 10)]: [1, 1],
  });
  // 採点経路が畳み込みを通ることを、呼び出し側の実コードでも固定する。
  assert.match(
    extractFunction("gradeQuiz"),
    /foldHistoryIntoDaily\(word\.history, word\.historyDaily\)/,
    "採点直後の切り詰めが畳み込みを経由していない",
  );
});

test("マージは左右を入れ替えても履歴と日別が同じになる", () => {
  const history = historyWithOverflow(10);
  const deviceA = rt.normalizeWord({ id: "w1", term: "apple", meaning: "りんご", history });
  const deviceB = rt.normalizeWord({
    id: "w1",
    term: "apple",
    meaning: "りんご",
    history: answersFrom(BASE_MS + 50 * HOUR_MS, 20),
  });

  const ab = rt.mergeWord(deviceA, deviceB, "remote");
  const ba = rt.mergeWord(deviceB, deviceA, "remote");

  assert.deepEqual(plain(ab.history), plain(ba.history));
  assert.deepEqual(plain(ab.historyDaily), plain(ba.historyDaily));
});

test("正規化を2回かけても結果は変わらない（読み込みのたびに増えない）", () => {
  const once = rt.normalizeWord({
    id: "w1",
    term: "apple",
    meaning: "りんご",
    history: historyWithOverflow(10),
  });
  const twice = rt.normalizeWord(once);

  assert.deepEqual(plain(twice), plain(once));
});

test("正規化は成績・進捗時刻・学習状態を書き換えない", () => {
  const source = {
    id: "w1",
    term: "apple",
    meaning: "りんご",
    stats: { correct: 40, wrong: 20 },
    progressUpdatedAt: 1_700_000_000_000,
    learning: {
      status: "review",
      firstAttempted: true,
      reviewAt: 5,
      blockedUntil: 0,
      correctStreak: 3,
      srsStage: 2,
      nextReviewAt: 1_700_000_100_000,
      srsUpdatedAt: 1_700_000_000_000,
      lastSrsResult: "correct",
    },
    history: historyWithOverflow(10),
  };

  const normalized = rt.normalizeWord(source);

  assert.deepEqual(plain(normalized.stats), source.stats, "累計成績は畳み込みで動かない");
  assert.equal(normalized.progressUpdatedAt, source.progressUpdatedAt);
  assert.deepEqual(plain(normalized.learning), source.learning);
});

test("日別は730日を超えたら古い日から落とす", () => {
  const days = {};
  const start = Date.parse("2024-01-01T00:00:00.000Z");
  for (let index = 0; index < 800; index += 1) {
    days[new Date(start + index * 24 * HOUR_MS).toISOString().slice(0, 10)] = [1, 1];
  }

  const normalized = rt.normalizeHistoryDaily({ days, foldedThrough: "" });
  const keys = Object.keys(normalized.days);

  assert.equal(keys.length, 730);
  assert.equal(keys[0], new Date(start + 70 * 24 * HOUR_MS).toISOString().slice(0, 10), "古い日から落ちること");
  assert.deepEqual(keys, [...keys].sort(), "キーは常に日付順（同期の指紋を端末間でそろえる）");
});

test("日別のキー順は入力順に依らない（無駄な全量同期を起こさない）", () => {
  const a = { days: { "2026-07-03": [1, 1], "2026-07-01": [2, 2] }, foldedThrough: "" };
  const b = { days: { "2026-07-02": [3, 3] }, foldedThrough: "" };

  assert.equal(
    JSON.stringify(rt.mergeHistoryDaily(a, b)),
    JSON.stringify(rt.mergeHistoryDaily(b, a)),
  );
});

test("時差の違う端末が同じ解答を畳み込んでも、日別は増えない", () => {
  // 日キーがローカル日付だと、端末ごとに別の日へ積まれて max が効かず二重に数えてしまう。
  const history = historyWithOverflow(10);
  const deviceA = rt.foldHistoryIntoDaily(history, null).historyDaily;
  const deviceB = rt.foldHistoryIntoDaily(history, null).historyDaily;

  const merged = rt.mergeHistoryDaily(deviceA, deviceB);

  assert.equal(totalAnswers(merged), 10);
  assert.deepEqual(plain(merged.days), { [OLD_DAY]: [10, 5] });
});

test("【現状の限界】オフライン並行学習では、統合水位より前の未畳み込み分が落ちる", () => {
  // 端末A: 00:00Z から1時間おきに60件。端末B: 同じ日の 00:30Z から1時間おきに60件。
  // どちらも畳み込み済み（生50＋日別10）。マージすると水位は進んだ方（＝Bの10件目）に
  // そろうため、Aだけが持っていた「水位以下のまだ畳み込んでいない解答」は数えられない。
  // 旧実装（slice(-50)）でも同じ解答は捨てられていたので退行ではないが、
  // 「全期間を残す」は並行学習では部分的にしか成立しない。
  const deviceA = rt.normalizeWord({
    id: "w1", term: "apple", meaning: "りんご", history: answersFrom(OLD_MS, 60),
  });
  const deviceB = rt.normalizeWord({
    id: "w1", term: "apple", meaning: "りんご", history: answersFrom(OLD_MS + HOUR_MS / 2, 60),
  });

  const merged = rt.mergeWord(deviceA, deviceB, "remote");
  const counted = merged.history.length + totalAnswers(merged.historyDaily);

  assert.equal(counted, 110, "現状の実測値（真値は120）");
});
