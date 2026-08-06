// CSPハッシュの計算と _headers 更新の検査。
//
// ここが壊れると **本番だけが壊れる**。インラインscriptのSHA-256が
// script-src に載っていなければ、ブラウザはそのscriptの実行を拒否する。
// ローカルでは file:// でもテストでも動くので、気づくのは公開後になる。
//
// しかも生成側（sync-html.mjs）と照合側（check-release.mjs）は同じ
// inlineScriptHashes を使うため、**この関数の取りこぼしは両方の目を同時に塞ぐ**。
// 「ハッシュは全部揃っている」と判定したまま本番が壊れる。
// そのため、ここでは取りこぼしそのものを固定入力で押さえる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { inlineScriptHashes, scanScriptElements } from "./csp-hashes.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// テスト内に生の "</script>" を書くとHTMLとして扱う道具に誤解されるので、組み立てる。
const CLOSE = `</${"script"}>`;
const sha = (body) => `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;

// ---- script 要素の走査 ----

test("属性の付いた script も取りこぼさない（本番が壊れる盲点だった）", () => {
  for (const open of [
    "<script>",
    '<script type="module">',
    "<script defer>",
    "<script async>",
    '<script type="text/javascript">',
    "<SCRIPT>",
    "<script >",
  ]) {
    const html = `${open}alert(1)${CLOSE}`;
    const found = scanScriptElements(html);
    assert.equal(found.inline.length, 1, `取りこぼした: ${open}`);
    assert.equal(found.inline[0].body, "alert(1)", `本文がずれた: ${open}`);
    assert.deepEqual(inlineScriptHashes(html), [sha("alert(1)")], `ハッシュがずれた: ${open}`);
  }
});

test("外部scriptはハッシュ対象にしない（本文を持たない）", () => {
  const html = `<script src="/a.js">${CLOSE}<script>alert(1)${CLOSE}`;
  const found = scanScriptElements(html);
  assert.equal(found.external, 1);
  assert.equal(found.inline.length, 1);
  assert.deepEqual(inlineScriptHashes(html), [sha("alert(1)")]);
});

test("src が他の属性と混ざっていても外部と判定する", () => {
  for (const open of ['<script src="/a.js" defer>', '<script defer src="/a.js">', "<script SRC='/a.js'>"]) {
    const found = scanScriptElements(`${open}${CLOSE}`);
    assert.equal(found.external, 1, `外部と判定できていない: ${open}`);
    assert.equal(found.inline.length, 0, `外部scriptをハッシュ対象にしている: ${open}`);
  }
});

test("本文中に書かれた文字列の <script> を要素と誤認しない", () => {
  // 本体の index.html にも、コメント内に <script> と書かれた箇所が実在する。
  const body = `const s = "<script>";`;
  const html = `<script>${body}${CLOSE}`;
  const found = scanScriptElements(html);
  assert.equal(found.inline.length, 1);
  assert.equal(found.inline[0].body, body);
});

test("複数のscriptを、それぞれ独立した本文として切り出す", () => {
  const html = `<script>A${CLOSE}\n<p>x</p>\n<script>B${CLOSE}\n<script>C${CLOSE}`;
  const found = scanScriptElements(html);
  assert.deepEqual(found.inline.map((s) => s.body), ["A", "B", "C"]);
  assert.deepEqual(inlineScriptHashes(html), [sha("A"), sha("B"), sha("C")]);
});

test("属性値の中の > でタグを終わらせない（本文がずれてハッシュが狂う）", () => {
  for (const open of [`<script data-x="a>b">`, `<script data-x='a>b'>`, `<script a=">" b="<">`]) {
    const found = scanScriptElements(`${open}alert(1)${CLOSE}`);
    assert.equal(found.inline.length, 1, `要素として拾えていない: ${open}`);
    assert.equal(found.inline[0].body, "alert(1)", `本文がずれている: ${open}`);
  }
});

test("HTMLコメントの中の script は要素ではない", () => {
  // ブラウザはコメント内を実行しない。ここを要素として数えると、
  // 実在しないscriptのハッシュが _headers に載る。
  const html = `<!-- <script>dead${CLOSE} -->\n<script>alive${CLOSE}`;
  const found = scanScriptElements(html);
  assert.deepEqual(found.inline.map((s) => s.body), ["alive"]);
  const multiline = `<!--\n<script>dead${CLOSE}\n-->\n<script>alive${CLOSE}`;
  assert.deepEqual(scanScriptElements(multiline).inline.map((s) => s.body), ["alive"]);
  // コメント本文に `>` が含まれる形。ここを「`<!` を見たら次の `>` まで飛ばす」で
  // 済ませると、コメント内の script を実在する要素として拾ってしまう。
  const withGt = `<!-- a > <script>dead${CLOSE} -->\n<script>alive${CLOSE}`;
  assert.deepEqual(scanScriptElements(withGt).inline.map((s) => s.body), ["alive"]);
});

test("閉じタグの変種（</script > </script/>）も本文の終わりとして扱う", () => {
  for (const close of [`</${"script"} >`, `</${"script"}/>`, `</${"script"}>`]) {
    const found = scanScriptElements(`<script>alert(1)${close}`);
    assert.equal(found.inline.length, 1, `閉じタグを認識できていない: ${close}`);
    assert.equal(found.inline[0].body, "alert(1)");
  }
});

test("scriptx のような別のタグを script と誤認しない", () => {
  const html = `<scriptx>x</scriptx><script>alert(1)${CLOSE}`;
  assert.deepEqual(scanScriptElements(html).inline.map((s) => s.body), ["alert(1)"]);
});

test("本文中の </scriptx> は本文の終わりではない", () => {
  // ブラウザは `</script` の直後が空白 / '/' / '>' のときだけ本文を終える。
  // ここを見落とすと本文が途中で切れ、ハッシュが実物と食い違って本番が壊れる。
  const body = `const s = "</${"script"}x>"; alert(1)`;
  const found = scanScriptElements(`<script>${body}${CLOSE}`);
  assert.equal(found.inline.length, 1);
  assert.equal(found.inline[0].body, body, "本文が途中で切れている");
});

test("属性値の中の src= を外部scriptと誤認しない（本文のハッシュが落ちる）", () => {
  // 正規表現で src= を探すと、これを外部scriptと判定して
  // 実際に実行される本文のハッシュを落とす＝そのscriptが本番でブロックされる。
  const html = `<script data-note="x src=/a.js">alert(1)${CLOSE}`;
  const found = scanScriptElements(html);
  assert.equal(found.external, 0, "属性値の文字列を src 属性と誤認している");
  assert.deepEqual(found.inline.map((s) => s.body), ["alert(1)"]);
});

test("タグや raw text の中の <!-- を、HTMLコメントの開始と誤認しない", () => {
  // 誤認すると、そこから "-->" まで飛ばして後続の本物の script を取りこぼす。
  for (const prefix of [
    `<div title="<!--"></div>`,
    `<style>/* <!-- */</style>`,
    `<textarea><!--</textarea>`,
  ]) {
    const found = scanScriptElements(`${prefix}<script>alert(1)${CLOSE}`);
    assert.deepEqual(found.inline.map((s) => s.body), ["alert(1)"], `取りこぼした: ${prefix}`);
  }
});

test("style / textarea の中身をHTMLとして解釈しない", () => {
  const inStyle = `<style>a{content:"<script>"}</style><script>alert(1)${CLOSE}`;
  assert.deepEqual(scanScriptElements(inStyle).inline.map((s) => s.body), ["alert(1)"]);
  const inTextarea = `<textarea><script>dead${CLOSE}</textarea><script>alive${CLOSE}`;
  assert.deepEqual(scanScriptElements(inTextarea).inline.map((s) => s.body), ["alive"]);
});

test("DOCTYPE や処理命令を読み飛ばす", () => {
  assert.deepEqual(
    scanScriptElements(`<!doctype html><script>alert(1)${CLOSE}`).inline.map((s) => s.body),
    ["alert(1)"],
  );
});

test("CRLF でも LF と同じハッシュになる", () => {
  // ブラウザは入力を LF へ正規化してから解析し、CSPはその本文をハッシュする。
  // 揃えないと、ファイルがCRLFになった瞬間に全ハッシュが食い違って本番が壊れる。
  const lf = `<script>a\nb\nc${CLOSE}`;
  assert.deepEqual(inlineScriptHashes(lf), inlineScriptHashes(lf.replace(/\n/g, "\r\n")));
  assert.deepEqual(inlineScriptHashes(lf), inlineScriptHashes(lf.replace(/\n/g, "\r")));
});

test("閉じられていない script / タグは例外にする（黙って続けない）", () => {
  assert.throws(() => scanScriptElements("<script>alert(1)"), /閉じられていない/);
  // EOFで開始タグが閉じない＝タグとして成立しない
  assert.throws(() => scanScriptElements("<script"), /閉じられていないタグ/);
  // 閉じタグが '>' を持たずEOF＝閉じタグとして成立しない
  assert.throws(() => scanScriptElements(`<script>a</${"script"} `), /閉じられていない/);
});

test("同じ本文でも、違う本文とはハッシュが変わる", () => {
  assert.notDeepEqual(inlineScriptHashes(`<script>A${CLOSE}`), inlineScriptHashes(`<script>B${CLOSE}`));
  assert.deepEqual(inlineScriptHashes(`<script>A${CLOSE}`), inlineScriptHashes(`<script defer>A${CLOSE}`));
});

// ---- _headers の script-src 更新 ----
// sync-html.mjs は実行時に副作用（ファイル書き換え）を持つので、
// 更新ロジックだけをソースから取り出して検査する。

const syncSource = readFileSync(join(here, "sync-html.mjs"), "utf8");

function loadUpdater() {
  const start = syncSource.indexOf("const CSP_SCRIPT_SRC =");
  const end = syncSource.indexOf("\n}", syncSource.indexOf("function updateCspScriptSrc"));
  assert.ok(start >= 0 && end > start, "updateCspScriptSrc を取り出せない");
  const src = syncSource.slice(start, end + 2);
  return new Function(`${src}\nreturn updateCspScriptSrc;`)();
}
const updateCspScriptSrc = loadUpdater();

const headersWith = (scriptSrc) =>
  ["# コメント", "/*", "  X-Frame-Options: DENY",
   `  Content-Security-Policy: default-src 'self'; ${scriptSrc} style-src 'self' 'unsafe-inline'`,
   ""].join("\n");

test("script-src を全ハッシュで置き換える", () => {
  const before = headersWith("script-src 'self' 'sha256-OLD' 'wasm-unsafe-eval';");
  const after = updateCspScriptSrc(before, ["'sha256-A'", "'sha256-B'"]);
  assert.ok(after.includes("'sha256-A'"), "1つ目のハッシュが入っていない");
  assert.ok(after.includes("'sha256-B'"), "2つ目のハッシュが入っていない");
  assert.ok(!after.includes("'sha256-OLD'"), "古いハッシュが残っている");
  assert.ok(after.includes("'wasm-unsafe-eval'"), "wasm-unsafe-eval が落ちている");
  assert.ok(after.includes("style-src 'self' 'unsafe-inline'"), "後続のディレクティブを壊している");
});

test("script-src が最後のディレクティブでも（末尾に ; が無くても）更新できる", () => {
  // 以前は `;` を必須にしていたため、並び替えた瞬間に置換が黙って失敗していた。
  const before = ["# コメント", "/*",
    "  Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-OLD' 'wasm-unsafe-eval'",
    ""].join("\n");
  const after = updateCspScriptSrc(before, ["'sha256-A'"]);
  assert.ok(after.includes("'sha256-A'"), "末尾の script-src を更新できていない");
  assert.ok(!after.includes("'sha256-OLD'"), "古いハッシュが残っている");
});

test("script-src が無ければ例外にする（黙って成功扱いにしない）", () => {
  const before = ["/*", "  Content-Security-Policy: default-src 'self'; style-src 'self'", ""].join("\n");
  assert.throws(() => updateCspScriptSrc(before, ["'sha256-A'"]), /script-src/);
});

test("先頭ハッシュが据え置きでも、2つ目以降が古いままにならない", () => {
  // これが以前の穴。「変化なし かつ 先頭ハッシュが本文に無い」を失敗条件に
  // していたため、先頭が一致していると2つ目以降が古いまま成功扱いになった。
  const before = headersWith("script-src 'self' 'sha256-A' 'sha256-STALE' 'wasm-unsafe-eval';");
  const after = updateCspScriptSrc(before, ["'sha256-A'", "'sha256-NEW'"]);
  assert.ok(after.includes("'sha256-NEW'"), "2つ目のハッシュを更新できていない");
  assert.ok(!after.includes("'sha256-STALE'"), "古い2つ目のハッシュが残っている");
});

test("`/*` ブロックのCSPを更新する（別ルールのCSPを先に置き換えない）", () => {
  // 将来 /api/* 用のCSPを先に足したとき、ファイル全体の最初のCSPを対象にすると
  // そちらだけ更新され、ページ用のハッシュが古いまま本番へ出る。
  const before = ["/api/*",
    "  Content-Security-Policy: default-src 'none'; script-src 'none'",
    "",
    "/*",
    "  Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-OLD' 'wasm-unsafe-eval'; style-src 'self'",
    ""].join("\n");
  const after = updateCspScriptSrc(before, ["'sha256-A'"]);
  assert.ok(after.includes("script-src 'none'"), "/api/* 側を書き換えてしまっている");
  assert.ok(after.includes("'sha256-A'"), "/* 側を更新できていない");
  assert.ok(!after.includes("'sha256-OLD'"), "古いハッシュが残っている");
});

test("`/*` ブロックが無ければ例外にする", () => {
  const before = ["/api/*", "  Content-Security-Policy: default-src 'self'; script-src 'self'", ""].join("\n");
  assert.throws(() => updateCspScriptSrc(before, ["'sha256-A'"]), /\/\*/);
});

test("コメント行に script-src と書いてあっても、そこを壊さない", () => {
  // 2026-07-30 に実際に起きた事故。コメント中の script-src を置換して
  // _headers を壊した。Content-Security-Policy 行だけを対象にする。
  // コメントは `/*` ブロックの外と中の両方に置く。中に置かないと、
  // ブロック限定にした時点で「コメントを避けられているか」を検査できない。
  const before = ["# script-src の説明をここに書いている", "/*",
    "  # ここでも script-src の話をしている",
    "  X-Frame-Options: DENY",
    "  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'",
    ""].join("\n");
  const after = updateCspScriptSrc(before, ["'sha256-A'"]);
  assert.ok(after.startsWith("# script-src の説明をここに書いている"), "ブロック外のコメントを壊している");
  assert.ok(after.includes("  # ここでも script-src の話をしている"), "ブロック内のコメントを壊している");
  assert.ok(after.includes("  X-Frame-Options: DENY"), "他のヘッダを壊している");
  assert.ok(after.includes("style-src 'self'"), "後続のディレクティブを壊している");
  assert.ok(after.includes("'sha256-A'"), "CSP行を更新できていない");
});

// ---- 実ファイルとの突き合わせ ----

test("公開版HTMLのハッシュが _headers の script-src と過不足なく一致する", () => {
  const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");
  const headers = readFileSync(join(here, "..", "publish", "_headers"), "utf8");
  const line = headers.split("\n").find((l) => /^\s*Content-Security-Policy:/.test(l));
  assert.ok(line, "_headers に Content-Security-Policy がない");
  const scriptSrc = line.match(/script-src ([^;]*)/)[1].trim().split(/\s+/);
  const inHeaders = new Set(scriptSrc.filter((s) => s.startsWith("'sha256-")));
  const fromHtml = new Set(inlineScriptHashes(html));
  assert.deepEqual(inHeaders, fromHtml, "npm run sync:html を実行してください");
  assert.equal(fromHtml.size, scanScriptElements(html).inline.length,
    "インラインscriptの数とハッシュの数が合わない");
});

test("公開版HTMLの script 要素の数が、閉じタグの数と一致する", () => {
  // 走査が本文中の文字列を要素と誤認していないことの、別の数え方による確認。
  const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");
  const found = scanScriptElements(html);
  const closing = (html.match(/<\/script\b/gi) || []).length;
  assert.equal(found.inline.length + found.external, closing);
});
