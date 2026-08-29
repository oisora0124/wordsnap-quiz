// 「回答速度の分布」を単語帳で絞り込む機能（1.0.99）を、公開HTML内の実コードから
// 抽出して検査する。流儀は scripts/context-quiz.test.mjs と同じ。
//
// 学習イベント（wordsnap-review-events:v1）は wordId しか持たない。記録の形式は
// 変えず、描画時にいまの単語帳を引いて紐づける方式にした。そのため、
//   - これまでに溜まった記録もそのまま絞り込める（移行が要らない）
//   - 単語帳を移した語は移動後の所属で数える
//   - 削除された語の記録はどの単語帳にも属さない
// という性質になる。ここが崩れると、利用者の記録が黙って数え漏れる。
//
// この機能で一番まずいのは次の3つ。
//   - 絞り込んだ結果カードごと消えて、絞り込みを解除する手段が画面から無くなる
//   - 消した単語帳を選んだままになり、いつまでも0件が続く
//   - チェックを1つ入れるたびに折りたたみが閉じ、2冊目を選べない
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Script } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

// 波括弧の対応をとって関数本体を切り出す（他のテストと同じ実装）。
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

// 記録は localStorage 由来なので、テストからは retainedReviewEvents を差し替えて渡す。
// それ以外（単語帳の突き合わせ・絞り込み・出力）は実コードをそのまま動かす。
function buildSandbox({ decks, words, events, logEnabled = true }) {
  const pieces = [
    `const appState = ${JSON.stringify({ decks, words })};`,
    `let __events = ${JSON.stringify(events)};`,
    `function reviewLogEnabled() { return ${logEnabled}; }`,
    "function retainedReviewEvents() { return __events; }",
    extractFunction("escapeHtml"),
    extractFunction("svgFill"),
    extractFunction("statsCardHeader"),
    extractFunction("reviewEventDeckIndex"),
    extractFunction("statsSpeedSelectedDecks"),
    extractFunction("statsSpeedDeckFilterMarkup"),
    extractFunction("statsSpeedCard"),
    "let statsSpeedDeckIds = new Set();",
    "let statsSpeedFilterOpen = false;",
    "globalThis.__s = {" +
      " card: () => statsSpeedCard()," +
      " select: (...ids) => { statsSpeedDeckIds = new Set(ids); }," +
      " setOpen: (v) => { statsSpeedFilterOpen = v; }," +
      " selected: () => [...statsSpeedDeckIds] };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "stats-speed-check.js" }).runInNewContext(sandbox);
  return sandbox.__s;
}

const DECKS = [
  { id: "d1", name: "準1級EX" },
  { id: "d2", name: "パス単1級5訂版" },
  { id: "d3", name: "空っぽの単語帳" },
];

// d1 に8語、d2 に7語。d3 は0語。
const WORDS = [
  ...Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, deckId: "d1" })),
  ...Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, deckId: "d2" })),
];

function ev(wordId, ms) {
  return { wordId, responseTimeMs: ms, result: "correct", occurredAt: 1 };
}

// d1 が8回、d2 が7回。
const EVENTS = [
  ...WORDS.filter((w) => w.deckId === "d1").map((w, i) => ev(w.id, 500 + i * 400)),
  ...WORDS.filter((w) => w.deckId === "d2").map((w, i) => ev(w.id, 900 + i * 700)),
];

const counts = (card) =>
  [...card.matchAll(/data-speed-deck="([^"]+)"[^>]*>\s*<span class="stats-deck-name"[^>]*>([^<]*)<\/span><span class="stats-deck-count">(\d+)回/g)]
    .map((m) => `${m[2]}:${m[3]}`);

test("絞り込み: 単語帳ごとの記録回数を出す（0件の単語帳も選べる形で並べる）", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS });
  const card = s.card();
  assert.deepEqual(counts(card), ["準1級EX:8", "パス単1級5訂版:7", "空っぽの単語帳:0"]);
  assert.match(card, /単語帳で絞る：すべての単語帳/);
});

test("絞り込み: 選んだ単語帳の記録だけで数える", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS });
  assert.match(s.card(), /回答速度の分布[\s\S]*?15回/, "絞る前は全件");
  s.select("d1");
  const card = s.card();
  assert.match(card, /8回<\/span>/, "選んだ単語帳の件数になっていない");
  assert.match(card, /選んだ1冊の正答・誤答を含む直近8回/, "何を数えたのかが書かれていない");
});

test("絞り込み: 複数選べる（選んだぶんを足し合わせる）", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS });
  s.select("d1", "d2");
  const card = s.card();
  assert.match(card, /15回<\/span>/, "2冊を選んだら合計になる");
  assert.match(card, /単語帳で絞る：2冊を選択中/);
  const checked = [...card.matchAll(/data-speed-deck="([^"]+)" checked/g)].map((m) => m[1]);
  assert.deepEqual(checked, ["d1", "d2"], "チェックが入った状態で描き直されていない");
});

test("絞り込み: 記録が5回に満たない選び方でも、カードと絞り込みは残る", () => {
  // ここでカードごと消すと、絞り込みを解除する手段が画面から無くなる。
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS });
  s.select("d3"); // 0件の単語帳
  const card = s.card();
  assert.ok(card, "カードごと消えている（元に戻せない）");
  assert.match(card, /data-speed-deck="d1"/, "絞り込みが残っていない");
  assert.match(card, /記録が0回しかありません/, "理由が書かれていない");
  assert.doesNotMatch(card, /<svg/, "件数が足りないのにグラフを出している");
});

test("絞り込み: 全体で5回に満たなければ、これまでどおりカードを出さない", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS.slice(0, 4) });
  assert.equal(s.card(), "");
});

test("絞り込み: 単語帳が1冊しかなければ絞り込みを出さない", () => {
  const s = buildSandbox({ decks: [DECKS[0]], words: WORDS, events: EVENTS });
  const card = s.card();
  assert.ok(card, "カード自体は出る");
  assert.doesNotMatch(card, /stats-deck-filter/, "絞る先が無いのに絞り込みを出している");
});

test("絞り込み: 消えた単語帳を選んだままにしない", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS });
  s.select("d1", "消えたID");
  const card = s.card();
  assert.match(card, /単語帳で絞る：1冊を選択中/, "実在しない単語帳を数えている");
  assert.match(card, /8回<\/span>/);
  // 覚えている側からも落とす。残すと、同期で同じidの単語帳が戻ったときに
  // 選んだ覚えのない絞り込みが復活する。
  assert.deepEqual(Array.from(s.selected()), ["d1"], "選択の記憶から消えた単語帳が落ちていない");
});

test("絞り込み: 折りたたみの開閉を覚えている（続けて2冊目を選べる）", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS });
  assert.doesNotMatch(s.card(), /<details class="stats-deck-filter" open>/, "既定は閉じている");
  s.setOpen(true);
  assert.match(s.card(), /<details class="stats-deck-filter" open>/, "開いたまま描き直せていない");
});

test("絞り込み: 「すべてに戻す」は、何も選んでいないときは押せない", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS });
  assert.match(s.card(), /id="statsSpeedDeckClear"[^>]*disabled/);
  s.select("d1");
  assert.doesNotMatch(s.card(), /id="statsSpeedDeckClear"[^>]*disabled/);
});

test("絞り込み: 単語帳を移した語は移動後の所属で数える（記録は作り直さない）", () => {
  // 学習イベントに単語帳を焼き付けていないことの裏返し。仕様として固定する。
  const moved = WORDS.map((w) => (w.id === "a0" ? { ...w, deckId: "d2" } : w));
  const s = buildSandbox({ decks: DECKS, words: moved, events: EVENTS });
  s.select("d2");
  assert.match(s.card(), /8回<\/span>/, "移動後の単語帳で数えていない");
});

test("絞り込み: 削除された語の記録は、どの単語帳にも数えない", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS.slice(1), events: EVENTS });
  assert.deepEqual(counts(s.card()), ["準1級EX:7", "パス単1級5訂版:7", "空っぽの単語帳:0"]);
  s.select("d1");
  assert.match(s.card(), /7回<\/span>/);
});

test("絞り込み: 単語帳の名前はエスケープして出す", () => {
  const s = buildSandbox({
    decks: [{ id: "d1", name: '<img src=x onerror="alert(1)">' }, { id: "d2", name: "ふつう" }],
    words: WORDS,
    events: EVENTS,
  });
  const card = s.card();
  assert.doesNotMatch(card, /<img src=x/, "単語帳名がそのままHTMLとして入っている");
  assert.match(card, /&lt;img src=x/);
});

test("絞り込み: 学習ログが無効なら、これまでどおり何も出さない", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS, logEnabled: false });
  assert.equal(s.card(), "");
});

// ---------------------------------------------------------------------------
// 配線。カードは描き直しで作り直されるので、委譲で受けていないと1回しか効かない。
// ---------------------------------------------------------------------------

test("配線: チェックの操作を委譲で受け、そのカードだけ作り直す", () => {
  const start = html.indexOf('elements.statsGrid?.addEventListener("change"');
  assert.ok(start > 0, "チェックの操作を受けていない");
  const body = html.slice(start, html.indexOf("});", start));
  assert.match(body, /closest\?\.\("input\[data-speed-deck\]"\)/, "委譲で受けていない");
  assert.match(body, /statsSpeedDeckIds\.add\(deckId\)/);
  assert.match(body, /statsSpeedDeckIds\.delete\(deckId\)/);
  // 成績全体を描き直すと、押したチェックボックスが消えて焦点が飛ぶ。
  assert.match(body, /refreshStatsSpeedCard\(deckId\)/, "そのカードだけ作り直していない");
  assert.doesNotMatch(body, /renderStatsCharts\(/, "成績全体を描き直すと焦点が飛ぶ");
});

test("配線: 「すべてに戻す」は学習の記録を閉じない", () => {
  const start = html.indexOf('if (!event.target?.closest?.("#statsSpeedDeckClear")) return;');
  assert.ok(start > 0, "「すべてに戻す」を受けていない");
  const body = html.slice(start, html.indexOf("});", start));
  assert.match(body, /statsSpeedDeckIds\.clear\(\)/);
  assert.match(body, /refreshStatsSpeedCard\(\)/);
  // 復習導線と同じ click 委譲に相乗りすると closeStreakPanel() が走ってしまう。
  assert.doesNotMatch(body, /closeStreakPanel/, "絞り込みを変えただけでパネルが閉じる");
});

test("配線: 折りたたみの開閉は捕捉フェーズで受ける（toggle は上へ伝わらない）", () => {
  const start = html.indexOf('elements.statsGrid?.addEventListener(\n  "toggle"');
  assert.ok(start > 0, "折りたたみの開閉を受けていない");
  const body = html.slice(start, html.indexOf("\n);", start));
  assert.match(body, /statsSpeedFilterOpen = details\.open/);
  assert.match(body, /\n\s*true,\s*$/, "捕捉フェーズにしていないと受け取れない");
});

test("配線: カードだけ作り直したあと、操作したチェックへ焦点を戻す", () => {
  const start = html.indexOf("function refreshStatsSpeedCard(");
  assert.ok(start > 0);
  const body = html.slice(start, html.indexOf("\n}", start));
  assert.match(body, /querySelector\("#statsSpeedCard"\)/);
  assert.match(body, /current\.replaceWith\(next\)/);
  assert.match(body, /box\?\.focus\(\)/, "焦点を戻さないとキーボードで続けて選べない");
});

test("絞り込み: チェックボックス群に名前を付ける（何を選ぶ場所か分かる）", () => {
  const s = buildSandbox({ decks: DECKS, words: WORDS, events: EVENTS });
  assert.match(
    s.card(),
    /<div class="stats-deck-options" role="group" aria-label="[^"]+">/,
    "読み上げでただのチェックボックスの列になる",
  );
});

test("配線: もう出せなくなったカードは、消えた記録のまま残さない", () => {
  // 学習の記録を切る・記録を全部消すと statsSpeedCard() は空文字を返す。
  // そこで return して終わると、古い内容のカードが画面に残り続ける。
  const start = html.indexOf("function refreshStatsSpeedCard(");
  const body = html.slice(start, html.indexOf("\n}", start));
  assert.match(
    body,
    /if \(!html\) \{\s*(?:\/\/[^\n]*\n\s*)*renderStatsCharts\(\);/,
    "出せなくなったカードを残したままにしている",
  );
});

test("配線: 学習の記録の切り替えと全削除で、開いている成績を描き直す", () => {
  // 記録を切り替える側と、記録を消す側の両方。前者は初期化の代入と紛らわしいので
  // 「切り替えを受けるところ」から数える。
  for (const marker of [
    'elements.reviewLogToggle.addEventListener("change"',
    "localStorage.removeItem(REVIEW_EVENTS_KEY);",
  ]) {
    const at = html.indexOf(marker);
    assert.ok(at > 0, `${marker} が見つからない`);
    assert.match(
      html.slice(at, at + 600),
      /refreshStatsIfVisible\(\)/,
      `記録を変えたのに成績を描き直していない: ${marker}`,
    );
  }
  const start = html.indexOf("function refreshStatsIfVisible(");
  assert.ok(start > 0, "ヘルパーが無い");
  const body = html.slice(start, html.indexOf("\n}", start));
  assert.match(body, /streakPanel\?\.hidden === false/, "閉じているときにも描いている");
});

test("配線: 「すべてに戻す」のあとは折りたたみの見出しへ焦点を移す", () => {
  // 戻したあとボタンは disabled になるので、そこへ焦点を残せない。
  const at = html.indexOf('if (!event.target?.closest?.("#statsSpeedDeckClear")) return;');
  const body = html.slice(at, html.indexOf("});", at));
  assert.match(body, /\.stats-deck-filter > summary"\)\?\.focus\(\)/, "焦点の行き先が無い");
});
