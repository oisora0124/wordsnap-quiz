// 1.0.134 の小さな使い勝手の改善を固定する。
//
// 1. 設定を折りたたんでも、見出しの要約の後ろに出題対象の語数を出す
// 2. 結果画面を初めて出したときだけ、焦点を「もう一度解く」へ移す（焦点を奪わない条件つき）
// 3. 再生中の🔊（クイズカード・フラッシュカード）に見た目の変化を付ける
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

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

// ---------- 1. 要約の後ろの語数 ----------

function runScopeCount({ count, from = "", to = "" }) {
  const elements = {
    quizSetupScopeCount: { textContent: "" },
    quizRangeFrom: { value: from },
    quizRangeTo: { value: to },
  };
  const sandbox = {
    elements,
    quizSelectedDeckWords: () => Array.from({ length: count }, (_, i) => ({ id: String(i) })),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [extractFunction("quizRangeWordCount"), extractFunction("updateQuizSetupScopeCount"), "updateQuizSetupScopeCount();"].join("\n"),
    sandbox,
  );
  return elements.quizSetupScopeCount.textContent;
}

test("出題対象の語数を、折りたたみの見出しの要約の後ろにも出す", () => {
  assert.equal(runScopeCount({ count: 6 }), "・6語");
  assert.equal(runScopeCount({ count: 0 }), "・対象なし");
});

test("番号範囲を指定したら、見出しの語数も実際の出題数（slice(from-1, to)）に合わせる", () => {
  assert.equal(runScopeCount({ count: 100, from: "1", to: "10" }), "・10語");
  assert.equal(runScopeCount({ count: 100, from: "91" }), "・10語", "開始だけ");
  assert.equal(runScopeCount({ count: 100, to: "25" }), "・25語", "終了だけ");
  assert.equal(runScopeCount({ count: 30, from: "21", to: "500" }), "・10語", "範囲外は端へ寄せる");
  assert.equal(runScopeCount({ count: 30, from: "20", to: "10" }), "・対象なし", "逆順は0語");
});

test("語数は要約と同じ更新経路（updateQuizSetupScope）で描き直す", () => {
  // 範囲入力・範囲トグル・同期・復元はすべて updateQuizSetupScope を呼ぶので、そこに乗せる
  assert.match(extractFunction("updateQuizSetupScope"), /updateQuizSetupScopeCount\(\)/);
});

test("語数の表示先は #quizSetupAdvanced の summary の中にある（閉じていても見える）", () => {
  const summaryStart = html.indexOf('<details id="quizSetupAdvanced"');
  const summaryEnd = html.indexOf("</summary>", summaryStart);
  assert.ok(summaryStart > 0 && summaryEnd > summaryStart);
  assert.match(html.slice(summaryStart, summaryEnd), /id="quizSetupScopeCount"/);
});

// ---------- 2. 結果画面の焦点 ----------

function makeEl(id = "") {
  return { id, inside: "" };
}

function runShouldMove({ active, step = "quiz" }) {
  const body = makeEl("body");
  const sandbox = {
    activeStepId: step,
    document: { body },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${extractFunction("shouldMoveFocusToReviewResult")}\nglobalThis.__fn = shouldMoveFocusToReviewResult;`,
    sandbox,
  );
  const target =
    active === "body"
      ? body
      : active === null
        ? null
        : {
            closest: (selector) =>
              selector === "#quizCard, .quiz-actions" && active === "quiz" ? {} : null,
          };
  return sandbox.__fn(target);
}

test("焦点が無い・body・クイズ周りなら結果の操作へ移す", () => {
  assert.equal(runShouldMove({ active: null }), true);
  assert.equal(runShouldMove({ active: "body" }), true);
  assert.equal(runShouldMove({ active: "quiz" }), true, "隠れる「次の問題」はクイズ操作列の中");
});

test("利用者が別の場所を操作中なら焦点を奪わない", () => {
  assert.equal(runShouldMove({ active: "elsewhere" }), false);
  assert.equal(runShouldMove({ active: "quiz", step: "library" }), false, "クイズタブ以外では移さない");
});

// renderReviewResult を最小のDOMで走らせる。replaceChildren で古いボタンが外れ、
// focus() は activeElement を動かす（外れた要素に焦点があれば body へ落ちる）ところまで再現する。
function makeResultSandbox({ result, initialActive = "quiz" }) {
  const created = [];
  const body = { id: "body" };
  const doc = { body, activeElement: null, querySelector: () => ({ textContent: "" }) };
  const choices = {
    childrenNodes: [],
    replaceChildren(...nodes) {
      const removed = this.childrenNodes;
      this.childrenNodes = nodes;
      if (removed.some((node) => node.containsNode(doc.activeElement))) doc.activeElement = body;
    },
    contains(node) {
      return this.childrenNodes.some((child) => child.containsNode(node));
    },
  };
  const makeNode = (tag) => {
    const node = {
      tag,
      children: [],
      parentElement: null,
      textContent: "",
      className: "",
      type: "",
      focusCount: 0,
      append(...items) {
        for (const item of items) item.parentElement = this;
        this.children.push(...items);
      },
      containsNode(target) {
        return target === this || this.children.some((child) => child.containsNode?.(target));
      },
      closest(selector) {
        if (selector === ".review-result-actions button") {
          return this.tag === "button" && this.parentElement?.className === "review-result-actions" ? this : null;
        }
        if (selector === "#quizCard, .quiz-actions") return choices.contains(this) ? this : null;
        return null;
      },
      addEventListener() {},
      focus() {
        this.focusCount += 1;
        doc.activeElement = this;
      },
    };
    created.push(node);
    return node;
  };
  doc.createElement = makeNode;
  doc.activeElement =
    initialActive === "quiz" ? { closest: (sel) => (sel === "#quizCard, .quiz-actions" ? {} : null) } : { closest: () => null };
  const sandbox = {
    reviewResult: result,
    activeStepId: "quiz",
    elements: {
      quizWord: { textContent: "" },
      quizFeedback: { textContent: "" },
      quizResultQuote: { textContent: "" },
      choices,
    },
    currentLearningQuote: () => ({ text: "学び", author: "誰か" }),
    document: doc,
    startReview() {},
    startFlashcardsFromIds() {},
    renderQuiz() {},
    playSound() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [extractFunction("shouldMoveFocusToReviewResult"), extractFunction("renderReviewResult"), "globalThis.__render = renderReviewResult;"].join("\n"),
    sandbox,
  );
  const buttons = () => created.filter((node) => node.tag === "button");
  return { render: () => sandbox.__render(), buttons, doc };
}

const baseResult = () => ({
  total: 3,
  missedCount: 1,
  midCount: 0,
  label: "単語帳1・全部",
  missedWords: [{ term: "apple", meaning: "りんご" }],
  allIds: ["a", "b", "c"],
});

test("結果画面を初めて出したときだけ「もう一度解く」へ焦点を移す", () => {
  const result = baseResult();
  const box = makeResultSandbox({ result });
  box.render();
  const [firstAgain] = box.buttons();
  assert.equal(firstAgain.focusCount, 1);
  assert.equal(result.focusMoved, true);
  // 焦点が外れて body に落ちた状態（ボタン以外をクリックした等）で同期の描き直しが来ても、
  // 2回目以降は「もう一度解く」へ引き戻さない（初回だけの約束）
  box.doc.activeElement = box.doc.body;
  box.render();
  const total = box.buttons().reduce((n, button) => n + button.focusCount, 0);
  assert.equal(total, 1, "2回目の描画ではどのボタンにも focus しない");
});

test("結果のボタンに焦点がある状態で描き直したら、作り直した同じ位置のボタンへ戻す", () => {
  const box = makeResultSandbox({ result: baseResult() });
  box.render();
  const [, firstClose] = box.buttons();
  firstClose.focus(); // 利用者が「通常クイズに戻る」へ移動した
  box.render(); // 同期による描き直し
  const [, , secondAgain, secondClose] = box.buttons();
  assert.equal(box.doc.activeElement, secondClose, "作り直した「通常クイズに戻る」に焦点がある");
  assert.equal(secondAgain.focusCount, 0, "「もう一度解く」へ引き戻さない");
});

test("焦点がクイズ周りに無ければ、結果画面でも焦点を奪わない", () => {
  const box = makeResultSandbox({ result: baseResult(), initialActive: "elsewhere" });
  box.render();
  assert.equal(box.buttons()[0].focusCount, 0);
});

// ---------- 3. 再生中の🔊 ----------

test("再生中の🔊は、クイズカード・フラッシュカードとも輪で囲んで変化を見せる", () => {
  const rule = html.match(/\.quiz-speak\.is-speaking,\s*\.flashcard-speak\.is-speaking \{[^}]*\}/)?.[0];
  assert.ok(rule, "両方のボタンに同じ規則が掛かる");
  assert.match(rule, /box-shadow:/);
  assert.match(rule, /animation: speak-pulse/);
});

test("動きを減らす設定では、再生中の点滅を止める", () => {
  const block = html.match(
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.quiz-speak\.is-speaking,\s*\.flashcard-speak\.is-speaking \{\s*animation: none;/,
  );
  assert.ok(block);
});
