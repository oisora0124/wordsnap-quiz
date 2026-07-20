import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptDir, "..");
const repoDir = resolve(projectDir, "..");
const publishDir = join(projectDir, "publish");

const read = (path) => readFileSync(path, "utf8");
const publicHtmlPath = join(publishDir, "index.html");
const rootHtmlPath = join(repoDir, "index.html");
const manifestPath = join(publishDir, "wordsnap.webmanifest");
const workerPath = join(publishDir, "wordsnap-sw.js");
const apiPath = join(projectDir, "functions", "api", "wordsnap-state.js");
const schemaPath = join(projectDir, "schema.sql");

for (const path of [publicHtmlPath, rootHtmlPath, manifestPath, workerPath, apiPath, schemaPath]) {
  assert.ok(existsSync(path), `required file is missing: ${path}`);
}

const publicHtml = read(publicHtmlPath);
const rootHtml = read(rootHtmlPath);
const worker = read(workerPath);
const api = read(apiPath);
const schema = read(schemaPath);
const manifest = JSON.parse(read(manifestPath));

assert.equal(rootHtml, publicHtml, "root index.html and publish/index.html must be identical");
assert.match(publicHtml, /<title>\s*WordBank\s*<\/title>/i, "WordBank title is missing");
assert.match(publicHtml, /function\s+downloadStandalone\s*\(/, "standalone download function is missing");
const inlineScripts = [...publicHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
assert.ok(inlineScripts.length >= 1, "no inline JavaScript found");
for (const [index, match] of inlineScripts.entries()) {
  assert.doesNotThrow(
    () => new Script(match[1], { filename: `publish/index.html:inline-script-${index + 1}.js` }),
    `inline script ${index + 1} has a syntax error`,
  );
}
assert.doesNotMatch(
  publicHtml,
  /fetch\(["'](?:styles\.css|cefr\.js|enrich\.js|app\.js)["']\)/,
  "standalone download still fetches source files that are not published",
);
assert.match(publicHtml, /sourceUrl\.search\s*=\s*["']["']/, "download source must drop URL query secrets");
assert.match(publicHtml, /sourceUrl\.hash\s*=\s*["']["']/, "download source must drop URL fragments");
assert.match(
  publicHtml,
  /location\.protocol\s*===\s*["']https:["']/,
  "standalone download must be enabled for the published HTTPS app",
);
assert.doesNotMatch(
  publicHtml,
  /document\.querySelector\(["']link\[rel=[\\"']stylesheet/,
  "legacy visibility check still hides the standalone download in the bundled app",
);
assert.match(
  publicHtml,
  /function\s+forcePullReplace[\s\S]*?offerUndo\(localSnapshot\)/,
  "force-pull replacement must offer restoration of the previous local state",
);
assert.match(publicHtml, /wordsnap-undo:v1:/, "undo checkpoint storage key is missing");
assert.match(
  publicHtml,
  /function\s+offerUndo[\s\S]*?localStorage\.setItem\(UNDO_STORAGE_KEY/,
  "undo checkpoint must be durable in local storage",
);
assert.match(
  publicHtml,
  /let\s+undoSnapshot\s*=\s*readLocalUndoSnapshot\(\)/,
  "durable undo checkpoint must be recovered during startup",
);

// 実際の保存処理と同じ変換を行い、生成後HTMLも構文・参照・秘密情報を検査する。
let standaloneHtml = publicHtml.replace(/\s*<link\b[^>]*rel=["']manifest["'][^>]*>/i, "");
for (const assetPath of ["assets/wordsnap-icon-light.png", "assets/wordsnap-icon-dark.png"]) {
  const dataUrl = `data:image/png;base64,${readFileSync(join(publishDir, assetPath)).toString("base64")}`;
  standaloneHtml = standaloneHtml.split(assetPath).join(dataUrl);
}
assert.doesNotMatch(standaloneHtml, /rel=["']manifest["']/i, "standalone HTML still has a manifest");
assert.doesNotMatch(
  standaloneHtml,
  /assets\/wordsnap-icon-(?:light|dark)\.png/,
  "standalone HTML still has external theme icon references",
);
const standaloneScripts = [...standaloneHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
for (const [index, match] of standaloneScripts.entries()) {
  assert.doesNotThrow(
    () => new Script(match[1], { filename: `standalone:inline-script-${index + 1}.js` }),
    `standalone inline script ${index + 1} has a syntax error`,
  );
}

assert.equal(manifest.name, "WordBank", "manifest name must be WordBank");
assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, "manifest icons are incomplete");
for (const icon of manifest.icons) {
  assert.ok(icon && typeof icon.src === "string", "manifest icon src is invalid");
  assert.ok(existsSync(join(publishDir, icon.src)), `manifest icon is missing: ${icon.src}`);
}

assert.match(worker, /const\s+CACHE_NAME\s*=\s*["']wordsnap-v\d+["']/, "versioned cache name is missing");
assert.match(worker, /const\s+CACHE_NAME\s*=\s*["']wordsnap-v5["']/, "service worker cache version must be v5");
assert.doesNotMatch(
  worker,
  /["']\.\/wordsnap-quiz\.html["']/,
  "service worker references a file that is not published",
);
assert.match(
  worker,
  /new\s+URL\(["']\.\/["'],\s*self\.registration\.scope\)\.href/,
  "navigation cache key must be normalized without sync-key query parameters",
);
assert.match(
  worker,
  /cache\.put\(navigationCacheUrl,\s*copy\)[\s\S]*?\.catch\(\(\)\s*=>\s*\{\}\)[\s\S]*?\.then\(\(\)\s*=>\s*response\)/,
  "navigation cache write must finish without breaking a valid network response",
);
assert.match(
  worker,
  /cache\.put\(request,\s*copy\)[\s\S]*?\.catch\(\(\)\s*=>\s*\{\}\)[\s\S]*?\.then\(\(\)\s*=>\s*response\)/,
  "asset cache write must finish without breaking a valid network response",
);
for (const requiredAsset of ["./", "./wordsnap.webmanifest", "./assets/icon-192.png", "./assets/icon-512.png"]) {
  assert.ok(worker.includes(JSON.stringify(requiredAsset)), `service worker precache is missing ${requiredAsset}`);
}

for (const column of ["key", "state", "rev", "updatedAt"]) {
  assert.match(schema, new RegExp(`\\b${column}\\b`), `D1 schema is missing ${column}`);
}
assert.match(schema, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+states/i, "D1 states table is missing");
assert.match(api, /env\.DB/, "API must require the DB binding");
assert.match(api, /RETURNING\s+rev,\s*updatedAt/i, "API atomic revision result is missing");
assert.match(api, /MAX_RAW_BODY/, "API body-size guard is missing");
assert.match(api, /MAX_INFLATED_JSON/, "API inflated-size guard is missing");
assert.match(api, /MAX_STORED_BASE64/, "API D1 row-size guard is missing");

// Detect only realistic ASCII secrets, not the UI's abbreviated placeholders (AIza… / gsk_…).
const scanned = [publicHtml, rootHtml, standaloneHtml, worker, api, schema].join("\n");
assert.doesNotMatch(scanned, /AIza[0-9A-Za-z_-]{30,}/, "possible Gemini API key committed");
assert.doesNotMatch(scanned, /gsk_[0-9A-Za-z]{30,}/, "possible Groq API key committed");
assert.doesNotMatch(scanned, /ws_[0-9a-f]{60}\b/i, "possible real WordBank sync key committed");

console.log("WordBank release checks passed.");
