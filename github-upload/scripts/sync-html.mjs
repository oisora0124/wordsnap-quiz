import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inlineScriptHashes } from "./csp-hashes.mjs";

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
function updateCspScriptSrc(headersText, hashes) {
  const replaced = headersText.replace(
    /^(\s*Content-Security-Policy:[^\n]*?script-src )[^;]*(;)/m,
    `$1'self' ${hashes.join(" ")} 'wasm-unsafe-eval'$2`,
  );
  if (replaced === headersText && !headersText.includes(hashes[0])) {
    throw new Error("_headers に Content-Security-Policy の script-src が見つかりません。");
  }
  return replaced;
}

// 置換で他のヘッダやルートセレクタを壊していないことを確かめる。
// ここが崩れると、防御ヘッダが無いまま本番へ出る。
function assertHeadersIntact(text, label) {
  const required = [
    /^\/\*$/m,
    /^\s*Strict-Transport-Security:/m,
    /^\s*Referrer-Policy:\s*no-referrer\s*$/m,
    /^\s*X-Content-Type-Options:\s*nosniff\s*$/m,
    /^\s*Permissions-Policy:/m,
    /^\s*Cross-Origin-Opener-Policy:/m,
    /^\s*Cross-Origin-Resource-Policy:/m,
    /^\s*X-Frame-Options:\s*DENY\s*$/m,
    /^\s*Content-Security-Policy:/m,
  ];
  for (const pattern of required) {
    if (!pattern.test(text)) {
      throw new Error(`_headers が壊れています（${label}）: ${pattern} が見つかりません。`);
    }
  }
}

copyFileSync(sourcePath, targetPath);

if (readFileSync(sourcePath, "utf8") !== readFileSync(targetPath, "utf8")) {
  throw new Error("公開用HTMLとルートHTMLの同期に失敗しました。");
}

const html = readFileSync(sourcePath, "utf8");
const hashes = inlineScriptHashes(html);
if (hashes.length === 0) throw new Error("インラインscriptが見つかりません。CSPハッシュを更新できませんでした。");
const headersBefore = readFileSync(headersPath, "utf8");
assertHeadersIntact(headersBefore, "更新前");
const headersAfter = updateCspScriptSrc(headersBefore, hashes);
if (!headersAfter.includes(hashes[0])) throw new Error("_headers の script-src を更新できませんでした。");
assertHeadersIntact(headersAfter, "更新後");
if (headersAfter !== headersBefore) writeFileSync(headersPath, headersAfter);

console.log(`publish/index.html をルート index.html へ同期しました（CSPハッシュ ${hashes.length}件）。`);
