// 取り消しうる保存（persistAppStateChecked）の途中は、通常の送信を新しく始めない（1.0.142）。
// 設計書: docs/DESIGN-2026-10-21-account-recovery.md §4.4 の 5
//
// 送信待ち（pushQueued）や 503 の再試行が保存の途中で発火すると、保存前の変更（削除記録を含む）が送られ、
// 保存に失敗して取り消しても同期先に残っていた。公開HTMLの実物の送信予約経路を、通信と保存だけ差し替えて走らせる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

function extractFunction(name) {
  const marker = html.indexOf(`\nfunction ${name}(`) >= 0 ? `\nfunction ${name}(` : `\nasync function ${name}(`;
  const start = html.indexOf(marker);
  assert.ok(start >= 0, `function ${name} が見つかること`);
  const bodyBrace = html.indexOf(") {", start) + 2;
  let depth = 0;
  for (let k = bodyBrace; k < html.length; k += 1) {
    if (html[k] === "{") depth += 1;
    else if (html[k] === "}" && --depth === 0) return html.slice(start + 1, k + 1);
  }
  throw new Error(`unbalanced braces for ${name}`);
}

const ROOM = `wr_${"a".repeat(32)}`;
const TOMBSTONE = "d1 imported-away";

function sandbox() {
  const timers = [];
  const puts = [];
  let releasePut = null;
  let releaseIdb = null;
  const ctx = {
    timers,
    puts,
    putErrors: [],
    appState: { words: [{ term: "keep" }], decks: [], deletions: {}, trash: [] },
    syncState: {
      connected: true, pushing: false, pulling: false, rev: 3, dirtyGen: 0, syncedGen: 0, requestGen: 0,
      pushQueued: false, pushTimer: 0, retryTimer: 0, applyingRemote: false, abortControllers: new Set(),
      persistInFlight: 0, persistEditGen: 0, syncedEditGen: 0, checkedPersistInFlight: 0, pushHeld: null,
    },
    window: {
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout: () => {},
    },
    STORAGE_KEY: "state",
    localStorage: { setItem: () => { if (ctx.localFails) throw new Error("quota"); } },
    idb: { set: () => new Promise((r) => { releaseIdb = r; }) },
    sanitizeDeletions: (d) => d || {},
    sanitizeTrash: (t) => t || [],
    showRuntimeStorageWarning: () => {},
    syncRequestRoute: () => ({ expectedSyncId: ROOM }),
    syncServerAvailable: () => true,
    // 送信内容は送る瞬間の appState（buildSyncPayloadState と同じく呼ばれた時点で作る）
    syncPutState: async () => {
      puts.push(JSON.parse(JSON.stringify(ctx.appState)));
      if (ctx.holdPut) await new Promise((r) => { releasePut = r; });
      const error = ctx.putErrors.shift();
      if (error) throw error;
      return { stateRev: 4 + puts.length, verifiedSyncTarget: ROOM };
    },
    recordVerifiedSync: () => {},
    setSyncStatus: () => {},
    isStaleSyncError: () => false,
    validSyncGetResponse: () => true,
    merged: 0,
    applyMergedRemoteState: () => { ctx.merged += 1; return true; },
  };
  vm.createContext(ctx);
  vm.runInContext([
    "let storageWriteGeneration = 0;",
    extractFunction("beginLocalPersist"),
    extractFunction("endLocalPersist"),
    extractFunction("persistAppStateCheckedOnce"),
    extractFunction("persistAppStateChecked"),
    extractFunction("resumeHeldSyncPush"),
    extractFunction("scheduleSyncPush"),
    extractFunction("scheduleSyncRetry"),
    extractFunction("pushWordsnapState"),
  ].join("\n"), ctx);
  ctx.releasePut = () => releasePut();
  ctx.releaseIdb = (ok) => releaseIdb(ok);
  // 予約済みのタイマーを順に走らせる（400ms・再試行の待ちの代わり）。コールバックは送信の完了を返さないので、間で待つ
  ctx.flushTimers = async () => {
    while (timers.length) {
      timers.shift()();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return ctx;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// 取り込み（置換）と同じ形: 語を消して削除記録を付け、保存の完了を待つ
function importReplace(ctx) {
  const before = JSON.parse(JSON.stringify(ctx.appState));
  ctx.appState.words = [{ term: "imported" }];
  ctx.appState.deletions = { [TOMBSTONE]: Date.now() };
  const saving = ctx.persistAppStateChecked();
  return { saving, rollback: () => { ctx.appState = before; } };
}

const sentTombstone = (ctx) => ctx.puts.some((p) => p.deletions && p.deletions[TOMBSTONE]);
const service503 = () => Object.assign(new Error("busy"), { status: 503 });

// PUT の応答待ち中に別の編集で pushQueued が立ち、そのあと取り込みの保存が始まる
async function queuedDuringSave(ctx) {
  ctx.holdPut = true;
  const inflight = ctx.pushWordsnapState();
  await tick();
  ctx.appState.words.push({ term: "earlier-edit" });
  ctx.scheduleSyncPush();
  assert.equal(ctx.syncState.pushQueued, true);
  const imp = importReplace(ctx);
  ctx.holdPut = false;
  ctx.releasePut();
  await inflight;
  await ctx.flushTimers(); // 保存が 400ms より長くかかった場合（pushQueued の再送予約が発火する）
  return imp;
}

// 503 の後の再試行待ちの間に、取り込みの保存が始まる
async function retryDuringSave(ctx) {
  ctx.putErrors.push(service503());
  await ctx.pushWordsnapState();
  assert.equal(ctx.timers.length, 1, "再試行を予約している");
  const imp = importReplace(ctx);
  await ctx.flushTimers(); // 再試行の発火
  return imp;
}

test("(a) pushQueued の再送は、保存が終わるまで送らず、保存成功後に 1 回だけ送る", async () => {
  const ctx = sandbox();
  const imp = await queuedDuringSave(ctx);
  assert.equal(ctx.puts.length, 1, "保存の途中は新しく送らない");
  assert.ok(ctx.syncState.pushHeld, "保留にしている");
  ctx.releaseIdb(true);
  assert.equal(await imp.saving, true);
  assert.equal(ctx.timers.length, 1, "保存成功後の予約は 1 回");
  await ctx.flushTimers();
  assert.equal(ctx.puts.length, 2, "1 回だけ送る");
  assert.ok(ctx.puts[1].words.some((w) => w.term === "imported"));
  assert.equal(ctx.syncState.pushHeld, null);
});

test("(b) 503 の再試行は、発火時に保存中なら送らず、保存成功後に送る", async () => {
  const ctx = sandbox();
  const imp = await retryDuringSave(ctx);
  assert.equal(ctx.puts.length, 1, "保存の途中は再試行を送らない");
  ctx.releaseIdb(true);
  assert.equal(await imp.saving, true);
  await ctx.flushTimers();
  assert.equal(ctx.puts.length, 2, "保存後に 1 回だけ送る");
  assert.ok(sentTombstone(ctx), "保存できた削除記録は送る");
});

for (const [name, setup] of [["(a)", queuedDuringSave], ["(b)", retryDuringSave]]) {
  test(`(c) ${name} で保存に失敗して取り消した削除記録は、一度も送られない（それ以前の未送信分は送る）`, async () => {
    const ctx = sandbox();
    ctx.localFails = true;
    const imp = await setup(ctx);
    const gen = ctx.syncState.dirtyGen;
    ctx.releaseIdb(false);
    assert.equal(await imp.saving, false);
    assert.equal(ctx.syncState.dirtyGen, gen, "失敗した保存では送信を予約しない");
    imp.rollback(); // 呼び出し側（取り込み）の取り消し
    const before = ctx.puts.length;
    await ctx.flushTimers();
    assert.equal(sentTombstone(ctx), false, "取り消した削除記録を送らない");
    assert.equal(ctx.puts.length, before + 1, "止めていた送信は取り消し後の状態で送る");
    assert.ok(ctx.puts.at(-1).words.some((w) => w.term === "keep"));
    assert.equal(ctx.timers.length, 0);
  });
}

test("(d) 保存が無い通常の編集・PUT 中の編集・409 の合流は従来どおり", async () => {
  const ctx = sandbox();
  ctx.scheduleSyncPush();
  assert.equal(ctx.timers.length, 1);
  await ctx.flushTimers();
  assert.equal(ctx.puts.length, 1, "編集は 1 回送る");

  ctx.holdPut = true;
  const inflight = ctx.pushWordsnapState();
  await tick();
  ctx.scheduleSyncPush();
  ctx.holdPut = false;
  ctx.releasePut();
  await inflight;
  await ctx.flushTimers();
  assert.equal(ctx.puts.length, 3, "PUT 中の編集は応答後に送り直す");

  const conflict = Object.assign(new Error("conflict"), {
    status: 409, data: { state: { words: [] }, stateRev: 10, syncId: ROOM },
  });
  ctx.putErrors.push(conflict);
  await ctx.pushWordsnapState();
  assert.equal(ctx.merged, 1, "409 は合流する");
  assert.equal(ctx.puts.length, 5, "合流後に再送する");
  assert.equal(ctx.syncState.pushHeld, null);
  assert.equal(ctx.timers.length, 0);
});
