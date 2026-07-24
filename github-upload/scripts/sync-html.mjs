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
function updateCspScriptSrc(headersText, hashes) {
  return headersText.replace(
    /(script-src )[^;]*(;)/,
    `$1'self' ${hashes.join(" ")} 'wasm-unsafe-eval' https://cdn.jsdelivr.net$2`,
  );
}

copyFileSync(sourcePath, targetPath);

if (readFileSync(sourcePath, "utf8") !== readFileSync(targetPath, "utf8")) {
  throw new Error("公開用HTMLとルートHTMLの同期に失敗しました。");
}

const html = readFileSync(sourcePath, "utf8");
const hashes = inlineScriptHashes(html);
if (hashes.length === 0) throw new Error("インラインscriptが見つかりません。CSPハッシュを更新できませんでした。");
const headersBefore = readFileSync(headersPath, "utf8");
const headersAfter = updateCspScriptSrc(headersBefore, hashes);
if (!headersAfter.includes(hashes[0])) throw new Error("_headers の script-src を更新できませんでした。");
if (headersAfter !== headersBefore) writeFileSync(headersPath, headersAfter);

console.log(`publish/index.html をルート index.html へ同期しました（CSPハッシュ ${hashes.length}件）。`);
