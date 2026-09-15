// 1.0.131: 初回体験の軽量化・設定の3分割・サンプルの出典・robots/sitemap・フォント整合。
//
// A. 名言バーは hero に常時出さず、学習の記録パネル（#streakPanel）の中でだけ見せる。
//    クイズ・復習完走の結果画面にも、同じ名言を1行だけ添える。
// B. 保存されたタブが無い（初回以外の再訪問なのに壊れている等も含む）ときだけ、
//    既に単語があれば「クイズ」タブから始める。
// D. サンプル単語帳のキー名を `*1500` に統一し、出典の注記を添える。
// E. robots.txt / sitemap.xml を publish 配下に置く。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const publishDir = resolve(scriptDir, "..", "publish");
const html = readFileSync(resolve(publishDir, "index.html"), "utf8");

// ============================================================================
// 抽出ヘルパー（他のテストと同じ方式：関数本体を波括弧の対応で切り出してvm実行する）
// ============================================================================

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

// トップレベルの `const NAME = [...];`（配列リテラル）を、角括弧の対応で切り出す。
function extractArrayConst(name) {
  const marker = `const ${name} = [`;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`const ${name} not found`);
  const bracketOpen = start + marker.length - 1;
  let depth = 0;
  for (let i = bracketOpen; i < html.length; i += 1) {
    if (html[i] === "[") depth += 1;
    else if (html[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        const semi = html.indexOf(";", i);
        return html.slice(start, semi + 1);
      }
    }
  }
  throw new Error(`unbalanced brackets for ${name}`);
}

function runInSandbox(source, exposedNames) {
  const sandbox = {};
  const exposeLines = exposedNames.map((n) => `globalThis.__${n} = ${n};`).join("\n");
  new Script(`${source}\n${exposeLines}`, { filename: "onboarding-131-sandbox.js" }).runInNewContext(
    sandbox,
  );
  const result = {};
  for (const n of exposedNames) result[n] = sandbox[`__${n}`];
  return result;
}

// ============================================================================
// A. 名言バー：置き場所
// ============================================================================

test("#learningQuote は #streakPanel の内側にある", () => {
  const streakPanelIdx = html.indexOf('<section id="streakPanel"');
  const streakPanelHeadCloseIdx = html.indexOf("</div>", html.indexOf('class="streak-panel-head"'));
  const quoteIdx = html.indexOf('<figure id="learningQuote"');
  const streakSummaryIdx = html.indexOf('<div id="streakSummary"');
  assert.ok(streakPanelIdx >= 0, "#streakPanel が存在すること");
  assert.ok(quoteIdx > streakPanelHeadCloseIdx, "#learningQuote は streak-panel-head の後ろにあること");
  assert.ok(quoteIdx < streakSummaryIdx, "#learningQuote は streakSummary より前にあること");
});

test("#learningQuote は hero（見出し直下）には無い", () => {
  const heroIdx = html.indexOf('<section class="hero boot-in">');
  const heroCloseIdx = html.indexOf("</section>", heroIdx);
  const quoteIdx = html.indexOf('<figure id="learningQuote"');
  assert.ok(
    quoteIdx < heroIdx || quoteIdx > heroCloseIdx,
    "#learningQuote は hero セクションの外にあること",
  );
});

test("body.quiz-active による .learning-quote の強制非表示は無い（移設で不要になったため）", () => {
  assert.doesNotMatch(
    html,
    /body\.quiz-active[^{]*\.learning-quote[^{]*\{[^}]*display:\s*none/,
    "quiz-active時に.learning-quoteをdisplay:noneにするルールが残っていないこと",
  );
});

// ============================================================================
// A. currentLearningQuote(): 4時間バケットの純関数
// ============================================================================

function loadQuoteFns() {
  const source = [
    extractArrayConst("LEARNING_QUOTES"),
    extractFunction("pickQuoteIndex"),
    extractFunction("currentLearningQuote"),
  ].join("\n\n");
  return runInSandbox(source, ["LEARNING_QUOTES", "currentLearningQuote"]);
}

test("currentLearningQuote: 同じ4時間バケット内では同じ名言を返す", () => {
  const { currentLearningQuote } = loadQuoteFns();
  const base = Date.UTC(2026, 0, 1, 3, 0, 0); // 適当な基準時刻
  const a = currentLearningQuote(base);
  const b = currentLearningQuote(base + 60 * 1000); // 1分後（同じバケット）
  assert.ok(a && b, "名言オブジェクトを返すこと");
  assert.equal(a.text, b.text);
  assert.equal(a.author, b.author);
});

test("currentLearningQuote: バケットが変わるとindexが変わりうる（未定義を返さない）", () => {
  const { currentLearningQuote, LEARNING_QUOTES } = loadQuoteFns();
  assert.ok(LEARNING_QUOTES.length > 1, "テストの前提：名言が2件以上あること");
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  const seen = new Set();
  for (let i = 0; i < 24; i += 1) {
    const quote = currentLearningQuote(i * FOUR_HOURS);
    assert.ok(quote, `バケット${i}で名言がundefinedにならないこと`);
    assert.ok(LEARNING_QUOTES.includes(quote), "LEARNING_QUOTES の要素であること");
    seen.add(quote.text);
  }
  assert.ok(seen.size > 1, "24バケットも回せばindexが変わっている（常に同じ名言に固定されていない）");
});

// ============================================================================
// A. #quizResultQuote: 結果画面にだけ出す名言
// ============================================================================

test("#quizResultQuote は #quizCard 内、#quizNextHint の後ろにあり、初期状態でhidden", () => {
  const cardIdx = html.indexOf('<div id="quizCard"');
  const cardCloseIdx = html.indexOf('<div class="actions quiz-actions">');
  const hintIdx = html.indexOf('<p id="quizNextHint"');
  const quoteMatch = html.match(/<p id="quizResultQuote"[^>]*>/);
  assert.ok(quoteMatch, "#quizResultQuote が存在すること");
  const quoteIdx = quoteMatch.index;
  assert.ok(quoteIdx > cardIdx && quoteIdx < cardCloseIdx, "#quizCard の内側にあること");
  assert.ok(quoteIdx > hintIdx, "#quizNextHint より後ろにあること");
  assert.match(quoteMatch[0], /\bhidden\b/, "初期状態はhiddenであること");
});

test("#quizResultQuote への書き込みは renderReviewResult() の1か所だけ", () => {
  const matches = html.match(/quizResultQuote\.textContent/g) || [];
  assert.equal(matches.length, 1, "quizResultQuote.textContent への代入が複数箇所にある");
  assert.match(
    extractFunction("renderReviewResult"),
    /currentLearningQuote\(\)/,
    "結果画面がcurrentLearningQuote()を使っていること",
  );
});

// ----------------------------------------------------------------------------
// A追補: updateQuizControls() の挙動として #quizResultQuote.hidden を固定する
// （review-followups.test.mjs の controlsSandbox() と同じ流儀でvmに載せる）
// ----------------------------------------------------------------------------

function makeControlsEl() {
  const classes = new Set();
  const attrs = {};
  return {
    hidden: false,
    textContent: "",
    classList: {
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    },
    get title() {
      return attrs.title;
    },
    set title(v) {
      attrs.title = String(v);
    },
    setAttribute: (k, v) => {
      attrs[k] = String(v);
    },
    removeAttribute: (k) => {
      delete attrs[k];
    },
    dataset: {},
  };
}

function quizControlsSandbox() {
  const names = [
    "quizSetup", "startQuizButton", "difficultQuizButton", "easyQuizButton", "contextQuizButton",
    "startFlashcardButton", "generalReviewButton", "nextQuizButton", "quizNextHint", "dontKnowButton",
    "quizResultQuote", "exitReviewButton", "exitQuizButton", "quizKeyboardHint", "quizSpeakButton",
  ];
  const elements = {};
  for (const n of names) elements[n] = makeControlsEl();
  const bodyEl = makeControlsEl();
  const sandbox = {
    elements,
    document: { body: bodyEl },
    // speechSynthesis無し → canSpeakは常にfalse。currentQuiz.answerを用意せずに済む。
    window: {},
  };
  const pieces = [
    "let reviewSession = null;",
    "let flashcardSession = null;",
    "let currentQuiz = null;",
    "let quizStarted = false;",
    "let reviewResult = null;",
    "function syncQuizTimer() {}",
    "function keyboardHintsEnabled() { return false; }",
    "function autoNextEnabled() { return false; }",
    "function autoNextDelay() { return 3000; }",
    extractFunction("updateQuizControls"),
    "globalThis.__c = {" +
      " set: (o) => { reviewSession = o.reviewSession ?? null; flashcardSession = o.flashcardSession ?? null;" +
      "   currentQuiz = o.currentQuiz ?? null; quizStarted = Boolean(o.quizStarted); reviewResult = o.reviewResult ?? null; }," +
      " run: updateQuizControls };",
  ];
  new Script(pieces.join("\n\n"), { filename: "onboarding-131-controls.js" }).runInNewContext(sandbox);
  return { c: sandbox.__c, el: elements };
}

test("quizResultQuote.hidden: 通常出題中は隠す", () => {
  const { c, el } = quizControlsSandbox();
  c.set({ quizStarted: true, currentQuiz: { answered: false, contextPending: false } });
  c.run();
  assert.equal(el.quizResultQuote.hidden, true);
});

test("quizResultQuote.hidden: 復習出題中は隠す", () => {
  const { c, el } = quizControlsSandbox();
  c.set({ reviewSession: { queue: [{}] }, currentQuiz: { answered: false, contextPending: false } });
  c.run();
  assert.equal(el.quizResultQuote.hidden, true);
});

test("quizResultQuote.hidden: フラッシュカード中は隠す", () => {
  const { c, el } = quizControlsSandbox();
  c.set({ flashcardSession: { index: 0 } });
  c.run();
  assert.equal(el.quizResultQuote.hidden, true);
});

test("quizResultQuote.hidden: 結果画面（reviewResultあり・reviewSessionなし）では出す", () => {
  const { c, el } = quizControlsSandbox();
  c.set({ reviewResult: { total: 5, missedCount: 0 } });
  c.run();
  assert.equal(el.quizResultQuote.hidden, false);
});

test("quizResultQuote.hidden: やめた後の開始画面では隠す", () => {
  const { c, el } = quizControlsSandbox();
  c.set({});
  c.run();
  assert.equal(el.quizResultQuote.hidden, true);
});

// ============================================================================
// B. initialStepId(): 起動時の初期タブ
// ============================================================================

function loadInitialStepId() {
  const source = [
    html.slice(html.indexOf("const STEP_IDS ="), html.indexOf(";", html.indexOf("const STEP_IDS =")) + 1),
    extractFunction("initialStepId"),
  ].join("\n\n");
  return runInSandbox(source, ["initialStepId"]).initialStepId;
}

test("initialStepId: 保存が無く単語も無ければ import", () => {
  assert.equal(loadInitialStepId()(null, 0), "import");
});

test("initialStepId: 保存が無く単語があれば quiz", () => {
  assert.equal(loadInitialStepId()(null, 5), "quiz");
});

test("initialStepId: 保存があればそれを優先する（単語があっても上書きしない）", () => {
  assert.equal(loadInitialStepId()("settings", 5), "settings");
});

test("initialStepId: 保存が不正な値なら import（既存のSTEP_IDSフォールバックどおり）", () => {
  assert.equal(loadInitialStepId()("bogus", 5), "import");
});

test("initStepTabs は appState.words.length を見て initialStepId を呼ぶ", () => {
  const start = html.indexOf("function initStepTabs()");
  const body = extractFunction("initStepTabs");
  assert.match(
    body,
    /initialStepId\(saved,\s*appState\.words\.length\)/,
    "initStepTabs が initialStepId(saved, appState.words.length) を使っていること",
  );
  assert.ok(start > 0);
});

test("appState は initStepTabs() より前に読み込まれている", () => {
  const appStateIdx = html.indexOf("let appState = loadState();");
  const callIdx = html.indexOf("initStepTabs();");
  assert.ok(appStateIdx >= 0, "let appState = loadState(); が見つかること");
  assert.ok(callIdx > 0, "initStepTabs() の起動呼び出しが見つかること");
  assert.ok(appStateIdx < callIdx, "appStateの読み込みがinitStepTabs()の呼び出しより前にあること");
});

// ----------------------------------------------------------------------------
// B追補: promoteInitialStepAfterRecovery()
//
// initStepTabs() は起動処理の早い段階で走るため、そのときの appState.words.length は
// まだ暫定値のことがある（recoverPersisted() の中で IndexedDB のクライアントID採用や
// 同期の接続によって appState が丸ごと差し替わるため）。復元が確定した後にもう一度、
// 「タブをまだ一度も触っていない・importタブのまま・単語は実はある」の3条件がそろった
// ときだけ quiz へ進める純関数を、実際に呼び出すコードとあわせて固定する。
// ----------------------------------------------------------------------------

function promoteSandbox({ savedStep = null, activeStepId, wordCount }) {
  const sandbox = {
    localStorage: {
      getItem: (key) => {
        assert.equal(key, "wordsnap-active-step", "ACTIVE_STEP_KEYを読むこと");
        return savedStep;
      },
    },
    appState: { words: new Array(wordCount).fill(0) },
  };
  const pieces = [
    'const ACTIVE_STEP_KEY = "wordsnap-active-step";',
    `let activeStepId = ${JSON.stringify(activeStepId)};`,
    // vmの別レルムで作ったオブジェクトをそのまま外へ返すと assert.deepEqual が
    // 「構造は同じだが同一realmでない」で失敗するため、JSON文字列にして渡す。
    "globalThis.__calls = [];",
    "function setActiveStep(id, options) { globalThis.__calls.push(JSON.stringify([id, options])); }",
    extractFunction("promoteInitialStepAfterRecovery"),
    "globalThis.__run = promoteInitialStepAfterRecovery;",
  ];
  new Script(pieces.join("\n\n"), { filename: "onboarding-131-promote.js" }).runInNewContext(sandbox);
  sandbox.__run();
  // sandbox.__calls はvmレルムのArrayなので、そのまま .map すると結果もvmレルムの
  // Arrayになり assert.deepEqual が「構造は同じだが同一realmでない」で落ちる。
  // スプレッドで先に外のレルムへコピーしてから map する。
  return [...sandbox.__calls].map((s) => JSON.parse(s));
}

test("promoteInitialStepAfterRecovery: 保存なし・importのまま・単語ありなら quiz へ切り替える", () => {
  const calls = promoteSandbox({ savedStep: null, activeStepId: "import", wordCount: 3 });
  assert.deepEqual(calls, [["quiz", { persist: false, sound: false }]]);
});

test("promoteInitialStepAfterRecovery: 保存があれば何もしない（利用者の選択を上書きしない）", () => {
  const calls = promoteSandbox({ savedStep: "import", activeStepId: "import", wordCount: 3 });
  assert.deepEqual(calls, []);
});

test("promoteInitialStepAfterRecovery: 既に import 以外のタブへ移っていれば何もしない", () => {
  const calls = promoteSandbox({ savedStep: null, activeStepId: "settings", wordCount: 3 });
  assert.deepEqual(calls, []);
});

test("promoteInitialStepAfterRecovery: 単語が0語なら何もしない", () => {
  const calls = promoteSandbox({ savedStep: null, activeStepId: "import", wordCount: 0 });
  assert.deepEqual(calls, []);
});

test("promoteInitialStepAfterRecovery は recoverPersisted() の then/catch 両方から、maybeShowInitialTutorial() より前に呼ばれる", () => {
  const start = html.indexOf("recoverPersisted()\n  .then(");
  const end = html.indexOf("window.setTimeout(startWordsnapSync, 4000);", start);
  assert.ok(start >= 0 && end > start, "起動時の recoverPersisted() 呼び出しが見つかること");
  const block = html.slice(start, end);
  const thenIdx = block.indexOf(".then(");
  const catchIdx = block.indexOf(".catch(");
  assert.ok(thenIdx >= 0 && catchIdx > thenIdx, "then→catch の順で構成されていること");
  const thenBody = block.slice(thenIdx, catchIdx);
  const catchBody = block.slice(catchIdx);
  for (const [label, body] of [["then", thenBody], ["catch", catchBody]]) {
    const promoteIdx = body.indexOf("promoteInitialStepAfterRecovery()");
    const tutorialIdx = body.indexOf("maybeShowInitialTutorial()");
    assert.ok(promoteIdx >= 0, `${label}内に promoteInitialStepAfterRecovery() が無い`);
    assert.ok(tutorialIdx >= 0, `${label}内に maybeShowInitialTutorial() が無い`);
    assert.ok(promoteIdx < tutorialIdx, `${label}内で promoteInitialStepAfterRecovery() が maybeShowInitialTutorial() より前であること`);
  }
});

test("initStepTabs() の起動呼び出しは try/catch で包まれ、失敗時は import へ倒す", () => {
  const idx = html.indexOf("try {\n  initStepTabs();\n} catch {");
  const end = html.indexOf("\ninitLearningQuote();", idx);
  assert.ok(idx >= 0, "initStepTabs() の try/catch が見つかること");
  assert.ok(end > idx, "try/catch ブロックの終端（initLearningQuote()の前）が見つかること");
  const catchBlock = html.slice(idx, end);
  assert.match(catchBlock, /setActiveStep\("import",\s*\{\s*persist:\s*false,\s*sound:\s*false\s*\}\)/);
});

// ============================================================================
// C. 設定を3つのグループに分ける
// ============================================================================

const EXPECTED_SETTINGS_ORDER = [
  "quiz", "sound", "appearance", "learning-log",
  "sync", "backup", "storage",
  "ai-keys", "guide", "feedback", "danger",
];

test("data-settings-section の出現順が仕様どおり（学習→データ→上級・その他）", () => {
  // JS側にも data-settings-section="sync" というセレクタ文字列リテラルが出てくるため、
  // .settings-accordion の中身だけに絞る（HTML属性としての出現だけを数える）。
  const accordionStart = html.indexOf('<div class="settings-accordion">');
  const accordionEnd = html.indexOf("</details>\n        </div>", accordionStart);
  const inner = html.slice(accordionStart, accordionEnd);
  const order = [...inner.matchAll(/data-settings-section="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, EXPECTED_SETTINGS_ORDER);
});

test("見出し3つ（学習・データ・上級その他）が .settings-accordion の直下に、この順である", () => {
  const accordionStart = html.indexOf('<div class="settings-accordion">');
  const accordionEnd = html.indexOf("</details>\n        </div>", accordionStart);
  assert.ok(accordionStart >= 0 && accordionEnd > accordionStart, ".settings-accordion の範囲が見つかること");
  const inner = html.slice(accordionStart, accordionEnd);
  const headings = [...inner.matchAll(/<h3 class="settings-group-title">([^<]+)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(headings, ["学習", "データ", "上級・その他"]);
  // 兄弟要素であること（ラッパーで包まない）＝ .settings-accordion 直後の子として現れる
  assert.match(inner, /<div class="settings-accordion">\s*<h3 class="settings-group-title">学習<\/h3>/);
});

test("initSettingsAccordionState は .settings-accordion > .settings-section を見る（見出しをアコーディオン扱いしない）", () => {
  const body = extractFunction("initSettingsAccordionState");
  assert.match(body, /document\.querySelectorAll\("\.settings-accordion > \.settings-section"\)/);
  assert.match(body, /dataset\.settingsSection === "quiz"/, "初回既定はquizだけ開くこと");
});

// ============================================================================
// D. サンプル単語帳: キー名の統一と出典表示
// ============================================================================

const NEW_SAMPLE_KEYS = ["jhs1500", "exam1500", "eiken1500", "soukei1500", "toeic1500", "ielts1500"];
const OLD_SAMPLE_KEYS = ["jhs100", "exam300", "eiken100", "soukei100", "toeic100", "ielts100"];

test("data-sample の6キーは SAMPLE_SETS のキーと過不足なく一致する", () => {
  const chipKeys = [...html.matchAll(/data-sample="([^"]+)"/g)].map((m) => m[1]);
  const setsBlock = html.slice(
    html.indexOf("const SAMPLE_SETS = {"),
    html.indexOf("\n};", html.indexOf("const SAMPLE_SETS = {")),
  );
  const setKeys = [...setsBlock.matchAll(/\n\s*([a-zA-Z0-9]+):\s*\{\s*label:/g)].map((m) => m[1]);
  assert.deepEqual([...chipKeys].sort(), [...NEW_SAMPLE_KEYS].sort(), "data-sample の集合");
  assert.deepEqual([...setKeys].sort(), [...NEW_SAMPLE_KEYS].sort(), "SAMPLE_SETS のキーの集合");
  for (const key of chipKeys) {
    assert.ok(setKeys.includes(key), `data-sample="${key}" に対応する SAMPLE_SETS が無い`);
  }
  for (const key of setKeys) {
    assert.ok(chipKeys.includes(key), `SAMPLE_SETS["${key}"] に対応する data-sample チップが無い`);
  }
});

test("旧キー名（jhs100等）は index.html にも check-release.mjs にも残っていない", () => {
  for (const oldKey of OLD_SAMPLE_KEYS) {
    assert.doesNotMatch(html, new RegExp(`["'\`]${oldKey}["'\`]|data-sample="${oldKey}"`));
  }
  const checkReleaseSrc = readFileSync(resolve(scriptDir, "check-release.mjs"), "utf8");
  for (const oldKey of OLD_SAMPLE_KEYS) {
    assert.ok(!checkReleaseSrc.includes(oldKey), `check-release.mjs に旧キー ${oldKey} が残っている`);
  }
});

test("サンプル単語帳の出典注記が .sample-chips の直後にある", () => {
  const chipsCloseIdx = html.indexOf(
    "</div>",
    html.indexOf('<div class="sample-chips"'),
  );
  const noteMatch = html.match(/<p class="settings-desc sample-source-note">([^<]*)<\/p>/);
  assert.ok(noteMatch, "出典注記の要素が存在すること");
  assert.ok(noteMatch.index > chipsCloseIdx, ".sample-chips の後ろにあること");
  assert.match(noteMatch[1], /独自に選定/);
  assert.match(noteMatch[1], /転載ではありません/);
});

// ============================================================================
// E. robots.txt / sitemap.xml
// ============================================================================

test("publish/robots.txt が存在し、Disallow: /api/ と Sitemap 行を含む", () => {
  const path = resolve(publishDir, "robots.txt");
  assert.ok(existsSync(path), "publish/robots.txt が存在すること");
  const body = readFileSync(path, "utf8");
  assert.match(body, /^Disallow: \/api\/$/m, "Disallow: /api/ を含むこと");
  assert.match(body, /^Sitemap: https:\/\/wordbank\.pages\.dev\/sitemap\.xml$/m);
});

test("publish/sitemap.xml が存在し、本番URLを含む", () => {
  const path = resolve(publishDir, "sitemap.xml");
  assert.ok(existsSync(path), "publish/sitemap.xml が存在すること");
  const body = readFileSync(path, "utf8");
  assert.match(body, /<loc>https:\/\/wordbank\.pages\.dev\/<\/loc>/);
});

test("robots.txt / sitemap.xml はサービスワーカーのキャッシュ対象に含めていない", () => {
  const sw = readFileSync(resolve(publishDir, "wordsnap-sw.js"), "utf8");
  assert.ok(!sw.includes("robots.txt"), "wordsnap-sw.js が robots.txt をキャッシュ対象にしていないこと");
  assert.ok(!sw.includes("sitemap.xml"), "wordsnap-sw.js が sitemap.xml をキャッシュ対象にしていないこと");
});

// ============================================================================
// F. フォント: Inter は指定しない（外部フォントを読み込まない方針のため）
// ============================================================================

test("font-family に Inter を指定していない", () => {
  const fontBlock = html.slice(html.indexOf("--font:"), html.indexOf(";", html.indexOf("--font:")) + 1);
  assert.doesNotMatch(fontBlock, /Inter/);
});
