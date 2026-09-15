// 「詳しく」（発音記号・例文・語源・類義語・コロケーション）の取得で、辞書サービスの一時的な失敗を
// 「その語が無い」と区別する（1.0.113）。
//
// 背景: dictionaryapi.dev が不調（応答に20秒・522）のとき、8秒で打ち切った失敗を null に畳んで
// キャッシュし、「情報が見つかりませんでした」と出したまま同じ起動中は二度と取りに行かなかった。
// 利用者からは発音記号も例文も「全然出ない」ように見えた。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Script } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

// `const Enrich = (() => { ... })();` を丸ごと取り出す
function extractEnrichModule() {
  const start = html.indexOf("const Enrich = (() => {");
  if (start < 0) throw new Error("Enrich module not found");
  const end = html.indexOf("\n})();\n", start);
  if (end < 0) throw new Error("Enrich module end not found");
  return html.slice(start, end + "\n})();".length);
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

// fetch を差し替えた砂場。responses は URL の部分一致 → 応答（関数なら呼ぶたびに評価）。
function enrichSandbox(respond) {
  const calls = [];
  const sandbox = {
    window: { Translate: { translateBatch: async (list) => list.map(() => "訳"), translateOne: async () => "訳" } },
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (url, options) => {
      calls.push(url);
      const r = respond(url, calls.length);
      if (r instanceof Error) throw r;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
  };
  new Script(`${extractEnrichModule()}\nglobalThis.__e = Enrich;`, { filename: "enrich.js" }).runInNewContext(sandbox);
  return { Enrich: sandbox.__e, calls };
}

const ENTRY = [{ word: "apple", phonetic: "/ˈæp.əl/", phonetics: [{ text: "/ˈæpəl/" }], meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "a fruit", example: "I ate an apple." }] }] }];

test("404（辞書に項目が無い）は確定した結果としてキャッシュし、発音記号は空になる", async () => {
  const { Enrich, calls } = enrichSandbox(() => ({ status: 404, body: { title: "No Definitions Found" } }));
  const first = await Enrich.fetch("pronunciation", "zzzzqqq");
  assert.equal(JSON.stringify(first), JSON.stringify({ texts: [] })); // vm の別レルムなので deepEqual は使わない
  assert.equal(Enrich.isEmpty("pronunciation", first), true);
  await Enrich.fetch("examples", "zzzzqqq");
  assert.equal(calls.length, 1, "404 はキャッシュされ、別の種類でも取り直さない");
});

test("5xx・タイムアウト・通信断は一時的な失敗として投げ、キャッシュしない（押し直せば取り直す）", async () => {
  let mode = "server";
  const { Enrich, calls } = enrichSandbox(() => {
    if (mode === "server") return { status: 522, body: null };
    if (mode === "timeout") return Object.assign(new Error("aborted"), { name: "AbortError" });
    if (mode === "network") return new TypeError("Failed to fetch");
    return { status: 200, body: ENTRY };
  });
  await assert.rejects(Enrich.fetch("pronunciation", "apple"), (e) => e.transient === true && e.reason === "server");
  mode = "timeout";
  await assert.rejects(Enrich.fetch("pronunciation", "apple"), (e) => e.reason === "timeout");
  mode = "network";
  await assert.rejects(Enrich.fetch("examples", "apple"), (e) => e.reason === "network");
  assert.equal(calls.length, 3, "失敗はキャッシュされず、押すたびに取りに行く");
  // 辞書が復旧したら、そのまま取れる（従来は同じ起動中は null のまま二度と取りに行かなかった）
  mode = "ok";
  const pron = await Enrich.fetch("pronunciation", "apple");
  assert.equal(JSON.stringify(pron.texts), JSON.stringify(["/ˈæp.əl/", "/ˈæpəl/"]));
  const ex = await Enrich.fetch("examples", "apple");
  assert.equal(ex.examples[0].en, "I ate an apple.");
  assert.equal(calls.length, 4, "成功はキャッシュされ、例文は同じ応答を使う");
});

test("辞書サービスの待ち時間は15秒、語彙サービス（Datamuse）は従来の8秒", () => {
  assert.match(html, /const DICT_TIMEOUT_MS = 15000;/);
  assert.match(html, /getJson\(DICT \+ encodeURIComponent\(w\), DICT_TIMEOUT_MS\)/);
  assert.match(html, /async function getJson\(url, timeoutMs = 8000\)/);
});

test("失敗の案内: 辞書側の不調は「この語が無いわけではない」と伝え、通信断のときだけ通信状態を確認と言う", () => {
  const sandbox = {};
  new Script(`${extractFunction("enrichFailureMessage")}\nglobalThis.__m = enrichFailureMessage;`, { filename: "msg.js" }).runInNewContext(sandbox);
  const m = sandbox.__m;
  const server = m("pronunciation", { reason: "server" }, "発音記号");
  assert.match(server, /辞書サービス（dictionaryapi\.dev）が応答しませんでした/);
  assert.match(server, /この語が無いわけではありません/);
  assert.match(server, /「発音記号」をもう一度/);
  assert.doesNotMatch(server, /通信状態/);
  assert.match(m("examples", { reason: "timeout" }, "例文"), /辞書サービス/);
  assert.match(m("synonyms", { reason: "server" }, "類義語"), /語彙サービス（datamuse\.com）/);
  assert.match(m("examples", { reason: "network" }, "例文"), /通信状態を確認して、「例文」をもう一度/);
  assert.match(m("examples", new Error("x"), "例文"), /通信状態を確認/);
  // ハンドラは error を受け取ってこの案内を出し、押し直しで再取得できる印を付ける
  assert.match(html, /\} catch \(error\) \{\s*if \(chip\.getAttribute\("aria-pressed"\) === "true"\) \{\s*chip\.dataset\.enrichError = "1";\s*section\.innerHTML = enrichSectionShell\(type, enrichEmpty\(enrichFailureMessage\(type, error, label\)\)\);/);
  // 取得は成功して中身が無かったときの文は「通信状態」に触れない（失敗と混同させない）
  assert.match(html, /enrichEmpty\("辞書APIにはこの情報が未収録でした。"\)/);
});
