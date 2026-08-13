// APIキーの有効性表示（1.0.88）を、公開HTML内の実コードから抽出して検査する。
// 流儀は scripts/context-quiz.test.mjs / scripts/ai-secret-sync.test.mjs と同じ。
//
// この機能で一番まずい失敗は「実際には使えないキーを『有効』と見せること」と、
// 逆に「使えるキーを『無効』と決めつけること」。特に次の2つを取り違えない：
//   - 通信できなかった／タイムアウトした（キーは正しいかもしれない）
//   - 無料枠の上限（429。認証は通っている＝キー自体は有効）
// あわせて、キーそのものを保存・送信しないことも固定する。
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

const TIMEOUT_MS = Number(html.match(/const AI_KEY_CHECK_TIMEOUT_MS = ([^;]+);/)[1].replace(/[^\d*]/g, "").split("*").reduce((a, b) => a * Number(b), 1) || 0);

// ---------- 応答の解釈（純粋関数） ----------

function buildInterpretSandbox() {
  const sandbox = {};
  new Script(
    [extractFunction("interpretAiKeyCheckResponse"), "globalThis.__i = { interpretAiKeyCheckResponse };"].join("\n\n"),
    { filename: "ai-key-check-interpret.js" },
  ).runInNewContext(sandbox);
  return sandbox.__i.interpretAiKeyCheckResponse;
}

test("応答の解釈: 2xx は有効", () => {
  const interpret = buildInterpretSandbox();
  for (const status of [200, 204]) {
    assert.equal(interpret(status).status, "valid", `HTTP ${status}`);
  }
});

test("応答の解釈: 400/401/403 はキーが受け付けられていない＝無効", () => {
  const interpret = buildInterpretSandbox();
  for (const status of [400, 401, 403]) {
    assert.equal(interpret(status).status, "invalid", `HTTP ${status}`);
  }
});

test("応答の解釈: 429 は無効にしない（認証は通っており、枠の上限にすぎない）", () => {
  const interpret = buildInterpretSandbox();
  const result = interpret(429);
  assert.equal(result.status, "limited", "上限を「キーが違う」と誤解させてはいけない");
  assert.notEqual(result.status, "invalid");
});

test("応答の解釈: 5xx など相手側の障害は「確認できなかった」であって無効ではない", () => {
  const interpret = buildInterpretSandbox();
  for (const status of [500, 502, 503]) {
    assert.equal(interpret(status).status, "error", `HTTP ${status}`);
    assert.notEqual(interpret(status).status, "invalid");
  }
});

// ---------- 表示文言 ----------

function buildViewSandbox() {
  const sandbox = {};
  new Script(
    [extractFunction("aiKeyStatusView"), "globalThis.__v = { aiKeyStatusView };"].join("\n\n"),
    { filename: "ai-key-check-view.js" },
  ).runInNewContext(sandbox);
  return sandbox.__v.aiKeyStatusView;
}

test("表示: 状態ごとに文言と印が変わり、色だけに頼らない", () => {
  const view = buildViewSandbox();
  assert.match(view("", null).text, /未設定/);
  assert.match(view("k", null).text, /未確認/);
  assert.match(view("k", { status: "checking" }).text, /確認中/);
  assert.match(view("k", { status: "valid" }).text, /有効/);
  assert.match(view("k", { status: "invalid", message: "だめ" }).text, /無効/);

  // 記号だけ・色だけで区別させない（同じ文言が使い回されていないこと）
  const texts = ["checking", "valid", "invalid", "limited", "error"].map(
    (status) => view("k", { status, message: "理由" }).text,
  );
  assert.equal(new Set(texts).size, texts.length, "状態ごとに文言が違うこと");
});

test("表示: 上限は「キー自体は有効」と伝える（無効と誤解させない）", () => {
  const view = buildViewSandbox();
  const text = view("k", { status: "limited", message: "いまは無料枠の上限に達しています" }).text;
  assert.match(text, /キー自体は有効/);
  assert.doesNotMatch(text, /無効/);
});

test("表示: 通信できなかった回を「無効」と出さない", () => {
  const view = buildViewSandbox();
  const text = view("k", { status: "error", message: "通信できませんでした" }).text;
  assert.doesNotMatch(text, /無効/);
  assert.match(text, /通信できませんでした/);
});

// ---------- 実際の問い合わせ ----------

function buildRequestSandbox(handler) {
  const pieces = [
    "const calls = [];",
    "async function fetch(url, init) { calls.push({ url, init }); return handler(url, init); }",
    extractFunction("interpretAiKeyCheckResponse"),
    // extractFunction は "function 名(" から切り出すため async が落ちる。付け直す。
    "async " + extractFunction("requestAiKeyCheck"),
    "globalThis.__r = { calls, requestAiKeyCheck };",
  ];
  const sandbox = { handler };
  new Script(pieces.join("\n\n"), { filename: "ai-key-check-request.js" }).runInNewContext(sandbox);
  return sandbox.__r;
}

test("問い合わせ: Gemini はモデル一覧をGETし、キーはヘッダーで送る（URLに載せない）", async () => {
  const r = buildRequestSandbox(() => ({ status: 200 }));
  const result = await r.requestAiKeyCheck("gemini", "AIza-secret", null);
  assert.equal(result.status, "valid");
  const call = r.calls[0];
  assert.match(call.url, /generativelanguage\.googleapis\.com/);
  assert.equal(call.init.method, "GET", "生成を呼ばない（無料枠の生成回数を使わない）");
  assert.equal(call.init.headers["x-goog-api-key"], "AIza-secret");
  assert.doesNotMatch(call.url, /AIza-secret/, "キーをURLに載せてはいけない（履歴やログに残る）");
});

test("問い合わせ: Groq はモデル一覧をGETし、キーはAuthorizationヘッダーで送る", async () => {
  const r = buildRequestSandbox(() => ({ status: 200 }));
  const result = await r.requestAiKeyCheck("groq", "gsk_secret", null);
  assert.equal(result.status, "valid");
  const call = r.calls[0];
  assert.match(call.url, /api\.groq\.com/);
  assert.match(call.url, /\/models$/, "チャット生成ではなく一覧を叩く");
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.headers.Authorization, "Bearer gsk_secret");
  assert.doesNotMatch(call.url, /gsk_secret/);
});

test("問い合わせ: どちらのサービスもWordBank自身のサーバーへは送らない", async () => {
  for (const id of ["gemini", "groq"]) {
    const r = buildRequestSandbox(() => ({ status: 200 }));
    await r.requestAiKeyCheck(id, "k", null);
    for (const call of r.calls) {
      assert.doesNotMatch(call.url, /\/api\//, `${id}: 自前のAPIへ送ってはいけない`);
    }
  }
});

test("問い合わせ: 未知のサービスは確認せず、無効とも言わない", async () => {
  const r = buildRequestSandbox(() => ({ status: 200 }));
  const result = await r.requestAiKeyCheck("unknown", "k", null);
  assert.equal(result.status, "error");
  assert.equal(r.calls.length, 0, "知らない相手へ問い合わせない");
});

test("設定: 確認は生成より短い時間で打ち切る（設定画面で長く待たせない）", () => {
  assert.ok(TIMEOUT_MS > 0, "AI_KEY_CHECK_TIMEOUT_MS が読めること");
  const extractTimeout = Number(
    html.match(/const AI_EXTRACT_TIMEOUT_MS = ([\d\s*]+);/)[1].split("*").reduce((a, b) => a * Number(b), 1),
  );
  assert.ok(TIMEOUT_MS < extractTimeout, "確認の待ち時間がAI抽出より長くならないこと");
});

// ---------- 配線 ----------

test("配線: キーを変えると判定が持ち越されない（指紋で引くようになっている）", () => {
  const body = extractFunction("renderAiKeyStatuses");
  assert.match(
    body,
    /aiKeyCheckResults\.get\(shortKeyFingerprint\(key\)\)/,
    "キーの指紋で判定を引いていない＝別のキーの結果を表示しうる",
  );
  assert.match(body, /key \?/, "キーが空なら判定を引かない（削除後に「有効」が残る）");
});

test("配線: 判定結果を保存しない（失効したキーを有効と表示し続けない）", () => {
  const source = html.slice(html.indexOf("const aiKeyCheckResults"), html.indexOf("function setAiKeysPersisted"));
  assert.doesNotMatch(source, /localStorage\.setItem/, "判定を端末に保存してはいけない");
  assert.doesNotMatch(source, /sessionStorage\.setItem/);
});

test("配線: 入力のたびには問い合わせず、確定操作でだけ確認する", () => {
  const body = extractFunction("renderAiKeyFields");
  // 同じ関数内にトグルの change ハンドラが先に出てくるため、キー入力欄のループだけを切り出す。
  const keyLoop = body.slice(
    body.indexOf('querySelectorAll(".ai-key")'),
    body.indexOf('querySelectorAll(".ai-check")'),
  );
  assert.ok(keyLoop.length > 0, "キー入力欄のループを切り出せていること");
  assert.match(keyLoop, /addEventListener\("input"/, "input を拾っていること");
  assert.match(keyLoop, /addEventListener\("change",[\s\S]{0,160}checkAiKey/, "入力を終えたら確認すること");

  // コメントに関数名が出てくるだけで誤検出しないよう、行コメントを落としてから見る。
  const stripComments = (text) => text.replace(/^\s*\/\/.*$/gm, "");
  const inputHandler = stripComments(
    keyLoop.slice(keyLoop.indexOf('addEventListener("input"'), keyLoop.indexOf('addEventListener("change"')),
  );
  assert.ok(inputHandler.trim().length > 0, "input ハンドラを切り出せていること");
  assert.match(inputHandler, /renderAiKeyStatuses\(\)/, "1文字ごとに表示は更新すること");
  assert.doesNotMatch(inputHandler, /checkAiKey/, "1文字ごとに問い合わせてはいけない");
});

test("配線: 削除すると、その場で表示も更新する（「有効」が残らない）", () => {
  const body = extractFunction("renderAiKeyFields");
  // 関数末尾にも renderAiKeyStatuses() があるので、クリアのハンドラ内に限って確かめる。
  const clearLoop = body.slice(body.indexOf('querySelectorAll(".ai-clear")'));
  const handler = clearLoop.slice(clearLoop.indexOf('setAiKey(id, "")'), clearLoop.indexOf("});"));
  assert.ok(handler.length > 0, "クリアのハンドラを切り出せていること");
  assert.match(handler, /renderAiKeyStatuses\(\)/, "削除の直後に表示を更新していない");
});

// ---------- 確認処理そのもの（通信失敗の扱い） ----------

function buildCheckSandbox(fetchImpl) {
  const pieces = [
    "const rendered = [];",
    "const keys = { gemini: 'AIza-key' };",
    "function getAiKey(id) { return keys[id] || ''; }",
    "function renderAiKeyStatuses() { rendered.push(1); }",
    "const aiKeyCheckResults = new Map();",
    "const aiKeyCheckInflight = new Map();",
    "const AI_KEY_CHECK_TIMEOUT_MS = 50;",
    "function setTimeout(fn, ms) { return 0; }",
    "function clearTimeout() {}",
    "function AbortController() { this.signal = {}; this.abort = () => {}; }",
    "async function fetch(url, init) { return fetchImpl(url, init); }",
    extractFunction("shortKeyFingerprint"),
    extractFunction("interpretAiKeyCheckResponse"),
    "async " + extractFunction("requestAiKeyCheck"),
    "async " + extractFunction("checkAiKey"),
    "globalThis.__c = { checkAiKey, results: aiKeyCheckResults, rendered, setKey: (v) => { keys.gemini = v; } };",
  ];
  const sandbox = { fetchImpl };
  new Script(pieces.join("\n\n"), { filename: "ai-key-check-run.js" }).runInNewContext(sandbox);
  return sandbox.__c;
}

test("確認処理: 通信できなかった回を「無効」と判定しない", async () => {
  const c = buildCheckSandbox(() => {
    throw new TypeError("Failed to fetch");
  });
  const result = await c.checkAiKey("gemini");
  assert.equal(result.status, "error", "キーが正しくても通信は失敗しうる");
  assert.notEqual(result.status, "invalid");
  assert.match(result.message, /通信できませんでした/);
});

test("確認処理: タイムアウトも「無効」ではなく確認できなかった扱い", async () => {
  const c = buildCheckSandbox(() => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  });
  const result = await c.checkAiKey("gemini");
  assert.equal(result.status, "error");
  assert.match(result.message, /タイムアウト/);
});

test("確認処理: 成功すれば有効として記録し、表示を更新する", async () => {
  const c = buildCheckSandbox(() => ({ status: 200 }));
  const result = await c.checkAiKey("gemini");
  assert.equal(result.status, "valid");
  assert.ok(c.rendered.length >= 2, "確認中と結果の2回は表示を更新すること");
});

test("確認処理: キーが空なら問い合わせない", async () => {
  let called = 0;
  const c = buildCheckSandbox(() => {
    called += 1;
    return { status: 200 };
  });
  c.setKey("");
  const result = await c.checkAiKey("gemini");
  assert.equal(result.status, "none");
  assert.equal(called, 0, "空のキーで外部へ問い合わせてはいけない");
});
