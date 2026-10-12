// 1.0.135 の3件を固定する。
//
// 1. クイズ開始画面に「今日の状況」（連続記録・今日の回答数）の1行を出し、復習があるときは「今日の復習」を強調する
// 2. 成績に「週ごとの推移」カード（月曜始まりの週ごとの正答率と回答時間の中央値）を足す
// 3. Anki に読み込めるテキスト（タブ区切り）の書き出しを足す
//
// 保存データ（appState・同期・学習履歴）の形式は変えない。関数は vm で実際に動かして確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

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

// vm の外で作った値と deepStrictEqual で比べられるよう、素の JSON に直す
const plain = (value) => JSON.parse(JSON.stringify(value));

function load(functionNames, sandbox = {}) {
  vm.createContext(sandbox);
  vm.runInContext(functionNames.map(extractFunction).join("\n\n"), sandbox);
  return sandbox;
}

const localKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

// ============================================================================
// 1. 今日の状況
// ============================================================================

test("describeTodaySummary: 連続記録（0日は出さない／今日済み／今日まだ）", () => {
  const { describeTodaySummary } = load(["describeTodaySummary"]);
  assert.equal(describeTodaySummary({ streakCount: 0, streakIsToday: false, todayAnswers: 0, dailyGoal: 0 }), "");
  assert.equal(describeTodaySummary({ streakCount: 5, streakIsToday: true, todayAnswers: 0, dailyGoal: 0 }), "🔥 連続5日");
  assert.equal(
    describeTodaySummary({ streakCount: 5, streakIsToday: false, todayAnswers: 0, dailyGoal: 0 }),
    "🔥 連続5日（今日解くと6日）",
  );
});

test("describeTodaySummary: 今日の回答（目標なし／目標あり／達成／0問）", () => {
  const { describeTodaySummary } = load(["describeTodaySummary"]);
  assert.equal(describeTodaySummary({ todayAnswers: 7 }), "今日 7問");
  assert.equal(describeTodaySummary({ todayAnswers: 0 }), "", "目標なしで0問なら出さない");
  assert.equal(describeTodaySummary({ todayAnswers: 7, dailyGoal: 20 }), "今日 7/20問");
  assert.equal(describeTodaySummary({ todayAnswers: 0, dailyGoal: 20 }), "今日 0/20問");
  assert.equal(describeTodaySummary({ todayAnswers: 20, dailyGoal: 20 }), "今日 20/20問✓", "ちょうど達成");
  assert.equal(describeTodaySummary({ todayAnswers: 25, dailyGoal: 20 }), "今日 25/20問✓", "超過も達成");
});

test("describeTodaySummary: 連続と今日の回答は「・」で連結し、引数の欠けや不正値で落ちない", () => {
  const { describeTodaySummary } = load(["describeTodaySummary"]);
  assert.equal(
    describeTodaySummary({ streakCount: 3, streakIsToday: true, todayAnswers: 12, dailyGoal: 20 }),
    "🔥 連続3日・今日 12/20問",
  );
  assert.equal(
    describeTodaySummary({ streakCount: 3, streakIsToday: false, todayAnswers: 0, dailyGoal: 10 }),
    "🔥 連続3日（今日解くと4日）・今日 0/10問",
  );
  assert.equal(describeTodaySummary(), "");
  assert.equal(describeTodaySummary({ streakCount: "x", todayAnswers: NaN, dailyGoal: -3 }), "");
});

// renderQuizTodaySummary を vm で動かす。進行状態の変数は sandbox のプロパティとして持たせる。
function summarySandbox(overrides = {}) {
  const el = { hidden: true, textContent: "" };
  const now = new Date();
  const sandbox = {
    elements: { quizTodaySummary: el },
    appState: { words: [{ id: "w1" }], streak: { count: 4, last: localKey(now), best: 4 } },
    reviewSession: null,
    flashcardSession: null,
    quizStarted: false,
    reviewResult: null,
    todayAnswerCount: () => 6,
    dailyGoalWords: () => 20,
    ...overrides,
  };
  load(["describeTodaySummary", "localDateString", "normalizeStreak", "renderQuizTodaySummary"], sandbox);
  return { sandbox, el };
}

test("renderQuizTodaySummary: 通常の開始画面では文言を出す", () => {
  const { sandbox, el } = summarySandbox();
  sandbox.renderQuizTodaySummary();
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, "🔥 連続4日・今日 6/20問");
});

test("renderQuizTodaySummary: 語が0語なら隠す", () => {
  const { sandbox, el } = summarySandbox();
  el.hidden = false;
  el.textContent = "古い文言";
  sandbox.appState.words = [];
  sandbox.renderQuizTodaySummary();
  assert.equal(el.hidden, true);
});

test("renderQuizTodaySummary: 出題中（通常・復習・フラッシュカード）と結果表示中は隠す", () => {
  for (const patch of [
    { quizStarted: true },
    { reviewSession: { queue: [] } },
    { flashcardSession: { order: [] } },
    { reviewResult: { total: 3 } },
  ]) {
    const { sandbox, el } = summarySandbox(patch);
    el.hidden = false;
    sandbox.renderQuizTodaySummary();
    assert.equal(el.hidden, true, JSON.stringify(patch));
  }
});

test("renderQuizTodaySummary: 結果表示を抜けて開始画面に戻れば、また出る", () => {
  const { sandbox, el } = summarySandbox({ reviewResult: { total: 3 } });
  sandbox.renderQuizTodaySummary();
  assert.equal(el.hidden, true);
  sandbox.reviewResult = null;
  sandbox.renderQuizTodaySummary();
  assert.equal(el.hidden, false);
});

test("renderQuizTodaySummary: 出す文言が空なら隠す", () => {
  const { sandbox, el } = summarySandbox({
    appState: { words: [{ id: "w1" }], streak: { count: 0, last: "", best: 0 } },
    todayAnswerCount: () => 0,
    dailyGoalWords: () => 0,
  });
  el.hidden = false;
  sandbox.renderQuizTodaySummary();
  assert.equal(el.hidden, true);
  assert.equal(el.textContent, "");
});

test("renderQuizTodaySummary: 今日まだなら昨日までの連続に「今日解くと」を添える", () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const { sandbox, el } = summarySandbox({
    appState: { words: [{ id: "w1" }], streak: { count: 4, last: localKey(yesterday), best: 4 } },
    todayAnswerCount: () => 0,
    dailyGoalWords: () => 0,
  });
  sandbox.renderQuizTodaySummary();
  assert.equal(el.textContent, "🔥 連続4日（今日解くと5日）");
});

test("renderQuizTodaySummary: 昨日より前で途切れた連続は出さない（次に解くと1日目から数え直し）", () => {
  const old = new Date();
  old.setDate(old.getDate() - 3);
  const { sandbox, el } = summarySandbox({
    appState: { words: [{ id: "w1" }], streak: { count: 9, last: localKey(old), best: 9 } },
  });
  sandbox.renderQuizTodaySummary();
  assert.equal(el.textContent, "今日 6/20問");
});

test("renderQuizTodaySummary: 要素が無い環境（テスト・古い画面）では何もしない", () => {
  const { sandbox } = summarySandbox();
  sandbox.elements.quizTodaySummary = null;
  assert.doesNotThrow(() => sandbox.renderQuizTodaySummary());
});

test("配線: 開始画面の表示切り替え（updateQuizControls）と連続記録の更新（renderStreakBadge）から描き直す", () => {
  assert.match(extractFunction("updateQuizControls"), /renderQuizTodaySummary\(\)/);
  assert.match(extractFunction("renderStreakBadge"), /renderQuizTodaySummary\(\)/);
  const setup = html.indexOf('id="quizSetup"');
  const summary = html.indexOf('id="quizTodaySummary"');
  const primary = html.indexOf('class="quiz-start-primary"', setup);
  assert.ok(setup < summary && summary < primary, "今日の状況は .quiz-start-primary の直前に置く");
});

test("「今日の復習」は復習が1語以上あるときだけ is-due が付き、0語で外れる", () => {
  const classes = new Set();
  const button = {
    textContent: "",
    disabled: false,
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
    },
  };
  let due = 3;
  const sandbox = {
    elements: { generalReviewButton: button },
    reviewSession: {}, // 復習中の分岐で renderQuiz を早期に抜ける
    flashcardSession: null,
    reviewResult: null,
    quizStarted: false,
    eligibleSrsWords: () => Array.from({ length: due }),
  };
  for (const stub of [
    "setFlashcardUiActive", "renderAccuracy", "renderQuizProgress", "renderDailyGoalChip",
    "renderQuizScope", "renderQuizLearningProgress", "updateResumeButton", "renderReviewQuiz", "updateQuizControls",
  ]) sandbox[stub] = () => {};
  load(["renderQuiz"], sandbox);

  sandbox.renderQuiz();
  assert.equal(button.textContent, "今日の復習（3語）");
  assert.equal(classes.has("is-due"), true);
  assert.equal(button.disabled, false);

  due = 0;
  sandbox.renderQuiz();
  assert.equal(button.textContent, "今日の復習（0語）");
  assert.equal(classes.has("is-due"), false);
  assert.equal(button.disabled, true);
});

test("HTML/CSS: 今日の状況の要素と is-due の見た目がある", () => {
  assert.match(html, /<p id="quizTodaySummary" class="quiz-today-summary" hidden><\/p>/);
  assert.match(html, /\.quiz-today-summary\s*\{[^}]*color:\s*var\(--muted\)/);
  assert.match(html, /\.quiz-start-primary > #generalReviewButton\.is-due\s*\{[^}]*border-color:\s*var\(--accent\)/);
  assert.match(html, /quizTodaySummary:\s*document\.querySelector\("#quizTodaySummary"\)/);
});

// ============================================================================
// 2. 週ごとの推移
// ============================================================================

const weeklyNames = ["localDateString", "weekStartKey", "buildWeeklyTrend"];

// 2026-10-14（水）の昼。月曜は 10/12。
const WED = new Date(2026, 9, 14, 12, 0, 0).getTime();

function dayMap(entries) {
  const map = new Map();
  for (const [key, answers, correct] of entries) map.set(key, { answers, correct, terms: new Set() });
  return map;
}

test("前提: テストの基準日は水曜で、その週の月曜は 10/12", () => {
  assert.equal(new Date(WED).getDay(), 3);
  assert.equal(new Date(2026, 9, 12).getDay(), 1);
});

test("buildWeeklyTrend: 8週ぶんを古い週→新しい週の順で、月曜の日付で返す", () => {
  const { buildWeeklyTrend } = load(weeklyNames);
  const weeks = plain(buildWeeklyTrend(new Map(), [], WED));
  assert.equal(weeks.length, 8);
  assert.equal(weeks[7].start, "2026-10-12");
  assert.equal(weeks[6].start, "2026-10-05");
  assert.equal(weeks[0].start, localKey(new Date(2026, 9, 12 - 49)));
  for (const w of weeks) assert.equal(new Date(`${w.start}T00:00:00`).getDay(), 1, `${w.start} は月曜`);
  for (let i = 1; i < weeks.length; i += 1) assert.ok(weeks[i - 1].start < weeks[i].start, "古い週が先");
  assert.deepEqual(weeks[3], { start: weeks[3].start, answers: 0, correct: 0, medianMs: null }, "データが無い週は0");
});

test("buildWeeklyTrend: weeks を指定でき、日付はローカルの日付で数える", () => {
  const { buildWeeklyTrend } = load(weeklyNames);
  assert.equal(buildWeeklyTrend(new Map(), [], WED, 3).length, 3);
});

test("buildWeeklyTrend: 週は月曜始まり。日曜は前の週、月曜は次の週に入る", () => {
  const { buildWeeklyTrend } = load(weeklyNames);
  const byDay = dayMap([
    ["2026-10-04", 1, 1], // 日曜 → 9/28 の週
    ["2026-10-05", 10, 8], // 月曜 → 10/5 の週
    ["2026-10-11", 4, 1], // 日曜 → 10/5 の週の最終日
    ["2026-10-12", 6, 5], // 月曜 → 10/12 の週
    ["2026-10-14", 2, 2],
  ]);
  const weeks = plain(buildWeeklyTrend(byDay, [], WED));
  const get = (start) => weeks.find((w) => w.start === start);
  assert.deepEqual([get("2026-09-28").answers, get("2026-09-28").correct], [1, 1]);
  assert.deepEqual([get("2026-10-05").answers, get("2026-10-05").correct], [14, 9]);
  assert.deepEqual([get("2026-10-12").answers, get("2026-10-12").correct], [8, 7]);
});

test("buildWeeklyTrend: 基準が日曜でも、その日は前の月曜から始まる週に入る", () => {
  const { buildWeeklyTrend } = load(weeklyNames);
  const sunday = new Date(2026, 9, 18, 23, 30, 0).getTime();
  assert.equal(new Date(sunday).getDay(), 0);
  const weeks = plain(buildWeeklyTrend(dayMap([["2026-10-18", 3, 3]]), [], sunday));
  assert.equal(weeks[7].start, "2026-10-12");
  assert.equal(weeks[7].answers, 3);
});

test("buildWeeklyTrend: 回答時間の中央値は週ごと。奇数は真ん中、偶数は中央2つの平均、3件未満は null", () => {
  const { buildWeeklyTrend } = load(weeklyNames);
  const at = (day, hour = 10) => new Date(2026, 9, day, hour, 0, 0).getTime();
  const ev = (day, ms, extra = {}) => ({ occurredAt: at(day), responseTimeMs: ms, result: "correct", ...extra });
  const events = [
    // 10/12 の週: 奇数3件（並びは不順）→ 2000
    ev(13, 3000), ev(12, 1000), ev(14, 2000),
    // 10/5 の週: 偶数4件 → (2000+3000)/2
    ev(5, 4000), ev(6, 1000), ev(7, 3000), ev(8, 2000),
    // 9/28 の週: 2件だけ → null
    ev(1, 500), ev(2, 700),
  ];
  const weeks = plain(buildWeeklyTrend(new Map(), events, WED));
  const get = (start) => weeks.find((w) => w.start === start);
  assert.equal(get("2026-10-12").medianMs, 2000);
  assert.equal(get("2026-10-05").medianMs, 2500);
  assert.equal(get("2026-09-28").medianMs, null);
  assert.equal(get("2026-09-21").medianMs, null, "記録の無い週");
});

test("buildWeeklyTrend: 日曜深夜は前の週、月曜0時は次の週の記録になる", () => {
  const { buildWeeklyTrend } = load(weeklyNames);
  const sundayLate = new Date(2026, 9, 11, 23, 59, 59).getTime();
  const mondayStart = new Date(2026, 9, 12, 0, 0, 0).getTime();
  const events = [
    { occurredAt: sundayLate, responseTimeMs: 100, result: "correct" },
    { occurredAt: sundayLate, responseTimeMs: 200, result: "correct" },
    { occurredAt: sundayLate, responseTimeMs: 300, result: "correct" },
    { occurredAt: mondayStart, responseTimeMs: 9000, result: "correct" },
    { occurredAt: mondayStart, responseTimeMs: 9000, result: "correct" },
    { occurredAt: mondayStart, responseTimeMs: 9000, result: "correct" },
  ];
  const weeks = plain(buildWeeklyTrend(new Map(), events, WED));
  assert.equal(weeks.find((w) => w.start === "2026-10-05").medianMs, 200);
  assert.equal(weeks.find((w) => w.start === "2026-10-12").medianMs, 9000);
});

test("buildWeeklyTrend: 「わからない」・回答時間が数値でない記録・日時が不正な記録は中央値に入れない", () => {
  const { buildWeeklyTrend } = load(weeklyNames);
  const at = new Date(2026, 9, 13, 10).getTime();
  const events = [
    { occurredAt: at, responseTimeMs: 1000, result: "correct" },
    { occurredAt: at, responseTimeMs: 2000, result: "wrong" },
    { occurredAt: at, responseTimeMs: 9999, result: "dont-know" },
    { occurredAt: at, responseTimeMs: null, result: "correct" },
    { occurredAt: at, responseTimeMs: "3000", result: "correct" },
    { occurredAt: at, responseTimeMs: Infinity, result: "correct" },
    { occurredAt: NaN, responseTimeMs: 5000, result: "correct" },
    null,
  ];
  // 有効なのは1000と2000の2件だけ → 3件未満なので null
  assert.equal(plain(buildWeeklyTrend(new Map(), events, WED))[7].medianMs, null);
  events.push({ occurredAt: at, responseTimeMs: 3000, result: "correct" });
  assert.equal(plain(buildWeeklyTrend(new Map(), events, WED))[7].medianMs, 2000, "3件そろうと出る（dont-know は除外のまま）");
});

// カード本体。学習の記録の有無と、成績の絞り込み済みイベントは stub で差し替える。
function weeklyCard({ activity, logEnabled = false, events = [] }) {
  const sandbox = {
    reviewLogEnabled: () => logEnabled,
    statsScopedEvents: () => events,
  };
  load(
    ["escapeHtml", "svgFill", "statsCardHeader", ...weeklyNames, "statsWeeklyCard"],
    sandbox,
  );
  return sandbox.statsWeeklyCard({ activity });
}

// buildWeeklyTrend は現在時刻を基準にするので、カードのテストは「今週」「先週」の日付で組む。
function thisAndLastWeekActivity(thisWeek = [10, 9], lastWeek = [20, 10]) {
  const today = new Date();
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const prev = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7);
  return {
    activity: dayMap([
      [localKey(monday), thisWeek[0], thisWeek[1]],
      [localKey(prev), lastWeek[0], lastWeek[1]],
    ]),
    monday,
    prev,
  };
}

test("statsWeeklyCard: 回答のある週が2週未満なら出さない", () => {
  assert.equal(weeklyCard({ activity: new Map() }), "");
  const { activity, monday } = thisAndLastWeekActivity();
  assert.equal(weeklyCard({ activity: dayMap([[localKey(monday), 10, 8]]) }), "");
  // 同じ週に何日あっても1週は1週
  const day2 = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 1);
  assert.equal(weeklyCard({ activity: dayMap([[localKey(monday), 10, 8], [localKey(day2), 5, 5]]) }), "");
  assert.notEqual(weeklyCard({ activity }), "");
});

test("statsWeeklyCard: 2週以上あれば SVG・読み上げ用リスト・見出し・説明を含む", () => {
  const { activity, monday, prev } = thisAndLastWeekActivity([10, 9], [20, 10]);
  const out = weeklyCard({ activity });
  assert.match(out, /^<div class="stats-card">/);
  assert.match(out, /<svg class="stats-chart" viewBox="0 0 240 \d+" aria-hidden="true">/);
  assert.match(out, /<ul class="sr-only">/);
  assert.match(out, /週ごとの推移/);
  assert.match(out, /直近8週/);
  assert.match(out, /棒の高さ＝その週の正答率。数字は回答時間の中央値（学習の記録がオンのときだけ）。/);
  assert.equal((out.match(/<li>/g) || []).length, 8, "sr-only は8週ぶん");
  const label = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  assert.ok(out.includes(`${label(monday)}〜の週 正答率90%（10問）`), "今週は9/10=90%");
  assert.ok(out.includes(`${label(prev)}〜の週 正答率50%（20問）`), "先週は10/20=50%");
  assert.ok(out.includes("回答なし"), "回答のない週は「回答なし」");
  assert.ok(!out.includes("回答の中央値"), "学習の記録がオフなら中央値は出さない");
  // 色の規則は日別の正答率と同じ: 90%=緑、50%=標準
  assert.ok(out.includes("fill:var(--success)") && out.includes("fill:var(--accent)"));
});

test("statsWeeklyCard: 色は丸めた%で決める（79.6%は80%と書いて緑、49.6%は50%と書いて標準）", () => {
  const green = weeklyCard(thisAndLastWeekActivity([1000, 796], [1000, 796]));
  assert.ok(green.includes("正答率80%") && green.includes("fill:var(--success)"));
  assert.ok(!green.includes("fill:var(--accent)"));
  const accent = weeklyCard(thisAndLastWeekActivity([1000, 496], [1000, 496]));
  assert.ok(accent.includes("正答率50%") && accent.includes("fill:var(--accent)"));
  assert.ok(!accent.includes("fill:var(--danger)"));
  const red = weeklyCard(thisAndLastWeekActivity([100, 10], [100, 10]));
  assert.ok(red.includes("fill:var(--danger)"));
});

test("statsWeeklyCard: 学習の記録がオンなら、中央値を棒の上と<title>・読み上げに出す", () => {
  const { activity, monday } = thisAndLastWeekActivity();
  const at = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate(), 10).getTime();
  const events = [1500, 1800, 2100].map((ms) => ({ occurredAt: at, responseTimeMs: ms, result: "correct" }));
  const off = weeklyCard({ activity, logEnabled: false, events });
  assert.ok(!off.includes("1.8秒"), "オフなら events があっても出さない");
  const on = weeklyCard({ activity, logEnabled: true, events });
  assert.ok(on.includes("・回答の中央値1.8秒"), "title と sr-only の文言");
  assert.match(on, /font-size:8px">1\.8秒<\/text>/, "棒の上の小さな文字");
});

test("statsWeeklyCard: 利用者のデータはHTMLエスケープされる（日付ラベルは数字だけ）", () => {
  const out = weeklyCard(thisAndLastWeekActivity());
  assert.ok(!/<script/i.test(out));
});

test("配線: STATS_CARDS の accuracy の直後に weekly があり、出ていない理由を案内する", () => {
  const defs = html.slice(html.indexOf("const STATS_CARDS = ["), html.indexOf("\n];", html.indexOf("const STATS_CARDS = [")));
  const keys = [...defs.matchAll(/key:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]);
  assert.equal(keys[keys.indexOf("accuracy") + 1], "weekly");
  assert.match(defs, /key: "weekly",\s*build: \(ctx\) => statsWeeklyCard\(ctx\),/);
  assert.match(defs, /\["週ごとの推移", "2週以上クイズを解くと、週ごとの正答率が出ます。"\]/);
});

// ============================================================================
// 3. Anki 形式の書き出し
// ============================================================================

const ankiNames = ["ankiField", "ankiTag", "buildAnkiExport"];

test("ankiField: タブ・改行を半角スペースにして、前後の空白を除く", () => {
  const { ankiField } = load(ankiNames);
  assert.equal(ankiField("a\tb"), "a b");
  assert.equal(ankiField("a\nb"), "a b");
  assert.equal(ankiField("a\r\nb"), "a b", "CRLF は1つのスペース");
  assert.equal(ankiField("a\rb"), "a b");
  assert.equal(ankiField("  \t行頭と行末\n "), "行頭と行末");
  assert.equal(ankiField(null), "");
  assert.equal(ankiField(undefined), "");
  assert.equal(ankiField(123), "123");
});

test("ankiTag: 空白は _ にし、引用符などを除く。空なら空", () => {
  const { ankiTag } = load(ankiNames);
  assert.equal(ankiTag("CEFR B1"), "CEFR_B1");
  assert.equal(ankiTag("  a   b\tc "), "a_b_c");
  assert.equal(ankiTag('say "hi"'), "say_hi");
  assert.equal(ankiTag("“全角”"), "全角");
  assert.equal(ankiTag("a\\b"), "ab");
  assert.equal(ankiTag(""), "");
  assert.equal(ankiTag(null), "");
  assert.equal(ankiTag('""'), "");
});

const decks = [
  { id: "d1", name: "TOEIC" },
  { id: "d2", name: "仕事::会議 用" },
  { id: "d3", name: "" },
];

test("buildAnkiExport: Anki 2.1.55 以降のヘッダー6行・BOM なし・行区切りは \\n", () => {
  const { buildAnkiExport } = load(ankiNames);
  const text = buildAnkiExport([{ term: "apple", meaning: "りんご", deckId: "d1" }], decks);
  assert.notEqual(text.charCodeAt(0), 0xfeff, "BOM を付けるとヘッダーを認識できない");
  assert.ok(!text.includes("\r"));
  const lines = text.split("\n");
  assert.deepEqual(lines.slice(0, 6), [
    "#separator:tab",
    "#html:false",
    "#notetype:Basic",
    "#deck column:3",
    "#tags column:4",
    "#columns:Front\tBack\tDeck\tTags",
  ]);
  assert.equal(lines.length, 7);
});

test("buildAnkiExport: 1語1行・4列。単語帳名の解決、:: の置換、単語帳なしは WordBank", () => {
  const { buildAnkiExport } = load(ankiNames);
  const rows = buildAnkiExport(
    [
      { term: "apple", meaning: "りんご", deckId: "d1" },
      { term: "meeting", meaning: "会議", deckId: "d2" },
      { term: "orphan", meaning: "孤児", deckId: null },
      { term: "ghost", meaning: "幽霊", deckId: "missing" },
      { term: "blank", meaning: "空の名前", deckId: "d3" },
    ],
    decks,
  )
    .split("\n")
    .slice(6)
    .map((line) => line.split("\t"));
  assert.ok(rows.every((cols) => cols.length === 4), "全行が4列");
  assert.deepEqual(rows.map((c) => c[0]), ["apple", "meeting", "orphan", "ghost", "blank"]);
  assert.deepEqual(rows.map((c) => c[1]), ["りんご", "会議", "孤児", "幽霊", "空の名前"]);
  assert.deepEqual(rows.map((c) => c[2]), [
    "WordBank::TOEIC",
    "WordBank::仕事：会議 用",
    "WordBank",
    "WordBank",
    "WordBank",
  ]);
});

test("buildAnkiExport: タグは WordBank と CEFR・品詞・お気に入り（スペース区切り）", () => {
  const { buildAnkiExport } = load(ankiNames);
  const rows = buildAnkiExport(
    [
      { term: "a", meaning: "A", cefr: { level: "B1" }, pos: { tag: "n" }, favorite: true },
      { term: "b", meaning: "B", cefr: { level: "C2" } },
      { term: "c", meaning: "C", pos: { tag: "adj" } },
      { term: "d", meaning: "D" },
      { term: "e", meaning: "E", favorite: true },
      { term: "f", meaning: "F", pos: { tag: 'a "b"' } },
    ],
    [],
  )
    .split("\n")
    .slice(6)
    .map((line) => line.split("\t")[3]);
  assert.deepEqual(rows, [
    "WordBank CEFR_B1 pos_n favorite",
    "WordBank CEFR_C2",
    "WordBank pos_adj",
    "WordBank",
    "WordBank favorite",
    "WordBank pos_a_b",
  ]);
});

test("buildAnkiExport: null が混ざっても止まらず、term が空の語は飛ばす。タブ・改行は1行に収める", () => {
  const { buildAnkiExport } = load(ankiNames);
  const text = buildAnkiExport(
    [
      null,
      undefined,
      { term: "", meaning: "空" },
      { term: "   ", meaning: "空白だけ" },
      { term: null, meaning: "null" },
      { term: "tab\there", meaning: "複数行\nの\r\n意味 ", deckId: "d1" },
      { term: "ok", meaning: null },
    ],
    [null, ...decks],
  );
  const rows = text.split("\n").slice(6);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].split("\t"), ["tab here", "複数行 の 意味", "WordBank::TOEIC", "WordBank"]);
  assert.deepEqual(rows[1].split("\t"), ["ok", "", "WordBank", "WordBank"]);
  assert.equal(buildAnkiExport(null, null).split("\n").length, 6, "語が無ければヘッダーだけ");
});

test("書き出しボタンがHTMLにあり、USAGE_NAMES に anki-export がある", () => {
  assert.match(html, /<button id="exportAnkiButton" class="secondary" type="button" title="[^"]*">Anki用に書き出す<\/button>/);
  assert.ok(html.indexOf('id="exportCsvButton"') < html.indexOf('id="exportAnkiButton"'), "CSV ボタンの隣");
  assert.match(html, /Anki用はAnkiの「ファイルを読み込む」でそのまま取り込めます（学習記録は含みません）。/);
  assert.match(html, /exportAnkiButton:\s*document\.querySelector\("#exportAnkiButton"\)/);
  const block = /const USAGE_NAMES = new Set\(\[([\s\S]*?)\]\);/.exec(html);
  assert.ok(block);
  assert.ok(block[1].includes('"anki-export"'));
});

test("書き出しのクリック処理: 0語なら案内だけ、語があればテキストを保存して計測する", () => {
  const start = html.indexOf('elements.exportAnkiButton?.addEventListener("click", () => {');
  assert.ok(start >= 0);
  const end = html.indexOf("\n});", start) + 4;
  const handlerSource = html.slice(start, end);
  const run = (words) => {
    let handler = null;
    const calls = { status: [], download: [], usage: [] };
    const sandbox = {
      elements: { exportAnkiButton: { addEventListener: (_type, fn) => (handler = fn) } },
      appState: { words, decks: [] },
      buildAnkiExport: (w) => `built:${w.length}`,
      Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts.type; } },
      downloadBlob: (blob, name) => calls.download.push({ blob, name }),
      localDateString: () => "2026-10-12",
      trackUsage: (name) => calls.usage.push(name),
      setStatus: (text) => calls.status.push(text),
    };
    vm.createContext(sandbox);
    vm.runInContext(handlerSource, sandbox);
    handler();
    return calls;
  };
  const empty = run([]);
  assert.deepEqual(empty.status, ["書き出す単語がありません。"]);
  assert.equal(empty.download.length, 0);
  assert.equal(empty.usage.length, 0);

  const ok = run([{ term: "a" }]);
  assert.equal(ok.download.length, 1);
  assert.equal(ok.download[0].name, "wordbank-anki-2026-10-12.txt");
  assert.equal(ok.download[0].blob.type, "text/plain;charset=utf-8");
  assert.deepEqual(plain(ok.download[0].blob.parts), ["built:1"]);
  assert.deepEqual(ok.usage, ["anki-export"]);
  assert.match(ok.status[0], /Anki用のファイルを書き出しました/);
});
