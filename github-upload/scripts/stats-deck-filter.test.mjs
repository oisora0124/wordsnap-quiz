// 成績の単語帳フィルタ（1.0.102）を、公開HTML内の実コードから抽出して検査する。
//
// 1.0.99 では「回答速度の分布」カードだけに付けていた。同じパネルの中でカードごとに
// 母集団が違うと数字を見比べられないため（Codexの指摘⑤）、パネル全体の絞り込みへ
// 格上げした。学習イベントは wordId しか持たないので、描画時にいまの単語帳を引く。
//
// この機能で一番まずいのは次の4つ。
//   - 絞り込みが一部のカードにしか効かず、同じ画面で母集団が揃わない
//   - 絞った結果カードが全部消えて、絞り込みを解除する手段が画面から無くなる
//   - チェックを1つ入れるたびに焦点が飛び、2冊目を選べない
//   - 消した単語帳を選んだままになり、いつまでも0件が続く
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Script } from "node:vm";

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

function buildSandbox({ decks, words, events = [] }) {
  const pieces = [
    `const appState = ${JSON.stringify({ decks, words })};`,
    `function retainedReviewEvents() { return ${JSON.stringify(events)}; }`,
    "let statsDeckIds = new Set();",
    "let statsFilterOpen = false;",
    extractFunction("escapeHtml"),
    extractFunction("reviewEventDeckIndex"),
    extractFunction("statsScopedWords"),
    extractFunction("statsScopedEvents"),
    extractFunction("statsScopedDecks"),
    extractFunction("statsPruneDeckSelection"),
    extractFunction("statsFilterSummaryText"),
    extractFunction("statsDeckFilterMarkup"),
    "globalThis.__s = {" +
      " select: (...ids) => { statsDeckIds = new Set(ids); }," +
      " selected: () => [...statsDeckIds]," +
      " setOpen: (v) => { statsFilterOpen = v; }," +
      " words: () => statsScopedWords()," +
      " events: () => statsScopedEvents()," +
      " decks: () => statsScopedDecks()," +
      " markup: () => statsDeckFilterMarkup() };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "stats-deck-filter-check.js" }).runInNewContext(sandbox);
  return sandbox.__s;
}

const DECKS = [
  { id: "d1", name: "準1級EX" },
  { id: "d2", name: "パス単1級5訂版" },
  { id: "d3", name: "空っぽの単語帳" },
];
const WORDS = [
  ...Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, deckId: "d1" })),
  ...Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, deckId: "d2" })),
];
const EVENTS = [
  ...Array.from({ length: 8 }, (_, i) => ({ wordId: `a${i}`, result: "correct" })),
  ...Array.from({ length: 7 }, (_, i) => ({ wordId: `b${i}`, result: "correct" })),
];

test("絞り込み: 空なら全部（絞っていない状態を作らない）", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS });
  assert.equal(s.words().length, 15);
  assert.equal(s.events().length, 15);
  assert.equal(s.decks().length, 3);
});

test("絞り込み: 単語も学習イベントも同じ選択に従う（母集団が揃う）", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS });
  s.select("d1");
  assert.equal(s.words().length, 8, "単語が絞れていない");
  assert.equal(s.events().length, 8, "学習イベントが絞れていない");
  assert.deepEqual(Array.from(s.decks()).map((d) => d.id), ["d1"], "単語帳の一覧が絞れていない");
});

test("絞り込み: 複数選べる（選んだぶんを足し合わせる）", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS });
  s.select("d1", "d2");
  assert.equal(s.words().length, 15);
  assert.equal(s.events().length, 15);
  assert.match(s.markup(), /2冊を選択中/);
});

test("絞り込み: 学習イベントはいまの単語帳で判定する（記録の形式は変えない）", () => {
  // 単語帳を移した語は移動後の所属で数える。記録に単語帳を焼き付けていないことの裏返し。
  const moved = WORDS.map((w) => (w.id === "a0" ? { ...w, deckId: "d2" } : w));
  const s = buildSandbox({ decks: DECKS, words: moved, events: EVENTS });
  s.select("d2");
  assert.equal(s.events().length, 8, "移動後の単語帳で数えていない");
});

test("絞り込み: 削除された語の記録は、どの単語帳にも入らない", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS.slice(1), events: EVENTS });
  s.select("d1");
  assert.equal(s.events().length, 7);
});

test("絞り込み: 消えた単語帳は選択の記憶からも落とす", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS });
  s.select("d1", "消えたID");
  assert.match(s.markup(), /1冊を選択中/, "実在しない単語帳を数えている");
  assert.deepEqual(Array.from(s.selected()), ["d1"], "選択の記憶から落ちていない");
});

test("UI: 単語帳ごとの語数を添える", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS });
  const rows = [...s.markup().matchAll(/stats-deck-name"[^>]*>([^<]*)<\/span><span class="stats-deck-count">(\d+)語/g)]
    .map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(rows, ["準1級EX:8", "パス単1級5訂版:7", "空っぽの単語帳:0"]);
});

test("UI: 単語帳が1冊しかなければ出さない", () => {
  const s = buildSandbox({ decks: [DECKS[0]], words: WORDS, events: EVENTS });
  assert.equal(s.markup(), "");
});

test("UI: 折りたたみの開閉を覚えている", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS });
  assert.doesNotMatch(s.markup(), /<details class="stats-deck-filter" open>/, "既定は閉じている");
  s.setOpen(true);
  assert.match(s.markup(), /<details class="stats-deck-filter" open>/);
});

test("UI: 「すべてに戻す」は、何も選んでいないときは押せない", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS });
  assert.match(s.markup(), /id="statsDeckClear"[^>]*disabled/);
  s.select("d1");
  assert.doesNotMatch(s.markup(), /id="statsDeckClear"[^>]*disabled/);
});

test("UI: 何に効くのか、効かないものは何かを書く", () => {
  // 行動のカードはクイズ側の「出題する単語帳」に従う。ここで絞ると数字と
  // 「復習を始める」ボタンの範囲がずれるため、意図的に対象外にしている。
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS });
  const markup = s.markup();
  assert.match(markup, /下の集計に効きます/);
  assert.match(markup, /「今日の復習」など次にやることのカードは/);
  assert.match(markup, /role="group" aria-label="成績に含める単語帳"/, "読み上げでただの列になる");
});

test("UI: 単語帳の名前はエスケープして出す", () => {
  const s = buildSandbox({
    decks: [{ id: "d1", name: '<img src=x onerror="alert(1)">' }, { id: "d2", name: "ふつう" }],
    words: WORDS,
    events: EVENTS,
  });
  assert.doesNotMatch(s.markup(), /<img src=x/);
  assert.match(s.markup(), /&lt;img src=x/);
});

// ---------------------------------------------------------------------------
// どのカードが絞り込みに従うか。ここがずれると「同じ画面で母集団が揃わない」に戻る。
// ---------------------------------------------------------------------------

const bodyOf = (name) => {
  const start = html.indexOf(`function ${name}(`);
  return html.slice(start, html.indexOf("\n}", start));
};

test("集計のカードは、絞り込んだ母集団を使う", () => {
  for (const [name, marker] of [
    ["statsMasteryCard", /learningBuckets\(statsScopedWords\(\)\)/],
    ["statsCefrWords", /statsScopedWords\(\)/],
    ["statsWeakCard", /for \(const word of statsScopedWords\(\)\)/],
    ["statsDeckProgressCard", /statsScopedDecks\(\)/],
    ["statsFormatCard", /statsScopedEvents\(\)/],
    ["statsSpeedCard", /statsScopedEvents\(\)/],
    ["statsPendingCard", /statsScopedWords\(\)/],
  ]) {
    assert.match(bodyOf(name), marker, `${name} が絞り込みに従っていない`);
  }
});

test("日別のカードは、絞り込み中だけ集計をやり直す（カレンダーは巻き込まない）", () => {
  const body = bodyOf("renderStatsCharts");
  assert.match(
    body,
    /statsDeckIds\.size > 0\s*\?\s*buildDailyActivity\(statsScopedWords\(\)\)/,
    "絞り込み中に日別集計をやり直していない",
  );
  // カレンダー側の呼び出しは引数なし＝全単語のまま。
  assert.match(
    bodyOf("buildDailyActivity"),
    /function buildDailyActivity\(words = appState\.words \|\| \[\]\)/,
    "既定が全単語でなくなっている（カレンダーが絞り込みに巻き込まれる）",
  );
});

test("次にやることのカードは、クイズの出題範囲に従ったまま", () => {
  // ここに成績側の絞り込みを効かせると、表示される数字と「復習を始める」が
  // 実際に始める範囲（quizSelectedDeckWords）がずれる。
  for (const name of ["statsTodayReviewCard", "statsRecoveryCard"]) {
    assert.match(bodyOf(name), /quizSelectedDeckWords\(\)/, `${name} の母集団が変わっている`);
    assert.doesNotMatch(bodyOf(name), /statsScopedWords\(\)/, `${name} に成績側の絞り込みを効かせている`);
  }
});

// ---------------------------------------------------------------------------
// 配線
// ---------------------------------------------------------------------------

test("配線: 絞り込みのUIはカードの外に置く（選ぶたびに焦点が飛ばない）", () => {
  assert.match(html, /<div id="statsFilter" class="stats-filter"><\/div>/, "置き場所が無い");
  const start = html.indexOf('elements.statsFilter?.addEventListener("change"');
  assert.ok(start > 0, "チェックの操作を受けていない");
  const body = html.slice(start, html.indexOf("});", start));
  assert.match(body, /statsDeckIds\.add\(deckId\)/);
  assert.match(body, /statsDeckIds\.delete\(deckId\)/);
  assert.match(body, /syncStatsFilterSummary\(\)/, "見出しの文言を直していない");
  assert.match(body, /renderStatsCharts\(\)/, "カードを描き直していない");
});

test("配線: UIは単語帳の顔ぶれが変わったときだけ作り直す", () => {
  const body = bodyOf("renderStatsFilter");
  assert.match(body, /host\.dataset\.signature === signature/, "毎回作り直すと焦点が飛ぶ");
  assert.match(body, /deck\?\.id\}:\$\{deck\?\.name/, "名前の変更に追従していない");
});

test("配線: 「すべてに戻す」はチェックも外し、見出しへ焦点を移す", () => {
  const start = html.indexOf('if (!event.target?.closest?.("#statsDeckClear")) return;');
  assert.ok(start > 0);
  const body = html.slice(start, html.indexOf("});", start));
  assert.match(body, /statsDeckIds\.clear\(\)/);
  assert.match(body, /box\.checked = false/, "DOMのチェックが残る（作り直さないため）");
  assert.match(body, /\.stats-deck-filter > summary"\)\?\.focus\(\)/);
  assert.doesNotMatch(body, /closeStreakPanel/, "絞り込みを変えただけでパネルが閉じる");
});

test("配線: パネルを開き直したら絞り込みは「すべて」に戻る", () => {
  const body = bodyOf("openStreakPanel");
  assert.match(body, /statsDeckIds = new Set\(\)/, "絞ったまま忘れる事故が起きる");
  assert.match(body, /statsFilterOpen = false/);
  assert.match(body, /statsFilter\.dataset\.signature = ""/, "UIが作り直されない");
});

test("配線: 絞り込みで0件になっても、絞り込みごと隠さない", () => {
  const body = bodyOf("renderStatsCharts");
  const at = body.indexOf("if (cards.length === 0)");
  assert.ok(at > 0);
  const branch = body.slice(at, at + 900);
  assert.match(branch, /if \(statsDeckIds\.size === 0\) \{/, "絞り込み中でもブロックごと隠している");
  assert.match(branch, /選んだ単語帳には、まだ集計できる記録がありません/, "理由が出ない");
  assert.match(branch, /renderStatsFilter\(\)/, "絞り込みを出し直していない");
});

test("単語帳ごとの進捗は、見えている数と全体数を区別する", () => {
  // 「2冊」とだけ出すと、単語帳が2冊しか無いように読める（Codexの指摘）。
  const body = bodyOf("statsDeckProgressCard");
  assert.match(body, /const allDeckCount = \(appState\.decks \|\| \[\]\)/, "全体数を数えていない");
  assert.match(
    body,
    /allDeckCount > decks\.length \? `全\$\{allDeckCount\}冊中\$\{decks\.length\}冊`/,
    "絞り込み中に全体数を出していない",
  );
});

// ---------------------------------------------------------------------------
// Codexレビュー（1.0.102）で挙がった経路
// ---------------------------------------------------------------------------

test("消えた単語帳の掃除は、カードを組み立てる前に済ませる", () => {
  // あとに回すと、単語帳を消した直後に「消えた単語帳で絞ったままのカード」と
  // 「すべてに戻った見出し」が同時に出る。
  const body = bodyOf("renderStatsCharts");
  const pruneAt = body.indexOf("statsPruneDeckSelection()");
  const buildAt = body.indexOf("const built = {");
  assert.ok(pruneAt > 0 && buildAt > 0, "どちらかが見つからない");
  assert.ok(pruneAt < buildAt, "掃除がカードの組み立てより後になっている");
});

test("単語帳の語数が変わったら、絞り込みの一覧を作り直す", () => {
  // id と名前だけを見ていると、単語の追加・削除・移動や同期で中身が入れ替わっても
  // 一覧の語数が古いまま残る。
  const body = bodyOf("renderStatsFilter");
  assert.match(body, /counts\.get\(deck\?\.id\) \|\| 0/, "語数を署名に入れていない");
  assert.match(body, /deck\?\.id\}:\$\{deck\?\.name\}:\$\{counts/, "署名の形が変わっている");
});

test("確信度カードは絞り込めないので、絞り込み中はその旨を書く", () => {
  // 確信度の記録は合計だけを持っていて単語帳ごとに分けられない。
  // 黙って全体を出すと、絞ったつもりの数字と混ざる。
  const body = bodyOf("statsConfidenceCard");
  assert.match(body, /statsDeckIds\.size > 0/, "絞り込み中かどうかを見ていない");
  assert.match(body, /単語帳の絞り込みに関係なく、全体の集計です/);
});

test("絞り込みの結果を読み上げへ通知する", () => {
  const markup = bodyOf("statsDeckFilterMarkup");
  assert.match(markup, /id="statsFilterStatus" role="status" aria-live="polite"/, "通知先が無い");
  const sync = bodyOf("syncStatsFilterSummary");
  // 文言があるだけでは足りない。通知先を実際に引いて書き込んでいることまで見る。
  assert.match(sync, /const status = host\.querySelector\("#statsFilterStatus"\)/, "通知先を引いていない");
  assert.match(sync, /status\.textContent =/, "通知先へ書き込んでいない");
  assert.match(sync, /冊で集計しました/, "選んだときに通知していない");
  assert.match(sync, /すべての単語帳で集計しました/, "戻したときに通知していない");
});

test("「まだ出せない指標」は、知らない出題形式を件数に数えない", () => {
  // 未知の形式が5件あると、カードは出ないのに「いま5回」と案内してしまう。
  const body = bodyOf("statsPendingCard");
  assert.match(body, /const known = new Set\(STATS_FORMAT_MODES\.map/, "既知の形式で絞っていない");
  assert.match(body, /if \(!known\.has\(e\.promptMode\)\) continue;/);
});

test("出題形式の一覧は1か所にまとめる（記録側とのずれを1か所で見る）", () => {
  assert.match(html, /const STATS_FORMAT_MODES = \[/, "一覧が定数になっていない");
  const card = bodyOf("statsFormatCard");
  assert.match(card, /STATS_FORMAT_MODES\.map\(\(\[key, label\]\)/, "カードが一覧を使っていない");
});
