// 外部レビュー（2026-09）への対応 7件（1.0.107）を、実コードのまま固定する。
//
// 1. 手順2の空状態: 静的HTMLと renderCandidates() の案内が同じで、手順1へ戻るボタンがある
// 2. 解答前の「次の問題」は弱い見た目（is-skip）＋理由の title。解答後・復習完了時は主ボタン
// 3. 正答率は「累計」と明記
// 4. OGP / twitter:card / canonical（個人キー付きURLを載せない）
// 5. 匿名統計の説明に送信先と内容
// 6. 学習カレンダーのまとまりに月入りの名前
// 7. 「個人リンクをコピー」は秘密を扱う操作の見た目（secondary danger）
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

// ============================================================================
// 1. 手順2の空状態
// ============================================================================
test("手順2の空状態: 静的HTMLの初期内容と renderCandidates() の案内が同じ", () => {
  const m = html.match(/<div id="candidateList" class="word-list empty empty-guide">([\s\S]*?)<\/div>/);
  assert.ok(m, "静的な空状態の案内が無い");
  const staticInner = m[1].replace(/\s*\n\s*/g, "");
  const sandbox = {};
  new Script(`${extractConst("CANDIDATE_EMPTY_GUIDE_HTML")}\nglobalThis.__g = CANDIDATE_EMPTY_GUIDE_HTML;`, {
    filename: "review-followups-guide.js",
  }).runInNewContext(sandbox);
  assert.equal(staticInner, sandbox.__g, "JSが動く前と後で案内が食い違う");
  assert.match(sandbox.__g, /data-goto-step="import"/, "手順1へ戻るボタンが無い");
  assert.match(extractFunction("renderCandidates"), /innerHTML = CANDIDATE_EMPTY_GUIDE_HTML;/);
  // 戻るボタンは文書全体に付けた委譲ハンドラで動く（静的HTML側のボタンも同じ経路）
  assert.match(html, /event\.target\.closest\("\[data-goto-step\]"\)/);
  assert.doesNotMatch(html, /候補はまだありません/, "旧い1行だけの空状態が残っている");
});

// ============================================================================
// 2. 解答前の「次の問題」
// ============================================================================
function makeEl() {
  const classes = new Set();
  const attrs = {};
  return {
    hidden: false,
    textContent: "",
    disabled: false,
    classList: {
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
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
    getAttribute: (k) => (Object.hasOwn(attrs, k) ? attrs[k] : null),
    removeAttribute: (k) => {
      delete attrs[k];
    },
    hasAttribute: (k) => Object.hasOwn(attrs, k),
    style: {},
    dataset: {},
  };
}

function controlsSandbox({ withSpeechSynthesis = true } = {}) {
  const names = [
    "quizSetup", "startQuizButton", "difficultQuizButton", "easyQuizButton", "contextQuizButton",
    "startFlashcardButton", "generalReviewButton", "nextQuizButton", "quizNextHint", "dontKnowButton",
    "exitReviewButton", "exitQuizButton", "quizKeyboardHint", "quizSpeakButton",
  ];
  const elements = {};
  for (const n of names) elements[n] = makeEl();
  const bodyEl = makeEl();
  const sandbox = {
    elements,
    document: { body: bodyEl },
    // 4択クイズカードの手動読み上げボタン（updateQuizControls内で "speechSynthesis" in window を見る）
    window: withSpeechSynthesis ? { speechSynthesis: {} } : {},
  };
  const pieces = [
    "let reviewSession = null;",
    "let flashcardSession = null;",
    "let currentQuiz = null;",
    "let quizStarted = false;",
    "let reviewResult = null;",
    "let __timer = null;",
    "function syncQuizTimer(active) { __timer = active; }",
    "function keyboardHintsEnabled() { return false; }",
    "function autoNextEnabled() { return false; }",
    "function autoNextDelay() { return 3000; }",
    extractFunction("updateQuizControls"),
    "globalThis.__c = {" +
      " set: (o) => { reviewSession = o.reviewSession ?? null; flashcardSession = o.flashcardSession ?? null;" +
      "   currentQuiz = o.currentQuiz ?? null; quizStarted = Boolean(o.quizStarted); reviewResult = o.reviewResult ?? null; }," +
      " run: updateQuizControls, timer: () => __timer };",
  ];
  new Script(pieces.join("\n\n"), { filename: "review-followups-controls.js" }).runInNewContext(sandbox);
  return { c: sandbox.__c, el: elements };
}

test("次の問題: おまかせで解答前は is-skip＋理由の title、解答後は主ボタンに戻る", () => {
  const { c, el } = controlsSandbox();
  c.set({
    quizStarted: true,
    currentQuiz: { answered: false, choices: [1, 2, 3, 4], answer: { term: "apple" } },
  });
  c.run();
  assert.equal(el.nextQuizButton.hidden, false, "飛ばす用途は残す（隠さない）");
  assert.equal(el.nextQuizButton.classList.contains("is-skip"), true);
  assert.match(el.nextQuizButton.title, /採点されません/);
  c.set({
    quizStarted: true,
    currentQuiz: { answered: true, choices: [1, 2, 3, 4], answer: { term: "apple" } },
  });
  c.run();
  assert.equal(el.nextQuizButton.classList.contains("is-skip"), false);
  assert.equal(el.nextQuizButton.hasAttribute("title"), false, "解答後は理由を消す");
});

test("次の問題: 復習の完了時（問題なし・キュー空）は主ボタンのまま。生成待ちは従来どおり隠す", () => {
  const { c, el } = controlsSandbox();
  c.set({ reviewSession: { queue: [] }, currentQuiz: null });
  c.run();
  assert.equal(el.nextQuizButton.hidden, false);
  assert.equal(el.nextQuizButton.classList.contains("is-skip"), false, "結果を出すボタンを弱めない");
  c.set({ reviewSession: { queue: ["a"] }, currentQuiz: { answered: false, contextPending: true, choices: [] } });
  c.run();
  assert.equal(el.nextQuizButton.hidden, true);
  assert.equal(el.nextQuizButton.classList.contains("is-skip"), false);
});

test("次の問題: 復習中の解答前も弱める（同じ語を作り直すだけの操作）", () => {
  const { c, el } = controlsSandbox();
  c.set({
    reviewSession: { queue: ["a", "b"] },
    currentQuiz: { answered: false, choices: [1, 2, 3, 4], answer: { term: "apple" } },
  });
  c.run();
  assert.equal(el.nextQuizButton.classList.contains("is-skip"), true);
});

test("次の問題: is-skip の見た目は選択肢より弱い（透明背景）", () => {
  const rule = html.match(/#nextQuizButton\.is-skip \{[^}]*\}/)?.[0];
  assert.ok(rule);
  assert.match(rule, /background: transparent;/);
  assert.match(rule, /color: var\(--ink\);/);
  assert.match(rule, /border-color: var\(--line\);/);
  // ライト・ダーク両方でトークンが定義されている
  assert.ok((html.match(/^  --ink: /gm) || []).length >= 2);
  assert.ok((html.match(/^  --line: /gm) || []).length >= 2);
});

// ============================================================================
// 1.0.129 D: 4択クイズカードの手動読み上げボタン
// ============================================================================
test("読み上げボタン: 英→日は解答前から表示する", () => {
  const { c, el } = controlsSandbox();
  c.set({
    quizStarted: true,
    currentQuiz: { answered: false, choices: [1, 2, 3, 4], answer: { term: "apple" } },
  });
  c.run();
  assert.equal(el.quizSpeakButton.hidden, false);
});

test("読み上げボタン: 日→英は解答前は隠す（答えが漏れるため）", () => {
  const { c, el } = controlsSandbox();
  c.set({
    quizStarted: true,
    currentQuiz: { answered: false, reverse: true, choices: [1, 2, 3, 4] },
  });
  c.run();
  assert.equal(el.quizSpeakButton.hidden, true);
});

test("読み上げボタン: 日→英でも解答後は表示する", () => {
  const { c, el } = controlsSandbox();
  c.set({
    quizStarted: true,
    currentQuiz: { answered: true, reverse: true, choices: [1, 2, 3, 4], answer: { term: "apple" } },
  });
  c.run();
  assert.equal(el.quizSpeakButton.hidden, false);
});

test("読み上げボタン: フラッシュカードでは隠す（専用ボタンが別にある）", () => {
  const { c, el } = controlsSandbox();
  c.set({
    flashcardSession: { index: 0 },
    currentQuiz: { flashcard: true, answered: false },
  });
  c.run();
  assert.equal(el.quizSpeakButton.hidden, true);
});

test("読み上げボタン: 例文モードは解答前は隠す（空所の答えが漏れるため）", () => {
  const { c, el } = controlsSandbox();
  c.set({
    quizStarted: true,
    currentQuiz: { answered: false, context: true, choices: [1, 2, 3, 4] },
  });
  c.run();
  assert.equal(el.quizSpeakButton.hidden, true);
});

test("読み上げボタン: 例文生成待ち（contextPending）は隠す", () => {
  const { c, el } = controlsSandbox();
  c.set({
    quizStarted: true,
    currentQuiz: { answered: false, contextPending: true, choices: [] },
  });
  c.run();
  assert.equal(el.quizSpeakButton.hidden, true);
});

test("読み上げボタン: window.speechSynthesisが無い端末では隠す", () => {
  const { c, el } = controlsSandbox({ withSpeechSynthesis: false });
  c.set({
    quizStarted: true,
    currentQuiz: { answered: false, choices: [1, 2, 3, 4], answer: { term: "apple" } },
  });
  c.run();
  assert.equal(el.quizSpeakButton.hidden, true);
});

test("読み上げボタン: 表示するたびaria-labelとdata-speech-termを出題単語へ貼り直す", () => {
  const { c, el } = controlsSandbox();
  // resetSpeechButton（speakWord完了時）が直前に読んだ単語名でaria-labelを上書きするため、
  // 次の問題に進んだらここで貼り直さないと古い単語名が残ったままになる。
  el.quizSpeakButton.setAttribute("aria-label", "banana の発音を再生しました。");
  el.quizSpeakButton.dataset.speechTerm = "banana";
  c.set({
    quizStarted: true,
    currentQuiz: { answered: false, choices: [1, 2, 3, 4], answer: { term: "apple" } },
  });
  c.run();
  assert.equal(el.quizSpeakButton.dataset.speechTerm, "apple");
  assert.equal(el.quizSpeakButton.getAttribute("aria-label"), "apple の発音を聞く");
});

// ============================================================================
// 3. 正答率（累計）
// ============================================================================
test("正答率: 表示に「累計」と入り、選んでいる単語帳の全解答から計算する", () => {
  assert.match(html, /<span id="accuracy" class="pill" title="[^"]*全解答[^"]*">正答率（累計） 0%<\/span>/);
  const pieces = [
    "const elements = { accuracy: { textContent: '' } };",
    "const quizSelectedDeckWords = () => [" +
      " { stats: { correct: 2, wrong: 1 } }, { stats: { correct: 0, wrong: 0 } } ];",
    extractFunction("renderAccuracy"),
    "renderAccuracy(); globalThis.__t = elements.accuracy.textContent;",
  ];
  const sandbox = {};
  new Script(pieces.join("\n\n"), { filename: "review-followups-accuracy.js" }).runInNewContext(sandbox);
  assert.equal(sandbox.__t, "正答率（累計） 67%");
});

// ============================================================================
// 4. OGP
// ============================================================================
test("OGP: 本番の素のURLと既存アイコンを指し、説明文は description と同じ", () => {
  const meta = (attr, key) => html.match(new RegExp(`<meta\\s+${attr}="${key}"\\s+content="([^"]*)"`))?.[1]
    ?? html.match(new RegExp(`<meta\\s*\\n\\s*${attr}="${key}"\\s*\\n\\s*content="([^"]*)"`))?.[1];
  const description = meta("name", "description");
  assert.ok(description);
  assert.equal(meta("property", "og:description"), description);
  assert.equal(meta("property", "og:title"), "WordBank");
  assert.equal(meta("property", "og:url"), "https://wordbank.pages.dev/");
  assert.equal(meta("name", "twitter:card"), "summary");
  const image = meta("property", "og:image");
  assert.match(image, /^https:\/\/wordbank\.pages\.dev\/assets\/[A-Za-z0-9._-]+\.png$/);
  assert.ok(existsSync(join(here, "..", "publish", image.replace("https://wordbank.pages.dev/", ""))), "画像が配信物に無い");
  assert.match(html, /<link rel="canonical" href="https:\/\/wordbank\.pages\.dev\/" \/>/);
  assert.equal(meta("property", "og:type"), "website");
  assert.equal(meta("property", "og:site_name"), "WordBank");
  assert.equal(meta("property", "og:image:width"), "512");
  assert.equal(meta("property", "og:image:height"), "512");
  assert.equal(meta("property", "og:locale"), "ja_JP");
  // 個人キー付きのURL（?w=）を載せない
  for (const key of ["og:url", "og:image"]) assert.doesNotMatch(meta("property", key), /[?#]/);
  // 参照元を送らない指定は残す（release check も見ている）
  assert.match(html, /<meta name="referrer" content="no-referrer" \/>/);
});

// ============================================================================
// 5. 匿名統計の説明
// ============================================================================
test("匿名統計の説明: 送信先（/api/telemetry）と内容・含まないものを明記し、実装と一致する", () => {
  const desc = html.match(/<p class="settings-desc">品質改善のため[^<]*<\/p>/)?.[0];
  assert.ok(desc, "説明文が見つからない");
  assert.match(desc, /\/api\/telemetry/);
  assert.match(desc, /WordBank 自身のサーバー/);
  // 送るもの・伏せるもの・送らないものを、実装どおりの強さで書く。
  // エラー時はエラー文とスタックを（伏せ字処理のうえ）送るので、「エラー文」と「伏せる」を明記し、
  // 「単語の内容は含まれない」のような実装より強い断定はしない（データそのものは送らない、が正しい）。
  for (const word of ["何回使ったか", "エラーの文と発生位置", "伏せてから送ります", "バージョン", "単語や成績のデータそのものは送りません", "個人キー", "引き継ぎコード", "外部の解析サービスには送りません"]) {
    assert.ok(desc.includes(word), `説明に「${word}」が無い`);
  }
  assert.doesNotMatch(desc, /単語の内容[^。]*含まれません/, "エラー文まで保証できない断定を書かない");
  // 実装: エラーは window.onerror から message と stack（伏せ字処理・長さ制限あり）を送る
  const capture = extractFunction("captureError");
  assert.match(capture, /name: safeMessage/);
  assert.match(capture, /detail: sanitize\(stack \|\|/);
  // 実装: 送信先は同一オリジンの /api/telemetry だけ（sendBeacon と fetch）
  const sends = html.match(/"\/api\/telemetry"/g) || [];
  assert.ok(sends.length >= 2, "送信先の記述が想定より少ない");
  assert.doesNotMatch(html, /https?:\/\/[^"'\s]*telemetry/, "外部の解析サービスへ送っている");
  // エラーの本文はURLのクエリ（?w=）と秘密の形を伏せてから送る
  assert.match(extractFunction("sanitize"), /\[redacted\]/);
});

// ============================================================================
// 6. 学習カレンダー
// ============================================================================
test("学習カレンダー: 日付ボタンのまとまりに月入りの名前が付く", () => {
  assert.match(html, /<div id="streakCalendar" class="streak-cal" role="group" aria-label="学習カレンダー"><\/div>/);
  const body = extractFunction("renderStreakCalendar");
  assert.match(body, /grid\.setAttribute\("aria-label", `\$\{year\}年\$\{month \+ 1\}月の学習カレンダー/);
  // 日付のボタンには従来どおり日付と回数の名前がある
  assert.match(body, /aria-label="\$\{escapeHtml\(label\)\}"/);
});

// ============================================================================
// 7. 個人リンクをコピー
// ============================================================================
test("個人リンクをコピー: 秘密を扱う操作の見た目で、渡してはいけないことを title で伝える", () => {
  const m = html.match(/<button id="syncCopyLinkButton"([^>]*)>個人リンクをコピー<\/button>/);
  assert.ok(m);
  assert.match(m[1], /class="secondary danger"/);
  assert.match(m[1], /title="[^"]*個人キー入り[^"]*自分以外には渡さないでください[^"]*"/);
  // 同じ並びの「今すぐ読み込む」（安全な操作）は主ボタン相当のままにしない＝secondary のまま
  assert.match(html, /<button id="syncPullButton" class="secondary"/);
});
