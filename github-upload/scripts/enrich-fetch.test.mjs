// 「詳しく」（発音記号・例文・語源）とクイズの例文モードが使う辞書データの取得（Enrich）。
//
// 1.0.113: 辞書サービスの一時的な失敗を「その語が無い」と区別する。
// 1.0.114: 源を切り替える。dictionaryapi.dev → freedictionaryapi.com（Wiktionary 由来）→ en.wiktionary.org REST。
//   応答しなかった源は後回しにし、発音記号がどの辞書にも無ければ Datamuse の IPA を目安として出す。
//
// 背景: dictionaryapi.dev が 2026-08-26 から不調（応答に20秒・522）で、発音記号も例文も「全然出ない」状態だった。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Script } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

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

// fetch を差し替えた砂場。respond(url) は { status, body } か Error（fetch 自体が投げる）を返す。
// storage を渡すと localStorage の代わりになる（後回しの記憶が起動をまたぐことの確認用）。
function enrichSandbox(respond, { storage } = {}) {
  const calls = [];
  const sandbox = {
    window: { Translate: { translateBatch: async (list) => list.map(() => "訳"), translateOne: async () => "訳" } },
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (url) => {
      calls.push(url);
      const r = respond(url, calls.length);
      if (r instanceof Error) throw r;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
  };
  if (storage) {
    sandbox.localStorage = {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => {
        storage[k] = String(v);
      },
    };
  }
  new Script(`${extractEnrichModule()}\nglobalThis.__e = Enrich;`, { filename: "enrich.js" }).runInNewContext(sandbox);
  return { Enrich: sandbox.__e, calls };
}
const host = (url) => new URL(url).host;
const json = (v) => JSON.stringify(v);

const DICTAPI_ENTRY = [{ word: "apple", phonetic: "/ˈæp.əl/", phonetics: [{ text: "/ˈæpəl/" }], origin: "From Old English æppel.", license: { name: "CC BY-SA 3.0" }, sourceUrls: ["https://en.wiktionary.org/wiki/apple"], meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "a fruit", example: "I ate an apple." }] }] }];
const FREEDICT_ENTRY = { word: "apple", entries: [{ partOfSpeech: "noun", pronunciations: [{ type: "ipa", text: "/ˈæp.əl/" }, { type: "ipa", text: "/ˈa.pɘl/" }], senses: [{ definition: "A common, firm, round fruit.", examples: ["She bit into the apple."], subsenses: [{ definition: "The fruit of Malus domestica.", examples: ["Apples keep well."] }] }] }], source: { url: "https://en.wiktionary.org/wiki/apple", license: { name: "CC BY-SA 4.0" } } };
const FREEDICT_EMPTY = { word: "zzz", entries: [], source: { url: "https://en.wiktionary.org", license: { name: "CC BY-SA 4.0" } } };
const WIKT_ENTRY = { en: [{ partOfSpeech: "Noun", definitions: [{ definition: "" }, { definition: "A <a href=\"/wiki/fruit\">fruit</a> &amp; tree.", parsedExamples: [{ example: "Occasionally <b>apples</b> fall." }], examples: ["Occasionally <b>apples</b> fall."] }] }] };
const DATAMUSE_IPA = [{ word: "apple", score: 1, tags: ["n", "pron:AE1 P AH0 L ", "ipa_pron:ˈæpʌɫ"] }];

test("順番: dictionaryapi.dev が元気なら従来どおりそこから取り、発音記号・例文・語源がそろう", async () => {
  const { Enrich, calls } = enrichSandbox((url) => (host(url) === "api.dictionaryapi.dev" ? { status: 200, body: DICTAPI_ENTRY } : { status: 500, body: null }));
  const pron = await Enrich.fetch("pronunciation", "apple");
  assert.equal(json(pron.texts), json(["/ˈæp.əl/", "/ˈæpəl/"]));
  assert.equal(pron.source.label, "Wiktionary", "dictionaryapi.dev のデータも Wiktionary 由来なので出典を付ける");
  assert.equal(pron.source.license, "CC BY-SA 3.0");
  const ex = await Enrich.fetch("examples", "apple");
  assert.equal(ex.examples[0].en, "I ate an apple.");
  assert.equal(ex.definitions[0].def, "a fruit");
  const ety = await Enrich.fetch("etymology", "apple");
  assert.equal(ety.text, "From Old English æppel.");
  assert.equal(calls.filter((u) => host(u) === "api.dictionaryapi.dev").length, 1, "同じ語の辞書データは1回だけ取り、3種類で共用する");
  assert.equal(calls.length, 1, "1番目で取れたら予備は叩かない");
});

test("切り替え: dictionaryapi.dev が 522 なら freedictionaryapi.com から取り、発音記号と例文が出る。以後その源は後回し", async () => {
  const { Enrich, calls } = enrichSandbox((url) => {
    if (host(url) === "api.dictionaryapi.dev") return { status: 522, body: null };
    if (host(url) === "freedictionaryapi.com") return { status: 200, body: FREEDICT_ENTRY };
    return { status: 500, body: null };
  });
  assert.equal(json(Enrich.sourceOrder()), json(["dictionaryapi", "freedictionaryapi", "wiktionary"]));
  const pron = await Enrich.fetch("pronunciation", "apple");
  assert.equal(json(pron.texts), json(["/ˈæp.əl/", "/ˈa.pɘl/"]));
  assert.equal(pron.source.url, "https://en.wiktionary.org/wiki/apple");
  assert.equal(pron.source.license, "CC BY-SA 4.0");
  const ex = await Enrich.fetch("examples", "apple");
  assert.equal(json(ex.examples.map((e) => e.en)), json(["She bit into the apple.", "Apples keep well."]), "副義の例文も拾う");
  assert.equal(ex.source.label, "Wiktionary");
  assert.equal(json(Enrich.sourceOrder()), json(["freedictionaryapi", "wiktionary", "dictionaryapi"]), "応答しなかった源は後回し");
  // 別の語では、後回しにした dictionaryapi.dev を待たずに予備から取る
  await Enrich.fetch("pronunciation", "pear").catch(() => {});
  const pearCalls = calls.filter((u) => u.endsWith("/pear"));
  assert.equal(host(pearCalls[0]), "freedictionaryapi.com", "後回しの源は最初に叩かない");
});

test("最後の砦: 辞書が Wiktionary REST しか答えないとき、例文はそこから、発音記号は Datamuse の IPA を目安として出す", async () => {
  const { Enrich } = enrichSandbox((url) => {
    if (host(url) === "api.dictionaryapi.dev") return { status: 404, body: { title: "No Definitions Found" } };
    if (host(url) === "freedictionaryapi.com") return { status: 200, body: FREEDICT_EMPTY };
    if (host(url) === "en.wiktionary.org") return { status: 200, body: WIKT_ENTRY };
    if (host(url) === "api.datamuse.com") return { status: 200, body: DATAMUSE_IPA };
    return { status: 500, body: null };
  });
  const ex = await Enrich.fetch("examples", "apple");
  assert.equal(ex.examples[0].en, "Occasionally apples fall.", "HTML のタグを剥がす");
  assert.equal(ex.definitions[0].def, "A fruit & tree.", "空の定義は飛ばし、実体参照を戻す");
  assert.equal(ex.source.url, "https://en.wiktionary.org/wiki/apple");
  const pron = await Enrich.fetch("pronunciation", "apple");
  assert.equal(json(pron.texts), json(["/ˈæpʌɫ/"]));
  assert.equal(pron.approx, true, "機械変換だと分かる印を付ける（描画で注記する）");
  assert.match(pron.source.label, /Datamuse/);
});

test("辞書が全部応答しないときも、発音記号は Datamuse の IPA で出す。例文は一時的な失敗として投げる（キャッシュしない）", async () => {
  let down = true;
  const { Enrich, calls } = enrichSandbox((url) => {
    if (host(url) === "api.datamuse.com") return { status: 200, body: DATAMUSE_IPA };
    return down ? Object.assign(new Error("aborted"), { name: "AbortError" }) : { status: 200, body: DICTAPI_ENTRY };
  });
  const pron = await Enrich.fetch("pronunciation", "apple");
  assert.equal(pron.approx, true);
  await assert.rejects(Enrich.fetch("examples", "apple"), (e) => e.transient === true && e.reason === "timeout");
  // 復旧したら押し直しでそのまま取れる
  down = false;
  const ex = await Enrich.fetch("examples", "apple");
  assert.equal(ex.examples[0].en, "I ate an apple.");
  assert.ok(calls.length >= 4);
});

test("未収録: 元気な源がそろって「無い」と答えたら、後回し中の源を待たずに未収録（null）とし、その結果はキャッシュする", async () => {
  const storage = { "wordsnap-dict-degraded:v1": JSON.stringify({ dictionaryapi: Date.now() }) }; // 前の起動で後回しになっていた
  const { Enrich, calls } = enrichSandbox((url) => {
    if (host(url) === "api.dictionaryapi.dev") return { status: 522, body: null };
    if (host(url) === "freedictionaryapi.com") return { status: 200, body: FREEDICT_EMPTY };
    if (host(url) === "en.wiktionary.org") return { status: 404, body: null };
    return { status: 200, body: [] }; // Datamuse: 該当なし
  }, { storage });
  assert.equal(Enrich.sourceOrder()[0], "freedictionaryapi", "後回しの記憶は起動をまたぐ");
  const rec = await Enrich.record("zzzzqqq");
  assert.equal(rec, null);
  assert.equal(calls.filter((u) => host(u) === "api.dictionaryapi.dev").length, 0, "後回しの源を待たない");
  const pron = await Enrich.fetch("pronunciation", "zzzzqqq");
  assert.equal(json(pron), json({ texts: [] }));
  assert.equal(calls.filter((u) => host(u) !== "api.datamuse.com").length, 2, "未収録の結果はキャッシュされる");
});

test("30分たてば後回しにした源をまた最初に試す", () => {
  const storage = { "wordsnap-dict-degraded:v1": JSON.stringify({ dictionaryapi: Date.now() - 31 * 60 * 1000 }) };
  const { Enrich } = enrichSandbox(() => ({ status: 500, body: null }), { storage });
  assert.equal(Enrich.sourceOrder()[0], "dictionaryapi");
});

test("通信の許可先（CSP）と文言: 予備の辞書が入っている", () => {
  const headers = readFileSync(join(here, "..", "publish", "_headers"), "utf8");
  const connect = headers.match(/connect-src ([^;]+);/)[1];
  for (const origin of ["https://api.dictionaryapi.dev", "https://freedictionaryapi.com", "https://en.wiktionary.org", "https://api.datamuse.com"]) {
    assert.ok(connect.includes(origin), `connect-src に ${origin}`);
  }
  assert.match(html, /freedictionaryapi\.com・en\.wiktionary\.org/, "プライバシーの説明に予備の送信先を明記");
  assert.match(html, /辞書サービス（dictionaryapi\.dev と予備の Wiktionary 系）/, "失敗の案内も予備込みの表現");
});

test("描画: 発音記号と例文に出典を付け、機械変換の IPA には注記を添える。出典は和訳の後追いで消えない", () => {
  const sandbox = {};
  new Script(
    [
      extractFunction("escapeHtml"),
      extractFunction("enrichEmpty"),
      extractFunction("enrichSourceLine"),
      extractFunction("normalizeEnrichSource"),
      extractFunction("normalizeExamplesData"),
      "globalThis.__r = { enrichSourceLine, normalizeExamplesData };",
    ].join("\n\n"),
    { filename: "enrich-render.js" },
  ).runInNewContext(sandbox);
  const { enrichSourceLine, normalizeExamplesData } = sandbox.__r;
  const line = enrichSourceLine({ label: "Wiktionary", url: "https://en.wiktionary.org/wiki/apple", license: "CC BY-SA 4.0" });
  assert.match(line, /出典: <a href="https:\/\/en\.wiktionary\.org\/wiki\/apple" target="_blank" rel="noopener noreferrer">Wiktionary ↗<\/a>（CC BY-SA 4\.0）/);
  assert.equal(enrichSourceLine(null), "");
  assert.equal(enrichSourceLine({ label: "Datamuse（CMU発音辞書からの機械変換）", url: null, license: null }), `<p class="enrich-source">出典: Datamuse（CMU発音辞書からの機械変換）</p>`);
  const norm = normalizeExamplesData({ examples: ["a"], definitions: [], source: { label: "Wiktionary", url: "u", license: "L" } });
  assert.equal(json(norm.source), json({ label: "Wiktionary", url: "u", license: "L" }), "書き戻しでも出典を保つ");
  assert.equal(normalizeExamplesData({ examples: ["a"] }).source, undefined, "旧キャッシュは出典なしのまま");
  // 描画側の配線（発音記号の注記・例文末尾の出典）
  assert.match(html, /data\?\.approx\s*\?\s*`<p class="enrich-caption">辞書に発音記号が無いため/);
  assert.match(html, /if \(html\) html \+= enrichSourceLine\(norm\.source\);/);
});
