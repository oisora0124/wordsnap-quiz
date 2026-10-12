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
  load(["describeTodaySummary", "localDateString", "normalizeStreak", "currentStreakCount", "renderQuizTodaySummary"], sandbox);
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

test("statsWeeklyCard: 動的な文字列（見出し・週ラベル・中央値・title・読み上げ）はすべて escapeHtml を通る", () => {
  // escapeHtml を印付きのスタブにして、通っていない文字列があれば印が付かないことで検出する。
  const sandbox = {
    reviewLogEnabled: () => true,
    statsScopedEvents: () => events,
    escapeHtml: (value) => `[E:${value}]`,
  };
  const { activity, monday } = thisAndLastWeekActivity();
  const at = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate(), 10).getTime();
  const events = [1500, 1800, 2100].map((ms) => ({ occurredAt: at, responseTimeMs: ms, result: "correct" }));
  load(["svgFill", "statsCardHeader", ...weeklyNames, "statsWeeklyCard"], sandbox);
  const out = sandbox.statsWeeklyCard({ activity });

  assert.ok(out.includes("<h4>[E:週ごとの推移]</h4>"), "見出し");
  assert.ok(out.includes("[E:直近8週]"), "見出しの右側");
  assert.equal((out.match(/<li>\[E:[^\]]*\]<\/li>/g) || []).length, 8, "読み上げ用リストの8項目");
  assert.equal((out.match(/<title>\[E:[^\]]*\]<\/title>/g) || []).length, 8, "棒ごとの title");
  assert.match(out, /font-size:8px">\[E:1\.8秒\]<\/text>/, "棒の上の中央値");
  assert.equal((out.match(/font-size:8px">\[E:\d+\/\d+\]<\/text>/g) || []).length, 8, "週の開始日ラベル");
  // 印付きの文字列を取り除いた残りに、動的な値（日付・秒・正答率・問数）が裸で残っていない
  const rest = out.replace(/\[E:[^\]]*\]/g, "");
  assert.doesNotMatch(rest, /\d+\/\d+/, "日付が裸で出ている");
  assert.doesNotMatch(rest, /\d(\.\d)?秒/, "中央値が裸で出ている");
  assert.doesNotMatch(rest, /正答率\d|\d+問|回答なし|〜の週/, "title・読み上げの文言が裸で出ている");
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

const ankiNames = ["ankiField", "ankiTag", "ankiQuote", "buildAnkiExport"];

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

// Anki の読み込みと同じ規則の小さなパーサー。
// 行頭が # の行はヘッダー（コメント）として除き、それ以外はタブ区切り・" 囲み・"" を " に戻す。
// split("\t") では引用符を解釈しないので、引用の不具合（後続行の吸い込み・# の取りこぼし）を見逃す。
function parseAnkiText(text) {
  const headers = [];
  const records = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text[i] === "#") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      headers.push(text.slice(i, stop));
      i = stop + 1;
      continue;
    }
    const row = [];
    for (;;) {
      let field = "";
      if (text[i] === '"') {
        i += 1;
        for (;;) {
          if (i >= n) throw new Error("閉じていない引用符で最後まで吸い込まれた");
          if (text[i] === '"') {
            if (text[i + 1] === '"') {
              field += '"';
              i += 2;
              continue;
            }
            i += 1;
            break;
          }
          field += text[i];
          i += 1;
        }
      } else {
        while (i < n && text[i] !== "\t" && text[i] !== "\n") {
          field += text[i];
          i += 1;
        }
      }
      row.push(field);
      if (text[i] === "\t") {
        i += 1;
        continue;
      }
      i += 1; // 改行（または末尾）
      break;
    }
    records.push(row);
  }
  return { headers, records };
}

test("buildAnkiExport: ヘッダーは区切り・html・デッキ列・タグ列の4行だけ。ノートタイプと列名は宣言しない", () => {
  const { buildAnkiExport } = load(ankiNames);
  const text = buildAnkiExport([{ term: "apple", meaning: "りんご", deckId: "d1" }], decks);
  assert.notEqual(text.charCodeAt(0), 0xfeff, "BOM を付けるとヘッダーを認識できない");
  assert.ok(!text.includes("\r"));
  const lines = text.split("\n");
  assert.deepEqual(lines.slice(0, 4), ["#separator:tab", "#html:false", "#deck column:3", "#tags column:4"]);
  // 日本語の Anki は標準ノートタイプのフィールド名が「表面／裏面」。Front/Back の名前対応だと裏面が空になる
  assert.ok(!/#notetype|#columns/.test(text), "名前対応を呼ぶ宣言を出さない（位置順に任せる）");
  const { headers, records } = parseAnkiText(text);
  assert.equal(headers.length, 4);
  assert.equal(records.length, 1);
  assert.equal(lines.length, 5);
});

test("buildAnkiExport: 1語1行・4列。単語帳名の解決、:: の置換、単語帳なしは WordBank", () => {
  const { buildAnkiExport } = load(ankiNames);
  const { records } = parseAnkiText(
    buildAnkiExport(
      [
        { term: "apple", meaning: "りんご", deckId: "d1" },
        { term: "meeting", meaning: "会議", deckId: "d2" },
        { term: "orphan", meaning: "孤児", deckId: null },
        { term: "ghost", meaning: "幽霊", deckId: "missing" },
        { term: "blank", meaning: "空の名前", deckId: "d3" },
      ],
      decks,
    ),
  );
  assert.ok(records.every((cols) => cols.length === 4), "全行が4列");
  assert.deepEqual(records.map((c) => c[0]), ["apple", "meeting", "orphan", "ghost", "blank"]);
  assert.deepEqual(records.map((c) => c[1]), ["りんご", "会議", "孤児", "幽霊", "空の名前"]);
  assert.deepEqual(records.map((c) => c[2]), [
    "WordBank::TOEIC",
    "WordBank::仕事：会議 用",
    "WordBank",
    "WordBank",
    "WordBank",
  ]);
});

test("buildAnkiExport: タグは WordBank と CEFR・品詞・お気に入り（スペース区切り）", () => {
  const { buildAnkiExport } = load(ankiNames);
  const { records } = parseAnkiText(
    buildAnkiExport(
      [
        { term: "a", meaning: "A", cefr: { level: "B1" }, pos: { tag: "n" }, favorite: true },
        { term: "b", meaning: "B", cefr: { level: "C2" } },
        { term: "c", meaning: "C", pos: { tag: "adj" } },
        { term: "d", meaning: "D" },
        { term: "e", meaning: "E", favorite: true },
        { term: "f", meaning: "F", pos: { tag: 'a "b"' } },
      ],
      [],
    ),
  );
  assert.deepEqual(records.map((c) => c[3]), [
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
  const { records } = parseAnkiText(text);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], ["tab here", "複数行 の 意味", "WordBank::TOEIC", "WordBank"]);
  assert.deepEqual(records[1], ["ok", "", "WordBank", "WordBank"]);
  assert.equal(text.split("\n").length, 4 + 2, "改行を含む意味でも1語1行");
  assert.equal(parseAnkiText(buildAnkiExport(null, null)).records.length, 0, "語が無ければヘッダーだけ");
});

test("ankiQuote: 全体を \" で囲み、中の \" は \"\" に二重化する", () => {
  const { ankiQuote } = load(ankiNames);
  assert.equal(ankiQuote("abc"), '"abc"');
  assert.equal(ankiQuote('a"b'), '"a""b"');
  assert.equal(ankiQuote('"'), '""""');
  assert.equal(ankiQuote(""), '""');
});

test("引用: \" で始まる意味・途中に \" がある語・# で始まる語・タブや改行入りの意味が、1行4列で元の文字に戻る", () => {
  const { buildAnkiExport } = load(ankiNames);
  const words = [
    { term: "hello", meaning: '"こんにちは', deckId: "d1" }, // 閉じない引用符が後続行を吸い込む
    { term: 'a"b', meaning: 'ab"', deckId: "d1" },
    { term: "#hashtag", meaning: "ハッシュタグ", deckId: "d1" }, // 行頭 # はコメントとして捨てられる
    { term: "multi", meaning: "1行目\n2行目\t3列目\r\n4行目", deckId: "d1" },
    { term: '""', meaning: '"""', deckId: "d1" },
    { term: "last", meaning: "最後", deckId: "d1" },
  ];
  const text = buildAnkiExport(words, decks);
  const { headers, records } = parseAnkiText(text);
  assert.equal(headers.length, 4, "ヘッダー以外の行を # でコメント扱いしない");
  assert.equal(records.length, words.length, "後続の行を吸い込まない");
  assert.ok(records.every((cols) => cols.length === 4));
  assert.deepEqual(records.map((c) => c[0]), ["hello", 'a"b', "#hashtag", "multi", '""', "last"]);
  assert.deepEqual(records.map((c) => c[1]), ['"こんにちは', 'ab"', "ハッシュタグ", "1行目 2行目 3列目 4行目", '"""', "最後"]);
  // 語の行はすべて " で始まるので、# で始まる語もヘッダーと取り違えられない
  const bodyLines = text.split("\n").slice(4);
  assert.ok(bodyLines.every((line) => line.startsWith('"')));
  // ヘッダー行は引用しない
  assert.ok(text.split("\n").slice(0, 4).every((line) => line.startsWith("#") && !line.includes('"')));
});

test("書き出しボタンがHTMLにあり、USAGE_NAMES に anki-export がある", () => {
  assert.match(html, /<button id="exportAnkiButton" class="secondary" type="button" title="[^"]*">Anki用に書き出す<\/button>/);
  assert.ok(html.indexOf('id="exportCsvButton"') < html.indexOf('id="exportAnkiButton"'), "CSV ボタンの隣");
  assert.match(html, /Anki用はAnkiの「ファイルを読み込む」で取り込めます。Ankiの読み込み画面でノートタイプは「基本（Basic）」を選んでください（学習記録は含みません）。/);
  assert.match(html, /title="[^"]*Ankiの読み込み画面でノートタイプは「基本（Basic）」を選んでください">Anki用に書き出す/, "ボタンの title にも案内を入れる");
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
  assert.match(ok.status[0], /Ankiの読み込み画面でノートタイプは「基本（Basic）」を選んでください/);
});

// ============================================================================
// buildDailyActivity: 日別の記録を実時刻に戻してローカル日へ寄せる
// ============================================================================

// 日別のトークン（UTC日キー＋その日の秒の36進＋正誤）。本体の historyDailyTokenFor と同じ規則。
function dailyTokensFrom(entries) {
  const { historyDailyTokenFor } = load(["historyDailyTokenFor"]);
  const days = {};
  for (const entry of entries) {
    const t = historyDailyTokenFor(entry);
    days[t.key] = days[t.key] ? `${days[t.key]},${t.token}` : t.token;
  }
  return days;
}

function withTimeZone(zone, fn) {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

const dailyNames = ["localDateString", "buildDailyActivity"];

function activityPlain(byDay) {
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, v]) => [key, v.answers, v.correct, [...v.terms].sort()]);
}

test("buildDailyActivity: 東京で月曜01:00（UTCでは日曜16:00）の解答は、畳み込み後も月曜として数える", () => {
  withTimeZone("Asia/Tokyo", () => {
    const { buildDailyActivity } = load(dailyNames);
    assert.equal(new Date(2026, 9, 12, 1, 0).getTimezoneOffset(), -540, "テストの前提: 東京");
    const at = "2026-10-11T16:00:00.000Z"; // 東京の 2026-10-12（月）01:00
    const word = { term: "apple", history: [], historyDaily: { days: dailyTokensFrom([{ at, correct: true }]) } };
    const byDay = buildDailyActivity([word]);
    assert.deepEqual(activityPlain(byDay), [["2026-10-12", 1, 1, ["apple"]]], "日曜ではなく月曜");
  });
});

test("buildDailyActivity: 畳み込み前（生の履歴）と畳み込み後（日別のトークン）で、日ごとの合計が時差に関わらず一致する", () => {
  for (const zone of ["Asia/Tokyo", "America/Los_Angeles", "Pacific/Auckland", "UTC", "Asia/Kolkata"]) {
    withTimeZone(zone, () => {
      const { buildDailyActivity } = load(dailyNames);
      // 3日ぶんを1時間おきに。0時台・日付境界・正誤が入り混じるように偶数番を正解にする
      const base = Date.parse("2026-10-10T00:00:00.000Z");
      const entries = Array.from({ length: 72 }, (_, i) => ({
        at: new Date(base + i * 3600 * 1000 + (i % 7) * 61 * 1000).toISOString(),
        correct: i % 2 === 0,
      }));
      const raw = buildDailyActivity([{ term: "apple", history: entries }]);
      const folded = buildDailyActivity([{ term: "apple", history: [], historyDaily: { days: dailyTokensFrom(entries) } }]);
      assert.deepEqual(activityPlain(folded), activityPlain(raw), zone);
      // 期待値は「各解答の実時刻のローカル日」で独立に数える
      const expected = new Map();
      for (const entry of entries) {
        const key = localKey(new Date(entry.at));
        const row = expected.get(key) || [0, 0];
        row[0] += 1;
        if (entry.correct) row[1] += 1;
        expected.set(key, row);
      }
      assert.deepEqual(
        activityPlain(folded).map(([k, a, c]) => [k, a, c]),
        [...expected.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, [a, c]]) => [k, a, c]),
        zone,
      );
    });
  }
});

test("buildDailyActivity: 週カードの「2週以上」の判定も畳み込みで変わらない（東京の月曜01:00が週の境界）", () => {
  withTimeZone("Asia/Tokyo", () => {
    const { buildDailyActivity, buildWeeklyTrend } = load([...dailyNames, "weekStartKey", "buildWeeklyTrend"]);
    const now = new Date(2026, 9, 14, 12).getTime();
    // 東京の 10/5（月）01:00 と 10/12（月）01:00。日付をそのまま正午で寄せると、どちらも前の日曜に入って週が1つ前へずれる
    const entries = [
      { at: "2026-10-04T16:00:00.000Z", correct: true },
      { at: "2026-10-11T16:00:00.000Z", correct: false },
    ];
    const raw = buildDailyActivity([{ term: "a", history: entries }]);
    const folded = buildDailyActivity([{ term: "a", history: [], historyDaily: { days: dailyTokensFrom(entries) } }]);
    const weeksOf = (byDay) => plain(buildWeeklyTrend(byDay, [], now)).filter((w) => w.answers > 0);
    assert.deepEqual(weeksOf(folded), weeksOf(raw));
    assert.deepEqual(weeksOf(folded).map((w) => [w.start, w.answers]), [["2026-10-05", 1], ["2026-10-12", 1]]);
  });
});

test("buildDailyActivity: 秒が読めない壊れたトークンも1解答として数え、正解は + で数える（従来どおり）", () => {
  withTimeZone("UTC", () => {
    const { buildDailyActivity } = load(dailyNames);
    const byDay = buildDailyActivity([{ term: "a", historyDaily: { days: { "2026-10-12": "1+,zzzzz-,abc+,99999+" } } }]);
    const row = byDay.get("2026-10-12");
    assert.deepEqual([row.answers, row.correct], [4, 3]);
    assert.ok(row.terms.has("a"));
  });
});

// ============================================================================
// 日付をまたいで戻ったときの更新
// ============================================================================

test("復帰処理: 出題画面なら今日の状況と目標チップ、どのタブでも🔥とパネルを描き直す", () => {
  const start = html.indexOf("const resetQuizTimerOnResume = () => {");
  assert.ok(start >= 0);
  const end = html.indexOf("\n  };", start) + 5;
  const run = (activeStepId, panelOpen) => {
    const calls = [];
    const sandbox = {
      Date,
      currentQuiz: { answered: false, shownAt: 0 },
      activeStepId,
      elements: { streakPanel: { hidden: !panelOpen } },
      stopQuizTimer: () => calls.push("stop"),
      updateQuizControls: () => calls.push("controls"),
      renderDailyGoalChip: () => calls.push("goalChip"),
      renderStreakBadge: () => calls.push("badge"),
      renderStreakCalendar: () => calls.push("calendar"),
    };
    vm.createContext(sandbox);
    vm.runInContext(`${html.slice(start, end)}\nresetQuizTimerOnResume();`, sandbox);
    return calls;
  };
  const onQuiz = run("quiz", false);
  assert.ok(onQuiz.includes("controls") && onQuiz.includes("goalChip") && onQuiz.includes("badge"));
  assert.ok(!onQuiz.includes("calendar"), "パネルが閉じていればカレンダーは描かない");
  assert.deepEqual(run("library", false), ["badge"], "クイズ以外のタブでも🔥は描き直す");
  assert.deepEqual(run("library", true), ["badge", "calendar"], "パネルを開いていれば一緒に描き直す");
});

test("時計を2日進めて復帰すると、🔥は途切れた連続を0日と表示し、保存値は変えない", () => {
  const today = new Date();
  const twoDaysAgo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2);
  const badge = {
    hidden: true,
    title: "",
    attrs: {},
    classList: { set: new Set(), toggle(name, on) { on ? this.set.add(name) : this.set.delete(name); } },
    setAttribute(name, value) { this.attrs[name] = value; },
  };
  const count = { textContent: "" };
  const saved = { count: 5, last: localKey(twoDaysAgo), best: 8 };
  const sandbox = {
    elements: { streakBadge: badge, streakBadgeCount: count },
    appState: { streak: { ...saved } },
    renderQuizTodaySummary() {},
  };
  load(["localDateString", "normalizeStreak", "currentStreakCount", "renderStreakBadge"], sandbox);
  sandbox.renderStreakBadge();
  assert.equal(count.textContent, "0");
  assert.equal(badge.attrs["aria-label"], "連続学習 0日");
  assert.equal(JSON.stringify(sandbox.appState.streak), JSON.stringify(saved), "保存値は書き換えない");
});

test("表示の判定（currentStreakCount）と回答時の更新（updateStreakOnAnswer）は同じ境界になる", () => {
  // 表示が「継続」なら、今日1問解いた後も日数は保たれる（今日済みならそのまま、昨日なら+1）。
  // 表示が0なら、今日1問解くと1日目から数え直される。未来の日付（時計が進んだ端末）も含めて確かめる。
  const today = new Date();
  const key = (offset) => localKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset));
  for (const offset of [1, 0, -1, -2, -5]) {
    const sandbox = {
      appState: { streak: { count: 5, last: key(offset), best: 8 } },
      renderStreakBadge() {},
    };
    load(["localDateString", "normalizeStreak", "currentStreakCount", "updateStreakOnAnswer"], sandbox);
    const shown = sandbox.currentStreakCount(sandbox.normalizeStreak(sandbox.appState.streak), key(0));
    sandbox.updateStreakOnAnswer();
    const after = sandbox.appState.streak.count;
    if (shown === 0) {
      assert.equal(after, 1, `最後が${offset}日: 表示0なら回答後は1日目`);
    } else {
      assert.ok(after >= shown, `最後が${offset}日: 表示${shown}日が回答後に減らない（${after}日）`);
    }
  }
});

// ============================================================================
// 連続記録: 途切れた記録はヘッダーの🔥と開始画面で同じ扱いにする
// ============================================================================

test("currentStreakCount: 今日・昨日なら count、それより前は 0（保存値は変えない）", () => {
  const { currentStreakCount } = load(["localDateString", "currentStreakCount"]);
  const today = new Date(2026, 9, 12);
  const key = (offset) => localKey(new Date(2026, 9, 12 + offset));
  const streak = (last, count = 5) => ({ count, last, best: 9 });
  assert.equal(currentStreakCount(streak(key(0)), key(0)), 5, "今日");
  assert.equal(currentStreakCount(streak(key(-1)), key(0)), 5, "昨日");
  assert.equal(currentStreakCount(streak(key(-2)), key(0)), 0, "一昨日");
  assert.equal(currentStreakCount(streak(key(-3)), key(0)), 0, "3日前");
  assert.equal(currentStreakCount(streak(key(1)), key(0)), 0, "未来の日付は回答時に1日目へ戻るので、表示も0（updateStreakOnAnswer と同じ境界）");
  assert.equal(currentStreakCount(streak(""), key(0)), 0);
  assert.equal(currentStreakCount(streak(key(0), 0), key(0)), 0);
  assert.equal(currentStreakCount(null, key(0)), 0);
  // 月・年をまたいでも昨日を取り違えない
  assert.equal(currentStreakCount(streak("2026-09-30"), "2026-10-01"), 5);
  assert.equal(currentStreakCount(streak("2025-12-31"), "2026-01-01"), 5);
  assert.equal(currentStreakCount(streak("2025-12-30"), "2026-01-01"), 0);
  assert.ok(today instanceof Date);
});

function badgeSandbox(streak) {
  const classes = new Set();
  const attrs = {};
  const badge = {
    hidden: true,
    title: "",
    classList: { toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)) },
    setAttribute: (name, value) => (attrs[name] = value),
  };
  const count = { textContent: "" };
  const sandbox = {
    elements: { streakBadge: badge, streakBadgeCount: count },
    appState: { streak },
    renderQuizTodaySummary: () => {},
  };
  load(["localDateString", "normalizeStreak", "currentStreakCount", "renderStreakBadge"], sandbox);
  sandbox.renderStreakBadge();
  return { badge, count, classes, attrs, appState: sandbox.appState };
}

test("renderStreakBadge: 今日解いた→count、昨日まで→count（薄く）、3日前→0日（薄くしない）。保存値は書き換えない", () => {
  const key = (offset) => localKey(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + offset));
  const today = badgeSandbox({ count: 5, last: key(0), best: 8 });
  assert.equal(today.count.textContent, "5");
  assert.equal(today.classes.has("is-stale"), false);
  assert.equal(today.badge.title, "連続学習 5日");
  assert.equal(today.attrs["aria-label"], "連続学習 5日");

  const yesterday = badgeSandbox({ count: 5, last: key(-1), best: 8 });
  assert.equal(yesterday.count.textContent, "5");
  assert.equal(yesterday.classes.has("is-stale"), true);
  assert.equal(yesterday.badge.title, "連続学習 5日");

  const lapsedStreak = { count: 5, last: key(-3), best: 8 };
  const lapsed = badgeSandbox(lapsedStreak);
  assert.equal(lapsed.count.textContent, "0");
  assert.equal(lapsed.classes.has("is-stale"), false);
  assert.equal(lapsed.badge.title, "連続学習 0日");
  assert.equal(lapsed.attrs["aria-label"], "連続学習 0日");
  assert.deepEqual(plain(lapsed.appState.streak), { count: 5, last: key(-3), best: 8 }, "保存値（最高記録を含む）は変えない");
});

test("配線: 開始画面の今日の状況も currentStreakCount を使う", () => {
  assert.match(extractFunction("renderQuizTodaySummary"), /currentStreakCount\(/);
  assert.match(extractFunction("renderStreakBadge"), /currentStreakCount\(/);
});
