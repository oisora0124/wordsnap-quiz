// AI抽出（写真の文字起こし）・例文生成に使うモデルの指定（1.0.116）。
// Gemini はキーごとに使える最新 Flash を一覧GETで自動選択する（既存）。Groq は新しい順に試し、
// 「そのモデルが無い」応答のときだけ次へ進む。レート制限などでは別モデルへ再送しない（二重課金しない）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Script } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

function extractConst(name) {
  const start = html.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`const ${name} not found`);
  return html.slice(start, html.indexOf(";\n", start) + 1);
}
function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const bodyBrace = html.indexOf("{", html.indexOf(")", start));
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

function groqSandbox(respond) {
  const calls = [];
  const storage = {};
  const sandbox = {
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); } },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body.model);
      const r = respond(body.model, calls.length);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
  };
  new Script(
    [
      extractConst("GROQ_MODELS"),
      extractConst("GROQ_MODEL_PREF_KEY"),
      "let groqModelMemory = '';",
      extractFunction("rememberedGroqModel"),
      extractFunction("rememberGroqModel"),
      extractFunction("groqModelOrder"),
      extractFunction("isGroqModelUnavailable"),
      "async " + extractFunction("groqChatCompletion"),
      "globalThis.__g = { groqChatCompletion, groqModelOrder, isGroqModelUnavailable };",
    ].join("\n\n"),
    { filename: "ai-models-groq.js" },
  ).runInNewContext(sandbox);
  return { ...sandbox.__g, calls, storage };
}

test("Gemini: 自動選択の候補は最新の 3.8 Flash から順に、最後は 2.5 Flash", () => {
  const sandbox = {};
  new Script(`${extractConst("GEMINI_MODELS")}\nglobalThis.__m = GEMINI_MODELS;`, { filename: "gemini.js" }).runInNewContext(sandbox);
  const list = Array.from(sandbox.__m);
  assert.equal(list[0], "gemini-3.8-flash");
  assert.equal(list.at(-1), "gemini-2.5-flash", "古いキーでも動くよう 2.5 は残す");
  assert.deepEqual(list, ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-2.5-flash"]);
});

test("Groq: 第一候補は Qwen 3.8。そのモデルが無い応答（404）のときだけ 3.6 で1回やり直し、使えたモデルを覚える", async () => {
  const g = groqSandbox((model) => (model === "qwen/qwen3.8-27b" ? { status: 404, body: { error: { message: "The model `qwen/qwen3.8-27b` does not exist" } } } : { status: 200, body: { choices: [{ message: { content: "ok" } }] } }));
  assert.equal(JSON.stringify(g.groqModelOrder()), JSON.stringify(["qwen/qwen3.8-27b", "qwen/qwen3.6-27b"])); // vm の別レルム
  const data = await g.groqChatCompletion("gsk_x", { messages: [] }, undefined);
  assert.equal(data.choices[0].message.content, "ok");
  assert.deepEqual(g.calls, ["qwen/qwen3.8-27b", "qwen/qwen3.6-27b"]);
  assert.equal(g.storage["wordsnap-groq-model:v1"], "qwen/qwen3.6-27b", "使えたモデルを端末に控える");
  await g.groqChatCompletion("gsk_x", { messages: [] }, undefined);
  assert.equal(g.calls.at(-1), "qwen/qwen3.6-27b", "次回は覚えたモデルを最初に使う（無いモデルを叩き直さない）");
  assert.equal(g.calls.length, 3);
});

test("Groq: レート制限（429）や本文の問題では別モデルへ再送しない（同じ画像で二重に課金しない）", async () => {
  const g = groqSandbox(() => ({ status: 429, body: { error: { message: "Rate limit reached" } } }));
  await assert.rejects(g.groqChatCompletion("gsk_x", { messages: [] }, undefined), (e) => e.status === 429 && /Rate limit/.test(e.message));
  assert.deepEqual(g.calls, ["qwen/qwen3.8-27b"], "1回だけ");
  const g2 = groqSandbox(() => ({ status: 400, body: { error: { message: "Invalid image data" } } }));
  await assert.rejects(g2.groqChatCompletion("gsk_x", { messages: [] }, undefined), (e) => e.status === 400);
  assert.equal(g2.calls.length, 1, "400 でもモデルの問題でなければ再送しない");
});

test("Groq: 「モデルが無い」判定は 404 と、model を含む 400 の文言（提供終了・権限なし）だけ", () => {
  const g = groqSandbox(() => ({ status: 200, body: {} }));
  assert.equal(g.isGroqModelUnavailable(404, ""), true);
  assert.equal(g.isGroqModelUnavailable(400, "The model `x` has been decommissioned"), true);
  assert.equal(g.isGroqModelUnavailable(400, "The model `x` does not exist or you do not have access to it."), true);
  assert.equal(g.isGroqModelUnavailable(400, "Invalid image data"), false);
  assert.equal(g.isGroqModelUnavailable(429, "Rate limit reached for model x"), false);
  assert.equal(g.isGroqModelUnavailable(500, "model overloaded"), false);
});

test("両方の呼び出し（写真の文字起こし・例文生成）が共通の Groq 呼び出しを通り、固定のモデル名を持たない", () => {
  assert.match(extractFunction("extractWithGroq"), /groqChatCompletion\(/);
  assert.match(extractFunction("generateContextWithGroq"), /groqChatCompletion\(/);
  assert.doesNotMatch(html, /model: GROQ_MODEL\b/);
  assert.match(html, /name: "Groq Qwen 3\.8 Vision（無料枠・使えないときは 3\.6）"/);
});
