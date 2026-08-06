// 検査スクリプト自身の検査。a11y-audit.mjs は npm test のゲートなので、
// 「見逃す（偽陰性）」と「無いものを報告してゲートを止める（偽陽性）」の
// どちらも本番の足を引っ張る。両方向を固定入力で押さえる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const AUDIT = join(here, "a11y-audit.mjs");
const work = mkdtempSync(join(tmpdir(), "wb-a11y-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

let seq = 0;
/** body の中身を持つ最小のHTMLを検査し、違反の配列を返す。 */
function audit(bodyHtml) {
  const file = join(work, `case-${(seq += 1)}.html`);
  writeFileSync(file, `<!doctype html><html lang="ja"><body>\n${bodyHtml}\n</body></html>\n`);
  try {
    return JSON.parse(execFileSync("node", [AUDIT, file, "--json"], { encoding: "utf8" }) || "[]");
  } catch (e) {
    // 違反があると exit 1 になるので、stdout から拾う。
    return JSON.parse(e.stdout || "[]");
  }
}
const rules = (bodyHtml) => audit(bodyHtml).map((f) => f.rule).sort();

// ---- 検出できること（偽陰性を防ぐ） ----

test("名前の無いボタン・リンクを検出する", () => {
  assert.deepEqual(rules("<button></button>"), ["button-no-name"]);
  assert.deepEqual(rules('<a href="/x"></a>'), ["link-no-name"]);
});

test("記号だけのボタンを検出する（読み上げで意味が伝わらない）", () => {
  assert.deepEqual(rules("<button>✕</button>"), ["button-symbol-only"]);
  assert.deepEqual(rules("<button>→</button>"), ["button-symbol-only"]);
});

test("ラベルの無い入力欄を検出する", () => {
  assert.deepEqual(rules('<input type="text">'), ["control-no-label"]);
  assert.deepEqual(rules("<select><option>a</option></select>"), ["control-no-label"]);
  assert.deepEqual(rules("<textarea></textarea>"), ["control-no-label"]);
});

test("壊れた参照・重複id・不正role・正のtabindexを検出する", () => {
  assert.deepEqual(rules('<div aria-labelledby="none"></div>'), ["broken-aria-reference"]);
  assert.deepEqual(rules('<label for="none">名前</label>'), ["broken-label-for"]);
  assert.deepEqual(rules('<p id="a"></p><p id="a"></p>'), ["duplicate-id", "duplicate-id"]);
  assert.deepEqual(rules('<div role="buttonn"></div>'), ["invalid-role"]);
  assert.deepEqual(rules('<div tabindex="3"></div>'), ["positive-tabindex"]);
});

test("alt の無い画像を検出する", () => {
  assert.deepEqual(rules('<img src="a.png">'), ["img-missing-alt"]);
});

test("aria-hidden の内側のフォーカス可能要素を検出する", () => {
  assert.deepEqual(rules('<div aria-hidden="true"><button>押す</button></div>'), ["focusable-in-aria-hidden"]);
  // 開始タグ直後に子が来る場合（過去に境界条件で取りこぼした）。
  assert.deepEqual(rules('<div aria-hidden="true"><a href="/x">行く</a></div>'), ["focusable-in-aria-hidden"]);
});

test("見出しレベルの飛びを検出する", () => {
  assert.deepEqual(rules("<h1>a</h1><h3>b</h3>"), ["heading-skip"]);
});

// ---- 検出してはいけないこと（偽陽性でゲートを止めない） ----

test("正しく書かれたUIは1件も報告しない", () => {
  assert.deepEqual(
    rules(
      '<label for="q">検索</label><input type="text" id="q">' +
      '<button aria-label="閉じる">✕</button>' +
      '<button>保存する</button>' +
      '<a href="/x">使い方</a>' +
      '<img src="a.png" alt="図">' +
      '<h1>見出し</h1><h2>小見出し</h2>' +
      '<div aria-hidden="true">飾り</div>',
    ),
    [],
  );
});

test("label で囲んだ入力欄はラベル済みとみなす（開始タグ直後でも）", () => {
  assert.deepEqual(rules('<label><input type="checkbox">音を鳴らす</label>'), []);
  assert.deepEqual(rules("<label>名前<input type=\"text\"></label>"), []);
});

test("ラベルの要らない input は報告しない", () => {
  assert.deepEqual(rules('<input type="hidden" name="a"><input type="submit" value="送信">'), []);
});

test("aria-hidden の中でも tabindex=-1 や disabled は報告しない", () => {
  assert.deepEqual(rules('<div aria-hidden="true"><button tabindex="-1">x</button></div>'), []);
  assert.deepEqual(rules('<div aria-hidden="true"><button disabled>x</button></div>'), []);
});

test("コメントアウトしたマークアップを実要素として拾わない", () => {
  // これが崩れると「消したはずの要素」で検査が落ち、原因が分からなくなる。
  assert.deepEqual(rules('<!-- <button></button> <img src="x.png"> <input type="text"> -->'), []);
  assert.deepEqual(rules("<!-- <button>\n  複数行\n</button> -->"), []);
});

test("コメントを潰しても行番号がずれない", () => {
  const found = audit("<!-- <button></button>\n     複数行のコメント -->\n<p>本文</p>\n<button></button>");
  assert.equal(found.length, 1);
  assert.equal(found[0].rule, "button-no-name");
  // body の中身は2行目から始まるので、4行目の button は 5行目になる。
  assert.equal(found[0].line, 5, "コメントを空白で潰す際に改行を消すと行番号がずれる");
});

test("script の中の文字列にある <!-- でHTMLを壊さない", () => {
  const body = '<script>const s = "<!-- これはJSの文字列";</' + "script>\n<button></button>";
  assert.deepEqual(rules(body), ["button-no-name"], "script内の <!-- を境にHTMLを読み飛ばしてはいけない");
});

test("script / style の中身は走査しない", () => {
  // JSのテンプレート文字列に書かれたHTMLは静的な要素ではない。
  const body = "<script>const t = `<button></button><img src=\"a.png\">`;</" + "script>";
  assert.deepEqual(rules(body), []);
  assert.deepEqual(rules("<style>/* <button></button> */</style>"), []);
});

// ---- 公開HTML本体 ----

test("公開版 index.html に違反が無い", () => {
  let out = "";
  let code = 0;
  try {
    out = execFileSync("node", [AUDIT, "--json"], { encoding: "utf8" });
  } catch (e) {
    out = e.stdout || "";
    code = e.status;
  }
  const found = JSON.parse(out || "[]");
  assert.deepEqual(found, [], `違反: ${JSON.stringify(found, null, 2)}`);
  assert.equal(code, 0, "違反ゼロなら終了コードは0であるべき");
});
