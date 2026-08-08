// 「選択した単語の一括デッキ移動」ボタンのハンドラを、公開HTML内の実コードを動かして検査する。
// 検査対象は elements.moveSelectedButton の click ハンドラ本体（名前なしアロー関数）。
// このリポジトリの流儀に従い、自作の再実装ではなく publish/index.html から
// ハンドラ本体そのものを切り出して node:vm 上で実行する（手本: a11y-dialog.test.mjs）。
//
// 固定したい不変条件:
//   1. 移動した単語は deckId と deckUpdatedAt の両方が更新される
//      （deckUpdatedAt を落とすと多端末マージでこの移動が消える）
//   2. 移動先にすでに入っている単語は触らない（無駄な deckUpdatedAt 更新は他端末の移動を上書きする）
//   3. 移動後に selectedIds が空になる（絞り込み中の移動で「見えない単語」が残らない）
//   4. offerUndo は saveState の後に呼ばれる（saveState 内の clearUndo に負けると取り消しが効かない）
//   5. snapshotState は単語を書き換える前に取られている（取り消しで移動前へ戻れること）
//   6. 移動先デッキが存在しない／選択が空／対象が全部すでに移動先にいる場合は、状態を書き換えない
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Script } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

// elements.moveSelectedButton?.addEventListener("click", () => { ... }); の
// アロー関数本体（ブロック）だけを、括弧の対応を数えて切り出す。
// 名前付き関数ではないので a11y-dialog.test.mjs の extractFunction(name) は使えない。
function extractMoveHandlerBody() {
  const anchor = 'elements.moveSelectedButton?.addEventListener("click", () => {';
  const start = html.indexOf(anchor);
  if (start < 0) throw new Error("moveSelectedButton の click ハンドラが見つからない");
  const bodyBrace = start + anchor.length - 1; // アロー本体の開き "{"
  let depth = 0;
  for (let i = bodyBrace; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(bodyBrace, i + 1);
    }
  }
  throw new Error("moveSelectedButton ハンドラの波括弧が対応していない");
}

const handlerBody = extractMoveHandlerBody();

test("ハンドラ本体を正しく切り出せている（目印の行を含む）", () => {
  // 切り出しに失敗して空文字や別の関数を拾っていないことを、検査自体で確かめる。
  assert.ok(handlerBody.startsWith("{") && handlerBody.endsWith("}"));
  assert.ok(handlerBody.includes("word.deckId = deckId;"), "deckId 更新の行が見当たらない＝切り出し失敗");
  assert.ok(handlerBody.includes("word.deckUpdatedAt = movedAt;"), "deckUpdatedAt 更新の行が見当たらない＝切り出し失敗");
  assert.ok(handlerBody.includes("selectedIds.clear();"), "selectedIds.clear() が見当たらない＝切り出し失敗");
  assert.ok(handlerBody.includes("saveState();"), "saveState() 呼び出しが見当たらない＝切り出し失敗");
  assert.ok(handlerBody.includes("offerUndo(snapshot);"), "offerUndo() 呼び出しが見当たらない＝切り出し失敗");
});

/**
 * 実ハンドラを動かすための最小限のスタブ環境を作る。
 * appState / selectedIds / elements はテストごとに初期値を渡し、
 * saveState・offerUndo・snapshotState・setStatus・deckName は
 * 呼び出し順と引数を記録するだけのスタブにする（本物の永続化やDOM描画はしない）。
 */
function buildSandbox({ decks, words, selectedIds, deckSelectValue }) {
  const src = `
    const calls = [];
    let lastStatus = null;
    let lastSnapshot = null;
    let offerUndoArg = null;

    const appState = ${JSON.stringify({ decks, words })};
    // clear() が呼ばれた時点を calls に残す。最終的に空かどうかだけを見ると、
    // saveState() の後ろへ動かす並べ替えを見逃す（saveState は renderAll を呼ぶので、
    // 順序が逆だと描画の時点ではまだ選択が残っている）。
    class RecordingSet extends Set {
      clear() {
        calls.push("selectedIds.clear");
        return super.clear();
      }
    }
    const selectedIds = new RecordingSet(${JSON.stringify(selectedIds)});
    const elements = {
      moveSelectedButton: {},
      moveSelectedDeckSelect: { value: ${JSON.stringify(deckSelectValue)} },
    };

    function deckName(id) {
      const deck = appState.decks.find((d) => d.id === id);
      return deck ? deck.name : "単語帳";
    }
    function snapshotState() {
      calls.push("snapshotState");
      lastSnapshot = JSON.parse(JSON.stringify(appState));
      return lastSnapshot;
    }
    function saveState() {
      calls.push("saveState");
    }
    function offerUndo(snapshot) {
      calls.push("offerUndo");
      offerUndoArg = snapshot;
    }
    function setStatus(message) {
      calls.push("setStatus");
      lastStatus = message;
    }

    function moveSelectedHandler() ${handlerBody}

    globalThis.__api = {
      appState,
      selectedIds,
      elements,
      calls,
      moveSelectedHandler,
      getLastStatus: () => lastStatus,
      getLastSnapshot: () => lastSnapshot,
      getOfferUndoArg: () => offerUndoArg,
    };
  `;
  const sandbox = { globalThis: undefined, Date, JSON, Set, Array };
  sandbox.globalThis = sandbox;
  new Script(src).runInNewContext(sandbox);
  return sandbox.__api;
}

function baseDecks() {
  return [
    { id: "d1", name: "デッキ1" },
    { id: "d2", name: "デッキ2" },
  ];
}

test("移動した単語は deckId と deckUpdatedAt の両方が更新される", () => {
  const api = buildSandbox({
    decks: baseDecks(),
    words: [
      { id: "w1", deckId: "d1" },
      { id: "w2", deckId: "d1" },
    ],
    selectedIds: ["w1", "w2"],
    deckSelectValue: "d2",
  });
  const before = Date.now();
  api.moveSelectedHandler();
  const after = Date.now();

  for (const word of api.appState.words) {
    assert.equal(word.deckId, "d2", `${word.id} の deckId が更新されていない`);
    assert.ok(
      typeof word.deckUpdatedAt === "number" && word.deckUpdatedAt >= before && word.deckUpdatedAt <= after,
      `${word.id} の deckUpdatedAt が更新されていない（多端末マージで移動が消える）`,
    );
  }
  // 同一操作で移動した単語は同じ移動時刻を持つ
  assert.equal(api.appState.words[0].deckUpdatedAt, api.appState.words[1].deckUpdatedAt);
});

test("移動先にすでに入っている単語は触らない（deckUpdatedAtを無駄に更新しない）", () => {
  const api = buildSandbox({
    decks: baseDecks(),
    words: [
      { id: "w1", deckId: "d1" }, // 移動対象
      { id: "w2", deckId: "d2", deckUpdatedAt: 111 }, // すでに移動先。既存の更新時刻を持つ
    ],
    selectedIds: ["w1", "w2"],
    deckSelectValue: "d2",
  });
  api.moveSelectedHandler();

  const w1 = api.appState.words.find((w) => w.id === "w1");
  const w2 = api.appState.words.find((w) => w.id === "w2");
  assert.equal(w1.deckId, "d2");
  assert.ok(typeof w1.deckUpdatedAt === "number");
  // すでに移動先にいた単語は deckUpdatedAt が書き換わっていない
  // （無駄に更新すると他端末で行われた移動を上書きしてしまう）
  assert.equal(w2.deckUpdatedAt, 111, "すでに移動先にいた単語の deckUpdatedAt が上書きされている");
});

test("移動後に selectedIds が空になる", () => {
  const api = buildSandbox({
    decks: baseDecks(),
    words: [
      { id: "w1", deckId: "d1" },
      { id: "w2", deckId: "d1" },
    ],
    selectedIds: ["w1", "w2"],
    deckSelectValue: "d2",
  });
  assert.equal(api.selectedIds.size, 2);
  api.moveSelectedHandler();
  assert.equal(
    api.selectedIds.size,
    0,
    "移動後も selectedIds が残ると、絞り込み中の移動で「見えない単語」を選んだ状態になる",
  );
});

test("selectedIds.clear() は saveState() より前に呼ばれる（描画時点で選択を残さない）", () => {
  const api = buildSandbox({
    decks: baseDecks(),
    words: [{ id: "w1", deckId: "d1" }],
    selectedIds: ["w1"],
    deckSelectValue: "d2",
  });
  api.moveSelectedHandler();

  const clearIdx = api.calls.indexOf("selectedIds.clear");
  const saveIdx = api.calls.indexOf("saveState");
  assert.ok(clearIdx >= 0, "selectedIds.clear() が呼ばれていない");
  assert.ok(saveIdx >= 0, "saveState() が呼ばれていない");
  // saveState() は renderAll() を呼ぶ。clear() が後ろにあると、描画の時点では
  // まだ移動済みの単語が選択されたままになり、「N件 選択中」の表示が一瞬ずれる。
  assert.ok(
    clearIdx < saveIdx,
    "selectedIds.clear() が saveState() より後にある。描画時点で選択が残る",
  );
});

test("offerUndo は saveState の後に呼ばれる（順序が逆だと取り消しが効かない）", () => {
  const api = buildSandbox({
    decks: baseDecks(),
    words: [{ id: "w1", deckId: "d1" }],
    selectedIds: ["w1"],
    deckSelectValue: "d2",
  });
  api.moveSelectedHandler();

  const saveIdx = api.calls.indexOf("saveState");
  const undoIdx = api.calls.indexOf("offerUndo");
  assert.ok(saveIdx >= 0 && undoIdx >= 0, "saveState / offerUndo が呼ばれていない");
  assert.ok(
    saveIdx < undoIdx,
    "offerUndo が saveState より先に呼ばれている。saveState 内の clearUndo に取り消しを消される",
  );
});

test("snapshotState は単語を書き換える前に取られている（取り消しで移動前へ戻れる）", () => {
  const api = buildSandbox({
    decks: baseDecks(),
    words: [{ id: "w1", deckId: "d1" }],
    selectedIds: ["w1"],
    deckSelectValue: "d2",
  });
  api.moveSelectedHandler();

  const snapshot = api.getLastSnapshot();
  assert.ok(snapshot, "snapshotState が呼ばれていない");
  const snapshotWord = snapshot.words.find((w) => w.id === "w1");
  // スナップショットが書き換え「前」に取られていれば deckId は元の "d1" のまま。
  // 書き換え後に取られていたら "d2" になってしまい、取り消しても移動が戻らない。
  assert.equal(snapshotWord.deckId, "d1", "snapshotState が単語の書き換え後に呼ばれている");
  // 実際の状態は移動済みであること（比較対象として）
  assert.equal(api.appState.words.find((w) => w.id === "w1").deckId, "d2");
  // offerUndo に渡されたスナップショットも同じもの
  assert.equal(api.getOfferUndoArg(), snapshot);
});

test("移動先デッキが存在しないときは状態を書き換えず案内だけ出す", () => {
  const api = buildSandbox({
    decks: baseDecks(),
    words: [{ id: "w1", deckId: "d1" }],
    selectedIds: ["w1"],
    deckSelectValue: "存在しないデッキ",
  });
  const wordsBefore = JSON.stringify(api.appState.words);
  api.moveSelectedHandler();

  assert.equal(JSON.stringify(api.appState.words), wordsBefore, "単語が書き換わってしまっている");
  assert.equal(api.selectedIds.size, 1, "選択が変わってしまっている");
  assert.deepEqual(Array.from(api.calls), ["setStatus"], "snapshotState/saveState/offerUndo を呼んではいけない");
  assert.equal(api.getLastStatus(), "移動先の単語帳を選んでください。");
});

test("選択が空のときは状態を書き換えず案内だけ出す", () => {
  const api = buildSandbox({
    decks: baseDecks(),
    words: [{ id: "w1", deckId: "d1" }],
    selectedIds: [],
    deckSelectValue: "d2",
  });
  const wordsBefore = JSON.stringify(api.appState.words);
  api.moveSelectedHandler();

  assert.equal(JSON.stringify(api.appState.words), wordsBefore);
  assert.deepEqual(Array.from(api.calls), ["setStatus"]);
  assert.equal(api.getLastStatus(), "移動する単語が選択されていません。");
});

test("対象が全部すでに移動先にいるときは状態を書き換えず案内だけ出す", () => {
  const api = buildSandbox({
    decks: baseDecks(),
    words: [
      { id: "w1", deckId: "d2" },
      { id: "w2", deckId: "d2" },
    ],
    selectedIds: ["w1", "w2"],
    deckSelectValue: "d2",
  });
  const wordsBefore = JSON.stringify(api.appState.words);
  api.moveSelectedHandler();

  assert.equal(JSON.stringify(api.appState.words), wordsBefore);
  assert.equal(api.selectedIds.size, 2, "案内だけのはずが選択まで消えている");
  assert.deepEqual(Array.from(api.calls), ["setStatus"]);
  assert.equal(api.getLastStatus(), "選んだ単語はすでにすべて単語帳「デッキ2」に入っています。");
});
