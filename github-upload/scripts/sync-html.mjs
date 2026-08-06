import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inlineScriptHashes, scanScriptElements } from "./csp-hashes.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptDir, "..");
const sourcePath = resolve(projectDir, "publish", "index.html");
const targetPath = resolve(projectDir, "..", "index.html");
const headersPath = resolve(projectDir, "publish", "_headers");

// ---- ハッシュ型CSP: インライン<script>のSHA-256を _headers の script-src に反映する ----
// 'unsafe-inline' を使わないことで、XSSで注入されたインラインscriptは
// ハッシュ不一致となりブラウザが実行を拒否する。HTMLを変更するたびに
// このスクリプトがハッシュを再計算するので、手動更新は不要（release checkで照合）。
// 置換は「Content-Security-Policy ヘッダ行の中の script-src」だけを対象にする。
// 以前は最初に見つかった "script-src " を無条件に置き換えていたため、
// コメントに script-src の文字列を書いただけで、そこから次の `;` までを
// 巻き込んで消し、`/*` 行や他のヘッダごと _headers を壊した（2026-07-30に発生）。
// script-src は最後のディレクティブになることもある（末尾に `;` が無い）。
// `;` を必須にしていると、そのときだけ置換に失敗する。
const CSP_SCRIPT_SRC = /^(\s*Content-Security-Policy:[^\n]*?script-src )[^;\n]*(;?)/m;

/**
 * `/*` ルールブロック（＝ページに配信されるヘッダ）の範囲を返す。
 * ファイル全体を対象にすると、将来 `/api/*` 用のCSPを先に足したときに
 * そちらだけ更新され、ページ用のハッシュが古いまま残る。
 */
function pageRuleBlockRange(headersText) {
  const lines = headersText.split("\n");
  const start = lines.findIndex((line) => line.trim() === "/*");
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // 次のルール行（インデントなしの非コメント行）でブロックは終わる
    if (line.trim() !== "" && !/^\s/.test(line) && !line.startsWith("#")) { end = i; break; }
  }
  const offsetOf = (lineIndex) =>
    lines.slice(0, lineIndex).reduce((sum, line) => sum + line.length + 1, 0);
  return { from: offsetOf(start), to: offsetOf(end) };
}

function updateCspScriptSrc(headersText, hashes) {
  const range = pageRuleBlockRange(headersText);
  if (!range) {
    throw new Error("_headers に `/*` のルールブロックが見つかりません。");
  }
  const head = headersText.slice(0, range.from);
  const block = headersText.slice(range.from, range.to);
  const tail = headersText.slice(range.to);

  // 「置換したか」を戻り値の比較で判定してはいけない。
  // 既に同じ内容だったときも「変化なし」になり、置換失敗と区別が付かない。
  // 以前は `変化なし && 先頭ハッシュが本文に無い` を失敗条件にしていたため、
  // 先頭のscriptだけ変わっていない場合に、2番目以降が古いまま成功扱いになった。
  // その状態で出すと、そのscriptだけCSPにブロックされて本番が壊れる。
  if (!CSP_SCRIPT_SRC.test(block)) {
    throw new Error("_headers の `/*` ブロックに Content-Security-Policy の script-src が見つかりません。");
  }
  const updated = block.replace(
    CSP_SCRIPT_SRC,
    `$1'self' ${hashes.join(" ")} 'wasm-unsafe-eval'$2`,
  );
  return head + updated + tail;
}

// 置換で他のヘッダやルートセレクタを壊していないことを確かめる。
// ここが崩れると、防御ヘッダが無いまま本番へ出る。
function assertHeadersIntact(text, label) {
  // ファイル全体を検索すると、ヘッダ行が `/*` ブロックの外へ出ても通ってしまう。
  // Cloudflare は各ルール行の下に続く行だけを、そのパターンへのヘッダとして扱う。
  // 配信されるのは `/*` ブロックの中身なので、その範囲だけを見る。
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === "/*");
  if (start < 0) throw new Error(`_headers が壊れています（${label}）: /* ブロックがありません。`);
  const block = [];
  for (const line of lines.slice(start + 1)) {
    // 次のルール行（インデントなしの非コメント行）でブロックは終わる
    if (line.trim() !== "" && !/^\s/.test(line) && !line.startsWith("#")) break;
    block.push(line);
  }
  const blockText = block.join("\n");
  const required = [
    /^\s+Strict-Transport-Security:\s*max-age=\d{7,}/m,
    /^\s+Referrer-Policy:\s*no-referrer\s*$/m,
    /^\s+X-Content-Type-Options:\s*nosniff\s*$/m,
    /^\s+Permissions-Policy:\s*camera=\(\)/m,
    /^\s+Cross-Origin-Opener-Policy:\s*same-origin\s*$/m,
    /^\s+Cross-Origin-Resource-Policy:\s*same-origin\s*$/m,
    /^\s+X-Frame-Options:\s*DENY\s*$/m,
    /^\s+Content-Security-Policy:\s*default-src 'self';/m,
  ];
  for (const pattern of required) {
    if (!pattern.test(blockText)) {
      throw new Error(
        `_headers が壊れています（${label}）: /* ブロックの中に ${pattern} が見つかりません。`,
      );
    }
  }
}

// HTMLのコピーより先に _headers を確定させる。
// 逆順だと、CSPの計算や検証で落ちたときに「ルートHTMLだけ新しく、_headers は古い」
// 中途半端な状態が残る。その状態をコミットすると、新しいscriptが
// 古いハッシュとしかCSPに載っておらず、本番でブロックされる。
const html = readFileSync(sourcePath, "utf8");
const { inline, external } = scanScriptElements(html);
if (inline.length === 0) {
  throw new Error("インラインscriptが見つかりません。CSPハッシュを更新できませんでした。");
}
const hashes = inlineScriptHashes(html);
const headersBefore = readFileSync(headersPath, "utf8");
assertHeadersIntact(headersBefore, "更新前");
const headersAfter = updateCspScriptSrc(headersBefore, hashes);
// 全ハッシュが載ったことを1件ずつ確かめる。先頭だけ見ると、2番目以降が
// 古いまま通ってしまう（そのscriptだけ本番でブロックされる）。
for (const hash of hashes) {
  if (!headersAfter.includes(hash)) {
    throw new Error(`_headers の script-src にハッシュを反映できませんでした: ${hash}`);
  }
}
assertHeadersIntact(headersAfter, "更新後");
if (headersAfter !== headersBefore) writeFileSync(headersPath, headersAfter);

copyFileSync(sourcePath, targetPath);
if (readFileSync(sourcePath, "utf8") !== readFileSync(targetPath, "utf8")) {
  throw new Error("公開用HTMLとルートHTMLの同期に失敗しました。");
}

const externalNote = external > 0 ? `、外部script ${external}件` : "";
console.log(
  `publish/index.html をルート index.html へ同期しました（CSPハッシュ ${hashes.length}件${externalNote}）。`,
);
