// 英→日翻訳のフォールバック（1.0.92）を、公開HTML内の実コードから抽出して検査する。
// 流儀は scripts/context-quiz.test.mjs / scripts/ai-key-check.test.mjs と同じ。
//
// 翻訳は単語の詳細（類義語・例文・定義の和訳）にだけ使う補助機能で、失敗しても
// 和訳が出ないだけ。単語データ・クイズ・SRS・同期には影響しない。
//
// gtx は非公開エンドポイントなので、ある日まとめて応答しなくなることがある。
// そのとき単語の詳細を開くたびに毎回8秒のタイムアウトを待たされてから MyMemory へ
// 回っていた。続けて「落ちている」応答が返ったらセッションの間だけ呼ぶのをやめる。
//
// この機能で一番まずいのは次の2つ。
//   - たまたま訳せない語が続いただけで相手を切り離す（＝訳せる語まで訳せなくなる）
//   - 遮断を保存して、相手が復旧しても切り離したままにする
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Script } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

// `const Translate = (() => { ... })();` を対応する括弧の末尾まで切り出す。
function extractTranslateModule() {
  const start = html.indexOf("const Translate = (() => {");
  if (start < 0) throw new Error("Translate module not found");
  let depth = 0;
  let seen = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      seen = true;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
    } else if (ch === ";" && depth === 0 && seen) {
      return html.slice(start, i + 1);
    }
  }
  throw new Error("could not terminate Translate module");
}

const MODULE_SOURCE = extractTranslateModule();

// 応答を差し替えて、実際に何回・どこへ問い合わせたかを数える。
// setTimeout は即時に返す偽物にして、テストで実時間を待たない。
function buildSandbox(handler) {
  const pieces = [
    "const calls = [];",
    "function setTimeout() { return 0; }",
    "function clearTimeout() {}",
    "function AbortController() { this.signal = {}; this.abort = () => {}; }",
    "async function fetch(url) { calls.push(String(url)); return handler(String(url)); }",
    MODULE_SOURCE,
    "globalThis.__t = { calls, Translate };",
  ];
  const sandbox = { handler };
  new Script(pieces.join("\n\n"), { filename: "translate-fallback-check.js" }).runInNewContext(sandbox);
  return sandbox.__t;
}

const isGtx = (url) => url.includes("translate.googleapis.com");
const isMyMemory = (url) => url.includes("mymemory");

// 正常な応答
const gtxOk = (text) => ({ ok: true, status: 200, text: async () => JSON.stringify([[[text, "", "", ""]]]) });
const myMemoryOk = (text) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ responseData: { translatedText: text } }),
});
const httpError = (status) => ({ ok: false, status, text: async () => "" });

test("落ちている応答が続いたら、それ以降 gtx を呼ばない（毎回タイムアウトを待たない）", async () => {
  const t = buildSandbox((url) => (isGtx(url) ? httpError(503) : myMemoryOk("訳")));
  for (const word of ["one", "two", "three", "four"]) {
    await t.Translate.translateOne(word);
  }
  const gtxCalls = Array.from(t.calls).filter(isGtx).length;
  assert.equal(gtxCalls, 2, "2回落ちた時点で見切りをつけ、以降は呼ばない");
});

test("gtx を切り離しても、MyMemory から訳は返る（機能は止まらない）", async () => {
  const t = buildSandbox((url) => (isGtx(url) ? httpError(503) : myMemoryOk("走る")));
  assert.equal(await t.Translate.translateOne("run"), "走る");
  assert.equal(await t.Translate.translateOne("walk"), "走る");
  assert.equal(await t.Translate.translateOne("jump"), "走る", "遮断後も訳せる");
});

test("途中で成功したら、連続は途切れる（一時的な失敗で切り離さない）", async () => {
  let n = 0;
  const t = buildSandbox((url) => {
    if (!isGtx(url)) return myMemoryOk("訳");
    n += 1;
    return n === 2 ? gtxOk("成功") : httpError(503); // 落ちる→成功→落ちる→…
  });
  for (const word of ["a", "b", "c", "d"]) await t.Translate.translateOne(word);
  const gtxCalls = Array.from(t.calls).filter(isGtx).length;
  assert.equal(gtxCalls, 4, "成功を挟めば連続扱いにせず、呼び続ける");
});

test("相手が生きている 4xx は「落ちている」と数えない（訳せない語で切り離さない）", async () => {
  const t = buildSandbox((url) => (isGtx(url) ? httpError(400) : myMemoryOk("訳")));
  for (const word of ["a", "b", "c", "d"]) await t.Translate.translateOne(word);
  const gtxCalls = Array.from(t.calls).filter(isGtx).length;
  assert.equal(gtxCalls, 4, "400はその語の問題であって、相手が落ちているわけではない");
});

test("429（上限）と5xx（相手側の障害）は「落ちている」と数える", async () => {
  for (const status of [429, 500, 503]) {
    const t = buildSandbox((url) => (isGtx(url) ? httpError(status) : myMemoryOk("訳")));
    for (const word of ["a", "b", "c", "d"]) await t.Translate.translateOne(word);
    assert.equal(Array.from(t.calls).filter(isGtx).length, 2, `HTTP ${status}`);
  }
});

test("通信できない場合も「落ちている」と数える", async () => {
  const t = buildSandbox((url) => {
    if (isGtx(url)) throw new TypeError("Failed to fetch");
    return myMemoryOk("訳");
  });
  for (const word of ["a", "b", "c", "d"]) await t.Translate.translateOne(word);
  assert.equal(Array.from(t.calls).filter(isGtx).length, 2);
});

test("MyMemory 側にも同じ遮断がかかる（両方落ちても待たされない）", async () => {
  const t = buildSandbox(() => httpError(503));
  for (const word of ["a", "b", "c", "d"]) {
    assert.equal(await t.Translate.translateOne(word), null, "両方落ちたら null（例外は投げない）");
  }
  assert.equal(Array.from(t.calls).filter(isGtx).length, 2);
  assert.equal(Array.from(t.calls).filter(isMyMemory).length, 2);
});

test("遮断は保存しない（再読み込みで元に戻り、相手の復旧に追随する）", () => {
  assert.doesNotMatch(MODULE_SOURCE, /localStorage/, "遮断状態を端末に残してはいけない");
  assert.doesNotMatch(MODULE_SOURCE, /sessionStorage/);
});

test("gtx が生きている間は、これまでどおり gtx の訳を使う（後方互換）", async () => {
  const t = buildSandbox((url) => (isGtx(url) ? gtxOk("走る") : myMemoryOk("別の訳")));
  assert.equal(await t.Translate.translateOne("run"), "走る");
  assert.equal(Array.from(t.calls).filter(isMyMemory).length, 0, "gtx で足りればMyMemoryを呼ばない");
});

test("成功した訳はキャッシュし、失敗は覚えない（後方互換）", async () => {
  let fail = true;
  const t = buildSandbox((url) => {
    if (!isGtx(url)) return httpError(400);
    return fail ? httpError(400) : gtxOk("走る");
  });
  assert.equal(await t.Translate.translateOne("run"), null);
  fail = false;
  assert.equal(await t.Translate.translateOne("run"), "走る", "失敗を覚えていたら再試行できない");
  const before = Array.from(t.calls).length;
  assert.equal(await t.Translate.translateOne("run"), "走る");
  assert.equal(Array.from(t.calls).length, before, "成功後は問い合わせ直さない");
});

test("まとめ訳は1回の呼び出しにまとめる（gtxを使う理由そのもの）", async () => {
  const marker = MODULE_SOURCE.match(/const BATCH_MARKER = "([^"]*)"/)[1];
  const t = buildSandbox((url) => {
    if (!isGtx(url)) return httpError(503);
    return gtxOk(["走る", "歩く", "跳ぶ"].join(marker));
  });
  const out = await t.Translate.translateBatch(["run", "walk", "jump"]);
  assert.deepEqual(Array.from(out), ["走る", "歩く", "跳ぶ"]);
  assert.equal(Array.from(t.calls).filter(isGtx).length, 1, "3語を1回で訳す");
});
