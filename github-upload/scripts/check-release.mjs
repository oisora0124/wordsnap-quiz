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
const apiPath = join(projectDir, "functions", "api", "wordsnap-state.js");
const schemaPath = join(projectDir, "schema.sql");
const distributionPath = join(repoDir, "DISTRIBUTION.md");
const reviewEventSchemaPath = join(projectDir, "schemas", "review-event.schema.json");
const lexicalShadowSchemaPath = join(projectDir, "schemas", "lexical-shadow.schema.json");

for (const path of [
  publicHtmlPath, rootHtmlPath, manifestPath, workerPath, apiPath, schemaPath, distributionPath,
  reviewEventSchemaPath, lexicalShadowSchemaPath,
]) {
  assert.ok(existsSync(path), `required file is missing: ${path}`);
}

const publicHtml = read(publicHtmlPath);
const rootHtml = read(rootHtmlPath);
const worker = read(workerPath);
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
assert.match(publicHtml, /<title>\s*WordBank\s*<\/title>/i, "WordBank title is missing");
assert.match(
  publicHtml,
  /<meta\s+name=["']referrer["']\s+content=["']no-referrer["']\s*\/?>/i,
  "sync keys in the page URL must not be sent as referrers",
);
assert.match(publicHtml, /function\s+downloadStandalone\s*\(/, "standalone download function is missing");
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

for (const column of ["key", "state", "rev", "updatedAt"]) {
  assert.match(schema, new RegExp(`\\b${column}\\b`), `D1 schema is missing ${column}`);
}
assert.match(schema, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+states/i, "D1 states table is missing");
assert.match(api, /env\.DB/, "API must require the DB binding");
assert.match(api, /RETURNING\s+rev,\s*updatedAt/i, "API atomic revision result is missing");
assert.match(api, /MAX_RAW_BODY/, "API body-size guard is missing");
assert.match(api, /MAX_INFLATED_JSON/, "API inflated-size guard is missing");
assert.match(api, /MAX_INCOMING_BASE64/, "API compressed-input guard is missing");
assert.match(api, /MAX_STORED_BASE64/, "API D1 row-size guard is missing");
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
assert.match(publicHtml, /削除記録は最長90日残り/,
  "deletion-tombstone retention disclosure is missing");
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
