// 取り込み（手順1→2）と候補の保存の自己レビュー（1.0.109）で直した点を、実コードのまま固定する。
//
// 1. 全角英数字の行（ａｐｐｌｅ りんご）は半角に直して読む。従来は英字として認識されず、
//    読み取れなかった行の報告も無いまま黙って落ちていた。
// 2. 「apple - りんご」の区切りのハイフンが語の末尾に残らない。
// 3. 「apple (n) りんご」の品詞の括弧書きが語に混じらない（「apple n」になっていた）。
// 4. 「apple(りんご)」の閉じ括弧が訳の末尾に残らない。
// 5. 候補の保存は、端末への保存が済んだことを確かめてから候補を消す。両方失敗したら
//    追加した語を取り消し、候補を残し、失敗を伝える。保存中は二重押しできない。
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

function extractConst(name) {
  const start = html.indexOf(`const ${name} `);
  if (start < 0) throw new Error(`const ${name} not found`);
  const end = html.indexOf(";\n", start);
  return html.slice(start, end + 1);
}

function extractHandlerBody(anchor) {
  const start = html.indexOf(anchor);
  if (start < 0) throw new Error(`anchor not found: ${anchor}`);
  const bodyBrace = start + anchor.length - 1;
  if (html[bodyBrace] !== "{") throw new Error("anchor must end with {");
  let depth = 0;
  for (let i = bodyBrace; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(bodyBrace, i + 1);
    }
  }
  throw new Error("unbalanced handler");
}

// ============================================================================
// 1〜4. 取り込みの読み取り
// ============================================================================
function parseSandbox(words = []) {
  const pieces = [
    extractConst("JP_CHAR"),
    extractConst("IPA_CHARS"),
    extractConst("POS_HEAD"),
    extractConst("SENTENCE_END_CHARS"),
    extractConst("TERM_POS_PAREN"),
    `const appState = { words: ${JSON.stringify(words)}, trash: [] };`,
    extractFunction("normalizeTerm"),
    extractFunction("stripNoise"),
    extractFunction("cleanTermText"),
    extractFunction("firstMeaning"),
    extractFunction("droppedEnglishTail"),
    extractFunction("looksLikeHeadword"),
    extractFunction("validPair"),
    extractFunction("parseVocabulary"),
    "globalThis.__p = { parseVocabulary, cleanTermText, firstMeaning, stripNoise };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "import-quality-parse.js" }).runInNewContext(sandbox);
  return sandbox.__p;
}

const pairs = (result) => Array.from(result.candidates, (c) => [c.term, c.meaning]);

test("取り込み: 全角の英数字は半角に直して読む（黙って落とさない）", () => {
  const p = parseSandbox();
  assert.deepEqual(pairs(p.parseVocabulary("ａｐｐｌｅ りんご\nＢａｎｋ３ 銀行", null)), [["apple", "りんご"], ["Bank3", "銀行"]]);
  assert.equal(p.stripNoise("ＡＢＣ ｘｙｚ ０１２"), "ABC xyz 012");
  // 半角と全角で同じ語は重複として扱う（保存済みの apple がある）
  const q = parseSandbox([{ id: "a", term: "apple", meaning: "りんご", deckId: "d1" }]);
  const r = q.parseVocabulary("ａｐｐｌｅ 林檎", null);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.dupSavedCount, 1);
});

test("取り込み: 区切りのハイフンは語の末尾に残さない。語中のハイフンはそのまま", () => {
  const p = parseSandbox();
  assert.deepEqual(pairs(p.parseVocabulary("apple - りんご\nwell-known 有名な\n- bank 銀行", null)), [
    ["apple", "りんご"],
    ["well-known", "有名な"],
    ["bank", "銀行"],
  ]);
  assert.equal(p.cleanTermText("apple -"), "apple");
  assert.equal(p.cleanTermText("-apple-"), "apple");
  assert.equal(p.cleanTermText("give up"), "give up");
});

test("取り込み: 品詞の括弧書きは語に混ぜない（apple (n) りんご → apple）", () => {
  const p = parseSandbox();
  assert.deepEqual(pairs(p.parseVocabulary("apple (n) りんご\nrun（v.）走る\nlook (at) 見る", null)), [
    ["apple", "りんご"],
    ["run", "走る"],
    ["look at", "見る"], // 品詞でない括弧書きは従来どおり語の一部として残す
  ]);
});

test("取り込み: 訳を囲む括弧は落とす（apple(りんご) → りんご）", () => {
  const p = parseSandbox();
  assert.deepEqual(pairs(p.parseVocabulary("apple(りんご)\nbank（銀行）\ncat 「猫」", null)), [
    ["apple", "りんご"],
    ["bank", "銀行"],
    ["cat", "猫"],
  ]);
  assert.equal(p.firstMeaning("（りんご）"), "りんご");
  assert.equal(p.firstMeaning("形 美しい"), "美しい", "行頭の品詞（従来の書き方）は従来どおり落とす");
});

test("取り込み: 従来どおり読める形は変わらない", () => {
  const p = parseSandbox();
  const text = [
    "1. apple りんご",
    "2) bank 銀行",
    "cat\t猫",
    "dog,犬",
    "egg／卵",
    "fish 魚、さかな",
    "don't しない",
    "give up あきらめる",
    "beautiful",
    "美しい",
  ].join("\n");
  assert.deepEqual(pairs(p.parseVocabulary(text, null)), [
    ["apple", "りんご"],
    ["bank", "銀行"],
    ["cat", "猫"],
    ["dog", "犬"],
    ["egg", "卵"],
    ["fish", "魚"],
    ["don't", "しない"],
    ["give up", "あきらめる"],
    ["beautiful", "美しい"],
  ]);
});

// ============================================================================
// 5. 候補の保存は端末への保存を確かめてから
// ============================================================================
function saveSandbox({ persisted }) {
  const body = extractHandlerBody('elements.saveParsedButton.addEventListener("click", async () => {');
  const pieces = [
    extractFunction("normalizeTerm"),
    extractFunction("validPair"),
    "let __idSeq = 0; function createId() { return `w${++__idSeq}`; }",
    "function emptyEnrich() { return {}; }",
    "const window = { Cefr: { peek: () => null } };",
    "let appState = { words: [{ id: 'old', term: 'old', meaning: '古い', deckId: 'd1' }], decks: [{ id: 'd1', name: 'A' }, { id: 'd2', name: 'B' }], activeDeckId: 'd1' };",
    "let candidates = [{ term: 'apple', meaning: '編集した訳' }, { term: 'bad', meaning: '' }];",
    "let currentQuiz = { answer: { id: 'old' } };",
    "let saveDeckChosenByUser = true;",
    "let saveParsedBusy = false;",
    "let activeOcrRun = null;",
    "function syncParseButtonLock() { if (elements.parseButton) elements.parseButton.disabled = Boolean(activeOcrRun) || saveParsedBusy; }",
    "const elements = { saveDeckSelect: { value: 'd2' }, saveParsedButton: { disabled: false } };",
    "let __log = [];",
    "function deckName(id) { return appState.decks.find((d) => d.id === id)?.name || '単語帳'; }",
    "function clearUndo() { __log.push('clearUndo'); }",
    `async function persistAppStateChecked() { __log.push('persist'); return ${persisted ? "true" : "false"}; }`,
    "function renderAll() { __log.push('renderAll'); }",
    "function renderCandidates() { __log.push('renderCandidates'); }",
    "function notifyInlineSaveFailure() { __log.push('failure'); }",
    "function scheduleInlineSaveSuccess(m) { __log.push('success'); }",
    "function setStatus(m) { __log.push(['status', m]); }",
    "function playSound(n) { __log.push(['sound', n]); }",
    "function setActiveStep(id) { __log.push(['step', id]); }",
    "function queueMetadataPrefetch(list) { __log.push(['prefetch', list.length]); }",
    `const handler = async () => ${body};`,
    "globalThis.__s = { run: handler, state: () => appState, candidates: () => candidates, log: () => __log, busy: () => saveParsedBusy, button: elements.saveParsedButton, chosen: () => saveDeckChosenByUser, quiz: () => currentQuiz };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "import-quality-save.js" }).runInNewContext(sandbox);
  return sandbox.__s;
}

test("候補の保存: 端末に保存できたら候補を消して案内する（従来の流れ）", async () => {
  const s = saveSandbox({ persisted: true });
  await s.run();
  const st = s.state();
  assert.deepEqual(Array.from(st.words, (w) => [w.term, w.meaning, w.deckId]), [["old", "古い", "d1"], ["apple", "編集した訳", "d2"]]);
  assert.deepEqual(Array.from(s.candidates(), (c) => c.term), ["bad"], "保存できなかった候補は理由付きで残す");
  assert.equal(st.activeDeckId, "d2");
  assert.equal(s.chosen(), true, "候補が残っている間は保存先の明示選択を解除しない");
  const log = s.log();
  const names = log.map((e) => (Array.isArray(e) ? e[0] : e));
  assert.ok(names.includes("clearUndo"), "取り消しを消す（saveState と同じ）");
  assert.ok(names.indexOf("persist") < names.indexOf("clearUndo"), "取り消しは保存できてから消す（失敗したときに残すため。1.0.119）");
  assert.ok(names.indexOf("persist") < names.indexOf("renderAll"), "保存してから描く");
  assert.ok(names.includes("success"));
  assert.ok(!names.includes("failure"));
  assert.ok(log.some((e) => Array.isArray(e) && e[0] === "prefetch" && e[1] === 1));
  assert.equal(s.busy(), false);
  assert.equal(s.button.disabled, false, "候補が残っているので押せる");
});

test("候補の保存: 端末に保存できなかったら、追加した語を取り消し、候補を残し、失敗を伝える", async () => {
  const s = saveSandbox({ persisted: false });
  await s.run();
  const st = s.state();
  assert.deepEqual(Array.from(st.words, (w) => w.term), ["old"], "保存できなかった語を残してはいけない（再読込で消えるのに一覧には出る）");
  assert.equal(st.activeDeckId, "d1", "表示中の単語帳も戻す");
  assert.deepEqual(Array.from(s.candidates(), (c) => c.term), ["apple", "bad"], "候補はそのまま残す");
  const log = s.log();
  const names = log.map((e) => (Array.isArray(e) ? e[0] : e));
  assert.ok(names.includes("failure"));
  assert.ok(!names.includes("success"), "失敗したのに「保存しました」を出してはいけない");
  assert.ok(!names.some((n) => n === "step"), "失敗時は画面を切り替えない");
  const status = log.find((e) => Array.isArray(e) && e[0] === "status")[1];
  assert.match(status, /端末に保存できませんでした/);
  assert.match(status, /候補はそのまま残しています/);
  assert.equal(s.busy(), false);
  assert.equal(s.button.disabled, false);
});

test("候補の保存: 保存中は二重押しできない", async () => {
  const body = extractHandlerBody('elements.saveParsedButton.addEventListener("click", async () => {');
  assert.match(body, /^\{\s*\n\s*if \(saveParsedBusy\) return;/);
  assert.match(body, /saveParsedBusy = true;\s*\n\s*elements\.saveParsedButton\.disabled = true;/);
  assert.match(body, /finally \{\s*\n\s*saveParsedBusy = false;/);
  assert.match(body, /const persisted = await persistAppStateChecked\(\);/);
  assert.doesNotMatch(body, /\bsaveState\(\)/, "確かめない保存（saveState）を使わない");
});
