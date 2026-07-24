import { createHash } from "node:crypto";

// HTML内の全インライン<script>本体のSHA-256をCSPソース形式で返す。
// sync-html.mjs（_headersの自動更新）と check-release.mjs（照合）で共用する。
export function inlineScriptHashes(html) {
  const hashes = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  for (let m; (m = re.exec(html)); ) {
    hashes.push(`'sha256-${createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
  }
  return hashes;
}
