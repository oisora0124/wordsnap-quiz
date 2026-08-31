// 「出題形式別の正答率」（statsFormatCard）を、公開HTML内の実コードから抽出して検査する。
// 流儀は scripts/stats-speed-deck-filter.test.mjs と同じ。
//
// このカードは 1.0.79 で「出題の向き」（日→英）を足したときに更新し漏れていて、
// recordReviewEvent は term-choice を記録しているのに、集計側の groups に無いため
// groups.find で落ちていた。つまり日→英で解いた回答が1件も出ていなかった。
// 記録できる形式と、集計する形式がずれると同じことが起きるので、その対応を固定する。
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

// `const NAME = [...];` を対応する括弧の末尾まで切り出す。
function extractConst(name) {
  const start = html.indexOf(`const ${name} `);
  if (start < 0) throw new Error(`const ${name} not found`);
  let depth = 0;
  let seen = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      seen = true;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
    } else if (ch === ";" && depth === 0 && seen) {
      return html.slice(start, i + 1);
    }
  }
  throw new Error(`could not terminate const ${name}`);
}

function buildSandbox(events, logEnabled = true) {
  const pieces = [
    `let __events = ${JSON.stringify(events)};`,
    `function reviewLogEnabled() { return ${logEnabled}; }`,
    "function retainedReviewEvents() { return __events; }",
    // 絞り込みはパネル共通（statsScopedEvents）。ここでは絞らない状態を再現する。
    "function statsScopedEvents() { return __events; }",
    extractConst("STATS_FORMAT_MODES"),
    extractFunction("escapeHtml"),
    extractFunction("statsCardHeader"),
    extractFunction("statsFormatCard"),
    "globalThis.__f = { card: () => statsFormatCard() };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "stats-format-check.js" }).runInNewContext(sandbox);
  return sandbox.__f;
}

// n件の回答（correct件を正答）をその形式で作る。
function events(promptMode, n, correct = n) {
  return Array.from({ length: n }, (_, i) => ({
    promptMode,
    result: i < correct ? "correct" : "wrong",
  }));
}

// 記録側が受け付ける promptMode の一覧。ここが集計側とずれると回答が黙って消える。
const RECORDED_MODES = ["meaning-choice", "term-choice", "context-choice", "flashcard"];

test("記録できる形式と、集計する形式が一致している", () => {
  const rec = html.slice(html.indexOf("function recordReviewEvent("));
  const recorded = new Set(
    [...rec.slice(0, rec.indexOf("const responseTimeMs")).matchAll(/"([a-z-]+-choice|flashcard)"/g)].map((m) => m[1]),
  );
  assert.deepEqual([...recorded].sort(), [...RECORDED_MODES].sort(), "記録側の形式が変わっている");

  const table = extractConst("STATS_FORMAT_MODES");
  const grouped = [...table.matchAll(/\["([a-z-]+)",/g)].map((m) => m[1]);
  assert.deepEqual(
    grouped.sort(),
    [...RECORDED_MODES].sort(),
    "記録できるのに集計しない形式がある（その形式の回答は1件も出ない）",
  );
});

test("日→英（term-choice）の回答が集計される", () => {
  const f = buildSandbox(events("term-choice", 8, 6));
  const card = f.card();
  assert.match(card, /単語を選ぶ（日→英）/, "日→英の行が出ていない");
  assert.match(card, /75%/, "8回中6正答なら75%");
  assert.match(card, /6 \/ 8回/);
});

test("英→日と日→英を、別の形式として分けて出す", () => {
  const f = buildSandbox([...events("meaning-choice", 10, 9), ...events("term-choice", 10, 5)]);
  const card = f.card();
  assert.match(card, /意味を選ぶ（英→日）[\s\S]*?90%/);
  assert.match(card, /単語を選ぶ（日→英）[\s\S]*?50%/);
  assert.match(card, /2形式/, "見出しの形式数が合っていない");
});

test("向きが分かる表記にする（意味4択が2つある画面で見分けられる）", () => {
  const f = buildSandbox(events("meaning-choice", 5));
  assert.match(f.card(), /意味を選ぶ（英→日）/, "向きの無い表記だと日→英と区別できない");
});

test("5回に満たない形式は出さないが、待ちであることを伝える", () => {
  const f = buildSandbox([...events("meaning-choice", 6), ...events("term-choice", 2)]);
  const card = f.card();
  assert.match(card, /意味を選ぶ（英→日）/);
  assert.doesNotMatch(card, /単語を選ぶ（日→英）[\s\S]*?fmt-rate/, "5回未満の形式の正答率を出している");
  assert.match(card, /単語を選ぶ（日→英）は5回たまると出ます/, "消えたのか件数待ちなのか分からない");
});

test("一度も解いていない形式は、待ちとして案内しない", () => {
  const f = buildSandbox(events("meaning-choice", 6));
  assert.doesNotMatch(f.card(), /5回たまると出ます/, "使っていない形式まで案内している");
});

test("どの形式も5回に満たなければ、これまでどおりカードを出さない", () => {
  const f = buildSandbox([...events("meaning-choice", 4), ...events("term-choice", 4)]);
  assert.equal(f.card(), "");
});

test("「わからない」は正答率の分母に入れない（従来どおり）", () => {
  const withDontKnow = [
    ...events("meaning-choice", 5, 5),
    ...Array.from({ length: 5 }, () => ({ promptMode: "meaning-choice", result: "dont-know" })),
  ];
  const f = buildSandbox(withDontKnow);
  assert.match(f.card(), /5 \/ 5回/, "dont-know を分母に入れている");
});

test("学習ログが無効なら、これまでどおり何も出さない", () => {
  const f = buildSandbox(events("meaning-choice", 10), false);
  assert.equal(f.card(), "");
});
