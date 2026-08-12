// スマホでの入力体験まわり（1.0.84）を、公開HTML内の実コードから抽出して検査する。
// 流儀は scripts/context-quiz.test.mjs / scripts/reverse-quiz.test.mjs と同じ。
//
//   1. ソフトウェアキーボードの検出（visualViewport）
//      iOS の position:fixed はレイアウトビューポート基準のままなので、キーボードが
//      開くとボトムナビが鍵盤の裏に隠れる。body.keyboard-open を付け外しして退避させる。
//      誤検知（アドレスバーの出入りで隠れる／入力していないのに隠れる）が起きると、
//      画面から普通にナビが消えるので、閾値とフォーカス条件の両方を固定する。
//   2. 音声の解放（iOS の自動再生制限）
//      ユーザー操作を伴わない speechSynthesis.speak() は黙って無視される。
//      最初の操作で無音の発話を1回だけ流す。2回以上流すと実害（無駄な発話）になる。
//   3. 単語検索のデバウンス
//      1打鍵ごとに全語を絞り込んで描き直すと数千語で引っかかる。手が止まってから描く。
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

// 閾値はHTML側の定数をそのまま使う（片方だけ変えても気づけるように）
const SHRINK_PX = Number(html.match(/const KEYBOARD_MIN_SHRINK_PX = (\d+);/)?.[1]);
const DEBOUNCE_MS = Number(html.match(/const WORD_SEARCH_DEBOUNCE_MS = (\d+);/)?.[1]);

test("閾値の定数がHTMLから読めている（名前を変えたらここで気づく）", () => {
  assert.ok(Number.isFinite(SHRINK_PX) && SHRINK_PX > 0, "KEYBOARD_MIN_SHRINK_PX");
  assert.ok(Number.isFinite(DEBOUNCE_MS) && DEBOUNCE_MS > 0, "WORD_SEARCH_DEBOUNCE_MS");
});

// ============================================================================
// 1. ソフトウェアキーボードの検出
// ============================================================================

function buildKeyboardSandbox({ hasVisualViewport = true } = {}) {
  const pieces = [
    "const classes = new Set();",
    "const document = { activeElement: null, body: { classList: {" +
      " toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); }," +
      " has: (name) => classes.has(name) } } };",
    hasVisualViewport
      ? "const window = { innerHeight: 800, visualViewport: { height: 800 } };"
      : "const window = { innerHeight: 800 };",
    `const KEYBOARD_MIN_SHRINK_PX = ${SHRINK_PX};`,
    extractFunction("isTextEntryElement"),
    extractFunction("syncKeyboardOpenState"),
    "globalThis.__k = {" +
      " isTextEntryElement," +
      " syncKeyboardOpenState," +
      " isOpen: () => classes.has('keyboard-open')," +
      " setViewportHeight: (h) => { if (window.visualViewport) window.visualViewport.height = h; }," +
      " focus: (el) => { document.activeElement = el; } };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "mobile-input-keyboard-check.js" }).runInNewContext(sandbox);
  return sandbox.__k;
}

const el = (tagName, extra = {}) => ({ tagName, ...extra });

test("入力欄の判定: キーボードが出る要素だけを true にする", () => {
  const k = buildKeyboardSandbox();
  assert.equal(k.isTextEntryElement(el("TEXTAREA")), true);
  assert.equal(k.isTextEntryElement(el("INPUT", { type: "text" })), true);
  assert.equal(k.isTextEntryElement(el("INPUT", { type: "number" })), true, "番号ジャンプ欄");
  assert.equal(k.isTextEntryElement(el("INPUT", { type: "search" })), true, "単語検索欄");
  assert.equal(k.isTextEntryElement(el("INPUT", { type: "password" })), true, "個人キー欄");
  assert.equal(k.isTextEntryElement(el("INPUT", {})), true, "type未指定はtext扱い");
  assert.equal(k.isTextEntryElement(el("DIV", { isContentEditable: true })), true);
});

test("入力欄の判定: キーボードが出ない要素は false（押しただけでナビが消えない）", () => {
  const k = buildKeyboardSandbox();
  for (const type of ["button", "checkbox", "radio", "range", "submit", "reset", "file", "color", "hidden"]) {
    assert.equal(k.isTextEntryElement(el("INPUT", { type })), false, `input[type=${type}]`);
  }
  assert.equal(k.isTextEntryElement(el("BUTTON")), false);
  assert.equal(k.isTextEntryElement(el("SELECT")), false);
  assert.equal(k.isTextEntryElement(el("DIV")), false);
  assert.equal(k.isTextEntryElement(null), false, "focusout 直後の null でも落ちない");
});

test("キーボード検出: 入力欄にフォーカスがあり、十分に縮んでいるときだけ開いた扱い", () => {
  const k = buildKeyboardSandbox();
  k.focus(el("INPUT", { type: "search" }));
  k.setViewportHeight(800 - SHRINK_PX); // ちょうど閾値
  k.syncKeyboardOpenState();
  assert.equal(k.isOpen(), true);
});

test("キーボード検出: 縮みが閾値未満なら反応しない（アドレスバーの出入り）", () => {
  const k = buildKeyboardSandbox();
  k.focus(el("INPUT", { type: "search" }));
  k.setViewportHeight(800 - (SHRINK_PX - 1));
  k.syncKeyboardOpenState();
  assert.equal(k.isOpen(), false);
});

test("キーボード検出: 入力欄以外にフォーカスがあるときは反応しない", () => {
  const k = buildKeyboardSandbox();
  k.focus(el("BUTTON"));
  k.setViewportHeight(400); // 大きく縮んでいても
  k.syncKeyboardOpenState();
  assert.equal(k.isOpen(), false, "ボタン操作でボトムナビが消えてはいけない");
});

test("キーボード検出: 閉じたら元に戻る", () => {
  const k = buildKeyboardSandbox();
  const input = el("INPUT", { type: "text" });
  k.focus(input);
  k.setViewportHeight(400);
  k.syncKeyboardOpenState();
  assert.equal(k.isOpen(), true);

  k.setViewportHeight(800); // キーボードが閉じた
  k.syncKeyboardOpenState();
  assert.equal(k.isOpen(), false);

  k.setViewportHeight(400);
  k.focus(null); // フォーカスが外れた（focusout 後）
  k.syncKeyboardOpenState();
  assert.equal(k.isOpen(), false);
});

test("キーボード検出: visualViewport 非対応の環境では何もしない（例外も出さない）", () => {
  const k = buildKeyboardSandbox({ hasVisualViewport: false });
  k.focus(el("INPUT", { type: "text" }));
  assert.doesNotThrow(() => k.syncKeyboardOpenState());
  assert.equal(k.isOpen(), false, "従来どおりナビは出したまま");
});

// ============================================================================
// 2. 音声の解放（iOS の自動再生制限）
// ============================================================================

function buildUnlockSandbox({ supported = true, speakThrows = false, hasUtterance = true } = {}) {
  const pieces = [
    "const spoken = [];",
    supported
      ? "const window = { speechSynthesis: { speak: (u) => {" +
        (speakThrows ? " throw new Error('blocked');" : " spoken.push(u);") +
        " } } };"
      : "const window = {};",
    hasUtterance
      ? "function SpeechSynthesisUtterance(text) { this.text = text; this.volume = 1; }"
      : "const SpeechSynthesisUtterance = undefined;",
    "let speechUnlocked = false;",
    extractFunction("unlockSpeechSynthesis"),
    "globalThis.__u = { spoken, unlockSpeechSynthesis, isUnlocked: () => speechUnlocked };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "mobile-input-unlock-check.js" }).runInNewContext(sandbox);
  return sandbox.__u;
}

test("音声解放: 最初の1回だけ無音の発話を流す", () => {
  const u = buildUnlockSandbox();
  u.unlockSpeechSynthesis();
  assert.equal(u.spoken.length, 1, "1回だけ");
  assert.equal(u.spoken[0].volume, 0, "無音でなければ利用者に聞こえてしまう");
  assert.notEqual(u.spoken[0].text, "", "空文字だと発話自体が起きず解放されない環境がある");
});

test("音声解放: 2回目以降は何もしない（操作のたびに発話しない）", () => {
  const u = buildUnlockSandbox();
  u.unlockSpeechSynthesis();
  u.unlockSpeechSynthesis();
  u.unlockSpeechSynthesis();
  assert.equal(u.spoken.length, 1);
});

test("音声解放: 読み上げ非対応の端末では何もしない", () => {
  const u = buildUnlockSandbox({ supported: false });
  assert.doesNotThrow(() => u.unlockSpeechSynthesis());
  assert.equal(u.spoken.length, 0);
  assert.equal(u.isUnlocked(), false, "非対応なら「解放済み」にもしない");
});

test("音声解放: SpeechSynthesisUtterance が無い環境でも落ちない", () => {
  const u = buildUnlockSandbox({ hasUtterance: false });
  assert.doesNotThrow(() => u.unlockSpeechSynthesis());
  assert.equal(u.spoken.length, 0);
});

test("音声解放: speak が例外を投げても呼び出し側へ漏らさない", () => {
  const u = buildUnlockSandbox({ speakThrows: true });
  assert.doesNotThrow(() => u.unlockSpeechSynthesis(), "最初のタップで例外が出ると操作が止まる");
});

// ============================================================================
// 3. 単語検索のデバウンス
// ============================================================================

function buildSearchSandbox() {
  const pieces = [
    "const calls = { render: 0, cleared: [] };",
    "let __timerId = 0;",
    "const __timers = new Map();",
    "const window = {" +
      " setTimeout: (fn, ms) => { __timerId += 1; __timers.set(__timerId, { fn, ms }); return __timerId; }," +
      " clearTimeout: (id) => { if (__timers.has(id)) { calls.cleared.push(id); __timers.delete(id); } } };",
    "function renderSavedWords() { calls.render += 1; }",
    "let wordSearchQuery = '';",
    "const elements = { wordSearchInput: { value: '', focus() {} } };",
    `const WORD_SEARCH_DEBOUNCE_MS = ${DEBOUNCE_MS};`,
    "let wordSearchDebounceTimer = 0;",
    extractFunction("scheduleWordSearchRender"),
    extractFunction("clearWordSearch"),
    "globalThis.__s = {" +
      " calls," +
      " scheduleWordSearchRender," +
      " clearWordSearch," +
      " pending: () => __timers.size," +
      " delays: () => Array.from(__timers.values()).map((t) => t.ms)," +
      " runTimers: () => { const fns = Array.from(__timers.values()); __timers.clear(); for (const t of fns) t.fn(); } };",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "mobile-input-search-check.js" }).runInNewContext(sandbox);
  return sandbox.__s;
}

test("検索デバウンス: 入力しただけでは描き直さない", () => {
  const s = buildSearchSandbox();
  s.scheduleWordSearchRender();
  assert.equal(s.calls.render, 0, "1打鍵ごとに全語を絞り込むと数千語で引っかかる");
  assert.deepEqual(Array.from(s.delays()), [DEBOUNCE_MS]);
});

test("検索デバウンス: 連続入力では最後の1回だけ描き直す", () => {
  const s = buildSearchSandbox();
  for (let i = 0; i < 8; i += 1) s.scheduleWordSearchRender();
  assert.equal(s.pending(), 1, "待機中のタイマーは常に1本（前のを消してから積む）");
  s.runTimers();
  assert.equal(s.calls.render, 1);
});

test("検索デバウンス: クリアは待機中の描き直しを捨ててから即描画する", () => {
  const s = buildSearchSandbox();
  s.scheduleWordSearchRender(); // 入力途中
  s.clearWordSearch({ focus: false });
  assert.equal(s.calls.render, 1, "クリアは待たせない");
  assert.equal(s.pending(), 0, "待機中の描き直しが後から古い検索語で上書きしてはいけない");
});
