// クイズ開始画面の段階的開示（1.0.129 A）を固定する。
//
// 最初に見えるのは「クイズを始める（おまかせ）」と「今日の復習」だけにして、
// 単語帳・範囲・出題形式の細かい設定と、他の出題モード（苦手だけ・やさしい順・
// 例文・フラッシュカード）は details に畳んでおく。既存のID・挙動は変えず、
// 置き場所と開閉状態の記憶だけを追加する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Script } from "node:vm";
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

// ============================================================================
// HTML構造: 段階的開示の置き場所
// ============================================================================

test("#startQuizButton と #generalReviewButton は #quizSetup 内（quizSetupAdvancedより前）にある", () => {
  const quizSetupIdx = html.indexOf('<div id="quizSetup"');
  const advancedIdx = html.indexOf('<details id="quizSetupAdvanced"');
  const startBtnIdx = html.indexOf('id="startQuizButton"');
  const reviewBtnIdx = html.indexOf('id="generalReviewButton"');
  assert.ok(quizSetupIdx >= 0 && advancedIdx > quizSetupIdx, "#quizSetup → #quizSetupAdvanced の順であること");
  assert.ok(startBtnIdx > quizSetupIdx && startBtnIdx < advancedIdx, "#startQuizButton は畳む前の主導線にあること");
  assert.ok(reviewBtnIdx > quizSetupIdx && reviewBtnIdx < advancedIdx, "#generalReviewButton は畳む前の主導線にあること");
});

test("苦手だけ・やさしい順・例文・フラッシュカードの4ボタンは #quizMoreModes 内にある", () => {
  const moreModesIdx = html.indexOf('<details id="quizMoreModes"');
  const nextDetailsClose = html.indexOf("</details>", moreModesIdx);
  assert.ok(moreModesIdx >= 0, "#quizMoreModes が見つかること");
  for (const id of ["difficultQuizButton", "easyQuizButton", "contextQuizButton", "startFlashcardButton"]) {
    const idx = html.indexOf(`id="${id}"`);
    assert.ok(idx > moreModesIdx && idx < nextDetailsClose, `#${id} は #quizMoreModes 内にあること`);
  }
});

test("#quizRangeStartButton は #quizSetupAdvanced 内にある", () => {
  const advancedIdx = html.indexOf('<details id="quizSetupAdvanced"');
  const moreModesIdx = html.indexOf('<details id="quizMoreModes"');
  const rangeStartIdx = html.indexOf('id="quizRangeStartButton"');
  assert.ok(rangeStartIdx > advancedIdx && rangeStartIdx < moreModesIdx, "#quizRangeStartButton は詳細側のdetails内にあること");
});

test("2つのdetailsは既定で閉じている（open属性が無い）", () => {
  assert.match(html, /<details id="quizSetupAdvanced" class="quiz-setup-more">/, "quizSetupAdvancedにopen属性が無いこと");
  assert.match(html, /<details id="quizMoreModes" class="quiz-setup-more">/, "quizMoreModesにopen属性が無いこと");
  assert.doesNotMatch(html, /<details id="quizSetupAdvanced"[^>]*\bopen\b/, "quizSetupAdvancedが既定で開いていないこと");
  assert.doesNotMatch(html, /<details id="quizMoreModes"[^>]*\bopen\b/, "quizMoreModesが既定で開いていないこと");
});

test(".quiz-actions に #startQuizButton は残っていない（開始画面へ移した）", () => {
  const actionsStart = html.indexOf('<div class="actions quiz-actions">');
  assert.ok(actionsStart >= 0, ".quiz-actions が見つかること");
  const actionsEnd = html.indexOf("</div>", actionsStart);
  const actionsBody = html.slice(actionsStart, actionsEnd);
  assert.doesNotMatch(actionsBody, /id="startQuizButton"/);
  assert.doesNotMatch(actionsBody, /id="generalReviewButton"/);
  assert.doesNotMatch(actionsBody, /id="difficultQuizButton"/);
  // 残すべきものは残っていること
  assert.match(actionsBody, /id="nextQuizButton"/);
  assert.match(actionsBody, /id="exitReviewButton"/);
  assert.match(actionsBody, /id="exitQuizButton"/);
  assert.match(actionsBody, /id="quizKeyboardHint"/);
});

// ============================================================================
// describeQuizSetupScope: 折りたたんだ summary の要約文
// ============================================================================

function scopeSandbox() {
  const sandbox = {};
  new Script(`${extractFunction("describeQuizSetupScope")}\nglobalThis.__f = describeQuizSetupScope;`, {
    filename: "quiz-start-disclosure-scope.js",
  }).runInNewContext(sandbox);
  return sandbox.__f;
}

test("describeQuizSetupScope: 既定値だけなら「すべての単語帳」", () => {
  const f = scopeSandbox();
  const result = f({
    deckId: "all",
    deckLabel: "すべて",
    cefr: "all",
    from: "",
    to: "",
    shuffle: true,
    contextAmount: "none",
    direction: "forward",
  });
  assert.equal(result, "すべての単語帳");
});

test("describeQuizSetupScope: 単語帳と範囲を両方変えると・区切りで並ぶ", () => {
  const f = scopeSandbox();
  const result = f({
    deckId: "d9",
    deckLabel: "受験1500",
    cefr: "all",
    from: "1",
    to: "50",
    shuffle: true,
    contextAmount: "none",
    direction: "forward",
  });
  assert.equal(result, "受験1500・番号 1〜50");
});

test("describeQuizSetupScope: 既定判定はdeckId基準（単語帳名が「すべて」でもidがallでなければ変更扱い）", () => {
  // 単語帳自体に「すべて」という名前が付いていた場合、表示名の文字列比較だと
  // 既定と誤認してしまう。idで判定していることを確認する。
  const f = scopeSandbox();
  const result = f({
    deckId: "d-named-subete",
    deckLabel: "すべて",
    cefr: "all",
    from: "",
    to: "",
    shuffle: true,
    contextAmount: "none",
    direction: "forward",
  });
  assert.equal(result, "すべて");
});

test("describeQuizSetupScope: 開始番号だけの片側範囲", () => {
  const f = scopeSandbox();
  const result = f({
    deckId: "all",
    deckLabel: "すべて",
    cefr: "all",
    from: "10",
    to: "",
    shuffle: true,
    contextAmount: "none",
    direction: "forward",
  });
  assert.equal(result, "番号 10〜");
});

test("describeQuizSetupScope: 終了番号だけの片側範囲", () => {
  const f = scopeSandbox();
  const result = f({
    deckId: "all",
    deckLabel: "すべて",
    cefr: "all",
    from: "",
    to: "50",
    shuffle: true,
    contextAmount: "none",
    direction: "forward",
  });
  assert.equal(result, "番号 〜50");
});

test("describeQuizSetupScope: CEFR未判定は「CEFR 未判定」と表記する", () => {
  const f = scopeSandbox();
  const result = f({
    deckId: "all",
    deckLabel: "すべて",
    cefr: "unknown",
    from: "",
    to: "",
    shuffle: true,
    contextAmount: "none",
    direction: "forward",
  });
  assert.equal(result, "CEFR 未判定");
});

test("describeQuizSetupScope: シャッフルOFF・例文全部・日→英を並べる", () => {
  const f = scopeSandbox();
  const result = f({
    deckId: "all",
    deckLabel: "すべて",
    cefr: "all",
    from: "",
    to: "",
    shuffle: false,
    contextAmount: "all",
    direction: "reverse",
  });
  assert.equal(result, "順番どおり・例文 全部・日→英");
});

test("describeQuizSetupScope: ミックスと例文一部", () => {
  const f = scopeSandbox();
  const result = f({
    deckId: "all",
    deckLabel: "すべて",
    cefr: "B1",
    from: "",
    to: "",
    shuffle: true,
    contextAmount: "some",
    direction: "mix",
  });
  assert.equal(result, "CEFR B1・例文 一部・ミックス");
});

// ============================================================================
// initQuizSetupDisclosure: 開閉状態の記憶
// ============================================================================

function makeDetailsEl(id) {
  const listeners = {};
  return {
    id,
    open: false,
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    dispatchToggle() {
      listeners.toggle?.();
    },
  };
}

function disclosureSandbox({ stored } = {}) {
  const store = new Map();
  if (stored !== undefined) store.set("wordsnap-quiz-setup-open:v1", stored);
  const quizSetupAdvanced = makeDetailsEl("quizSetupAdvanced");
  const quizMoreModes = makeDetailsEl("quizMoreModes");
  const context = {
    JSON,
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    elements: { quizSetupAdvanced, quizMoreModes },
  };
  const source = [
    extractConstLine("QUIZ_SETUP_OPEN_KEY"),
    extractFunction("initQuizSetupDisclosure"),
    "globalThis.__init = initQuizSetupDisclosure;",
  ].join("\n\n");
  vm.runInNewContext(source, context);
  return { context, quizSetupAdvanced, quizMoreModes, store };
}

function extractConstLine(name) {
  const start = html.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`const ${name} not found`);
  const end = html.indexOf(";", start);
  return html.slice(start, end + 1);
}

test("initQuizSetupDisclosure: 保存値が無ければ両方とも閉じる", () => {
  const { context, quizSetupAdvanced, quizMoreModes } = disclosureSandbox();
  context.__init();
  assert.equal(quizSetupAdvanced.open, false);
  assert.equal(quizMoreModes.open, false);
});

test("initQuizSetupDisclosure: 保存値どおりに片方だけ開く", () => {
  const { context, quizSetupAdvanced, quizMoreModes } = disclosureSandbox({
    stored: JSON.stringify(["quizSetupAdvanced"]),
  });
  context.__init();
  assert.equal(quizSetupAdvanced.open, true);
  assert.equal(quizMoreModes.open, false);
});

test("initQuizSetupDisclosure: 壊れたJSONは安全側（両方閉じる）へ倒す", () => {
  const { context, quizSetupAdvanced, quizMoreModes } = disclosureSandbox({ stored: "{こわれた" });
  context.__init();
  assert.equal(quizSetupAdvanced.open, false);
  assert.equal(quizMoreModes.open, false);
});

test("initQuizSetupDisclosure: toggleで開閉状態を保存する", () => {
  const { context, quizSetupAdvanced, quizMoreModes, store } = disclosureSandbox();
  context.__init();
  quizSetupAdvanced.open = true;
  quizSetupAdvanced.dispatchToggle();
  assert.deepEqual(JSON.parse(store.get("wordsnap-quiz-setup-open:v1")), ["quizSetupAdvanced"]);
  quizMoreModes.open = true;
  quizMoreModes.dispatchToggle();
  assert.deepEqual(JSON.parse(store.get("wordsnap-quiz-setup-open:v1")).sort(), ["quizMoreModes", "quizSetupAdvanced"]);
});

test("initQuizSetupDisclosure: localStorageが書けなくても例外を漏らさない", () => {
  const { context, quizSetupAdvanced } = disclosureSandbox();
  context.__init();
  context.localStorage.setItem = () => {
    throw new Error("quota");
  };
  assert.doesNotThrow(() => {
    quizSetupAdvanced.open = true;
    quizSetupAdvanced.dispatchToggle();
  });
});

// ============================================================================
// restoreLastQuizSettings: 範囲を復元したときは quizSetupAdvanced を開く
// ============================================================================

function restoreSettingsSandbox({ stored } = {}) {
  const store = new Map();
  if (stored !== undefined) store.set("wordsnap-quiz-last-settings:v1", stored);
  const quizSetupAdvanced = { open: false };
  const quizRangeRow = { hidden: true };
  const quizRangeToggle = { setAttribute() {} };
  const quizRangeFrom = { value: "" };
  const quizRangeTo = { value: "" };
  const quizContextAmountSelect = { value: "none" };
  const elements = {
    quizDeckSelect: { options: [] },
    quizCefrSelect: { options: [] },
    quizShuffle: { checked: true },
    quizContextAmountSelect,
    quizRangeRow,
    quizRangeToggle,
    quizRangeFrom,
    quizRangeTo,
    quizSetupAdvanced,
  };
  const context = {
    JSON,
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    elements,
    // restoreLastQuizSettings自体の挙動だけを見たいので、依存関数はダミーにする
    // （updateQuizDeckCountは単語帳選択が無いこのテストでは呼ばれない経路）。
    updateQuizDeckCount() {},
    updateQuizSetupScope() {},
    normalizeQuizContextAmount: (value) => (value === "some" || value === "all" ? value : "none"),
  };
  const source = [
    'const QUIZ_LAST_SETTINGS_KEY = "wordsnap-quiz-last-settings:v1";',
    extractFunction("restoreLastQuizSettings"),
    "globalThis.__restore = restoreLastQuizSettings;",
  ].join("\n\n");
  vm.runInNewContext(source, context);
  return { context, elements };
}

test("restoreLastQuizSettings: useRangeの保存値があると範囲を表示し、quizSetupAdvancedを開く", () => {
  const { context, elements } = restoreSettingsSandbox({
    stored: JSON.stringify({ useRange: true, from: "5", to: "20" }),
  });
  context.__restore();
  assert.equal(elements.quizRangeRow.hidden, false);
  assert.equal(elements.quizSetupAdvanced.open, true);
  assert.equal(elements.quizRangeFrom.value, "5");
  assert.equal(elements.quizRangeTo.value, "20");
});

test("restoreLastQuizSettings: useRangeが無い保存値では範囲を開かない", () => {
  const { context, elements } = restoreSettingsSandbox({
    stored: JSON.stringify({ shuffle: false }),
  });
  context.__restore();
  assert.equal(elements.quizRangeRow.hidden, true);
  assert.equal(elements.quizSetupAdvanced.open, false);
});

// ============================================================================
// updateQuizSetupScope: 偽elementsで走らせて#quizSetupScopeへ書く
// ============================================================================

function setupScopeSandbox(fieldValues) {
  const quizSetupScope = { textContent: "" };
  const elements = {
    quizSetupScope,
    quizDeckSelect: { value: fieldValues.deckId ?? "all" },
    quizCefrSelect: { value: fieldValues.cefr ?? "all" },
    quizRangeFrom: { value: fieldValues.from ?? "" },
    quizRangeTo: { value: fieldValues.to ?? "" },
    quizShuffle: { checked: fieldValues.shuffle ?? true },
    quizContextAmountSelect: { value: fieldValues.contextAmount ?? "none" },
    quizDirectionSelect: { value: fieldValues.direction ?? "forward" },
  };
  const context = { elements };
  const source = [
    extractFunction("describeQuizSetupScope"),
    extractFunction("updateQuizSetupScope"),
    "globalThis.__update = updateQuizSetupScope;",
  ].join("\n\n");
  vm.runInNewContext(source, context);
  return { context, quizSetupScope };
}

test("updateQuizSetupScope: 既定値のまま(deckId=all)なら「すべての単語帳」を書く", () => {
  const { context, quizSetupScope } = setupScopeSandbox({});
  context.__update();
  assert.equal(quizSetupScope.textContent, "すべての単語帳");
});

test("updateQuizSetupScope: 変更した項目を・区切りで#quizSetupScopeへ書く", () => {
  const { context, quizSetupScope } = setupScopeSandbox({
    deckId: "all",
    cefr: "B1",
    from: "5",
    to: "",
    shuffle: false,
    contextAmount: "some",
    direction: "reverse",
  });
  context.__update();
  assert.equal(quizSetupScope.textContent, "CEFR B1・番号 5〜・順番どおり・例文 一部・日→英");
});
