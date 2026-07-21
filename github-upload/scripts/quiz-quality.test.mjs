// クイズ品質の純粋関数を、公開HTML内の実コードから抽出して固定入力で検査する。
// これらは過去に「誤答が正解になる」「多品詞語を取りこぼす」等の回帰を繰り返した箇所で、
// 不変条件をここで固定して将来の変更が静かに壊さないようにする。アプリHTMLは変更しない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Script } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

// 波括弧の対応をとって関数本体を丸ごと切り出す（次の宣言に頼らないので配置変更に強い）。
function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const bodyBrace = html.indexOf("{", html.indexOf(")", start));
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

// `const NAME = ...;`（IIFEや配列/Setを含む）を、対応する括弧の末尾＋セミコロンまで切り出す。
function extractConst(name) {
  const start = html.indexOf(`const ${name} `);
  if (start < 0) throw new Error(`const ${name} not found`);
  let depth = 0;
  let seen = false;
  for (let i = start; i < html.length; i += 1) {
    const c = html[i];
    if (c === "(" || c === "[" || c === "{") {
      depth += 1;
      seen = true;
    } else if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
    } else if (c === ";" && depth === 0 && seen) {
      return html.slice(start, i + 1);
    } else if (c === "\n" && depth === 0 && seen) {
      // 単一行 const（括弧の対応が閉じた直後の改行）で終端
      return html.slice(start, i);
    }
  }
  throw new Error(`could not terminate const ${name}`);
}

// 依存順に組み立てたサンドボックス。appState はテストごとに書き換える。
function buildSandbox() {
  const pieces = [
    "const appState = { words: [] };",
    "Math.random = () => 0.5;", // shuffle を決定論化
    extractConst("BUILTIN_POS_GROUPS"),
    extractConst("BUILTIN_POS"),
    extractConst("BUILTIN_POS_NOUN_AND_VERB"),
    extractConst("DERIVATIONAL_SUFFIXES"),
    extractFunction("builtinPosTag"),
    extractFunction("builtinPosTags"),
    extractFunction("posTagsFor"),
    extractFunction("derivationStem"),
    extractFunction("hasDerivationalSuffix"),
    extractFunction("contextDistractorHasBasis"),
    extractFunction("normalizeMeaning"),
    extractFunction("meaningsTooClose"),
    extractFunction("spellingDistance"),
    extractFunction("shuffle"),
    extractFunction("pickDistractors"),
    "globalThis.__q = { appStateRef: () => appState, setWords: (w) => { appState.words = w; }," +
      " builtinPosTags, posTagsFor, contextDistractorHasBasis, meaningsTooClose, pickDistractors, normalizeMeaning, spellingDistance };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "quiz-quality-check.js" }).runInNewContext(sandbox);
  return sandbox.__q;
}

const q = buildSandbox();
const W = (term, meaning, tag) => ({ id: term, term, meaning, pos: { tag } });

test("built-in noun/verb words expose both parts of speech", () => {
  // 代表品詞1つで判定すると多品詞語(attempt/impact/decline)を誤って除外根拠にしてしまう回帰の固定。
  assert.deepEqual([...q.builtinPosTags("attempt")].sort(), ["n", "v"]);
  assert.deepEqual([...q.builtinPosTags("impact")].sort(), ["n", "v"]);
  assert.deepEqual([...q.builtinPosTags("accurate")], ["adj"]);
  assert.deepEqual([...q.builtinPosTags("zzznotaword")], []);
});

test("posTagsFor unions the built-in table with saved tags", () => {
  q.setWords([]);
  // 表に無い語でも、保存済みの複数タグがあれば両方返す（Datamuseが返す全品詞を捨てない）。
  const word = { term: "custom", pos: { tag: "v", tags: ["v", "n"] } };
  assert.deepEqual([...q.posTagsFor("custom", word)].sort(), ["n", "v"]);
});

test("a distractor has basis only when parts of speech do not overlap", () => {
  q.setWords([]);
  // 品詞が1つでも重なれば空所に入り得るので根拠にならない（=false）。
  assert.equal(q.contextDistractorHasBasis(W("decline"), "impact"), false); // 両方 n,v
  assert.equal(q.contextDistractorHasBasis(W("decline"), "accurate"), true); // v,n vs adj
  assert.equal(q.contextDistractorHasBasis(W("accurate"), "impact"), true); // adj vs n,v
  assert.equal(q.contextDistractorHasBasis(W("observe"), "structure"), false); // v vs n,v (重なる)
  assert.equal(q.contextDistractorHasBasis(W("observe"), "poverty"), true); // v vs n
  assert.equal(q.contextDistractorHasBasis(W("observe"), "zzznotaword"), false); // 品詞不明は根拠にしない
});

test("derived forms of the answer are a valid basis regardless of the built-in table", () => {
  q.setWords([]);
  // 出題語の名詞化などは品詞が違うので空所に入らない＝根拠あり。
  assert.equal(q.contextDistractorHasBasis(W("decide", "決める", "v"), "decision"), true);
});

test("meaningsTooClose rejects containment, not merely equality", () => {
  assert.equal(q.meaningsTooClose("変える", "部分的に変える"), true);
  assert.equal(q.meaningsTooClose("重要な", "極めて重要な"), true);
  assert.equal(q.meaningsTooClose("分配する", "減少する"), false);
  assert.equal(q.meaningsTooClose("な", "危険な"), false); // 短すぎる語で過剰除外しない
});

test("pickDistractors keeps at most one spelling-confusable choice", () => {
  const answer = W("affect", "影響を与える", "v");
  const pool = [
    W("afflict", "苦しめる", "v"), W("affix", "貼り付ける", "v"), W("effect", "効果", "n"),
    W("gather", "集める", "v"), W("wisdom", "知恵", "n"), W("urban", "都会の", "adj"),
  ];
  // 綴りが近い(距離1-2)語は最大1つまで。300回試行しても超えない。
  let worst = 0;
  for (let i = 0; i < 300; i += 1) {
    const picked = q.pickDistractors(pool, answer, 3);
    const confusable = picked.filter((w) => { const d = q.spellingDistance(answer.term, w.term); return d > 0 && d <= 2; }).length;
    if (confusable > worst) worst = confusable;
  }
  assert.ok(worst <= 1, `confusable distractors must stay <= 1, saw ${worst}`);
});

test("pickDistractors never repeats the answer meaning and stays within count", () => {
  const answer = W("large", "大きい", "adj");
  const pool = [
    W("big", "大きい", "adj"), // 意味重複 → 除外されるべき
    W("small", "小さい", "adj"), W("fast", "速い", "adj"), W("slow", "遅い", "adj"),
  ];
  const picked = q.pickDistractors(pool, answer, 3);
  assert.ok(picked.length <= 3);
  assert.ok(!picked.some((w) => q.normalizeMeaning(w.meaning) === q.normalizeMeaning(answer.meaning)),
    "a distractor must not share the answer meaning");
});

test("cloze mode prefers distractors of a different part of speech", () => {
  const answer = W("accurate", "正確な", "adj");
  const pool = [
    W("vague", "曖昧な", "adj"), W("rigid", "硬直した", "adj"),
    W("infer", "推論する", "v"), W("factor", "要因", "n"), W("gather", "集める", "v"),
  ];
  // preferDifferentPos=true では同品詞(adj)を避け、別品詞を優先する。
  let sameAdj = 0;
  for (let i = 0; i < 200; i += 1) {
    const picked = q.pickDistractors(pool, answer, 3, [], { preferDifferentPos: true });
    sameAdj += picked.filter((w) => w.pos.tag === "adj").length;
  }
  assert.equal(sameAdj, 0, "cloze distractors should avoid the answer's part of speech when alternatives exist");
});
