import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
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
const headersPath = join(publishDir, "_headers");
const apiPath = join(projectDir, "functions", "api", "wordsnap-state.js");
const schemaPath = join(projectDir, "schema.sql");
const distributionPath = join(repoDir, "DISTRIBUTION.md");
const reviewEventSchemaPath = join(projectDir, "schemas", "review-event.schema.json");
const lexicalShadowSchemaPath = join(projectDir, "schemas", "lexical-shadow.schema.json");

for (const path of [
  publicHtmlPath, rootHtmlPath, manifestPath, workerPath, headersPath, apiPath, schemaPath, distributionPath,
  reviewEventSchemaPath, lexicalShadowSchemaPath,
]) {
  assert.ok(existsSync(path), `required file is missing: ${path}`);
}

const publicHtml = read(publicHtmlPath);
const rootHtml = read(rootHtmlPath);
const worker = read(workerPath);
const headers = read(headersPath);
const api = read(apiPath);
const schema = read(schemaPath);
const distribution = read(distributionPath);
const reviewEventSchema = JSON.parse(read(reviewEventSchemaPath));
const lexicalShadowSchema = JSON.parse(read(lexicalShadowSchemaPath));
const manifest = JSON.parse(read(manifestPath));

assert.equal(reviewEventSchema.additionalProperties, false,
  "review-event shadow schema must reject unspecified data collection fields");
assert.ok(reviewEventSchema.required.includes("result") && reviewEventSchema.required.includes("occurredAt"),
  "review-event shadow schema is missing its outcome or timestamp");
assert.equal(lexicalShadowSchema.additionalProperties, false,
  "lexical shadow schema must reject unspecified fields");
assert.ok(lexicalShadowSchema.required.includes("approvalStatus"),
  "lexical shadow records must include an approval state");
assert.ok(lexicalShadowSchema.required.includes("provenance") &&
    lexicalShadowSchema.properties.provenance.minItems === 1,
  "lexical shadow records must include at least one provenance entry");
assert.deepEqual(lexicalShadowSchema.properties.provenance.items.properties.licenseStatus.enum,
  ["verified", "user-provided", "not-required"],
  "lexical provenance must not accept an unverified license state");

assert.match(distribution, /公開版では自動発行される個人キーに紐づけてWordBankの同期サーバーにも保存/,
  "distribution guide must disclose automatic server sync");
assert.doesNotMatch(distribution, /同期を使わなければ、データはその端末から出ません/,
  "distribution guide still claims that public data stays only on the device");
for (const model of ["gemini-3.5-flash", "qwen/qwen3.6-27b"]) {
  assert.ok(publicHtml.includes(model), `app model configuration is missing ${model}`);
  assert.ok(distribution.includes(model), `distribution guide is out of sync for ${model}`);
}

assert.equal(rootHtml, publicHtml, "root index.html and publish/index.html must be identical");
assert.match(headers, /^\/\*[\s\S]*?Referrer-Policy:\s*no-referrer\s*$/m,
  "Cloudflare static responses must suppress referrers before the HTML meta policy is parsed");
assert.match(headers, /^\s*X-Content-Type-Options:\s*nosniff\s*$/mi,
  "Cloudflare static responses must disable MIME type sniffing");
const cspHeader = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/mi)?.[1];
assert.ok(cspHeader, "Cloudflare static responses must include a Content-Security-Policy");
const cspDirectives = new Map(
  cspHeader
    .split(";")
    .map((directive) => directive.trim().split(/\s+/))
    .filter((parts) => parts[0])
    .map(([name, ...sources]) => [name.toLowerCase(), sources]),
);
assert.deepEqual(cspDirectives.get("object-src"), ["'none'"],
  "Content-Security-Policy must disable object embeds");
assert.deepEqual(cspDirectives.get("frame-ancestors"), ["'none'"],
  "Content-Security-Policy must prevent framing");

// HTML内の外部オリジンをすべて拾い、単なる外部ナビゲーション以外がCSPに含まれることを保証する。
const htmlExternalOrigins = new Set(
  [...publicHtml.matchAll(/https:\/\/[a-z0-9.-]+/gi)].map((match) => new URL(match[0]).origin),
);
const navigationOnlyOrigins = new Set([
  "https://aistudio.google.com",
  "https://console.groq.com",
  "https://www.etymonline.com",
  "https://en.wiktionary.org",
  "https://www.google.com",
  "https://wordbank.pages.dev",
]);
const cspExternalOrigins = new Set(
  [...cspHeader.matchAll(/https:\/\/[a-z0-9.-]+/gi)].map((match) => new URL(match[0]).origin),
);
for (const origin of htmlExternalOrigins) {
  if (navigationOnlyOrigins.has(origin)) continue;
  assert.ok(cspExternalOrigins.has(origin),
    `external resource origin is missing from Content-Security-Policy: ${origin}`);
}
const scriptSources = new Set(cspDirectives.get("script-src") || []);
assert.ok(scriptSources.has("https://cdn.jsdelivr.net"),
  "Tesseract.js CDN must be allowed by script-src");
assert.ok(scriptSources.has("'wasm-unsafe-eval'"),
  "Tesseract WebAssembly compilation must be allowed by script-src");
const workerSources = new Set(cspDirectives.get("worker-src") || []);
assert.ok(workerSources.has("'self'") && workerSources.has("blob:"),
  "Service Worker and Tesseract blob workers must be allowed by worker-src");
const connectSources = new Set(cspDirectives.get("connect-src") || []);
for (const origin of [
  "https://api.datamuse.com",
  "https://api.dictionaryapi.dev",
  "https://translate.googleapis.com",
  "https://api.mymemory.translated.net",
  "https://generativelanguage.googleapis.com",
  "https://api.groq.com",
  "https://cdn.jsdelivr.net",
  "https://tessdata.projectnaptha.com",
]) {
  assert.ok(connectSources.has(origin),
    `runtime connection origin is missing from connect-src: ${origin}`);
}
assert.match(publicHtml, /<title>\s*WordBank\s*<\/title>/i, "WordBank title is missing");
assert.doesNotMatch(publicHtml, /WordSnap\s+単語帳/,
  "the OS share title still exposes the retired WordSnap product name");
const staticMarkup = publicHtml.slice(0, publicHtml.indexOf("<script>"));
const staticIds = [...staticMarkup.matchAll(/\sid=(["'])([^"']+)\1/g)].map((match) => match[2]);
assert.equal(new Set(staticIds).size, staticIds.length,
  "static HTML contains duplicate ids that can bind controls to the wrong element");
const staticIdSet = new Set(staticIds);
for (const match of staticMarkup.matchAll(/\sfor=(["'])([^"']+)\1/g)) {
  assert.ok(staticIdSet.has(match[2]), `label references a missing control id: ${match[2]}`);
}
for (const attribute of ["aria-labelledby", "aria-describedby", "aria-controls"]) {
  const pattern = new RegExp(`\\s${attribute}=(["'])([^"']+)\\1`, "g");
  for (const match of staticMarkup.matchAll(pattern)) {
    for (const id of match[2].trim().split(/\s+/)) {
      assert.ok(staticIdSet.has(id), `${attribute} references a missing id: ${id}`);
    }
  }
}
for (const id of ["quizRangeToggle", "quizSetupHintToggle", "trashToggleButton"]) {
  const control = staticMarkup.match(new RegExp(`<button\\b[^>]*\\bid=["']${id}["'][^>]*>`, "i"));
  assert.ok(control && /\baria-expanded=["']false["']/i.test(control[0]) &&
    /\baria-controls=["'][^"']+["']/i.test(control[0]),
  `${id} must expose both its collapsed state and controlled region`);
}
const streakBadge = staticMarkup.match(
  /<button\b[^>]*\bid=["']streakBadge["'][^>]*>/i,
)?.[0] || "";
assert.match(streakBadge, /\btitle=["']連続学習 0日["']/i,
  "the streak badge must expose its initial day count in the title");
assert.match(streakBadge, /\baria-label=["']連続学習 0日["']/i,
  "the streak badge must expose its initial day count to assistive technology");
assert.match(publicHtml,
  /const\s+streakLabel\s*=\s*`連続学習\s+\$\{streak\.count\}日`[\s\S]*?badge\.title\s*=\s*streakLabel[\s\S]*?badge\.setAttribute\(["']aria-label["'],\s*streakLabel\)/,
  "the streak badge title and aria-label must track the current streak count");
const tutorialDialog = staticMarkup.match(/<section\b[^>]*\bid=["']tutorialDialog["'][^>]*>/i)?.[0] || "";
assert.match(tutorialDialog, /\brole=["']dialog["']/i,
  "the onboarding tutorial must expose dialog semantics");
assert.match(tutorialDialog, /\baria-modal=["']true["']/i,
  "the onboarding tutorial must be announced as modal");
const tutorialContent = staticMarkup.match(/<div\b[^>]*\bid=["']tutorialContent["'][^>]*>/i)?.[0] || "";
assert.match(tutorialContent, /\baria-live=["']polite["']/i,
  "tutorial step changes must be announced to screen readers");
assert.match(tutorialContent, /\baria-atomic=["']true["']/i,
  "tutorial step announcements must include the complete step");
const safeShareToggle = staticMarkup.match(
  /<button\b[^>]*\bid=["']safeShareToggleButton["'][^>]*>/i,
)?.[0] || "";
// 既定はコンパクト表示（詳細は閉じている）。一行警告は常時表示なので false が正。
assert.match(safeShareToggle, /\baria-expanded=["']false["']/i,
  "the safe-share warning toggle must expose its initial (collapsed) state");
assert.match(safeShareToggle, /\baria-controls=["']safeShareWarning["']/i,
  "the safe-share warning toggle must identify its controlled warning");
for (const match of staticMarkup.matchAll(/<button\b[^>]*>/gi)) {
  assert.match(match[0], /\btype=["']button["']/i,
    "a static button is missing type=button and may submit a future form unexpectedly");
}
for (const match of staticMarkup.matchAll(/<img\b[^>]*>/gi)) {
  assert.match(match[0], /\balt=["'][^"']*["']/i, "a static image is missing alt text");
}
for (const match of staticMarkup.matchAll(/<a\b[^>]*\btarget=["']_blank["'][^>]*>/gi)) {
  assert.match(match[0], /\brel=["'][^"']*\bnoopener\b[^"']*["']/i,
    "a target=_blank link is missing rel=noopener");
}
assert.match(
  publicHtml,
  /<meta\s+name=["']referrer["']\s+content=["']no-referrer["']\s*\/?>/i,
  "sync keys in the page URL must not be sent as referrers",
);
assert.match(publicHtml, /function\s+downloadStandalone\s*\(/, "standalone download function is missing");
assert.match(publicHtml, /const\s+STANDALONE_DOWNLOAD_TIMEOUT_MS\s*=\s*60\s*\*\s*1000/,
  "standalone download must have a bounded timeout");
assert.match(publicHtml, /fetch\(sourceUrl,\s*{\s*cache:\s*["']no-store["'],\s*signal:\s*controller\.signal\s*}\)/,
  "standalone source download must use the timeout signal");
assert.match(publicHtml, /clearTimeout\(timeout\)[\s\S]*?function\s+storageKeyFor/,
  "standalone download timeout must be cleared after completion");
const sampleMatch = publicHtml.match(/const\s+SAMPLE_TEXT\s*=\s*`([\s\S]*?)`;/);
assert.ok(sampleMatch, "built-in vocabulary sample is missing");
const sampleRows = sampleMatch[1]
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const separator = line.indexOf(" ");
    return {
      valid: separator > 0,
      term: separator > 0 ? line.slice(0, separator).trim().toLowerCase() : "",
      meaning: separator > 0 ? line.slice(separator + 1).trim() : "",
    };
  });
assert.equal(sampleRows.length, 300, "built-in sample must contain exactly 300 valid rows");
assert.ok(sampleRows.every((row) => row.valid && row.term && row.meaning),
  "built-in sample contains a malformed row or an empty term/meaning");
assert.equal(new Set(sampleRows.map((row) => row.term)).size, sampleRows.length,
  "built-in sample contains duplicate terms");
assert.equal(new Set(sampleRows.map((row) => row.meaning)).size, sampleRows.length,
  "built-in sample contains duplicate meanings that weaken multiple-choice questions");
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
assert.match(publicHtml, /function\s+downloadBlob[\s\S]*?document\.body\.append\(link\)[\s\S]*?link\.click\(\)[\s\S]*?link\.remove\(\)[\s\S]*?setTimeout\(\(\)\s*=>\s*URL\.revokeObjectURL\(objectUrl\),\s*0\)/,
  "blob downloads must remain attached until the browser has accepted the save action");
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
  const iconPath = join(publishDir, icon.src);
  assert.ok(existsSync(iconPath), `manifest icon is missing: ${icon.src}`);
  assert.equal(icon.type, "image/png", `manifest icon must declare PNG: ${icon.src}`);
  const png = readFileSync(iconPath);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a",
    `manifest icon is not a valid PNG: ${icon.src}`);
  const expectedSize = String(icon.sizes || "").match(/^(\d+)x(\d+)$/);
  assert.ok(expectedSize, `manifest icon has an invalid sizes value: ${icon.src}`);
  assert.equal(png.readUInt32BE(16), Number(expectedSize[1]),
    `manifest icon width does not match its declaration: ${icon.src}`);
  assert.equal(png.readUInt32BE(20), Number(expectedSize[2]),
    `manifest icon height does not match its declaration: ${icon.src}`);
}

assert.match(worker, /const\s+CACHE_NAME\s*=\s*["']wordsnap-v\d+["']/, "versioned cache name is missing");
assert.match(worker, /const\s+CACHE_NAME\s*=\s*["']wordsnap-v6["']/, "service worker cache version must be v6");
assert.match(
  worker,
  /cache\s*\.add\(CORE_PRECACHE_URL\)[\s\S]*?\.then\(\(\)\s*=>\s*Promise\.allSettled/,
  "service worker must fetch the core app before accepting optional precache failures",
);
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

function serviceWorkerInstallHarness(failUrl = null) {
  const handlers = {};
  const added = [];
  let skipped = false;
  const sandbox = {
    URL,
    fetch: async () => ({ ok: true, clone() { return this; } }),
    caches: {
      open: async () => ({
        add: async (url) => {
          added.push(url);
          if (url === failUrl) throw new Error(`precache failed: ${url}`);
        },
        put: async () => {},
      }),
      keys: async () => [],
      delete: async () => true,
      match: async () => null,
    },
    self: {
      addEventListener(type, handler) { handlers[type] = handler; },
      skipWaiting: async () => { skipped = true; },
      clients: { claim: async () => {} },
      location: { origin: "https://wordbank.pages.dev" },
      registration: { scope: "https://wordbank.pages.dev/" },
    },
  };
  new Script(worker, { filename: "wordsnap-sw.js" }).runInNewContext(sandbox);
  let installPromise;
  handlers.install({ waitUntil(promise) { installPromise = promise; } });
  return { added, installPromise, wasSkipped: () => skipped };
}

const failedCoreInstall = serviceWorkerInstallHarness("./");
await assert.rejects(failedCoreInstall.installPromise, /precache failed/,
  "a failed core precache must reject service-worker installation");
assert.equal(failedCoreInstall.wasSkipped(), false,
  "a failed core precache must not activate the incomplete worker");
assert.deepEqual(failedCoreInstall.added, ["./"],
  "optional assets must not be fetched after the core app failed");

const failedOptionalInstall = serviceWorkerInstallHarness("./assets/icon-192.png");
await assert.doesNotReject(failedOptionalInstall.installPromise,
  "an optional asset failure must not block an otherwise usable update");
assert.equal(failedOptionalInstall.wasSkipped(), true,
  "a worker with the core app cached should be allowed to activate");

// 学習状態は既存利用者の履歴へ直接影響するため、HTML内の実関数を固定入力で回帰検査する。
const learningStart = publicHtml.indexOf("function scheduleReview(");
const learningEnd = publicHtml.indexOf("\nfunction shuffle(", learningStart);
assert.ok(learningStart >= 0 && learningEnd > learningStart, "learning scheduler source is missing");
const learningSandbox = {};
new Script(
  "const SRS_DAY_MS = 86400000;\n" +
    "const SRS_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60, 120];\n" +
    "const SLOW_ANSWER_MS = 5000;\n" +
    "const MAX_TIMED_ANSWER_MS = 60000;\n" +
    // 個人適応SRSは既定OFF。OFF時に従来の間隔・判定と完全一致することを、
    // この回帰検査がそのまま保証し続ける。係数関数のスタブは「呼ばれたら例外」にして、
    // OFF経路が履歴走査へ一切入らないことも同時に証明する。
    "const FAST_ANSWER_MS = 3000;\n" +
    "const adaptiveSrsEnabled = () => false;\n" +
    "const adaptiveSrsMultiplier = () => { throw new Error('adaptive multiplier must not run while OFF'); };\n" +
    "const wordAccuracyFactor = () => { throw new Error('word factor must not run while OFF'); };\n" +
    "const personalAccuracyFactorCached = () => { throw new Error('personal factor must not run while OFF'); };\n" +
    "const appState = { quizCounter: 10 };\n" +
    "Math.random = () => 0.5;\n" +
    `${publicHtml.slice(learningStart, learningEnd)}\n` +
    "globalThis.__learning = { applyLearningResult };",
  { filename: "learning-scheduler-check.js" },
).runInNewContext(learningSandbox);
const now = 1_700_000_000_000;
const learningWord = {
  learning: {
    status: "new", firstAttempted: false, reviewAt: 0, correctStreak: 0,
    srsStage: 0, nextReviewAt: 0, srsUpdatedAt: 0, lastSrsResult: "",
  },
};
learningSandbox.__learning.applyLearningResult(learningWord, true, false, now, { responseMs: 1000 });
assert.equal(learningWord.learning.status, "review", "one correct answer must not immediately master a word");
assert.equal(learningWord.learning.correctStreak, 1, "the first correct answer must start a streak");
assert.equal(learningWord.learning.nextReviewAt, now + 86_400_000,
  "the first correct answer must start the one-day SRS stage");
learningSandbox.__learning.applyLearningResult(learningWord, true, false, now + 1000, { responseMs: 1000 });
assert.equal(learningWord.learning.status, "mastered", "two consecutive fast correct answers must master a word");
assert.equal(Object.hasOwn(learningWord.learning, "masteryVerify"), false,
  "ordinary multiple-choice mastery must not acquire a flashcard verification marker");

learningWord.learning.srsStage = 5;
learningSandbox.__learning.applyLearningResult(learningWord, false, true, now + 2000, { responseMs: 1000 });
assert.equal(learningWord.learning.status, "review", "a wrong answer must return a word to review");
assert.equal(learningWord.learning.srsStage, 3, "a wrong answer must reduce the SRS stage by two");
assert.equal(learningWord.learning.correctStreak, 0, "a wrong answer must reset the correct streak");

const mergeLearningStart = publicHtml.indexOf("function mergeLearningState(");
const mergeLearningEnd = publicHtml.indexOf("\nfunction applyMergedRemoteState(", mergeLearningStart);
assert.ok(mergeLearningStart >= 0 && mergeLearningEnd > mergeLearningStart,
  "learning merge source is missing");
const mergeLearningSandbox = {};
new Script(
  "const SRS_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60, 120];\n" +
    `${publicHtml.slice(mergeLearningStart, mergeLearningEnd)}\n` +
    "globalThis.__mergeLearning = mergeLearningState;",
  { filename: "learning-merge-check.js" },
).runInNewContext(mergeLearningSandbox);
const mergeNow = Date.now();
const invalidFuture = {
  status: "mastered", srsStage: 7, srsUpdatedAt: mergeNow + 60 * 60 * 1000,
  nextReviewAt: mergeNow + 120 * 86_400_000, lastSrsResult: "correct",
};
const validRecent = {
  status: "review", srsStage: 2, srsUpdatedAt: mergeNow - 1000,
  nextReviewAt: mergeNow + 86_400_000, lastSrsResult: "wrong",
};
const mergedLearning = mergeLearningSandbox.__mergeLearning(invalidFuture, validRecent);
assert.equal(mergedLearning.status, "review",
  "a far-future device clock must not override a valid recent learning result");
assert.equal(mergedLearning.srsUpdatedAt, validRecent.srsUpdatedAt,
  "a far-future learning timestamp must not survive synchronization");

// 削除墓標は複数端末マージのデータ保護境界。実際の mergeAppStates を固定状態で動かし、
// 削除語の復活防止と、別デッキの同名語を巻き込まないことを同時に確認する。
const mergeStateStart = publicHtml.indexOf("function mergeAppStates(");
const mergeStateEnd = publicHtml.indexOf("\nfunction applyMergedRemoteState(", mergeStateStart);
assert.ok(mergeStateStart >= 0 && mergeStateEnd > mergeStateStart,
  "application-state merge source is missing");
const mergeStateSandbox = {};
new Script(
  "const LEARNING_SCHEMA_VERSION = 1;\n" +
    "const SRS_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30, 60, 120];\n" +
    "const defaultState = () => ({ words: [], decks: [] });\n" +
    "const createId = () => 'generated-id';\n" +
    "const sanitizeId = (value) => String(value || '').replace(/[^A-Za-z0-9_-]/g, '') || createId();\n" +
    "const normalizeTerm = (value) => String(value || '').replace(/[()[\\]{}]/g, ' ').replace(/\\s+/g, ' ').trim().toLowerCase();\n" +
    "const deletionKeyForWord = (word) => `${word.deckId || ''} ${normalizeTerm(word.term)}`;\n" +
    "const wordAddedMs = (word) => { const ms = Date.parse(word.addedAt); return Number.isNaN(ms) ? 0 : ms; };\n" +
    "const trashKeyForWord = (word) => `${word.deckId || ''}:${normalizeTerm(word.term)}`;\n" +
    "const sanitizeTrash = () => [];\n" +
    "const mergeStreaks = (a, b) => a || b || {};\n" +
    "const emptyEnrich = () => ({ examples: null, etymology: null, synonyms: null, collocations: null });\n" +
    "const normalizeState = (value) => value;\n" +
    `${publicHtml.slice(mergeStateStart, mergeStateEnd)}\n` +
    "globalThis.__mergeAppStates = mergeAppStates;",
  { filename: "application-state-merge-check.js" },
).runInNewContext(mergeStateSandbox);
const mergeDeckA = { id: "deck-a", name: "A", updatedAt: 0 };
const mergeDeckB = { id: "deck-b", name: "B", updatedAt: 0 };
const mergeWordFixture = (id, deckId, addedAt) => ({
  id, deckId, term: "apple", meaning: "りんご", addedAt,
  stats: { correct: 0, wrong: 0 }, history: [], enrich: {},
  learning: { status: "new", srsUpdatedAt: 0 },
});
const mergeStateFixture = (words, decks, deletions = {}) => ({
  learningSchemaVersion: 1, words, decks, deletions, trash: [], streak: {},
  quizCounter: 0, activeDeckId: "all", savedAt: 0,
});
const oldAddedAt = "2026-07-20T00:00:00.000Z";
const newAddedAt = "2026-07-20T02:00:00.000Z";
const deletedAt = Date.parse("2026-07-20T01:00:00.000Z");
const mergeStates = (local, remote) =>
  mergeStateSandbox.__mergeAppStates(local, remote, { normalized: true });

const deletedMerge = mergeStates(
  mergeStateFixture([mergeWordFixture("old-a", "deck-a", oldAddedAt)], [mergeDeckA]),
  mergeStateFixture([], [mergeDeckA], { "deck-a apple": deletedAt }),
);
assert.equal(deletedMerge.words.length, 0,
  "a newer composite tombstone must prevent a deleted word from returning during merge");

const crossDeckLegacyMerge = mergeStates(
  mergeStateFixture([
    mergeWordFixture("old-a", "deck-a", oldAddedAt),
    mergeWordFixture("old-b", "deck-b", oldAddedAt),
  ], [mergeDeckA, mergeDeckB]),
  mergeStateFixture([], [mergeDeckA, mergeDeckB], { apple: deletedAt }),
);
assert.equal(crossDeckLegacyMerge.words.length, 2,
  "a legacy term-only tombstone must not delete same-term words from multiple decks");

const oneDeckDeletedMerge = mergeStates(
  mergeStateFixture([
    mergeWordFixture("old-a", "deck-a", oldAddedAt),
    mergeWordFixture("old-b", "deck-b", oldAddedAt),
  ], [mergeDeckA, mergeDeckB]),
  mergeStateFixture([], [mergeDeckA, mergeDeckB], { "deck-a apple": deletedAt }),
);
assert.equal(oneDeckDeletedMerge.words.map((word) => word.deckId).join(","), "deck-b",
  "a composite tombstone must delete only the matching deck's word");

const readdedMerge = mergeStates(
  mergeStateFixture([mergeWordFixture("new-a", "deck-a", newAddedAt)], [mergeDeckA]),
  mergeStateFixture([], [mergeDeckA], { "deck-a apple": deletedAt }),
);
assert.equal(readdedMerge.words.length, 1,
  "a word deliberately re-added after its tombstone must remain available");

const remappedDeletionMerge = mergeStates(
  mergeStateFixture([mergeWordFixture("old-a", "deck-a", oldAddedAt)], [mergeDeckA]),
  mergeStateFixture([], [{ id: "other-device-deck", name: "A", updatedAt: 0 }], {
    "other-device-deck apple": deletedAt,
  }),
);
assert.equal(remappedDeletionMerge.words.length, 0,
  "a tombstone from a same-name deck with another device id must be remapped before merge");

const idempotentOnce = mergeStates(crossDeckLegacyMerge, crossDeckLegacyMerge);
const idempotentTwice = mergeStates(idempotentOnce, crossDeckLegacyMerge);
assert.equal(JSON.stringify(idempotentTwice), JSON.stringify(idempotentOnce),
  "repeating the same application-state merge must be idempotent");

const getResponseStart = publicHtml.indexOf("function syncStateExceedsLimits(");
const getResponseEnd = publicHtml.indexOf("\nasync function syncRequest(", getResponseStart);
assert.ok(getResponseStart >= 0 && getResponseEnd > getResponseStart,
  "sync GET response validator source is missing");
const getResponseSandbox = {};
new Script(
  "const cleanSyncId = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64);\n" +
    `${publicHtml.slice(getResponseStart, getResponseEnd)}\n` +
    "globalThis.__syncResponse = { syncStateExceedsLimits, validSyncGetResponse, validSyncPutResponse };",
  { filename: "sync-get-response-check.js" },
).runInNewContext(getResponseSandbox);
const { syncStateExceedsLimits, validSyncGetResponse, validSyncPutResponse } =
  getResponseSandbox.__syncResponse;
assert.equal(syncStateExceedsLimits({
  words: Array(60_000).fill(null),
  decks: Array(2_000).fill(null),
}), false, "sync state at the safety limits must remain accepted");
assert.equal(syncStateExceedsLimits({ words: Array(60_001).fill(null), decks: [] }), true,
  "sync state above the word limit must be rejected");
assert.equal(syncStateExceedsLimits({ words: [], decks: Array(2_001).fill(null) }), true,
  "sync state above the deck limit must be rejected");
assert.equal(validSyncGetResponse({ state: null, stateRev: 0 }, null), true,
  "a new empty sync room must remain backward compatible");
assert.equal(validSyncGetResponse({ state: null, stateRev: 3, notModified: true }, 3), true,
  "an explicit matching notModified response must be accepted");
assert.equal(validSyncGetResponse({ state: { words: [], decks: [] }, stateRev: 3 }, null), true,
  "a full valid sync state must be accepted");
assert.equal(validSyncGetResponse(
  { syncId: "room-a", state: { words: [], decks: [] }, stateRev: 3 }, null, "room-a"), true,
  "a response for the requested sync id must be accepted");
for (const invalid of [
  [{ state: null, stateRev: 3 }, null],
  [{ state: null, stateRev: 3, notModified: true }, 2],
  [{ state: { words: [] }, stateRev: 3 }, null],
  [{ state: { words: [], decks: [] }, stateRev: -1 }, null],
  [{ state: { words: [], decks: [] }, stateRev: 1.5 }, null],
  [{ state: { words: [], decks: [] }, stateRev: "not-a-revision" }, null],
]) {
  assert.equal(validSyncGetResponse(invalid[0], invalid[1]), false,
    "an ambiguous or malformed successful GET must fail closed");
}
assert.equal(validSyncGetResponse(
  { syncId: "room-b", state: { words: [], decks: [] }, stateRev: 3 }, null, "room-a"), false,
  "a GET response for another sync id must fail closed");
assert.equal(validSyncPutResponse({ ok: true, stateRev: 1 }), true,
  "a successful PUT with a positive integer revision must be accepted");
assert.equal(validSyncPutResponse({ ok: true, syncId: "room-a", stateRev: 1 }, "room-a"), true,
  "a PUT confirmation for the requested sync id must be accepted");
assert.equal(validSyncPutResponse({ ok: true, syncId: "room-b", stateRev: 1 }, "room-a"), false,
  "a PUT confirmation for another sync id must fail closed");
for (const invalid of [
  null,
  { ok: false, stateRev: 1 },
  { ok: true },
  { ok: true, stateRev: 0 },
  { ok: true, stateRev: -1 },
  { ok: true, stateRev: 1.5 },
]) {
  assert.equal(validSyncPutResponse(invalid), false,
    "a PUT without a confirmed positive integer revision must fail closed");
}

// キー切替時にabortを無視する通信実装でも、遅れて届いた旧キーの応答を世代番号で破棄する。
const staleSyncStart = publicHtml.indexOf("function staleSyncError(");
const staleSyncEnd = publicHtml.indexOf("\n// 【同期用ビュー】", staleSyncStart);
assert.ok(staleSyncStart >= 0 && staleSyncEnd > staleSyncStart,
  "sync request-generation guard source is missing");
let resolveLateSyncFetch;
class IgnoredAbortController {
  constructor() { this.signal = {}; }
  abort() { /* intentionally ignored to simulate a response that still arrives */ }
}
const staleSyncSandbox = {
  AbortController: IgnoredAbortController,
  fetch: () => new Promise((resolve) => { resolveLateSyncFetch = resolve; }),
  window: { setTimeout, clearTimeout },
};
new Script(
  "const SYNC_REQUEST_TIMEOUT_MS = 60 * 1000;\n" +
    "const syncState = { id: 'room-a', accessKey: '', requestGen: 0, pushTimer: 0, retryTimer: 0, pushQueued: false, abortControllers: new Set() };\n" +
    "const cleanSyncId = (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64);\n" +
    "const syncEndpoint = () => '/api/wordsnap-state?sync=room-a';\n" +
    "const syncHeaders = () => ({ 'Content-Type': 'application/json' });\n" +
    `${publicHtml.slice(staleSyncStart, staleSyncEnd)}\n` +
    "globalThis.__syncRace = { syncRequest, bumpSyncRequestGen, syncState };",
  { filename: "sync-key-switch-race-check.js" },
).runInNewContext(staleSyncSandbox);
const lateRequest = staleSyncSandbox.__syncRace.syncRequest("GET");
staleSyncSandbox.__syncRace.bumpSyncRequestGen();
resolveLateSyncFetch({
  ok: true,
  json: async () => ({ syncId: "room-a", state: { words: [], decks: [] }, stateRev: 1 }),
});
await assert.rejects(lateRequest, (error) => error?.staleSync === true,
  "a late response for the previous sync key must be discarded");
assert.equal(staleSyncSandbox.__syncRace.syncState.abortControllers.size, 0,
  "a discarded request must not remain registered as in flight");

// PUT待機中に発生したローカル変更が、完了後の単一キューでちょうど1回再送される。
const syncQueueStart = publicHtml.indexOf("function scheduleSyncPush(");
const syncQueueEnd = publicHtml.indexOf("\n// 戻り値: 取り込みで状態が変わったか", syncQueueStart);
assert.ok(syncQueueStart >= 0 && syncQueueEnd > syncQueueStart,
  "sync push-queue source is missing");
let resolveFirstSyncPut;
let syncPutCalls = 0;
let nextTimerId = 1;
const queuedTimers = new Map();
const syncQueueSandbox = {
  window: {
    setTimeout(callback) {
      const id = nextTimerId++;
      queuedTimers.set(id, callback);
      return id;
    },
    clearTimeout(id) { queuedTimers.delete(id); },
  },
};
new Script(
  "const syncState = { id: 'room-a', connected: true, applyingRemote: false, pushing: false, pushQueued: false, dirtyGen: 1, requestGen: 0, rev: 0, retryTimer: 0, pushTimer: 0 };\n" +
    "const syncServerAvailable = () => true;\n" +
    "const setSyncStatus = () => {};\n" +
    "const isStaleSyncError = () => false;\n" +
    "const validSyncGetResponse = () => true;\n" +
    "const applyMergedRemoteState = () => {};\n" +
    "const syncPutState = async () => { globalThis.__putCalls += 1; if (globalThis.__putCalls === 1) return new Promise((resolve) => { globalThis.__resolveFirst = resolve; }); return { stateRev: globalThis.__putCalls }; };\n" +
    `${publicHtml.slice(syncQueueStart, syncQueueEnd)}\n` +
    "globalThis.__putCalls = 0; globalThis.__syncQueue = { scheduleSyncPush, pushWordsnapState, syncState };",
  { filename: "sync-push-queue-check.js" },
).runInNewContext(syncQueueSandbox);
const firstQueuedPush = syncQueueSandbox.__syncQueue.pushWordsnapState();
syncQueueSandbox.__syncQueue.scheduleSyncPush();
assert.equal(syncQueueSandbox.__syncQueue.syncState.pushQueued, true,
  "a local change during PUT must mark one follow-up push as queued");
syncQueueSandbox.__resolveFirst({ stateRev: 1 });
await firstQueuedPush;
assert.equal(queuedTimers.size, 1,
  "finishing the first PUT must schedule exactly one follow-up push");
const followUpTimer = [...queuedTimers.values()][0];
queuedTimers.clear();
followUpTimer();
await Promise.resolve();
await Promise.resolve();
syncPutCalls = syncQueueSandbox.__putCalls;
assert.equal(syncPutCalls, 2, "the queued local change must be sent exactly once");
assert.equal(syncQueueSandbox.__syncQueue.syncState.pushQueued, false,
  "the follow-up push must consume its queue marker");
assert.equal(queuedTimers.size, 0, "a successful follow-up must not schedule another push");

for (const column of ["key", "state", "rev", "updatedAt"]) {
  assert.match(schema, new RegExp(`\\b${column}\\b`), `D1 schema is missing ${column}`);
}
assert.match(schema, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+states/i, "D1 states table is missing");
assert.match(api, /env\.DB/, "API must require the DB binding");
assert.match(api, /RETURNING\s+rev,\s*updatedAt/i, "API atomic revision result is missing");
assert.match(api, /MAX_RAW_BODY/, "API body-size guard is missing");
assert.match(api, /const\s+MAX_INFLATED_JSON\s*=\s*24_000_000/,
  "API inflated-size guard must stay at 24MB");
assert.match(api, /const\s+MAX_STATE_WORDS\s*=\s*60_000/,
  "API sync-state word limit is missing");
assert.match(api, /const\s+MAX_STATE_DECKS\s*=\s*2_000/,
  "API sync-state deck limit is missing");
assert.match(api, /MAX_INCOMING_BASE64/, "API compressed-input guard is missing");
assert.match(api, /MAX_STORED_BASE64/, "API D1 row-size guard is missing");
assert.match(publicHtml, /const\s+SYNC_REQUEST_TIMEOUT_MS\s*=\s*60\s*\*\s*1000/,
  "client sync requests must have a bounded timeout");
assert.match(publicHtml, /setTimeout\(\(\)\s*=>\s*controller\.abort\(\),\s*SYNC_REQUEST_TIMEOUT_MS\)/,
  "client sync timeout must abort the in-flight fetch");
assert.match(publicHtml, /clearTimeout\(timeout\)[\s\S]*?syncState\.abortControllers\.delete\(controller\)/,
  "client sync timeout must be cleared after every request");
assert.match(publicHtml, /error\?\.name\s*===\s*["']AbortError["'][\s\S]*?timeoutError\.syncTimeout\s*=\s*true/,
  "a sync timeout must be distinguished from a stale key-switch cancellation");
assert.match(publicHtml, /const\s+validConflictState\s*=\s*error\.data\.state\s*&&\s*validSyncGetResponse\([\s\S]*?if\s*\(!validConflictState\)\s*{[\s\S]*?error\.noRetry\s*=\s*true/,
  "a malformed 409 state or revision must stop instead of overwriting unseen changes");
assert.match(publicHtml, /if\s*\(syncStateExceedsLimits\(data\?\.state\)\)[\s\S]*?同期データが異常に大きいため適用を中止しました。[\s\S]*?error\.stateTooLarge\s*=\s*true/,
  "oversized received sync state must stop at the common response boundary");
assert.match(publicHtml, /if\s*\(!options\.silent\s*\|\|\s*error\.stateTooLarge\)/,
  "oversized sync-state rejection must remain visible during silent polling");
assert.doesNotMatch(publicHtml, /壊れた409応答（stateなし）でも[^\n]*再送/,
  "the client still documents unsafe retry behavior for a state-less conflict");
assert.match(api, /latest\.corrupt[\s\S]*?code:\s*["']corrupt_state["']/,
  "API must fail closed when a stored state cannot be decoded");
assert.ok(
  publicHtml.includes(
    'script.integrity = "sha384-2BQ3U3OdKOb0Uczxqr41I9UvZkzr4V9Hv8uSzMMZAlmhsFClvdZX5wi5fDCzG+tM";',
  ),
  "Tesseract.js subresource integrity is missing or has changed",
);
assert.match(publicHtml, /id=["']runtimeStorageWarning["']/, "runtime storage warning is missing");
assert.match(publicHtml, /外部辞書への通信：/, "external dictionary data disclosure is missing");
assert.match(publicHtml, /例文問題の外部通信：/, "context-question data disclosure is missing");
assert.match(publicHtml, /削除記録は最長90日保持/,
  "deletion-tombstone retention disclosure is missing");
assert.match(publicHtml, /長期間まったくアクセスされないサーバー保存分を定期削除する機能は、現在はありません/,
  "dormant server-row retention limitation is missing");
assert.match(publicHtml, /サイトデータ消去や機種変更後の復元には個人リンクまたはJSONバックアップが必要/,
  "PWA recovery disclosure must require an externally retained recovery artifact");
assert.doesNotMatch(publicHtml, /ホーム画面に追加すると、機種変更してもデータが残ります/,
  "the app must not claim that a home-screen icon alone survives device migration");
assert.match(publicHtml, /id=["']syncKeySecurityWarning["'][^>]*role=["']alert["'][^>]*hidden/,
  "legacy sync-key warning is missing");
assert.match(publicHtml, /function\s+isModernPrivateKey\(id\)\s*{\s*return \/\^ws_\[0-9a-f\]\{60\}\$\//,
  "modern sync keys must be recognized by their full 240-bit format");
const keyCheckStart = publicHtml.indexOf("function isModernPrivateKey(");
const keyCheckEnd = publicHtml.indexOf("\nfunction updateSyncKeySecurityWarning(", keyCheckStart);
const keySandbox = {};
new Script(
  `${publicHtml.slice(keyCheckStart, keyCheckEnd)}\n` +
    "globalThis.__isModernPrivateKey = isModernPrivateKey;",
  { filename: "sync-key-strength-check.js" },
).runInNewContext(keySandbox);
assert.equal(keySandbox.__isModernPrivateKey(`ws_${"a".repeat(60)}`), true,
  "a generated 240-bit sync key must not show the legacy warning");
for (const weak of ["family", "ws_short", `ws_${"a".repeat(59)}`, `ws_${"g".repeat(60)}`]) {
  assert.equal(keySandbox.__isModernPrivateKey(weak), false,
    "legacy or malformed sync keys must show the migration warning");
}
const keyGenerateStart = publicHtml.indexOf("function generatePrivateKey(");
const keyGenerateEnd = publicHtml.indexOf("\nfunction isModernPrivateKey(", keyGenerateStart);
assert.ok(keyGenerateStart >= 0 && keyGenerateEnd > keyGenerateStart,
  "private sync-key generator source is missing");
function runKeyGenerator(cryptoValue) {
  const sandbox = { crypto: cryptoValue, Uint8Array };
  new Script(
    `${publicHtml.slice(keyGenerateStart, keyGenerateEnd)}\n` +
      "globalThis.__generatePrivateKey = generatePrivateKey;",
    { filename: "sync-key-generation-check.js" },
  ).runInNewContext(sandbox);
  return sandbox.__generatePrivateKey;
}
const generatedKey = runKeyGenerator({
  getRandomValues(bytes) {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
    return bytes;
  },
})();
assert.equal(generatedKey, `ws_${Array.from({ length: 30 }, (_, index) => index.toString(16).padStart(2, "0")).join("")}`,
  "private sync keys must encode all 30 Web Crypto bytes");
assert.equal(keySandbox.__isModernPrivateKey(generatedKey), true,
  "newly generated sync keys must satisfy the modern-key policy");
assert.throws(() => runKeyGenerator(null)(), /Secure random number generation is unavailable/,
  "sync-key generation must fail instead of falling back to predictable randomness");
assert.match(
  publicHtml,
  /showRuntimeStorageWarning\(!localSaved\s*&&\s*!idbSaved\)/,
  "runtime storage warning must require both local stores to fail",
);

// JSON取込・同期・ローカルCEFRキャッシュの不正値を、class属性や本文へ未検証で埋め込まない。
assert.match(publicHtml, /const\s+SAFE_CEFR_LEVELS\s*=\s*new Set\(\["A1", "A2", "B1", "B2", "C1", "C2"\]\)/,
  "CEFR allowlist is missing");
assert.match(publicHtml, /function\s+safeCefrLevel\(value\)[\s\S]*?SAFE_CEFR_LEVELS\.has\(level\)\s*\?\s*level\s*:\s*null/,
  "CEFR values must be normalized through the allowlist");
assert.match(publicHtml, /escapeHtml\(cefrText\(result\)\)/,
  "CEFR badge text must be escaped before innerHTML insertion");
const cefrNormalizeStart = publicHtml.indexOf("const SAFE_CEFR_LEVELS");
const cefrNormalizeEnd = publicHtml.indexOf("\nfunction normalizePos(", cefrNormalizeStart);
assert.ok(cefrNormalizeStart >= 0 && cefrNormalizeEnd > cefrNormalizeStart,
  "CEFR normalization source is missing");
const cefrSandbox = {};
new Script(
  `${publicHtml.slice(cefrNormalizeStart, cefrNormalizeEnd)}\n` +
    "globalThis.__cefr = { safeCefrLevel, normalizeCefr };",
  { filename: "cefr-normalization-check.js" },
).runInNewContext(cefrSandbox);
assert.equal(cefrSandbox.__cefr.safeCefrLevel("b2"), "B2", "valid CEFR must be normalized");
assert.equal(cefrSandbox.__cefr.safeCefrLevel('<img src=x onerror=alert(1)>'), null,
  "invalid CEFR markup must be rejected");
assert.equal(cefrSandbox.__cefr.normalizeCefr({ level: 'A1\" onmouseover=alert(1)' }), null,
  "imported CEFR attributes must be rejected");
assert.match(publicHtml, /const\s+CACHE_PERSIST_LIMIT\s*=\s*1500/,
  "CEFR persistent cache must have a bounded size");
assert.match(publicHtml, /Object\.fromEntries\(entries\.slice\(-CACHE_PERSIST_LIMIT\)\)/,
  "CEFR persistent cache must discard excess old entries");
assert.match(publicHtml, /function\s+persist\(\)\s*{\s*try\s*{[\s\S]*?localStorage\.setItem\(CACHE_KEY/,
  "CEFR cache write failures must not stop the app");

// 同期・JSON取込の壊れた数値や品詞が、正答率・復習順・教材判定を汚染しない。
const numericNormalizeStart = publicHtml.indexOf("function nonNegativeNumber(");
const numericNormalizeEnd = publicHtml.indexOf("\nfunction normalizeState(", numericNormalizeStart);
assert.ok(numericNormalizeStart >= 0 && numericNormalizeEnd > numericNormalizeStart,
  "numeric normalization source is missing");
const numericSandbox = {};
new Script(
  `${publicHtml.slice(numericNormalizeStart, numericNormalizeEnd)}\n` +
    "globalThis.__numbers = { nonNegativeNumber, nonNegativeInteger };",
  { filename: "numeric-normalization-check.js" },
).runInNewContext(numericSandbox);
assert.equal(numericSandbox.__numbers.nonNegativeInteger("4.9"), 4,
  "valid counters must be normalized to integers");
for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, "not-a-number"]) {
  assert.equal(numericSandbox.__numbers.nonNegativeNumber(invalid), 0,
    "invalid counters and timestamps must fall back to zero");
}
assert.match(publicHtml, /const\s+SAFE_POS_TAGS\s*=\s*new Set\(\["n", "v", "adj", "adv"\]\)/,
  "part-of-speech allowlist is missing");
const posNormalizeStart = publicHtml.indexOf("const SAFE_POS_TAGS");
const posNormalizeEnd = publicHtml.indexOf("\nfunction posLabel(", posNormalizeStart);
assert.ok(posNormalizeStart >= 0 && posNormalizeEnd > posNormalizeStart,
  "part-of-speech normalization source is missing");
const posSandbox = {};
new Script(
  `${publicHtml.slice(posNormalizeStart, posNormalizeEnd)}\n` +
    "globalThis.__pos = { normalizePos };",
  { filename: "pos-normalization-check.js" },
).runInNewContext(posSandbox);
assert.deepEqual(
  JSON.parse(JSON.stringify(posSandbox.__pos.normalizePos({ tag: "<img>", tags: ["N", "v", "v", "bad"] }))),
  { tag: "n", tags: ["n", "v"] },
  "invalid and duplicate part-of-speech values must be rejected",
);
assert.match(publicHtml, /const\s+status\s*=\s*\["new", "review", "mastered"\]\.includes\(rawStatus\)\s*\?\s*rawStatus\s*:\s*"new"/,
  "learning status must fall back to new for invalid imports");

// バックグラウンドタブで同期ポーリングを継続せず、D1無料枠を浪費しない。
const pollingStart = publicHtml.indexOf("function startSyncPolling(");
const pollingEnd = publicHtml.indexOf("\nfunction scheduleSyncPush(", pollingStart);
assert.ok(pollingStart >= 0 && pollingEnd > pollingStart, "sync polling source is missing");
const pollingSource = publicHtml.slice(pollingStart, pollingEnd);
assert.match(pollingSource, /stopSyncPolling\(\);[\s\S]*?if\s*\(document\.hidden\)\s*return/,
  "sync polling must not start while the tab is hidden");
assert.match(pollingSource, /function\s+stopSyncPolling\(\)[\s\S]*?syncState\.pollTimer\s*=\s*0/,
  "sync polling stop must clear its active timer state");
assert.match(publicHtml, /visibilitychange[\s\S]*?if\s*\(document\.hidden\)\s*{\s*stopSyncPolling\(\)/,
  "sync polling must stop when the tab becomes hidden");

// 「この設定で出題」の例文問題は opt-in。旧保存値やシャッフルだけで暗黙に有効化しない。
assert.match(
  publicHtml,
  /<select id="quizContextAmountSelect"[^>]*>[\s\S]*?<option value="none">出さない<\/option>[\s\S]*?<option value="some">一部（約半分）<\/option>[\s\S]*?<option value="all">全部<\/option>/,
  "quiz context amount selector is missing or its safe default is not first",
);
assert.match(
  publicHtml,
  /function\s+normalizeQuizContextAmount\(value\)\s*{\s*return value === "some" \|\| value === "all" \? value : "none";/,
  "quiz context amount must fall back to none for missing/legacy values",
);
const startReviewStart = publicHtml.indexOf("function startReview(");
const startReviewEnd = publicHtml.indexOf("\nfunction eligibleReviewWords(", startReviewStart);
assert.ok(startReviewStart >= 0 && startReviewEnd > startReviewStart, "startReview source is missing");
const startReviewSource = publicHtml.slice(startReviewStart, startReviewEnd);
assert.match(
  startReviewSource,
  /context:\s*Boolean\(options\.context\) \|\| contextAmount === "all"/,
  "all must enable context questions for the whole configured quiz",
);
assert.match(
  startReviewSource,
  /mixFormat:\s*contextAmount === "some"/,
  "some must explicitly enable mixed question formats",
);
assert.doesNotMatch(
  startReviewSource,
  /mixFormat:\s*shuffled/,
  "shuffle must not implicitly enable context questions",
);
assert.match(
  publicHtml,
  /mixFormat:\s*contextAmount === "some" && Boolean\(saved\.mixFormat\)/,
  "legacy resume snapshots must not restore implicit mixed context questions",
);
assert.match(
  publicHtml,
  /contextAmount:\s*selectedQuizContextAmount\(\)/,
  "quiz context amount must be saved on this device",
);
assert.match(
  publicHtml,
  /cefr:\s*elements\.quizCefrSelect\s*\?\s*elements\.quizCefrSelect\.value\s*:\s*"all"/,
  "the selected CEFR filter must be saved with the other quiz settings",
);
assert.match(
  publicHtml,
  /elements\.quizCefrSelect\.value\s*=\s*saved\.cefr/,
  "a valid saved CEFR filter must be restored",
);
assert.match(
  publicHtml,
  /contextAmount !== "none" && contextGenMode\(\) !== "off" && !contextNetworkConsented\(\)/,
  "some/all must keep the existing external-service consent gate",
);
assert.match(
  publicHtml,
  /reviewSession === pendingSession\s*&&\s*currentQuiz\?\.contextPending/,
  "mixed context generation must resume rendering after its pending request",
);
assert.match(
  publicHtml,
  /startReview\(result\.allIds,[\s\S]*?contextAmount:\s*result\.contextAmount/,
  "retrying a completed quiz must keep the selected context amount",
);

// 公開物だけでなく、仕様書・fixture・ログ相当のテキストへ誤貼付した秘密も拒否する。
// .git / node_modules / 画像は対象外。実在し得る長さだけに絞り、UIの省略例は誤検出しない。
const SECRET_TEXT_EXTENSIONS = new Set([
  ".html", ".js", ".mjs", ".json", ".md", ".sql", ".txt", ".yml", ".yaml",
]);
function repositoryTextFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...repositoryTextFiles(path));
    else if (entry.isFile() && SECRET_TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(path);
  }
  return files;
}
const scanned = [standaloneHtml, ...repositoryTextFiles(repoDir).map(read)].join("\n");
assert.doesNotMatch(scanned, /AIza[0-9A-Za-z_-]{30,}/, "possible Gemini API key committed");
assert.doesNotMatch(scanned, /gsk_[0-9A-Za-z]{30,}/, "possible Groq API key committed");
assert.doesNotMatch(scanned, /sk-(?:proj-)?[0-9A-Za-z_-]{30,}/, "possible OpenAI API key committed");
assert.doesNotMatch(scanned, /(?:ghp_|github_pat_)[0-9A-Za-z_]{30,}/, "possible GitHub token committed");
assert.doesNotMatch(scanned, /ws_[0-9a-f]{60}\b/i, "possible real WordBank sync key committed");

console.log("WordBank release checks passed.");
