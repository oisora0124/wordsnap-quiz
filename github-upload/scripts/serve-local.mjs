#!/usr/bin/env node
// publish/ をローカルへ配信する検証用サーバ。
//
// なぜ要るか:
//   実ブラウザでの通し確認を**本番サイトでやってはいけない**。
//   本番を開くと利用者の実データ（個人キー・進捗）に触れてしまう。
//   localhost なら localStorage も Service Worker も別スコープになり、
//   実データに一切影響しない。
//
// 本番へ寄せてある点:
//   - `publish/_headers` の `/*` ブロックのヘッダを**そのまま**返す。
//     CSPを外して確認すると「本番だけ壊れる」型の不具合を見逃す。
//   - localhost は Service Worker の登録が許される（https と同じ扱い）。
//
// 本番と違う点（把握して使うこと）:
//   - `/api/*` は Pages Functions なのでここには無い。同期は失敗する。
//     同期まで見るなら wrangler pages dev を使う。
//   - 圧縮・キャッシュヘッダは付けない。
//
// 使い方:
//   node scripts/serve-local.mjs [ポート]     既定 8788
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const publishDir = join(here, "..", "publish");
const port = Number(process.argv[2] || 8788);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".traineddata": "application/octet-stream",
  ".gz": "application/octet-stream",
};

/** `_headers` の `/*` ブロックを読み、本番と同じヘッダを再現する。 */
function productionHeaders() {
  const text = readFileSync(join(publishDir, "_headers"), "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === "/*");
  if (start < 0) throw new Error("_headers に /* ブロックが無い");
  const headers = {};
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    if (!/^\s/.test(line)) break; // 次のルール行
    const at = line.indexOf(":");
    if (at < 0) continue;
    headers[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return headers;
}

const baseHeaders = productionHeaders();

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  let path = decodeURIComponent(url.pathname);

  // /api/* はここには無い。本番との違いを黙って隠さず、はっきり返す。
  if (path.startsWith("/api/")) {
    res.writeHead(501, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "local server has no Pages Functions" }));
    return;
  }

  if (path === "/" || path.endsWith("/")) path += "index.html";
  // publish/ の外へ出さない。
  const target = normalize(join(publishDir, path));
  if (!target.startsWith(publishDir)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    // SPA ではないが、ナビゲーションは index.html へ寄せる（本番の挙動に合わせる）
    const fallback = join(publishDir, "index.html");
    res.writeHead(200, { ...baseHeaders, "content-type": TYPES[".html"] });
    res.end(readFileSync(fallback));
    return;
  }
  res.writeHead(200, {
    ...baseHeaders,
    "content-type": TYPES[extname(target)] || "application/octet-stream",
  });
  res.end(readFileSync(target));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`publish/ を http://localhost:${port}/ で配信中`);
  console.log(`  本番と同じヘッダを付与: ${Object.keys(baseHeaders).join(", ")}`);
  console.log("  /api/* は 501（Pages Functions はローカルに無い）");
});
