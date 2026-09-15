// 取り込み・確認・単語一覧の Codex（gpt-6-astra）レビュー（2026-09-14）で直した点を、実コードのまま固定する（1.0.110）。
//
// 1. 取り込み: 丸数字の行頭番号、曲がったアポストロフィ、語中のダッシュ、行頭の番号の外し方（24-hour は残す）、
//    どの形にも当てはまらない日本語の行を報告する。（例文の訳を意味にしない案は、類義語の羅列を誤認するため見送り）
// 2. OCR・AI抽出: 待っている間に入力欄が変わっていたら上書きせず末尾に足す。
// 3. 候補の保存: 待っている間は候補の編集・再変換を止め、消すのは保存した候補だけ。
// 4. 共有単語帳の追加: 端末への保存を確かめてから成功を伝える。失敗したら戻す。
// 5. 採点で成績が変わったら一覧を作り直す（並びと番号選択のずれ）。
// 6. 選択の整理・一括操作の対象抽出は語数×選択数にしない。補完の保存はまとめる。
//
// 1.0.111（astra・Fable の相互レビュー対応）: 後読み正規表現を使わない（Safari 16.4 未満で全体が構文エラー）、
// 空白なしの全角記号が続く番号（1・apple）、語を囲む引用符（‘apple’）、保存待ちと OCR のロックの重なり。
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
// 1. 取り込み
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
    "globalThis.__p = { parseVocabulary, stripNoise };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "import-library-parse.js" }).runInNewContext(sandbox);
  return sandbox.__p;
}
const pairs = (result) => Array.from(result.candidates, (c) => [c.term, c.meaning]);

test("取り込み: 丸数字の行頭番号を外す。曲がったアポストロフィと語中のダッシュは ASCII に", () => {
  const p = parseSandbox();
  assert.equal(p.stripNoise("①りんご"), "りんご");
  assert.equal(p.stripNoise("⑫ apple りんご"), "apple りんご");
  assert.equal(p.stripNoise("don’t しない"), "don't しない");
  assert.equal(p.stripNoise("well‑known 有名な"), "well-known 有名な"); // U+2011
  assert.equal(p.stripNoise("well–known 有名な"), "well-known 有名な"); // U+2013
  assert.equal(p.stripNoise("apple – りんご"), "apple – りんご", "語の間のダッシュ（区切り）は触らない");
  // 「apple ↵ ①りんご ↵ 果物」で最初の訳が黙って消えていた
  assert.deepEqual(pairs(p.parseVocabulary("apple\n①りんご\n果物", null)), [["apple", "りんご"]]);
  // 曲がったアポストロフィの語は同じ語として重複判定される
  const r = p.parseVocabulary("don't しない\ndon’t しない", null);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.dupInputCount, 1);
});

test("取り込み: 行頭の番号は「番号＋区切り」か「番号＋空白」のときだけ外す（24-hour は残す）", () => {
  const p = parseSandbox();
  assert.deepEqual(pairs(p.parseVocabulary("1. apple りんご\n2) bank 銀行\n3、cat 猫\n4 dog 犬\n24-hour 終日の\n・egg 卵", null)), [
    ["apple", "りんご"],
    ["bank", "銀行"],
    ["cat", "猫"],
    ["dog", "犬"],
    ["24-hour", "終日の"],
    ["egg", "卵"],
  ]);
  assert.deepEqual(pairs(p.parseVocabulary("1. 24-hour 終日の", null)), [["24-hour", "終日の"]], "番号を外したあとも語の一部の数字は残す");
  // 番号のあとに記号が残る形（main で読めていた）は従来どおり読める
  for (const line of ["1 - りんご", "1 ・ りんご", "1. ・りんご", "(1) - りんご", "1.（りんご）", "1. (1) りんご", "1.1 りんご", "② 2) りんご"]) {
    assert.deepEqual(pairs(p.parseVocabulary(`apple\n${line}\n果物`, null)), [["apple", "りんご"]], line);
  }
});

test("取り込み: 空白なしで全角記号が続く番号（1・apple、2．apple）も番号として外す（1.0.110 の退行）", () => {
  const p = parseSandbox();
  assert.deepEqual(pairs(p.parseVocabulary("1・apple りんご\n2．bank 銀行\n3：cat 猫\n4，dog 犬\n5|egg 卵\n24-hour 終日の", null)), [
    ["apple", "りんご"],
    ["bank", "銀行"],
    ["cat", "猫"],
    ["dog", "犬"],
    ["egg", "卵"],
    ["24-hour", "終日の"],
  ]);
  // 保存済みの apple と同じ語として重複判定される（「1 apple」にならない）
  assert.equal(p.parseVocabulary("1・apple りんご", null).candidates[0].term, "apple");
});

test("取り込み: 語を囲む曲がった引用符は綴りに残さず、同じ語として重複判定される（1.0.110 の退行）", () => {
  const p = parseSandbox();
  assert.deepEqual(pairs(p.parseVocabulary("‘apple’ りんご", null)), [["apple", "りんご"]]);
  assert.deepEqual(pairs(p.parseVocabulary("'bank' 銀行", null)), [["bank", "銀行"]]);
  assert.deepEqual(pairs(p.parseVocabulary("don’t しない\nrock 'n' roll ロック", null)), [["don't", "しない"], ["rock 'n' roll", "ロック"]], "語中の ' は残す");
  const r = p.parseVocabulary("‘apple’ りんご\napple りんご", null);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.dupInputCount, 1);
});

test("取り込み: 語中のダッシュの置換に後読み正規表現を使わない（Safari 16.4 未満で全体が構文エラーになる）", () => {
  assert.doesNotMatch(html, /\(\?<[=!]/);
  const p = parseSandbox();
  assert.equal(p.stripNoise("a‐b‐c 連続"), "a-b-c 連続", "連続するダッシュも全部置き換える");
  assert.equal(p.stripNoise("apple —りんご"), "apple —りんご", "英字に挟まれていないダッシュは触らない");
});

test("取り込み: 見出し語のあとの英語行（例文・類義語・補足）は読み飛ばし、続く訳は従来どおり意味になる", () => {
  const p = parseSandbox();
  // main と同じ挙動を保つ（例文の訳を機械的に捨てる案は、類義語の羅列や cf. 等を誤認するため見送り）
  for (const middle of ["fast, quick, swift", "fast, quick, swift.", "e.g. fast, quick.", "cf. fast, quick.", "= fast, quick.", "I run every day."]) {
    assert.deepEqual(pairs(p.parseVocabulary(`rapid\n${middle}\n速い。`, null)), [["rapid", "速い"]], middle);
    assert.deepEqual(pairs(p.parseVocabulary(`rapid\n${middle}\n速い。\n迅速に`, null)), [["rapid", "速い"]], middle);
  }
  assert.deepEqual(pairs(p.parseVocabulary("apple\nりんご", null)), [["apple", "りんご"]]);
});

test("取り込み: どの形にも当てはまらない日本語の行は、読み取れなかった行として報告する", () => {
  const p = parseSandbox();
  const r = p.parseVocabulary("apple りんご\n★みかん\nbank 銀行", null);
  assert.deepEqual(pairs(r), [["apple", "りんご"], ["bank", "銀行"]]);
  assert.deepEqual(Array.from(r.unreadableLines), [2], "「★みかん」は黙って捨てない");
});

test("取り込み: 内蔵の単語帳は従来どおり全行読める", () => {
  const p = parseSandbox();
  const extractTemplate = (name) => {
    const start = html.indexOf(`const ${name} = \``);
    const open = html.indexOf("`", start);
    const close = html.indexOf("`;", open + 1);
    return html.slice(open + 1, close);
  };
  for (const name of ["SAMPLE_TEXT", "SAMPLE_TEXT_JHS", "SAMPLE_TEXT_EIKEN", "SAMPLE_TEXT_SOUKEI", "SAMPLE_TEXT_TOEIC", "SAMPLE_TEXT_IELTS"]) {
    const r = p.parseVocabulary(extractTemplate(name), null);
    assert.equal(r.candidates.length, 1500, name);
    assert.equal(r.unreadableLines.length, 0, name);
  }
});

// ============================================================================
// 2. OCR・AI抽出の結果の入れ方
// ============================================================================
test("OCRの結果: 待っている間に入力欄が変わっていなければ置き換え、変わっていれば末尾に足す", () => {
  const pieces = [
    "const elements = { ocrText: { value: '' } };",
    extractFunction("applyOcrText"),
    "globalThis.__o = { apply: applyOcrText, el: elements.ocrText };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "import-library-ocr.js" }).runInNewContext(sandbox);
  const o = sandbox.__o;
  o.el.value = "old";
  assert.equal(o.apply("ocr result", "old"), false);
  assert.equal(o.el.value, "ocr result");
  o.el.value = "typed while waiting  ";
  assert.equal(o.apply("ocr result", "old"), true, "変わっていたら足す");
  assert.equal(o.el.value, "typed while waiting\nocr result");
  o.el.value = "   ";
  assert.equal(o.apply("ocr result", "old"), false, "空白だけなら置き換える");
  assert.equal(o.el.value, "ocr result");
  // 端末内OCR・AI抽出の両方がこれを通す。読み取り中はサンプル集の追加も止める
  assert.match(html, /const appended = applyOcrText\(result\.text, inputAtStart\);[\s\S]*?const appended = applyOcrText\(result\.text, inputAtStart\);/);
  assert.match(extractFunction("lockOcrUiForRun"), /elements\.sampleChips\.querySelectorAll\("button"\)/);
});

test("AI抽出と端末内OCRは同時に走らせない。AI抽出は想定外の失敗も案内し、画像キャンバスを解放する（1.0.119）", () => {
  const ai = extractHandlerBody('elements.aiOcrButton.addEventListener("click", async () => {');
  const ocr = extractHandlerBody('elements.ocrButton.addEventListener("click", async () => {');
  // AI抽出中は端末内OCRを始めさせない（始まると AI抽出の中断ボタンが無効になり止められない）
  assert.match(ocr, /if \(aiExtractAbort\) \{[\s\S]*?setStatus\("AI抽出が終わるまでお待ちください/);
  assert.match(ai, /const ocrButtonWasDisabled = elements\.ocrButton\.disabled;\s*elements\.ocrButton\.disabled = true;/);
  assert.match(ai, /finally \{[\s\S]*?elements\.ocrButton\.disabled = ocrButtonWasDisabled;/);
  // プロバイダ呼び出しの外で起きた失敗も無言にしない
  assert.match(ai, /\} catch \(error\) \{\s*\/\/[^\n]*\n\s*setStatus\(`AI抽出に失敗しました：\$\{error\?\.message \|\| error\}`\);/);
  // 使い捨てキャンバスの解放（端末内OCRと同じ）
  assert.match(ai, /let canvas = null;[\s\S]*?canvas = getEditedCanvas\(\);/);
  assert.match(ai, /finally \{[\s\S]*?if \(canvas\) releaseTemporaryCanvas\(canvas\);/);
});

// ============================================================================
// 3. 候補の保存（待っている間の編集）
// ============================================================================
function saveSandbox() {
  const body = extractHandlerBody('elements.saveParsedButton.addEventListener("click", async () => {');
  const pieces = [
    extractFunction("normalizeTerm"),
    extractFunction("validPair"),
    "let __idSeq = 0; function createId() { return `w${++__idSeq}`; }",
    "function emptyEnrich() { return {}; }",
    "const window = { Cefr: { peek: () => null } };",
    "let appState = { words: [], decks: [{ id: 'd1', name: 'A' }], activeDeckId: 'all' };",
    "let candidates = [{ term: 'apple', meaning: 'りんご' }, { term: 'bank', meaning: '銀行' }, { term: 'bad', meaning: '' }];",
    "let currentQuiz = null;",
    "let saveDeckChosenByUser = false;",
    "let saveParsedBusy = false;",
    "let activeOcrRun = null;",
    "const elements = { saveDeckSelect: { value: 'd1' }, saveParsedButton: { disabled: false }, candidateList: { inert: false }, parseButton: { disabled: false } };",
    extractFunction("syncParseButtonLock"),
    "let __release; const __persist = new Promise((r) => { __release = r; });",
    "let __during = null;",
    "function deckName(id) { return appState.decks.find((d) => d.id === id)?.name || '単語帳'; }",
    "function clearUndo() {}",
    "async function persistAppStateChecked() { __during = { inert: elements.candidateList.inert, parseDisabled: elements.parseButton.disabled, saveDisabled: elements.saveParsedButton.disabled }; return __persist; }",
    "function renderAll() {}",
    "function renderCandidates() {}",
    "function notifyInlineSaveFailure() {}",
    "function scheduleInlineSaveSuccess() {}",
    "function setStatus() {}",
    "function playSound() {}",
    "function setActiveStep() {}",
    "function queueMetadataPrefetch() {}",
    `const handler = async () => ${body};`,
    "globalThis.__s = { run: handler, state: () => appState, candidates: () => candidates, setCandidates: (c) => { candidates = c; }, release: (v) => __release(v), during: () => __during, el: elements, setOcrRun: (r) => { activeOcrRun = r; }, syncParseButtonLock };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "import-library-save.js" }).runInNewContext(sandbox);
  return sandbox.__s;
}

test("候補の保存: 待っている間は候補の編集と再変換を止め、終わったら戻す", async () => {
  const s = saveSandbox();
  const pending = s.run();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual({ ...s.during() }, { inert: true, parseDisabled: true, saveDisabled: true }); // vm の別レルム
  s.release(true);
  await pending;
  assert.equal(s.el.candidateList.inert, false);
  assert.equal(s.el.parseButton.disabled, false);
});

test("候補の保存: 保存待ち中に端末内OCRが始まり先に保存が終わっても、「変換」は OCR の終了まで止め、終われば押せる", async () => {
  const s = saveSandbox();
  const pending = s.run();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(s.el.parseButton.disabled, true);
  // 保存待ち中に OCR が始まる（lockOcrUiForRun は控えを取って disabled にする）
  const run = {};
  s.setOcrRun(run);
  const snapshotDisabled = s.el.parseButton.disabled; // OCR 側の控え＝true
  s.el.parseButton.disabled = true;
  // 保存が先に終わる。従来はここで false に戻し、OCR 終了時に控えの true が戻って押せないまま残った
  s.release(true);
  await pending;
  assert.equal(s.el.parseButton.disabled, true, "OCR がまだ動いているので止めたまま");
  // OCR の終了: 控えを戻してから求め直す（finishOcrUiRun と同じ順）
  s.el.parseButton.disabled = snapshotDisabled;
  s.setOcrRun(null);
  s.syncParseButtonLock();
  assert.equal(s.el.parseButton.disabled, false, "両方終わったら押せる");
  assert.match(extractFunction("finishOcrUiRun"), /activeOcrRun = null;\s*[^]*?syncParseButtonLock\(\);/, "OCR 側も解除の最後に求め直す");
});

test("候補の保存: 待っている間に一覧が作り直されても、消すのは保存した候補だけ", async () => {
  const s = saveSandbox();
  const pending = s.run();
  await new Promise((r) => setTimeout(r, 0));
  // 待っている間に手順1で再変換された（新しい配列に置き換わる）ケースを再現
  const survivor = s.candidates()[2]; // 'bad'（保存できず残る候補）
  s.setCandidates([survivor, { term: "cherry", meaning: "さくらんぼ" }]);
  s.release(true);
  await pending;
  assert.deepEqual(Array.from(s.state().words, (w) => w.term), ["apple", "bank"]);
  assert.deepEqual(Array.from(s.candidates(), (c) => c.term), ["bad", "cherry"], "新しい候補を消してはいけない");
  assert.equal(s.candidates()[0].problem, "単語と意味の両方を入力してください。", "残した候補には理由が付く");
});

// ============================================================================
// 4. 共有単語帳の追加
// ============================================================================
function shareSandbox({ persisted, during = "" }) {
  const body = extractHandlerBody('elements.importDeckShareInput?.addEventListener("change", async () => {');
  const pieces = [
    extractFunction("normalizeTerm"),
    extractFunction("validPair"),
    "const DECK_SHARE_MAX_FILE_BYTES = 1e9; const DECK_SHARE_MAX_WORDS = 1e6;",
    "let __idSeq = 0; function createId() { return `id${++__idSeq}`; }",
    "function emptyEnrich() { return {}; }",
    "let appState = { words: [{ id: 'old', term: 'old', meaning: '古い', deckId: 'd1' }], decks: [{ id: 'd1', name: 'A' }], activeDeckId: 'd1' };",
    "let currentQuiz = { live: true }; const selectedIds = new Set(['old']);",
    "function undoSignature(state) { return JSON.stringify(state.words.map((w) => [w.id, w.term, w.meaning, w.stats || null])); }",
    "let __status = []; let __undo = 0; let __rendered = 0; let __cleared = 0;",
    "function setStatus(m) { __status.push(m); }",
    "function offerUndo() { __undo += 1; }",
    "function renderAll() { __rendered += 1; }",
    "function clearUndo() { __cleared += 1; }",
    "function snapshotState() { return JSON.parse(JSON.stringify(appState)); }",
    `async function persistAppStateChecked() { ${during || ""}; return ${persisted ? "true" : "false"}; }`,
    extractFunction("uniqueImportedDeckName"),
    extractFunction("parseDeckSharePayload"),
    "const elements = { importDeckShareInput: { files: [{ size: 10, text: async () => JSON.stringify({ kind: 'wordbank-deck', version: 1, deck: { name: 'B' }, words: [{ term: 'apple', meaning: 'りんご' }, { term: 'bank', meaning: '銀行' }] }) }], value: 'x' } };",
    `const handler = async () => ${body};`,
    "globalThis.__d = { run: handler, state: () => appState, status: () => __status, undo: () => __undo, rendered: () => __rendered, cleared: () => __cleared, quiz: () => currentQuiz, selected: () => selectedIds };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "import-library-share.js" }).runInNewContext(sandbox);
  return sandbox.__d;
}

test("共有単語帳の追加: 端末に保存できたら追加して案内する（従来の流れ）", async () => {
  const d = shareSandbox({ persisted: true });
  await d.run();
  assert.equal(d.state().decks.length, 2);
  assert.deepEqual(Array.from(d.state().words, (w) => w.term), ["old", "apple", "bank"]);
  assert.equal(d.state().activeDeckId, d.state().decks[1].id);
  assert.equal(d.undo(), 1);
  assert.equal(d.cleared(), 1, "saveState と同じく取り消しを消してから保存する");
  assert.match(d.status().at(-1), /共有単語帳「B」を2語追加しました/);
});

test("共有単語帳の追加: 保存を待つ間に内容が変わっていたら（同期・採点）、取り消しは出さない（1.0.111）", async () => {
  // 取り消しの指紋を待ったあとに取ると、待っている間の学習記録まで取り消しの対象になっていた
  const d = shareSandbox({ persisted: true, during: "appState.words[0].stats = { correct: 1, wrong: 0 }" });
  await d.run();
  assert.deepEqual(Array.from(d.state().words, (w) => w.term), ["old", "apple", "bank"], "追加自体は成功する");
  assert.equal(d.undo(), 0, "待っている間の変更ごと巻き戻る取り消しは出さない");
  assert.equal(d.cleared(), 1, "古い取り消しは消す");
  assert.equal(d.quiz(), null);
  assert.match(d.status().at(-1), /共有単語帳「B」を2語追加しました/);
});

test("共有単語帳の追加: 端末に保存できなかったら、追加した単語帳と語を戻し、失敗を伝える", async () => {
  const d = shareSandbox({ persisted: false });
  await d.run();
  assert.equal(d.state().decks.length, 1, "追加した単語帳を戻す");
  assert.deepEqual(Array.from(d.state().words, (w) => w.term), ["old"], "追加した語を戻す");
  assert.equal(d.state().activeDeckId, "d1", "表示中の単語帳も戻す");
  assert.equal(d.undo(), 0, "失敗したのに取り消しを出さない");
  assert.match(d.status().at(-1), /共有単語帳を追加できませんでした：端末に保存できませんでした/);
  assert.ok(d.rendered() >= 1, "戻した状態で描き直す");
  // 1.0.111: 失敗したときは、進行中のクイズ・選択・直前の取り消しもそのまま残す
  assert.equal(d.quiz()?.live, true, "進行中のクイズを捨てない"); // vm の別レルムなので deepEqual は使わない
  assert.deepEqual(Array.from(d.selected()), ["old"], "選択を消さない");
  assert.equal(d.cleared(), 0, "直前の取り消しを消さない");
});

// ============================================================================
// 5. 採点後の一覧
// ============================================================================
test("採点で成績が変わった行の更新は、一覧を「次に開いたとき作り直す」印を付ける", () => {
  const pieces = [
    "const dirtyPanels = new Set();",
    "const elements = { savedList: { querySelector: () => null } };",
    extractFunction("updateSavedWordRow"),
    "updateSavedWordRow({ id: 'x', stats: { correct: 0, wrong: 1 }, history: [] });",
    "globalThis.__dirty = [...dirtyPanels];",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "import-library-dirty.js" }).runInNewContext(sandbox);
  assert.deepEqual(Array.from(sandbox.__dirty), ["library"]);
  // 採点の3経路すべてがこの関数を通る
  assert.equal((extractFunction("gradeQuiz").match(/updateSavedWordRow\(word\);/g) || []).length, 3);
});

// ============================================================================
// 6. 計算量
// ============================================================================
test("選択の整理・一括操作の対象抽出は Set で引く（語数×選択数にしない）。補完の保存はまとめる", () => {
  const prune = extractFunction("pruneSelection");
  assert.match(prune, /new Set\(appState\.words\.map\(\(word\) => word\.id\)\)/);
  assert.doesNotMatch(prune, /\.some\(/);
  const del = extractHandlerBody('elements.deleteSelectedButton?.addEventListener("click", () => {');
  assert.match(del, /appState\.words\.filter\(\(word\) => selectedIds\.has\(word\.id\)\)/);
  assert.doesNotMatch(del, /ids\.includes\(word\.id\)/);
  const move = extractHandlerBody('elements.moveSelectedButton?.addEventListener("click", () => {');
  assert.match(move, /appState\.words\.filter\(\(word\) => selectedIds\.has\(word\.id\)\)\.map\(\(word\) => word\.id\)/);
  const prefetch = extractFunction("runMetadataPrefetchBatch");
  assert.match(prefetch, /new Map\(appState\.words\.map\(\(w\) => \[w\.id, w\]\)\)/, "語の検索は索引で");
  assert.doesNotMatch(prefetch, /appState\.words\.find\(/);
  assert.match(prefetch, /prefetchDirtyBatches >= PREFETCH_PERSIST_EVERY_BATCHES/, "保存はまとめる");
  assert.match(prefetch, /if \(prefetchDirtyBatches > 0\) \{[\s\S]*?persistAppState\(\{ sync: false \}\);/, "キューが空になったら残りを保存する");
  // 1.0.117: 背面へ行く・閉じられるときは、まとめていた未保存分をその場で保存する
  const flush = extractFunction("flushPendingPrefetchPersist");
  assert.match(flush, /if \(prefetchDirtyBatches <= 0\) return;[\s\S]*?prefetchDirtyBatches = 0;[\s\S]*?persistAppState\(\{ sync: false \}\);/);
  assert.match(html, /if \(document\.hidden\) \{[\s\S]*?flushPendingSyncPush\(\);\s*[^]*?flushPendingPrefetchPersist\(\);/, "visibilitychange（背面）で保存");
  assert.match(html, /window\.addEventListener\("pagehide", flushPendingPrefetchPersist\);/, "pagehide で保存");
  const every = Number(html.match(/const PREFETCH_PERSIST_EVERY_BATCHES = (\d+);/)[1]);
  assert.ok(every >= 10 && every <= 100);
});

test("補完の保存をまとめても、最後の変更はキューが空になった時点で必ず保存される", async () => {
  const words = Array.from({ length: 12 }, (_, i) => ({ id: `w${i}`, term: `t${i}`, cefr: null, pos: null }));
  const pieces = [
    `const PREFETCH_BATCH_SIZE = ${html.match(/const PREFETCH_BATCH_SIZE = (\d+);/)[1]};`,
    `const PREFETCH_PERSIST_EVERY_BATCHES = ${html.match(/const PREFETCH_PERSIST_EVERY_BATCHES = (\d+);/)[1]};`,
    "let prefetchRunning = false; let prefetchDirtyBatches = 0; const prefetchQueue = [];",
    "const appState = { words: globalThis.__words };",
    "let persisted = 0; const persistAppState = () => { persisted += 1; };",
    "const updatePrefetchAllStatus = () => {};",
    "const resolveCefrOnce = async () => ({ level: 'B1', estimated: true });",
    "const resolvePosOnce = async () => ({ tag: 'n', tags: ['n'] });",
    "const scheduleIdleTask = (cb) => { setTimeout(cb, 0); };",
    "const normalizeTerm = (t) => String(t).trim().toLowerCase();",
    extractFunction("queueMetadataPrefetch"),
    `async ${extractFunction("runMetadataPrefetchBatch")}`,
    "globalThis.__q = { queue: queueMetadataPrefetch, persisted: () => persisted, running: () => prefetchRunning };",
  ];
  const sandbox = { setTimeout, __words: words };
  new Script(pieces.join("\n\n"), { filename: "import-library-prefetch.js" }).runInNewContext(sandbox);
  sandbox.__q.queue(words);
  for (let i = 0; i < 200 && (sandbox.__q.running() || words.some((w) => !w.cefr)); i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.ok(words.every((w) => w.cefr && w.pos), "全語が埋まる");
  assert.equal(sandbox.__q.persisted(), 1, "12語（3バッチ）なら、キューが空になった時点の1回だけ保存する");
});
