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
function enrichSandbox(respond, { storage, now } = {}) {
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
      if (r && typeof r.then === "function") return r; // 返ってこない fetch の再現（pending のまま）
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
  };
  if (now) sandbox.Date = { now }; // 後回しの期限（30分）を進めるための時計
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
  // 語源だけは Wiktionary の MediaWiki API（/w/api.php）を並行して叩く設計なので、辞書の予備だけを数える
  assert.equal(calls.filter((u) => !u.includes("/w/api.php")).length, 1, "1番目で取れたら予備は叩かない");
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

test("速さ: 先頭の源が1.5秒返らなければ次の源も並行して叩き、先に取れた方で出す（1.0.115）", async () => {
  const { Enrich, calls } = enrichSandbox((url) => {
    if (host(url) === "api.dictionaryapi.dev") return new Promise(() => {}); // 返ってこない（不調の再現）
    if (host(url) === "freedictionaryapi.com") return { status: 200, body: FREEDICT_ENTRY };
    return { status: 500, body: null };
  });
  const t0 = Date.now();
  const pron = await Enrich.fetch("pronunciation", "apple");
  const elapsed = Date.now() - t0;
  assert.equal(json(pron.texts), json(["/ˈæp.əl/", "/ˈa.pɘl/"]));
  assert.ok(elapsed >= 1400 && elapsed < 4000, `ヘッジ（1.5秒）で切り替わる: ${elapsed}ms`);
  assert.equal(json(calls.map(host)), json(["api.dictionaryapi.dev", "freedictionaryapi.com"]), "先頭を待ってから次を並行に");
  assert.match(html, /const HEDGE_MS = 1500;/);
});

test("速さ: 例文・語源は和訳を待たずに返し（ja は取得中の印）、新規取得の直後に後追いの翻訳を走らせる（1.0.115）", async () => {
  let translateCalls = 0;
  const { Enrich } = enrichSandbox((url) => (host(url) === "api.dictionaryapi.dev" ? { status: 200, body: DICTAPI_ENTRY } : { status: 500, body: null }));
  const ex = await Enrich.fetch("examples", "apple");
  assert.equal(ex.examples[0].en, "I ate an apple.");
  assert.equal(ex.examples[0].ja, undefined, "和訳は表示後に後追い");
  assert.equal(ex.definitions[0].ja, undefined);
  const ety = await Enrich.fetch("etymology", "apple");
  assert.equal(ety.ja, undefined);
  assert.equal(translateCalls, 0);
  // 新規取得の直後に backfillTranslations を呼ぶ配線（例文が出たあと和訳が埋まる）
  assert.match(html, /section\.innerHTML = enrichSectionShell\(type, enrichBody\(type, data, word\.term\)\);\s*[^]*?if \(word\.enrich\[type\]\) backfillTranslations\(type, word, section, chip\);/);
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

test("未確定: 応答しなかった源が残っているとき、他の源が「無い」と言っても未収録を確定（キャッシュ）しない（1.0.117）", async () => {
  let dictDown = true;
  let clock = 1_700_000_000_000;
  const { Enrich, calls } = enrichSandbox((url) => {
    if (host(url) === "api.dictionaryapi.dev") return dictDown ? { status: 522, body: null } : { status: 200, body: DICTAPI_ENTRY };
    if (host(url) === "freedictionaryapi.com") return { status: 200, body: FREEDICT_EMPTY };
    if (host(url) === "en.wiktionary.org") return { status: 404, body: null };
    return { status: 200, body: [] };
  }, { now: () => clock });
  assert.equal(await Enrich.record("apple"), null, "今回は未収録として扱う");
  // 後回しの期限が過ぎて辞書も復旧したら、同じ語を取り直せる
  // （従来は null が確定キャッシュされ、起動中は二度と取りに行かなかった）
  dictDown = false;
  clock += 31 * 60 * 1000;
  const rec = await Enrich.record("apple");
  assert.ok(rec && rec.pronunciations.length > 0, "復旧後に取り直せる");
  assert.equal(calls.filter((u) => host(u) === "api.dictionaryapi.dev").length, 2, "応答しなかった源だけ取り直す");
  assert.equal(calls.filter((u) => host(u) === "freedictionaryapi.com").length, 1, "「無い」と確定した源は叩き直さない");
});

test("未確定: 元気な源が1つだけで、それが「無い」と言ったときも確定しない（後回し中の源が復帰したら取り直す）", async () => {
  const storage = { "wordsnap-dict-degraded:v1": JSON.stringify({ dictionaryapi: Date.now(), freedictionaryapi: Date.now() }) };
  let wiktCalls = 0;
  const { Enrich } = enrichSandbox((url) => {
    if (host(url) === "en.wiktionary.org") { wiktCalls += 1; return { status: 404, body: null }; }
    return { status: 522, body: null };
  }, { storage });
  assert.equal(await Enrich.record("apple"), null);
  assert.equal(await Enrich.record("apple"), null);
  assert.equal(wiktCalls, 1, "「無い」と確定した源は叩き直さないが、結果そのものは確定していない（後回しの源を待たずに返す）");
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

test("和訳の後追い: 同じ語・種類の後追いは同時に1本だけ。閉じて開き直しても訳文は捨てられず、新しい欄へ描く（1.0.117）", async () => {
  let resolveTranslate;
  let translateCalls = 0;
  const persisted = [];
  const chipA = { getAttribute: () => "true", closest: () => null };
  const sectionA = { isConnected: false, innerHTML: "" }; // 閉じて外れた古い欄
  const sectionB = { isConnected: true, innerHTML: "" }; // 開き直して作り直された新しい欄
  const chipB = { getAttribute: () => "true", closest: () => ({ querySelector: () => sectionB }) };
  const sandbox = {
    document: { querySelector: () => chipB },
    window: { Translate: { translateBatch: () => { translateCalls += 1; return new Promise((r) => { resolveTranslate = r; }); } } },
    persistAppState: () => persisted.push(1),
    enrichSectionShell: (type, inner) => inner,
    enrichBody: (type, data) => JSON.stringify(data),
    normalizeEtymologyData: (d) => d,
    normalizeSynonymsData: (d) => d,
  };
  new Script(
    [
      extractFunction("normalizeEnrichSource"),
      extractFunction("normalizeExamplesData"),
      "const backfillInFlight = new Map();",
      extractFunction("backfillTranslations"),
      extractFunction("liveEnrichTargets"),
      "async " + extractFunction("backfillTranslationsOnce"),
      "globalThis.__b = { backfillTranslations, backfillInFlight };",
    ].join("\n\n"),
    { filename: "backfill.js" },
  ).runInNewContext(sandbox);
  const word = { id: "w1", term: "apple", enrich: { examples: { examples: [{ en: "I ate an apple.", ja: undefined }], definitions: [] } } };
  const first = sandbox.__b.backfillTranslations("examples", word, sectionA, chipA);
  const second = sandbox.__b.backfillTranslations("examples", word, sectionB, chipB); // 開き直し直後の2本目
  assert.equal(first, second, "2本目は始めず、進行中の1本目を返す");
  assert.equal(translateCalls, 1, "翻訳の通信は1回");
  resolveTranslate(["私はりんごを食べた。"]);
  await first;
  assert.equal(word.enrich.examples.examples[0].ja, "私はりんごを食べた。", "訳文は表示・保存される側のオブジェクトに入る");
  assert.match(sectionB.innerHTML, /私はりんごを食べた。/, "開き直した新しい欄に描く");
  assert.equal(sectionA.innerHTML, "", "外れた古い欄には描かない");
  assert.equal(persisted.length, 1);
  assert.equal(sandbox.__b.backfillInFlight.size, 0, "終わったら進行中の記録を消す");
});

test("クイズ用: throwIfUnconfirmed なら、未確定の未収録は null を返さず一時的な失敗として投げる（1.0.117）", async () => {
  const { Enrich } = enrichSandbox((url) => {
    if (host(url) === "api.dictionaryapi.dev") return { status: 522, body: null };
    if (host(url) === "freedictionaryapi.com") return { status: 200, body: FREEDICT_EMPTY };
    if (host(url) === "en.wiktionary.org") return { status: 404, body: null };
    return { status: 200, body: [] };
  });
  await assert.rejects(Enrich.record("apple", { throwIfUnconfirmed: true }), (e) => e.transient === true);
  assert.equal(await Enrich.record("apple"), null, "「詳しく」向けの既定は null（未収録として表示、確定はしない）");
  // 全源が確定して「無い」なら、指定があっても null
  const all404 = enrichSandbox(() => ({ status: 404, body: null }));
  assert.equal(await all404.Enrich.record("zzz", { throwIfUnconfirmed: true }), null);
  assert.match(html, /window\.Enrich\.record\(term, \{ throwIfUnconfirmed: true \}\)/, "クイズの例文取得はこの指定で呼ぶ");
});

test("和訳の後追い: 前に取れなかった（null）項目も次に開いたときに取り直す。また取れなければ保存も再描画もしない（1.0.118）", async () => {
  let nextResult = null;
  const persisted = [];
  const section = { isConnected: true, innerHTML: "" };
  const chip = { getAttribute: () => "true", closest: () => ({ querySelector: () => section }) };
  const requested = [];
  const sandbox = {
    document: { querySelector: () => chip },
    window: { Translate: { translateBatch: async (texts) => { requested.push(texts); return texts.map(() => nextResult); } } },
    persistAppState: () => persisted.push(1),
    enrichSectionShell: (type, inner) => inner,
    enrichBody: (type, data) => JSON.stringify(data),
    normalizeEtymologyData: (d) => d,
    normalizeSynonymsData: (d) => d,
  };
  new Script(
    [
      extractFunction("normalizeEnrichSource"),
      extractFunction("normalizeExamplesData"),
      "const backfillInFlight = new Map();",
      extractFunction("backfillTranslations"),
      extractFunction("liveEnrichTargets"),
      "async " + extractFunction("backfillTranslationsOnce"),
      "globalThis.__b = { backfillTranslations };",
    ].join("\n\n"),
    { filename: "backfill-retry.js" },
  ).runInNewContext(sandbox);
  const word = { id: "w1", term: "apple", enrich: { examples: { examples: [{ en: "I ate an apple.", ja: null }, { en: "Apples keep well.", ja: "りんごは日持ちする。" }], definitions: [] } } };
  await sandbox.__b.backfillTranslations("examples", word, section, chip);
  assert.equal(JSON.stringify(requested[0]), JSON.stringify(["I ate an apple."]), "取れなかった項目だけ取り直す（取れている項目は送らない）");
  assert.equal(word.enrich.examples.examples[0].ja, null, "また取れなければ null のまま");
  assert.equal(persisted.length, 0, "変わらなければ保存しない");
  assert.equal(section.innerHTML, "", "変わらなければ再描画しない");
  nextResult = "私はりんごを食べた。";
  await sandbox.__b.backfillTranslations("examples", word, section, chip);
  assert.equal(word.enrich.examples.examples[0].ja, "私はりんごを食べた。", "取れたら置き換わる");
  assert.equal(persisted.length, 1);
  assert.match(section.innerHTML, /私はりんごを食べた。/);
});

// ---------- 語源: Wiktionary の MediaWiki API（1.0.130） ----------
// dictionaryapi.dev 等の origin はほぼ空なので、語源だけ en.wiktionary.org の action=parse で
// English 節配下の Etymology 節を直接取りに行く。

const WIKT_SECTIONS_OK = {
  parse: {
    sections: [
      { index: "1", toclevel: "1", line: "English" },
      { index: "2", toclevel: "2", line: "Etymology 1" },
      { index: "3", toclevel: "3", line: "Noun" },
      { index: "4", toclevel: "2", line: "Etymology 2" },
      { index: "5", toclevel: "1", line: "French" },
      { index: "6", toclevel: "2", line: "Etymology" },
    ],
  },
};
const WIKT_SECTIONS_NO_ETYMOLOGY = {
  parse: {
    sections: [
      { index: "1", toclevel: "1", line: "English" },
      { index: "2", toclevel: "2", line: "Noun" },
      { index: "3", toclevel: "1", line: "French" },
      { index: "4", toclevel: "2", line: "Etymology" },
    ],
  },
};
const WIKT_SECTIONS_NO_ENGLISH = {
  parse: { sections: [{ index: "1", toclevel: "1", line: "French" }, { index: "2", toclevel: "2", line: "Etymology" }] },
};
const WIKT_TEXT_OK = {
  parse: { text: '<p>From Middle English <i>appel</i>, from Old English <i>æppel</i>.</p><h3>Noun</h3><p>ignored</p>' },
};

test("pickEnglishEtymologySection: English節内のEtymologyを選び、English節の後ろ（他言語）のEtymologyは選ばない", async () => {
  const { Enrich } = enrichSandbox(() => ({ status: 500, body: null }));
  assert.equal(Enrich.pickEnglishEtymologySection(WIKT_SECTIONS_OK.parse.sections), "2", "English節内の最初のEtymology（Etymology 1）");
  assert.equal(Enrich.pickEnglishEtymologySection(WIKT_SECTIONS_NO_ETYMOLOGY.parse.sections), null, "English節にEtymologyが無ければnull（French側のEtymologyは選ばない）");
  assert.equal(Enrich.pickEnglishEtymologySection(WIKT_SECTIONS_NO_ENGLISH.parse.sections), null, "English節自体が無ければnull");
  assert.equal(Enrich.pickEnglishEtymologySection([]), null);
});

test("extractEtymologyParagraph: 最初の<p>を採り、下位見出し以降の<p>は無視。脚注除去と600字超の切り詰めも行う", async () => {
  const { Enrich } = enrichSandbox(() => ({ status: 500, body: null }));
  assert.equal(
    Enrich.extractEtymologyParagraph(WIKT_TEXT_OK.parse.text),
    "From Middle English appel, from Old English æppel.",
    "最初の<p>だけを採り、<h3>以降の<p>は無視する",
  );
  assert.equal(
    Enrich.extractEtymologyParagraph('<p>Word origin.<sup>[1]</sup> Displaced native word.<sup>[2]</sup></p>'),
    "Word origin. Displaced native word.",
    "脚注 [1] [2] を除く",
  );
  // 実際の action=parse&section=N は「節自身の見出し → 空の <p class="mw-empty-elt"> → 本文」の順で、
  // [ ] * は数値参照で来る。先頭の見出しで止めてしまうと語源が一度も出ない（実データで再現した退行）。
  assert.equal(
    Enrich.extractEtymologyParagraph(
      '<div class="mw-content-ltr mw-parser-output"><div class="mw-heading mw-heading3"><h3 id="Etymology_1">Etymology 1</h3></div>' +
        '<p class="mw-empty-elt">\n</p><p>From Old French <i>abandoner</i>,&#91;1&#93; from Frankish &#42;ban.</p>' +
        '<div class="mw-heading mw-heading4"><h4 id="Verb">Verb</h4></div><p>ignored</p></div>',
    ),
    "From Old French abandoner, from Frankish *ban.",
    "節自身の見出しは読み飛ばし、空段落を飛ばし、数値参照を戻してから脚注を除く",
  );
  assert.equal(Enrich.extractEtymologyParagraph('<div>No paragraph here.</div>'), null, "<p>が無ければnull");
  assert.equal(Enrich.extractEtymologyParagraph(''), null);

  const filler = "This is a filler sentence used to pad the etymology text past six hundred characters for the truncation test. ";
  const long = Enrich.extractEtymologyParagraph(`<p>${filler.repeat(8)}</p>`);
  assert.ok(long.length <= 602, `600字程度で切る: ${long.length}`);
  assert.match(long, /\.…$/, "文の区切り（. ）で切って…を付ける");
});

test("etymology(term): recordにoriginがあればそれを優先する（Wiktionaryは並行して取りに行くが結果には使わない）", async () => {
  // Wiktionary 側が失敗（500）しても、origin があれば例外にならずに辞書の語源を返す
  const { Enrich, calls } = enrichSandbox((url) => (host(url) === "api.dictionaryapi.dev" ? { status: 200, body: DICTAPI_ENTRY } : { status: 500, body: null }));
  const ety = await Enrich.fetch("etymology", "apple");
  assert.equal(ety.text, "From Old English æppel.");
  assert.equal(ety.ja, undefined);
  assert.equal(ety.source.label, "Wiktionary");
  assert.equal(calls.filter((u) => host(u) === "api.dictionaryapi.dev").length, 1);
  // 辞書の待ちと Wiktionary の往復を直列にしない（不調時に10秒を超えるため）
  assert.equal(calls.filter((u) => u.includes("/w/api.php")).length, 1, "Wiktionary は record() の完了を待たずに並行して始める");
});

test("etymology(term): originが無ければWiktionaryのMediaWiki APIを2回叩き、textとsourceが返る", async () => {
  const { Enrich, calls } = enrichSandbox((url) => {
    if (host(url) === "api.dictionaryapi.dev") return { status: 404, body: null };
    if (host(url) === "freedictionaryapi.com") return { status: 404, body: null };
    if (url.includes("/api/rest_v1/")) return { status: 404, body: null }; // Wiktionary REST（例文用）には該当なし
    if (url.includes("prop=sections")) return { status: 200, body: WIKT_SECTIONS_OK };
    if (url.includes("prop=text")) return { status: 200, body: WIKT_TEXT_OK };
    return { status: 500, body: null };
  });
  const ety = await Enrich.fetch("etymology", "apple");
  assert.equal(ety.text, "From Middle English appel, from Old English æppel.");
  assert.equal(ety.ja, undefined);
  assert.equal(ety.source.id, "wiktionary");
  assert.equal(ety.source.label, "Wiktionary");
  assert.equal(ety.source.url, "https://en.wiktionary.org/wiki/apple");
  assert.equal(ety.source.license, "CC BY-SA 4.0");
  assert.equal(calls.filter((u) => u.includes("/w/api.php")).length, 2, "sections→textの2リクエスト");
});

test("etymology(term): missingtitle（未収録）は { text: null, ja: null } で、sectionsの1回しか叩かない", async () => {
  const { Enrich, calls } = enrichSandbox((url) => {
    if (host(url) === "api.dictionaryapi.dev") return { status: 404, body: null };
    if (host(url) === "freedictionaryapi.com") return { status: 404, body: null };
    if (url.includes("/api/rest_v1/")) return { status: 404, body: null };
    if (url.includes("prop=sections")) return { status: 200, body: { error: { code: "missingtitle", info: "The page you specified doesn't exist." } } };
    return { status: 500, body: null };
  });
  const ety = await Enrich.fetch("etymology", "zzzzqqq");
  assert.equal(json(ety), json({ text: null, ja: null }));
  assert.equal(calls.filter((u) => u.includes("/w/api.php")).length, 1, "missingtitleならsectionsだけでtextは叩かない");
});

test("etymology(term): WiktionaryのMediaWiki APIが5xxなら一時的な失敗として投げる（キャッシュしない）", async () => {
  const { Enrich } = enrichSandbox((url) => {
    if (host(url) === "api.dictionaryapi.dev") return { status: 404, body: null };
    if (host(url) === "freedictionaryapi.com") return { status: 404, body: null };
    if (url.includes("/api/rest_v1/")) return { status: 404, body: null };
    if (url.includes("prop=sections")) return { status: 522, body: null };
    return { status: 500, body: null };
  });
  await assert.rejects(Enrich.fetch("etymology", "apple"), (e) => e.transient === true);
});
