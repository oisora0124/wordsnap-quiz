// 単語データのCSV書き出し（1.0.129 C）を固定する。
//
// CSVは表計算ソフト・他ツールへ渡す用の書き出し専用形式で、読み込み（復元）には使わない。
// 数式注入（セル先頭が = + - @ 等だと表計算ソフトが実行してしまう）を防ぐエスケープと、
// BOM付きUTF-8・CRLF区切りでExcel等でも文字化け・改行崩れが起きないことを検査する。
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

function csvSandbox() {
  const sandbox = {};
  const source = [
    extractFunction("posLabel"),
    extractFunction("localDateString"),
    extractFunction("wordAddedMs"),
    extractFunction("csvEscapeCell"),
    extractFunction("buildCsvExport"),
    "globalThis.__csvEscapeCell = csvEscapeCell;",
    "globalThis.__buildCsvExport = buildCsvExport;",
  ].join("\n\n");
  new Script(source, { filename: "csv-export-sandbox.js" }).runInNewContext(sandbox);
  return sandbox;
}

// ============================================================================
// csvEscapeCell
// ============================================================================

test("csvEscapeCell: 通常の文字列はそのまま", () => {
  const { __csvEscapeCell: csvEscapeCell } = csvSandbox();
  assert.equal(csvEscapeCell("apple"), "apple");
});

test("csvEscapeCell: カンマを含む値は引用符で囲む", () => {
  const { __csvEscapeCell: csvEscapeCell } = csvSandbox();
  assert.equal(csvEscapeCell("a,b"), '"a,b"');
});

test("csvEscapeCell: 引用符は二重化してから全体を引用符で囲む", () => {
  const { __csvEscapeCell: csvEscapeCell } = csvSandbox();
  assert.equal(csvEscapeCell('say "hi"'), '"say ""hi"""');
});

test("csvEscapeCell: 改行を含む値は引用符で囲む", () => {
  const { __csvEscapeCell: csvEscapeCell } = csvSandbox();
  assert.equal(csvEscapeCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvEscapeCell("a\r\nb"), '"a\r\nb"');
});

test("csvEscapeCell: 先頭が = + - @ の値は数式注入対策で ' を付ける", () => {
  const { __csvEscapeCell: csvEscapeCell } = csvSandbox();
  assert.equal(csvEscapeCell("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(csvEscapeCell("+81"), "'+81");
  assert.equal(csvEscapeCell("-1"), "'-1");
  assert.equal(csvEscapeCell("@user"), "'@user");
});

test("csvEscapeCell: 先頭タブ/CR/LFにも同じ対策をする", () => {
  const { __csvEscapeCell: csvEscapeCell } = csvSandbox();
  assert.equal(csvEscapeCell("\tevil"), "'\tevil");
});

test("csvEscapeCell: null/undefinedは空文字として扱う", () => {
  const { __csvEscapeCell: csvEscapeCell } = csvSandbox();
  assert.equal(csvEscapeCell(null), "");
  assert.equal(csvEscapeCell(undefined), "");
});

// ============================================================================
// buildCsvExport
// ============================================================================

// タイムゾーン非依存にするため、年月日は「ローカル時刻」のコンストラクタ引数で組む。
// new Date(y, m, d, ...) は常にテスト実行プロセスのローカルTZで解釈されるので、
// 後で同じプロセス内の localDateString で読み戻しても、TZが何であれ同じ年月日に戻る
// （Date.UTC(...)で固定すると、TZ=UTC以外では日付がずれて期待値と食い違う）。
const NEXT_REVIEW_LOCAL = new Date(2026, 0, 15, 12, 0, 0);
const ADDED_LOCAL = new Date(2025, 11, 1, 12, 0, 0);

function makeWord(overrides = {}) {
  return {
    id: "w1",
    term: "apple",
    meaning: "りんご",
    deckId: "d1",
    cefr: { level: "A1" },
    pos: { tag: "n" },
    favorite: false,
    stats: { correct: 3, wrong: 1 },
    learning: { status: "review", nextReviewAt: NEXT_REVIEW_LOCAL.getTime() },
    // addedAtは実データと同じくISO文字列（wordAddedMsがDate.parseで読む。数値ミリ秒ではない）
    addedAt: ADDED_LOCAL.toISOString(),
    ...overrides,
  };
}

const DECKS = [{ id: "d1", name: "受験1500" }];

test("buildCsvExport: 先頭にBOM、続いてヘッダー行", () => {
  const { __buildCsvExport: buildCsvExport } = csvSandbox();
  const csv = buildCsvExport([], []);
  assert.equal(csv.charAt(0), "﻿");
  const header = csv.slice(1).split("\r\n")[0];
  assert.equal(
    header,
    "英単語,意味,単語帳,CEFR,品詞,お気に入り,正解数,不正解数,学習状態,次の復習日,追加日",
  );
});

test("buildCsvExport: 行はCRLFで区切る", () => {
  const { __buildCsvExport: buildCsvExport } = csvSandbox();
  const csv = buildCsvExport([makeWord(), makeWord({ id: "w2", term: "banana" })], DECKS);
  assert.match(csv, /\r\n/);
  assert.equal(csv.split("\r\n").length, 3); // ヘッダー + 2語
});

test("buildCsvExport: 単語帳名の解決・CEFR・品詞・お気に入り・正解不正解・学習状態・日付", () => {
  const { __buildCsvExport: buildCsvExport } = csvSandbox();
  const word = makeWord({ favorite: true });
  const csv = buildCsvExport([word], DECKS);
  const row = csv.slice(1).split("\r\n")[1];
  const cells = row.split(",");
  assert.equal(cells[0], "apple");
  assert.equal(cells[1], "りんご");
  assert.equal(cells[2], "受験1500");
  assert.equal(cells[3], "A1");
  assert.equal(cells[4], "名"); // posLabel("n")
  assert.equal(cells[5], "★");
  assert.equal(cells[6], "3");
  assert.equal(cells[7], "1");
  assert.equal(cells[8], "復習中");
  assert.equal(cells[9], "2026-01-15");
  assert.equal(cells[10], "2025-12-01");
});

test("buildCsvExport: 学習状態のnew/masteredも日本語化する", () => {
  const { __buildCsvExport: buildCsvExport } = csvSandbox();
  const csv = buildCsvExport(
    [
      makeWord({ id: "w1", learning: { status: "new", nextReviewAt: 0 } }),
      makeWord({ id: "w2", learning: { status: "mastered", nextReviewAt: 0 } }),
    ],
    DECKS,
  );
  const rows = csv.slice(1).split("\r\n").slice(1);
  assert.match(rows[0], /,未着手,/);
  assert.match(rows[1], /,習得済み,/);
});

test("buildCsvExport: 次の復習日が無ければ空欄", () => {
  const { __buildCsvExport: buildCsvExport } = csvSandbox();
  const csv = buildCsvExport([makeWord({ learning: { status: "new", nextReviewAt: 0 } })], DECKS);
  const cells = csv.slice(1).split("\r\n")[1].split(",");
  assert.equal(cells[9], "");
});

test("buildCsvExport: deckIdがnullなら単語帳は空欄", () => {
  const { __buildCsvExport: buildCsvExport } = csvSandbox();
  const csv = buildCsvExport([makeWord({ deckId: null })], DECKS);
  const cells = csv.slice(1).split("\r\n")[1].split(",");
  assert.equal(cells[2], "");
});

test("buildCsvExport: 品詞・CEFRが無い語は該当列が空欄", () => {
  const { __buildCsvExport: buildCsvExport } = csvSandbox();
  const csv = buildCsvExport([makeWord({ cefr: null, pos: null })], DECKS);
  const cells = csv.slice(1).split("\r\n")[1].split(",");
  assert.equal(cells[3], "");
  assert.equal(cells[4], "");
});

test("buildCsvExport: 追加日はwordAddedMs経由でISO文字列から解決し、数値・不正値・欠損は空欄", () => {
  const { __buildCsvExport: buildCsvExport } = csvSandbox();
  const cases = [
    ["数値ミリ秒（本来の形式ではない）", NEXT_REVIEW_LOCAL.getTime()],
    ["不正な文字列", "invalid"],
    ["欠損", undefined],
  ];
  for (const [label, addedAt] of cases) {
    const csv = buildCsvExport([makeWord({ addedAt })], DECKS);
    const cells = csv.slice(1).split("\r\n")[1].split(",");
    assert.equal(cells[10], "", label);
  }
});

test("buildCsvExport: null混入は飛ばし、語順は保たれる", () => {
  const { __buildCsvExport: buildCsvExport } = csvSandbox();
  const csv = buildCsvExport(
    [makeWord({ id: "w1", term: "apple" }), null, makeWord({ id: "w2", term: "banana" })],
    DECKS,
  );
  const rows = csv.slice(1).split("\r\n").slice(1);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^apple,/);
  assert.match(rows[1], /^banana,/);
});

test("buildCsvExport: 意味にカンマ・改行があっても1語として崩れない", () => {
  const { __buildCsvExport: buildCsvExport } = csvSandbox();
  const csv = buildCsvExport([makeWord({ meaning: "a, b\nc" })], DECKS);
  const rows = csv.slice(1).split("\r\n");
  // ヘッダー + 引用符で囲われた複数行セルを含む1語ぶん
  assert.equal(rows[0].split(",").length, 11);
  assert.match(csv, /"a, b\nc"/);
});

// ============================================================================
// HTML・USAGE_NAMES
// ============================================================================

test("#exportCsvButton が存在する", () => {
  assert.match(html, /id="exportCsvButton"/);
});

test("USAGE_NAMESに csv-export が含まれる", () => {
  const start = html.indexOf("const USAGE_NAMES = new Set([");
  const end = html.indexOf("]);", start);
  assert.ok(start >= 0 && end > start, "USAGE_NAMES が見つかること");
  const body = html.slice(start, end);
  assert.match(body, /"csv-export"/);
});
