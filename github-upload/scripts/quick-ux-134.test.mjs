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

function runDeckCount(count) {
  const elements = {
    quizDeckCount: { textContent: "" },
    quizSetupScopeCount: { textContent: "" },
    quizRangeFrom: { max: "" },
    quizRangeTo: { max: "" },
  };
  let scopeUpdated = 0;
  const sandbox = {
    elements,
    quizSelectedDeckWords: () => Array.from({ length: count }, (_, i) => ({ id: String(i) })),
    updateQuizSetupScope: () => {
      scopeUpdated += 1;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction("updateQuizDeckCount")}\nupdateQuizDeckCount();`, sandbox);
  return { elements, scopeUpdated };
}

test("出題対象の語数を、折りたたみの見出しの要約の後ろにも出す", () => {
  const { elements, scopeUpdated } = runDeckCount(6);
  assert.equal(elements.quizDeckCount.textContent, "出題対象: 6語");
  assert.equal(elements.quizSetupScopeCount.textContent, "・6語");
  assert.equal(scopeUpdated, 1, "要約本体の更新も従来どおり呼ぶ");
});

test("出題対象が0語なら、要約の後ろは「対象なし」", () => {
  const { elements } = runDeckCount(0);
  assert.equal(elements.quizSetupScopeCount.textContent, "・対象なし");
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

// renderReviewResult を最小のDOMで走らせ、焦点移動が「初回だけ」であることを確かめる
function runRenderReviewResult({ result, activeIsQuiz = true }) {
  const created = [];
  const makeNode = (tag) => {
    const node = {
      tag,
      children: [],
      textContent: "",
      className: "",
      type: "",
      focusCount: 0,
      append(...items) {
        this.children.push(...items);
      },
      addEventListener() {},
      focus() {
        this.focusCount += 1;
      },
    };
    created.push(node);
    return node;
  };
  const body = { id: "body" };
  const activeElement = activeIsQuiz ? { closest: () => ({}) } : { closest: () => null };
  const sandbox = {
    reviewResult: result,
    activeStepId: "quiz",
    elements: {
      quizWord: { textContent: "" },
      quizFeedback: { textContent: "" },
      quizResultQuote: { textContent: "" },
      choices: { replaceChildren() {} },
    },
    currentLearningQuote: () => ({ text: "学び", author: "誰か" }),
    document: {
      body,
      activeElement,
      querySelector: () => ({ textContent: "" }),
      createElement: makeNode,
    },
    startReview() {},
    startFlashcardsFromIds() {},
    renderQuiz() {},
    playSound() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [
      extractFunction("shouldMoveFocusToReviewResult"),
      extractFunction("renderReviewResult"),
      "renderReviewResult();",
      "renderReviewResult();",
    ].join("\n"),
    sandbox,
  );
  const buttons = created.filter((node) => node.tag === "button");
  return { again: buttons[0], close: buttons[1] };
}

const baseResult = () => ({
  total: 3,
  missedCount: 1,
  midCount: 0,
  label: "単語帳1・全部",
  missedWords: [{ term: "apple", meaning: "りんご" }],
  allIds: ["a", "b", "c"],
});

test("結果画面を初めて出したときだけ「もう一度解く」へ焦点を移す（描き直しでは移さない）", () => {
  const result = baseResult();
  const { again } = runRenderReviewResult({ result });
  assert.equal(again.focusCount, 1, "2回描いても焦点移動は1回");
  assert.equal(result.focusMoved, true);
});

test("焦点がクイズ周りに無ければ、結果画面でも焦点を奪わない", () => {
  const { again } = runRenderReviewResult({ result: baseResult(), activeIsQuiz: false });
  assert.equal(again.focusCount, 0);
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
