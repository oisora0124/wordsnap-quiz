// モーダルのフォーカス閉じ込めを、公開HTML内の実コードを動かして検査する。
// aria-modal="true" は読み上げ上だけ背景を隠すのでフォーカスは止まらない。
// トラップが外れると「Tabで背景へ抜けたのに読み上げは無音」という状態になり、
// 見た目にも成績にも出ないまま壊れる。ここで不変条件を固定する。
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
      if (paren === 0) { paramEnd = i; break; }
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

function extractSelector() {
  const start = html.indexOf("const DIALOG_FOCUSABLE_SELECTOR =");
  if (start < 0) throw new Error("DIALOG_FOCUSABLE_SELECTOR not found");
  const end = html.indexOf(";", start);
  return html.slice(start, end + 1);
}

/**
 * 最小限のDOM代役。実DOMを持ち込まずに、トラップが見ている性質だけを再現する:
 * querySelectorAll の結果順、hidden、祖先のhidden、focus() の副作用。
 */
function makeDialog(specs) {
  const nodes = specs.map((s, i) => ({
    name: s.name ?? `n${i}`,
    hidden: Boolean(s.hidden),
    hiddenAncestor: Boolean(s.hiddenAncestor),
    focus() { dialog.activeElement = this; },
    closest(sel) {
      // 実コードは closest("[hidden]") でしか呼ばない。
      if (sel !== "[hidden]") return null;
      return this.hidden || this.hiddenAncestor ? {} : null;
    },
  }));
  const dialog = {
    nodes,
    activeElement: null,
    querySelectorAll() { return nodes; },
  };
  return dialog;
}

function buildSandbox() {
  const src = [
    extractSelector(),
    extractFunction("dialogFocusables"),
    extractFunction("trapDialogTab"),
    // document.activeElement はテストごとに差し替える。
    "const document = { activeElement: null };",
    "globalThis.__api = { dialogFocusables, trapDialogTab, document };",
  ].join("\n");
  const sandbox = { globalThis: undefined, Array, Boolean };
  sandbox.globalThis = sandbox;
  new Script(src).runInNewContext(sandbox);
  return sandbox.__api;
}

/** Tabキーイベントの代役。preventDefault が呼ばれたかを記録する。 */
function tabEvent(shiftKey = false, key = "Tab") {
  return { key, shiftKey, prevented: false, preventDefault() { this.prevented = true; } };
}

/** ダイアログ内で Tab を押した状況を作り、押した後のフォーカス先を返す。 */
function press(api, dialog, fromName, shiftKey) {
  const from = dialog.nodes.find((n) => n.name === fromName) ?? null;
  api.document.activeElement = from;
  dialog.activeElement = from;
  const event = tabEvent(shiftKey);
  api.trapDialogTab(dialog, event);
  return { moved: dialog.activeElement?.name ?? null, prevented: event.prevented };
}

const api = buildSandbox();

test("最後の要素から Tab すると先頭へ戻る（背景へ抜けない）", () => {
  const dialog = makeDialog([{ name: "skip" }, { name: "next" }]);
  const r = press(api, dialog, "next", false);
  assert.equal(r.moved, "skip");
  assert.equal(r.prevented, true, "既定のTab移動を止めていないと背景へ抜ける");
});

test("先頭の要素から Shift+Tab すると末尾へ回る", () => {
  const dialog = makeDialog([{ name: "skip" }, { name: "next" }]);
  const r = press(api, dialog, "skip", true);
  assert.equal(r.moved, "next");
  assert.equal(r.prevented, true);
});

test("中間の要素では邪魔をしない（既定のTab移動に任せる）", () => {
  const dialog = makeDialog([{ name: "a" }, { name: "b" }, { name: "c" }]);
  const r = press(api, dialog, "b", false);
  assert.equal(r.moved, "b", "中間では focus() を呼ばない");
  assert.equal(r.prevented, false);
});

test("フォーカスがダイアログ外にある状態でも中へ引き戻す", () => {
  const dialog = makeDialog([{ name: "skip" }, { name: "next" }]);
  // activeElement がダイアログ内に無い＝indexOf が -1 になる経路。
  api.document.activeElement = { name: "背景のボタン" };
  dialog.activeElement = null;
  const event = tabEvent(false);
  api.trapDialogTab(dialog, event);
  // 前方Tab: index === -1 は末尾ではないので既定に任せるが、
  // 後方Tab（Shift）では端とみなして末尾へ引き戻す。
  const back = tabEvent(true);
  api.document.activeElement = { name: "背景のボタン" };
  api.trapDialogTab(dialog, back);
  assert.equal(dialog.activeElement?.name, "next");
  assert.equal(back.prevented, true);
});

test("Tab 以外のキーには一切触れない（Escape等の処理を奪わない）", () => {
  const dialog = makeDialog([{ name: "skip" }, { name: "next" }]);
  for (const key of ["Escape", "Enter", " ", "ArrowRight"]) {
    api.document.activeElement = dialog.nodes[1];
    dialog.activeElement = dialog.nodes[1];
    const event = tabEvent(false, key);
    api.trapDialogTab(dialog, event);
    assert.equal(event.prevented, false, `${key} で preventDefault してはいけない`);
    assert.equal(dialog.activeElement.name, "next", `${key} でフォーカスを動かしてはいけない`);
  }
});

test("hidden な要素と hidden な祖先を持つ要素は順路から外れる", () => {
  const dialog = makeDialog([
    { name: "skip" },
    { name: "隠れ", hidden: true },
    { name: "祖先が隠れ", hiddenAncestor: true },
    { name: "next" },
  ]);
  const names = api.dialogFocusables(dialog).map((n) => n.name);
  assert.deepEqual([...names], ["skip", "next"]);
  // 末尾は "next"。ここから Tab すると "skip" へ戻る（隠れ要素を経由しない）。
  const r = press(api, dialog, "next", false);
  assert.equal(r.moved, "skip");
});

test("フォーカス可能な要素が無いときは何もしない（例外で止まらない）", () => {
  const dialog = makeDialog([{ name: "隠れ", hidden: true }]);
  const event = tabEvent(false);
  api.document.activeElement = null;
  assert.doesNotThrow(() => api.trapDialogTab(dialog, event));
  assert.equal(event.prevented, false);
});

test("2つのモーダルの両方に、Tabトラップが配線されている", () => {
  // 片方だけ配線が外れる回帰（V2お知らせ側に無かった）を再発させない。
  for (const dialogId of ["tutorialDialog", "v2AnnounceDialog"]) {
    const anchor = html.indexOf(`elements.${dialogId}?.addEventListener("keydown"`);
    assert.ok(anchor > 0, `${dialogId} の keydown ハンドラが見つからない`);
    const end = html.indexOf("\n});", anchor);
    const body = html.slice(anchor, end);
    assert.ok(
      body.includes("trapDialogTab("),
      `${dialogId} の keydown が trapDialogTab を呼んでいない＝Tabで背景へ抜ける`,
    );
    assert.ok(body.includes("Escape"), `${dialogId} が Escape で閉じられない`);
  }
});

test("モーダルは開くときにフォーカスを移し、閉じるときに元へ戻す", () => {
  for (const [open, close, saved] of [
    ["showTutorial", "completeTutorial", "tutorialReturnFocus"],
    ["maybeShowV2Announce", "dismissV2Announce", "v2AnnounceReturnFocus"],
  ]) {
    const openSrc = extractFunction(open);
    const closeSrc = extractFunction(close);
    assert.ok(openSrc.includes(`${saved} =`), `${open} が戻り先を保存していない`);
    assert.ok(openSrc.includes(".focus()"), `${open} がダイアログへフォーカスを移していない`);
    assert.ok(closeSrc.includes(`${saved}?.focus?.()`), `${close} がフォーカスを戻していない`);
  }
});
