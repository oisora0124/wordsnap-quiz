// 学習履歴の「日別への畳み込み」（historyDaily）の挙動を、公開HTMLの実コードで確かめる。
//
// 生の履歴は容量と同期の都合で1語あたり直近50件しか残せない。その切り捨てを
// そのまま行うと、よく解いた語の古い解答がカレンダー・連続記録から消える。
// そこで「捨てる前に日別の記録へ畳み込む」のだが、日別を [解答数, 正解数] の数で持って
// max でマージすると**結合的でない**（3端末を突き合わせる順番で最終値が変わる）。
// 今の形式は1解答＝1トークン（日・秒・正誤）で、マージは集合の和。ここでは
// 「和が可換・結合・冪等であること」「生と日別を合わせて解答が失われないこと」という、
// データ保全に直結する性質を対象にしている。
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
    "const HISTORY_DAILY_MAX_ENTRIES = 3000;",
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
    extractFunction("compareHistoryDailyTokens"),
    extractFunction("normalizeHistoryDailyTokens"),
    extractFunction("validHistoryDailyKey"),
    extractFunction("historyDailyDayCount"),
    extractFunction("trimHistoryDailyDays"),
    extractFunction("normalizeHistoryDaily"),
    extractFunction("historyDailyTokenFor"),
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
    extractFunction("shouldPromoteInitialStep"),
    "globalThis.__rt = {" +
      " localDateString, normalizeHistoryDaily, foldHistoryIntoDaily, mergeHistoryDaily," +
      " mergeHistoryEntries, normalizeWord, mergeWord, buildDailyActivity, deckSharePayload," +
      " shouldPromoteInitialStep," +
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

// 日別の合計解答数。1解答＝1トークンなので、トークン数を数える。
function totalAnswers(daily) {
  return Object.values(daily.days).reduce((sum, tokens) => sum + tokens.split(",").length, 0);
}

// 解答から期待されるトークン（秒の36進＋正誤）。テスト側でも同じ規則を書いて、
// 本体の符号化がこっそり変わったら気付けるようにする。
function tokenFor(entry) {
  const date = new Date(entry.at);
  const seconds = date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds();
  return seconds.toString(36) + (entry.correct ? "+" : "-");
}

// ============================================================================
// 畳み込み（foldHistoryIntoDaily）
// ============================================================================

test("50件以下の履歴は畳み込まれず、日別も空のまま", () => {
  const folded = rt.foldHistoryIntoDaily(answersFrom(BASE_MS, 50), null);

  assert.equal(folded.history.length, 50);
  assert.deepEqual(plain(folded.historyDaily), { days: {} });
});

test("60件の履歴は古い10件が日別のトークンへ畳み込まれる", () => {
  const history = historyWithOverflow(10);
  const folded = rt.foldHistoryIntoDaily(history, null);

  assert.equal(folded.history.length, 50);
  assert.equal(folded.history[0].at, history[10].at, "残るのは新しい50件");
  assert.deepEqual(
    plain(folded.historyDaily.days),
    { [OLD_DAY]: history.slice(0, 10).map(tokenFor).join(",") },
    "落とした10件がトークンとして残ること",
  );
  assert.equal(totalAnswers(folded.historyDaily), 10);
});

test("採点で51件目を積むと、押し出された1件が日別に残る", () => {
  const history = answersFrom(BASE_MS, 51);
  const folded = rt.foldHistoryIntoDaily(history, null);

  assert.equal(folded.history.length, 50);
  assert.deepEqual(plain(folded.historyDaily.days), {
    [new Date(BASE_MS).toISOString().slice(0, 10)]: tokenFor(history[0]),
  });
  // 採点経路が畳み込みを通ることを、呼び出し側の実コードでも固定する。
  assert.match(
    extractFunction("gradeQuiz"),
    /foldHistoryIntoDaily\(word\.history, word\.historyDaily\)/,
    "採点直後の切り詰めが畳み込みを経由していない",
  );
});

test("入力は変異させない（純関数）", () => {
  const history = historyWithOverflow(10);
  const daily = { days: { "2026-05-01": "5+,9-" } };
  const historyCopy = plain(history);
  const dailyCopy = plain(daily);

  rt.foldHistoryIntoDaily(history, daily);

  assert.deepEqual(history, historyCopy, "渡した履歴を書き換えないこと");
  assert.deepEqual(daily, dailyCopy, "渡した日別を書き換えないこと");
});

test("同じ履歴を何度畳み込んでも増えない（冪等）", () => {
  const history = historyWithOverflow(10);
  const once = rt.foldHistoryIntoDaily(history, null);
  // 同期で受け取った生の履歴（60件）を、畳み込み済みの日別へもう一度通す。
  const twice = rt.foldHistoryIntoDaily(history, once.historyDaily);

  assert.deepEqual(plain(twice.historyDaily), plain(once.historyDaily));
  // 畳み込み後の履歴（50件）を通し直しても同じ。
  const again = rt.foldHistoryIntoDaily(once.history, once.historyDaily);
  assert.deepEqual(plain(again.historyDaily), plain(once.historyDaily));
});

test("同じ秒・同じ正誤の解答は1件に畳まれる（符号化の限界）", () => {
  // 1語を同一秒に2回採点した場合にだけ起きる。旧実装が同一ミリ秒を1件と見ていたのと同種。
  const at = new Date(OLD_MS).toISOString();
  const history = [
    { at, correct: true },
    { at: at.replace(".000Z", ".500Z"), correct: true }, // 同じ秒・同じ正誤
    { at: at.replace(".000Z", ".700Z"), correct: false }, // 同じ秒・違う正誤は別トークン
    ...answersFrom(BASE_MS, 50),
  ];

  const folded = rt.foldHistoryIntoDaily(history, null);

  assert.equal(folded.history.length, 50);
  const second = tokenFor({ at, correct: true }).slice(0, -1);
  assert.deepEqual(plain(folded.historyDaily.days), { [OLD_DAY]: `${second}+,${second}-` });
  assert.equal(totalAnswers(folded.historyDaily), 2, "3件のうち同一秒・同一正誤の2件が1件になる");
});

// ============================================================================
// 日別どうしのマージ（mergeHistoryDaily）— 可換・結合・冪等
// ============================================================================

test("日別のマージは日ごとのトークン集合の和", () => {
  const a = { days: { "2026-07-01": "5+,9-", "2026-07-02": "3+" } };
  const b = { days: { "2026-07-01": "9-,20+", "2026-07-03": "1-" } };

  const merged = rt.mergeHistoryDaily(a, b);

  assert.deepEqual(plain(merged.days), {
    "2026-07-01": "5+,9-,20+",
    "2026-07-02": "3+",
    "2026-07-03": "1-",
  });
});

test("日別のマージは可換（左右を入れ替えても同じ）", () => {
  const a = { days: { "2026-07-03": "1+,z-", "2026-07-01": "2+" } };
  const b = { days: { "2026-07-02": "3+", "2026-07-01": "2+,5-" } };

  assert.equal(
    JSON.stringify(rt.mergeHistoryDaily(a, b)),
    JSON.stringify(rt.mergeHistoryDaily(b, a)),
    "キーの並びまで含めて一致すること（同期の指紋を端末間でそろえる）",
  );
});

test("日別のマージは結合的（突き合わせる順番で結果が変わらない）", () => {
  const a = { days: { "2026-07-01": "1+,2-" } };
  const b = { days: { "2026-07-01": "2-,3+" } };
  const c = { days: { "2026-07-01": "3+,4-" } };

  const left = rt.mergeHistoryDaily(rt.mergeHistoryDaily(a, b), c);
  const right = rt.mergeHistoryDaily(a, rt.mergeHistoryDaily(b, c));

  assert.equal(JSON.stringify(left), JSON.stringify(right));
  assert.deepEqual(plain(left.days), { "2026-07-01": "1+,2-,3+,4-" });
});

test("日別のマージは冪等（何度マージしても増えない）", () => {
  const a = { days: { "2026-07-01": "5+,9-" } };

  const once = rt.mergeHistoryDaily(a, a);
  const twice = rt.mergeHistoryDaily(once, a);

  assert.deepEqual(plain(twice), plain(once));
  assert.deepEqual(plain(once.days), { "2026-07-01": "5+,9-" });
});

test("片方が空の日別でも、もう片方の記録を失わない", () => {
  const a = { days: { "2026-07-01": "5+,9-" } };

  assert.deepEqual(plain(rt.mergeHistoryDaily(a, null)), a);
  assert.deepEqual(plain(rt.mergeHistoryDaily(undefined, a)), a);
  assert.deepEqual(plain(rt.mergeHistoryDaily(null, undefined)), { days: {} });
});

test("3端末が同じ日に60件ずつ解いた日別を統合すると真値の180件になる", () => {
  // 旧実装（日ごとに [解答数, 正解数] の max）はここで 136 / 134 と、順番によって
  // 違う値を返していた（真値は180）。集合の和にしたことで順番に依らず真値へ収束する。
  const dailyFor = (offsetSeconds) => ({
    days: {
      [OLD_DAY]: Array.from({ length: 60 }, (_, index) =>
        (index * 300 + offsetSeconds).toString(36) + "+").join(","),
    },
  });
  const a = dailyFor(0);
  const b = dailyFor(60);
  const c = dailyFor(120);

  const left = rt.mergeHistoryDaily(rt.mergeHistoryDaily(a, b), c);
  const right = rt.mergeHistoryDaily(a, rt.mergeHistoryDaily(b, c));

  assert.equal(totalAnswers(left), 180);
  assert.equal(JSON.stringify(left), JSON.stringify(right));
});

// ============================================================================
// 語まるごとのマージ（mergeWord）
// ============================================================================

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
    "生＋日別の合計が元の解答数と一致すること",
  );
  // もう一度マージしても増えない（同期は何度も走る）
  const again = rt.mergeWord(merged, deviceB, "remote");
  assert.equal(again.history.length + totalAnswers(again.historyDaily), 60);
  assert.deepEqual(plain(again.historyDaily), plain(merged.historyDaily));
});

test("マージは左右を入れ替えても履歴と日別が同じになる（可換）", () => {
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

test("3端末×60件のマージは結合的で、生50＋日別130の真値180になる", () => {
  // レビュー（Codex high）で見つかった不具合の再現条件そのもの。
  // 3端末が同じ語を同じ日にオフラインで60件ずつ解き、突き合わせる順番を変える。
  const deviceFor = (offsetMs) =>
    rt.normalizeWord({
      id: "w1",
      term: "apple",
      meaning: "りんご",
      history: answersFrom(OLD_MS + offsetMs, 60),
    });
  const a = deviceFor(0);
  const b = deviceFor(60_000);
  const c = deviceFor(120_000);

  const left = rt.mergeWord(rt.mergeWord(a, b, "remote"), c, "remote");
  const right = rt.mergeWord(a, rt.mergeWord(b, c, "remote"), "remote");

  assert.equal(
    JSON.stringify([plain(left.history), plain(left.historyDaily)]),
    JSON.stringify([plain(right.history), plain(right.historyDaily)]),
    "(A⊔B)⊔C と A⊔(B⊔C) が一致すること",
  );
  assert.equal(left.history.length, 50, "生の履歴は直近50件");
  assert.equal(totalAnswers(left.historyDaily), 130, "残り130件は日別に残る");
  assert.equal(left.history.length + totalAnswers(left.historyDaily), 180, "真値を数えられること");
});

// ============================================================================
// 正規化（normalizeWord / normalizeHistoryDaily）
// ============================================================================

test("日別を持たない旧データも、正規化で空の日別を得て古い解答を畳み込む", () => {
  const history = historyWithOverflow(5);
  const legacy = rt.normalizeWord({ id: "w1", term: "apple", meaning: "りんご", history });

  assert.equal(legacy.history.length, 50);
  assert.deepEqual(
    plain(legacy.historyDaily.days),
    { [OLD_DAY]: history.slice(0, 5).map(tokenFor).join(",") },
    "溢れた5件が日別に残ること",
  );

  const untouched = rt.normalizeWord({
    id: "w2",
    term: "banana",
    meaning: "バナナ",
    history: answersFrom(BASE_MS, 10),
  });
  assert.deepEqual(plain(untouched.historyDaily), { days: {} });
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

test("旧フォーマット（値が配列の日別）は安全に捨てる", () => {
  // 本番未リリースの形式なので、変換せず捨てる方が単純で安全。
  const daily = rt.normalizeHistoryDaily({
    days: { "2026-07-01": [10, 6], "2026-07-02": "5+,9-" },
    foldedThrough: "2026-07-02T00:00:00.000Z", // 廃止した水位。残っていても持ち回らない
  });

  assert.deepEqual(plain(daily), { days: { "2026-07-02": "5+,9-" } });
  assert.equal(daily.foldedThrough, undefined, "水位は持たないこと");
});

test("壊れた日キーとトークンは落とす（数え間違いを持ち回らない）", () => {
  const daily = rt.normalizeHistoryDaily({
    days: {
      "2026-07-01": "5+,9-,5+", // 重複は1件に畳む
      "2026-07-02": "zz+,,こわれた,9", // 形の合わないトークンは捨てる（zz+ は有効）
      "2026-02-31": "1+", // 正規表現は通るが存在しない日
      "07-03": "1+", // 日付ではないキー
      "2026-07-04": "", // 空は残す意味がない
      "2026-07-05": "1unz+,1uo0+", // 86399秒は有効、86400秒は範囲外
    },
    days2: "無関係",
  });

  assert.deepEqual(plain(daily.days), {
    "2026-07-01": "5+,9-",
    "2026-07-02": "zz+",
    "2026-07-05": "1unz+",
  });
  assert.deepEqual(plain(rt.normalizeHistoryDaily(null)), { days: {} });
  assert.deepEqual(plain(rt.normalizeHistoryDaily({ days: "壊れた" })), { days: {} });
});

test("日別のトークンは秒の昇順に並べ直す（同期の指紋を端末間でそろえる）", () => {
  const daily = rt.normalizeHistoryDaily({
    days: { "2026-07-02": "5+", "2026-07-01": "z-,5+,a+,5-" },
  });

  assert.equal(JSON.stringify(daily.days), '{"2026-07-01":"5+,5-,a+,z-","2026-07-02":"5+"}');
});

test("日別の総件数が3000を超えたら、古い日から丸ごと落とす", () => {
  const days = {};
  const start = Date.parse("2024-01-01T00:00:00.000Z");
  // 1日100件 × 40日 = 4000件。上限3000に収めるには古い10日を落とすことになる。
  const oneDay = Array.from({ length: 100 }, (_, index) => `${index.toString(36)}+`).join(",");
  for (let index = 0; index < 40; index += 1) {
    days[new Date(start + index * 24 * HOUR_MS).toISOString().slice(0, 10)] = oneDay;
  }

  const normalized = rt.normalizeHistoryDaily({ days });
  const keys = Object.keys(normalized.days);

  assert.equal(totalAnswers(normalized), 3000);
  assert.equal(keys.length, 30);
  assert.equal(
    keys[0],
    new Date(start + 10 * 24 * HOUR_MS).toISOString().slice(0, 10),
    "古い日から落ちること",
  );
  assert.deepEqual(keys, [...keys].sort(), "キーは常に日付順");
});

test("履歴の上限値はHTMLの定数とテストの前提が一致している", () => {
  // 砂場では定数を手書きしているので、本体だけ変わったときに気付けるようにする。
  assert.match(html, /const HISTORY_RAW_MAX = 50;/);
  assert.match(html, /const HISTORY_DAILY_MAX_ENTRIES = 3000;/);
  assert.doesNotMatch(html, /foldedThrough/, "廃止した水位が残っていないこと");
});

// ============================================================================
// 集計（buildDailyActivity）
// ============================================================================

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
  assert.equal(byDay.get(OLD_DAY_LOCAL).correct, 5, '"+" の数が正解数になること');
  assert.ok(byDay.get(OLD_DAY_LOCAL).terms.has("apple"), "日別だけの日にも単語が入ること");
});

test("時差の違う端末が同じ解答を畳み込んでも、日別は増えない", () => {
  // 日キーがローカル日付だと、端末ごとに別の日へ積まれて和が効かず二重に数えてしまう。
  const history = historyWithOverflow(10);
  const deviceA = rt.foldHistoryIntoDaily(history, null).historyDaily;
  const deviceB = rt.foldHistoryIntoDaily(history, null).historyDaily;

  const merged = rt.mergeHistoryDaily(deviceA, deviceB);

  assert.equal(totalAnswers(merged), 10);
  assert.deepEqual(plain(merged.days), plain(deviceA.days));
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

// ============================================================================
// 同レビューの medium / low（日別の変更を見落とさない・起動直後の導線・URLの露出）
// ============================================================================

test("Undoの指紋は日別の記録も見る（日別だけ増えた同期を『変更なし』にしない）", () => {
  const body = extractFunction("undoSignature");
  assert.match(body, /w\.historyDaily/, "undoSignature が historyDaily を含むこと");

  // 「日別だけが違う2つの状態」で指紋が変わることを、実コードの範囲で確かめる。
  const base = rt.normalizeWord({
    id: "w1",
    term: "apple",
    meaning: "りんご",
    history: answersFrom(BASE_MS, 10),
  });
  const withDaily = { ...base, historyDaily: { days: { [OLD_DAY]: "5+,9-" } } };

  // undoSignature 自体は sanitizeDeletions 等に依存するので、ここでは
  // 指紋が見る語の並び（normalizeWord の結果）が違うことだけを固定する。
  assert.notEqual(
    JSON.stringify(rt.normalizeWord(withDaily).historyDaily),
    JSON.stringify(base.historyDaily),
    "日別の違いが正規化後にも残ること",
  );
});

test("起動直後のタブ昇格は、未保存・取り込みタブ・単語ありの3条件がそろったときだけ", () => {
  // 単語がサーバーにしか無い端末では、最初のリモート適用で初めて単語が戻る。
  assert.equal(rt.shouldPromoteInitialStep(null, "import", 0), false, "0語なら昇格しない");
  assert.equal(rt.shouldPromoteInitialStep(null, "import", 5), true, "リモートで5語戻ったら昇格");
  assert.equal(rt.shouldPromoteInitialStep("list", "import", 5), false, "保存済みタブは変えない");
  assert.equal(rt.shouldPromoteInitialStep(null, "list", 5), false, "別タブへ移動済みなら変えない");

  // 起動時の復元だけでなく、最初のリモート適用の直後にも一度だけ呼ぶこと。
  const apply = extractFunction("applyMergedRemoteState");
  assert.match(apply, /remoteStatePromotionDone/, "初回だけ呼ぶガードがあること");
  assert.match(apply, /promoteInitialStepAfterRecovery\(\)/);
  assert.match(html, /let remoteStatePromotionDone = false;/);
});

test("設定の「学習の記録」にも data-settings-section が付いている", () => {
  assert.match(html, /<details class="settings-section" data-settings-section="review-log">/);
  // 属性の無い .settings-section が残っていないこと（アコーディオンの状態保存から漏れる）
  assert.doesNotMatch(html, /<details class="settings-section">/);
});

test("個人キー付きURLで開いた回だけ、robots の noindex を1つだけ足す", () => {
  const source = extractFunction("applyPrivateLinkNoindex");
  const run = (search, existing) => {
    const metas = [];
    const context = {
      window: { location: { search } },
      URLSearchParams,
      document: {
        head: { appendChild: (node) => metas.push(node) },
        querySelector: (selector) =>
          selector === 'meta[name="robots"]' && (existing || metas.length) ? {} : null,
        createElement: () => {
          const attrs = {};
          return { setAttribute: (key, value) => { attrs[key] = value; }, attrs };
        },
      },
    };
    vm.runInNewContext(`${source}\napplyPrivateLinkNoindex(); applyPrivateLinkNoindex();`, context, {
      filename: "private-link-noindex.js",
    });
    return metas;
  };

  const withKey = run("?w=abc123");
  assert.equal(withKey.length, 1, "2回呼んでも1つだけ");
  assert.deepEqual(withKey[0].attrs, { name: "robots", content: "noindex,nofollow,noarchive" });

  assert.equal(run("").length, 0, "キーの無いURLでは足さない");
  assert.equal(run("?deck=abc").length, 0, "関係ない引数だけでも足さない");
  assert.equal(run("?w=abc123", true).length, 0, "既にある robots は上書きしない");

  // 起動処理から実際に呼ばれていること（定義だけでは効かない）
  assert.match(html, /\napplyPrivateLinkNoindex\(\);/);
});
