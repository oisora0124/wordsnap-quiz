// 「まだ出せない指標」カード（1.0.101）を、公開HTML内の実コードから抽出して検査する。
//
// 成績カードは条件を満たさないと黙って消える（学習ログがオフ、記録が5回未満、
// 単語帳が1冊、CEFR判定済みが10語未満など）。利用者からは「機能が無い」のか
// 「データ待ち」なのか区別できず、不具合に見えていた。足りないものだけを最後に
// 1枚並べて理由を書く。
//
// この機能で一番まずいのは次の3つ。
//   - 出ているカードまで「出せない」と案内する（案内と実物が食い違う）
//   - 始めたばかりの画面が、不足の一覧だけになる
//   - 理由が実装と食い違い、条件を満たしても出ないように読める
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

// built は「各カードを実際に描いた結果」。空文字＝出ていない。
function buildSandbox({ built = {}, words = [], events = [], logEnabled = true } = {}) {
  const pieces = [
    `const appState = ${JSON.stringify({ words })};`,
    `const CEFR_ORDER = ["A1", "A2", "B1", "B2", "C1", "C2"];`,
    `function reviewLogEnabled() { return ${logEnabled}; }`,
    `function retainedReviewEvents() { return ${JSON.stringify(events)}; }`,
    `function statsScopedEvents() { return ${JSON.stringify(events)}; }`,
    `function statsScopedWords() { return ${JSON.stringify(words)}; }`,
    "let statsDeckIds = new Set();",
    `const STATS_FORMAT_MODES = [["meaning-choice","a"],["term-choice","b"],["context-choice","c"],["flashcard","d"]];`,
    extractFunction("escapeHtml"),
    extractFunction("statsCardHeader"),
    extractFunction("statsPendingCard"),
    `globalThis.__p = { card: () => statsPendingCard(${JSON.stringify(built)}) };`,
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "stats-pending-check.js" }).runInNewContext(sandbox);
  return sandbox.__p;
}

// 全部出ている状態（＝理由を書く対象が無い）。
const ALL = {
  activity: "x", accuracy: "x", deck: "x", cefr: "x", weak: "x", format: "x", speed: "x",
};

test("全部出ているときは、このカード自体を出さない", () => {
  const p = buildSandbox({ built: ALL });
  assert.equal(p.card(), "");
});

test("出ていないカードだけを挙げる（出ているものは案内しない）", () => {
  const p = buildSandbox({ built: { ...ALL, deck: "" } });
  const card = p.card();
  assert.match(card, /単語帳ごとの進捗/);
  assert.match(card, /単語帳を2冊以上つくると/);
  assert.doesNotMatch(card, /苦手な単語/, "出ているカードまで案内している");
  assert.match(card, /1件/, "件数が合っていない");
});

test("CEFRは、あと何語で出るのかを数字で言う", () => {
  const words = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, cefr: { level: "B1" } })),
    { id: "z", cefr: null },
  ];
  const p = buildSandbox({ built: { ...ALL, cefr: "" }, words });
  assert.match(p.card(), /CEFRが判定できた単語が10語たまると出ます（いま4語）/);
});

test("学習ログを使う2枚は、オフなら設定を案内する", () => {
  const p = buildSandbox({ built: { ...ALL, format: "", speed: "" }, logEnabled: false });
  const card = p.card();
  assert.match(card, /出題形式別の正答率・回答速度の分布/, "2枚をまとめて案内していない");
  assert.match(card, /「📈 学習の記録」をオンにすると/);
  assert.match(card, /1件/, "2枚まとめて1件として数える");
});

// カードごとに数え方が違う。総イベント数で「あと何回」と書くと、
// 0回と言っているのにカードが出ない状態になる（Codexの指摘）。
//   出題形式別 … dont-know を除き、同じ形式で5回
//   回答速度   … dont-know を除き、回答時間が残った回で5回
const graded = (promptMode, n, timed = true) =>
  Array.from({ length: n }, () => ({
    promptMode,
    result: "correct",
    ...(timed ? { responseTimeMs: 1200 } : {}),
  }));

test("出題形式別は「形式ごとに5回」で数える（合計では数えない）", () => {
  // 合計6回だが、形式ごとには3回ずつ。合計で数えると「あと0回」と嘘になる。
  const p = buildSandbox({
    built: { ...ALL, format: "" },
    events: [...graded("meaning-choice", 3), ...graded("term-choice", 3)],
  });
  assert.match(p.card(), /同じ出題形式で5回たまると出ます（いちばん多い形式でいま3回）/);
});

test("回答速度は「回答時間が残った回」で数える", () => {
  // 回答時間の無い記録（フラッシュカード等）は速度の分布に使えない。
  const p = buildSandbox({
    built: { ...ALL, speed: "" },
    events: [...graded("meaning-choice", 2), ...graded("flashcard", 6, false)],
  });
  assert.match(p.card(), /回答時間が残った記録が5回たまると出ます（いま2回）/);
});

test("「わからない」は、どちらの数にも入れない", () => {
  const dontKnow = Array.from({ length: 8 }, () => ({
    promptMode: "meaning-choice",
    result: "dont-know",
    responseTimeMs: 900,
  }));
  const p = buildSandbox({
    built: { ...ALL, format: "", speed: "" },
    events: [...graded("meaning-choice", 2), ...dontKnow],
  });
  const card = p.card();
  assert.match(card, /いちばん多い形式でいま2回/);
  assert.match(card, /回答時間が残った記録が5回たまると出ます（いま2回）/);
});

test("2枚とも出ていなくても、理由が違うので別々に書く", () => {
  const p = buildSandbox({
    built: { ...ALL, format: "", speed: "" },
    events: graded("meaning-choice", 2),
  });
  const card = p.card();
  assert.match(card, /class="stats-pending-name">出題形式別の正答率</);
  assert.match(card, /class="stats-pending-name">回答速度の分布</);
  assert.match(card, /2件/, "別々の行として数えていない");
});

test("学習ログがオフのときだけ、2枚をまとめて設定を案内する", () => {
  const p = buildSandbox({ built: { ...ALL, format: "", speed: "" }, logEnabled: false });
  const card = p.card();
  assert.match(card, /出題形式別の正答率・回答速度の分布/);
  assert.match(card, /1件/, "オフのときは理由が同じなので1件");
});

test("記録が1件も無くても、0回として書ける（負の数や NaN を出さない）", () => {
  const p = buildSandbox({ built: { ...ALL, format: "", speed: "" }, events: [] });
  const card = p.card();
  assert.match(card, /いちばん多い形式でいま0回/);
  assert.match(card, /（いま0回）/);
  assert.doesNotMatch(card, /-\d|Infinity|NaN/, "空の記録で壊れている");
});

test("片方だけ出ていないときは、その1枚だけを名前で挙げる", () => {
  const p = buildSandbox({ built: { ...ALL, speed: "" }, events: [{}], logEnabled: true });
  const card = p.card();
  assert.match(card, /回答速度の分布/);
  assert.doesNotMatch(card, /出題形式別の正答率/, "出ているカードまで案内している");
});

test("学習の記録が無いときは、期間つきで案内する", () => {
  // カード側の条件は「直近30日／14日に回答があること」。期間を書かないと、
  // 古い回答しか無い人にも出るように読めてしまう。
  const p = buildSandbox({ built: { ...ALL, activity: "", accuracy: "" } });
  const card = p.card();
  assert.match(card, /学習量の推移[\s\S]*?直近30日にクイズを解くと/);
  assert.match(card, /正答率の推移[\s\S]*?直近14日にクイズを解くと/);
});

test("苦手な単語は「1回でも間違える」ことまで書く", () => {
  // 実装は履歴3回以上かつ正答率100%未満。3回解けば必ず出ると書くと嘘になる。
  const p = buildSandbox({ built: { ...ALL, weak: "" } });
  assert.match(p.card(), /同じ単語を3回以上解いて、1回でも間違えると出ます/);
});

test("案内の文言はエスケープして出す", () => {
  const words = [{ id: "a", cefr: { level: "B1" } }];
  const p = buildSandbox({ built: { ...ALL, cefr: "" }, words });
  assert.doesNotMatch(p.card(), /<script/);
  assert.match(p.card(), /class="stats-pending-name"/);
});

// ---------------------------------------------------------------------------
// 配線。始めたばかりの画面を「不足の一覧」だけにしない。
// ---------------------------------------------------------------------------

test("配線: カードが1枚も無いときは、まだ出せない指標も出さずブロックごと隠す", () => {
  const start = html.indexOf("function renderStatsCharts(");
  const body = html.slice(start, html.indexOf("\n}", start));
  // 空判定 → 早期return が、まだ出せない指標の追加より前にあること。
  const hideAt = body.indexOf("block.hidden = true;");
  const pendingAt = body.indexOf("statsPendingCard(built)");
  assert.ok(hideAt > 0 && pendingAt > 0, "どちらかが見つからない");
  assert.ok(hideAt < pendingAt, "始めたばかりの画面が不足の一覧だけになる");
  // 並びの最後に足す。先頭に置くと、実際の指標より不足の一覧が先に目に入る。
  assert.match(body, /cards\.push\(pending\)/, "不足の一覧を末尾に足していない");
});

test("配線: 案内は「実際に描いた結果」から作る（条件の書き写しでずれない）", () => {
  const start = html.indexOf("function renderStatsCharts(");
  const body = html.slice(start, html.indexOf("\n}", start));
  assert.match(body, /const built = \{/, "描いた結果をまとめていない");
  assert.match(body, /statsPendingCard\(built\)/, "描いた結果を渡していない");
  // カードの並びも built から組む。二重に呼ぶと結果がずれる。
  const list = body.slice(body.indexOf("const cards = ["), body.indexOf("].filter(Boolean)"));
  assert.ok(list.length > 0, "カードの並びが見つからない");
  assert.doesNotMatch(list, /stats\w+Card\(/, "カードを2回組み立てている（結果がずれる）");
});

// ---------------------------------------------------------------------------
// 案内の数え方が、カードの実条件と本当に一致しているかを突き合わせる。
// 文言だけを検査していると、片方を変えたときに静かにずれる（Codexの指摘の本体）。
// 実物のカード関数と案内を同じ記録で動かし、境界で食い違わないことを見る。
// ---------------------------------------------------------------------------

function buildPairSandbox(events) {
  const decks = [{ id: "d1", name: "帳" }];
  const words = [{ id: "w", deckId: "d1" }];
  const pieces = [
    `const appState = ${JSON.stringify({ decks, words })};`,
    `const CEFR_ORDER = ["A1", "A2", "B1", "B2", "C1", "C2"];`,
    "function reviewLogEnabled() { return true; }",
    `function retainedReviewEvents() { return ${JSON.stringify(events)}; }`,
    `function statsScopedEvents() { return ${JSON.stringify(events)}; }`,
    `function statsScopedWords() { return ${JSON.stringify(words)}; }`,
    "let statsDeckIds = new Set(); let statsFilterOpen = false;",
    `const STATS_FORMAT_MODES = [["meaning-choice","意味を選ぶ（英→日）"],["term-choice","単語を選ぶ（日→英）"],["context-choice","例文の空所"],["flashcard","フラッシュカード"]];`,
    extractFunction("escapeHtml"),
    extractFunction("svgFill"),
    extractFunction("statsCardHeader"),
    extractFunction("statsSpeedCard"),
    extractFunction("statsFormatCard"),
    extractFunction("statsPendingCard"),
    "globalThis.__x = { format: () => statsFormatCard(), speed: () => statsSpeedCard()," +
      " pending: (b) => statsPendingCard(b) };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "stats-pending-pair.js" }).runInNewContext(sandbox);
  return sandbox.__x;
}

const answered = (promptMode, n, timed = true) =>
  Array.from({ length: n }, () => ({
    promptMode,
    result: "correct",
    ...(timed ? { responseTimeMs: 1500 } : {}),
  }));

test("突き合わせ: 案内が「5回たまった」と読める状態なら、カードは実際に出る", () => {
  for (const n of [4, 5, 6]) {
    const x = buildPairSandbox(answered("meaning-choice", n));
    const format = x.format();
    const speed = x.speed();
    const pending = x.pending({ activity: "x", accuracy: "x", deck: "x", cefr: "x", weak: "x", format, speed });
    if (n < 5) {
      assert.equal(format, "", `${n}回では形式別は出ない`);
      assert.equal(speed, "", `${n}回では速度は出ない`);
      assert.match(pending, new RegExp(`いちばん多い形式でいま${n}回`), `${n}回の案内が実際の件数と違う`);
      assert.match(pending, new RegExp(`回答時間が残った記録が5回たまると出ます（いま${n}回）`));
    } else {
      assert.ok(format, `${n}回なら形式別が出る`);
      assert.ok(speed, `${n}回なら速度が出る`);
      assert.doesNotMatch(pending, /出題形式別の正答率|回答速度の分布/, "出ているカードを案内している");
    }
  }
});

test("突き合わせ: 形式がばらけていると、合計5回でもカードは出ない（案内もそう言う）", () => {
  const events = [...answered("meaning-choice", 3), ...answered("term-choice", 3)];
  const x = buildPairSandbox(events);
  const format = x.format();
  assert.equal(format, "", "形式ごとに5回に満たないので出ない");
  const pending = x.pending({ activity: "x", accuracy: "x", deck: "x", cefr: "x", weak: "x", format, speed: x.speed() });
  assert.match(pending, /いちばん多い形式でいま3回/, "合計6回を根拠に「あと0回」と言ってはいけない");
});

test("突き合わせ: 回答時間の無い記録だけなら、速度は出ない（案内もそう言う）", () => {
  const events = answered("flashcard", 8, false);
  const x = buildPairSandbox(events);
  const speed = x.speed();
  assert.equal(speed, "", "回答時間が無いので速度は出ない");
  const pending = x.pending({ activity: "x", accuracy: "x", deck: "x", cefr: "x", weak: "x", format: x.format(), speed });
  assert.match(pending, /回答時間が残った記録が5回たまると出ます（いま0回）/);
});

// ---------------------------------------------------------------------------
// 単語の難しさ（CEFR）カードの表記（1.0.102 / Codexレビューの指摘④）
// 「レベル別（CEFR）」だと自分の英語力の判定に読めてしまう。また、バーの長さは
// レベル間の語数比較で、右の「習得/総数」とは別の軸なので、何を見ているのか書く。
// ---------------------------------------------------------------------------

test("CEFR: 見出しで「単語の難しさ」だと分かる", () => {
  const card = html.slice(html.indexOf("function statsCefrCard("));
  const body = card.slice(0, card.indexOf("\n}"));
  assert.match(body, /statsCardHeader\("単語の難しさ（CEFR）"/, "自分の英語力の判定に読める見出し");
  assert.doesNotMatch(body, /statsCardHeader\("レベル別（CEFR）"/);
});

test("CEFR: バーの長さと右の数字が別の軸であることを書く", () => {
  const card = html.slice(html.indexOf("function statsCefrCard("));
  const body = card.slice(0, card.indexOf("\n}"));
  assert.match(body, /バーの長さ＝そのレベルの語数/, "バーが何を表すか書いていない");
  assert.match(body, /あなたの英語力ではなく/, "誤読の打ち消しが無い");
});

test("CEFR: 案内の名前も見出しと合わせる", () => {
  const pending = html.slice(html.indexOf("function statsPendingCard("));
  const body = pending.slice(0, pending.indexOf("\n}"));
  assert.match(body, /add\("単語の難しさ（CEFR）"/, "案内とカードの名前が食い違っている");
});

test("絞り込み中は「選んだ単語帳の中で数えている」と書く", () => {
  // 「同じ単語を3回以上解くと出ます」のような全体基準の説明をそのまま出すと、
  // 絞り込んでいることを忘れて全体の話だと読んでしまう（Codexの指摘）。
  const pending = html.slice(html.indexOf("function statsPendingCard("));
  const body = pending.slice(0, pending.indexOf("\n}"));
  assert.match(body, /statsDeckIds\.size > 0/, "絞り込み中かどうかを見ていない");
  assert.match(body, /選んだ単語帳の中で数えています/);
  assert.match(body, /「すべてに戻す」/, "全体へ戻す方法が書かれていない");
});
