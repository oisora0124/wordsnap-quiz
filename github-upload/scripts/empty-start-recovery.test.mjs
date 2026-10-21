// 1.0.139: 端末内の保存（localStorage・IndexedDB）が消えると、アプリは新規利用者と区別できず
// 黙って新しい同期先を作っていた。サーバーの元データは残るのに戻る手がかりが無いため、
// 1. 空の端末で起動したら、初回チュートリアルより先に復元の案内を出す
// 2. 引き継ぎコードを iPhone のパスワード（キーチェーン）へ控えられるようにする
// 3. コードを控えていない間は、設定タブ以外にも帯で知らせる
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
  const brace = html.indexOf("{", html.indexOf(")", start));
  let depth = 0;
  for (let i = brace; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

function handlerBody(anchor) {
  const start = html.indexOf(anchor);
  if (start < 0) throw new Error(`${anchor} not found`);
  return html.slice(start, html.indexOf("\n});", start));
}

// ---- 1. 空の端末で起動したときの案内 ----
function startupSandbox({ tutorialDone = false, storedSyncId = "", search = "", words = 0, promptAvailable = true }) {
  const calls = [];
  const context = {
    localStorage: {
      getItem: (key) => (key === "tutorial" ? (tutorialDone ? "1" : null) : key === "sync" ? storedSyncId || null : null),
    },
    TUTORIAL_COMPLETE_KEY: "tutorial",
    SYNC_ID_KEY: "sync",
    URLSearchParams,
    window: { location: { search } },
    cleanSyncId: (value) => (value ? String(value) : ""),
    appState: { words: Array.from({ length: words }, (_, i) => ({ id: `w${i}` })) },
    showRecoveryPrompt: () => {
      calls.push("recovery");
      return promptAvailable;
    },
    showTutorial: () => calls.push("tutorial"),
  };
  new Script(`${extractFunction("maybeShowInitialTutorial")}\nmaybeShowInitialTutorial();`, {
    filename: "startup.js",
  }).runInNewContext(context);
  return calls;
}

test("保存が丸ごと消えた端末（チュートリアル記録も同期IDも単語も無い）では、チュートリアルより先に復元の案内を出す", () => {
  assert.deepEqual(startupSandbox({}), ["recovery"]);
});

test("復元の案内が出せない環境では従来どおりチュートリアルを出す", () => {
  assert.deepEqual(startupSandbox({ promptAvailable: false }), ["recovery", "tutorial"]);
});

test("個人リンクで開いた・同期IDがある・単語がある・チュートリアル済みのときは何も出さない", () => {
  for (const [name, opts] of [
    ["個人リンク", { search: "?w=ws_abc" }],
    ["保存済み同期ID", { storedSyncId: "ws_abc" }],
    ["単語あり", { words: 3 }],
    ["チュートリアル済み", { tutorialDone: true }],
  ]) {
    assert.deepEqual(startupSandbox(opts), [], name);
  }
});

test("案内の「新しく始める」はチュートリアルへ、「コードで復元」は閉じてから同期設定の入力欄へ送る", () => {
  const fresh = handlerBody('elements.recoveryPromptNewButton?.addEventListener("click"');
  assert.ok(fresh.indexOf("dismissRecoveryPrompt()") < fresh.indexOf("showTutorial()"));
  const restore = handlerBody('elements.recoveryPromptRestoreButton?.addEventListener("click"');
  assert.ok(restore.indexOf("dismissRecoveryPrompt()") < restore.indexOf("openSyncV2Section()"), "閉じてから移動する");
  assert.match(restore, /elements\.syncV2JoinInput\?\.focus\(\)/);
  // 案内の文面: 別端末の単語まで消す逆向きの操作を止める
  assert.match(html, /recoveryPromptText[\s\S]*?逆向き[\s\S]*?しないでください/);
  // 案内は同期・identity を書き換えない（表示だけ）
  const block = html.slice(html.indexOf("function showRecoveryPrompt("), html.indexOf("function openSyncV2Section("));
  assert.doesNotMatch(block, /localStorage\.(setItem|removeItem)|syncState\.\w+\s*=/);
});

// ---- 2. パスワード（キーチェーン）への控え ----
test("引き継ぎコードはパスワード欄＋username欄の form にあり、submit は送信せず保存済みにする", () => {
  const form = html.slice(html.indexOf('<form id="syncV2KeychainForm"'), html.indexOf("</form>", html.indexOf('<form id="syncV2KeychainForm"')));
  assert.match(form, /autocomplete="username"/, "username 欄が無いとパスワード管理が何のコードか識別できない");
  assert.match(form, /id="syncV2TransferCode"[\s\S]*?type="password"[\s\S]*?autocomplete="new-password"/);
  assert.doesNotMatch(form, /type="submit"/, "submit ボタンは check-release の type=button 規則に反する");
  const submit = handlerBody('elements.syncV2KeychainForm?.addEventListener("submit"');
  assert.match(submit, /event\.preventDefault\(\);/, "送信先は無い。止めないとコードがURLに載る");
  assert.match(submit, /markV2CodeSavedFor\(credential\)/);
  const save = handlerBody('elements.syncV2KeychainSaveButton?.addEventListener("click"');
  assert.match(save, /requestSubmit/, "submit() はイベントを起こさず、ブラウザの保存確認も出ない");
});

test("合流の入力欄は保存したパスワードを自動入力で呼び出せる形（current-password）", () => {
  const form = html.slice(html.indexOf('<form id="syncV2JoinForm"'), html.indexOf("</form>", html.indexOf('<form id="syncV2JoinForm"')));
  assert.match(form, /autocomplete="username"/);
  assert.match(form, /id="syncV2JoinInput"[\s\S]*?type="password"[\s\S]*?autocomplete="current-password"/);
  assert.doesNotMatch(form, /type="submit"/);
});

// ---- 3. 上部の帯の配線（表示条件は sync-v2-recovery-ux.test.mjs） ----
test("帯のボタンは同期設定へ送り、タブ切替のたびに帯の表示を更新する", () => {
  assert.match(html, /elements\.v2BackupStripButton\?\.addEventListener\("click", openSyncV2Section\)/);
  assert.match(extractFunction("setActiveStep"), /syncSafeShareStripVisibility\(\);\s*syncV2BackupStripVisibility\(\);/);
  assert.match(extractFunction("renderV2RecoveryNotice"), /syncV2BackupStripVisibility\(\);/);
});
