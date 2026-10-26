// 取り消しうる保存（persistAppStateChecked）の途中は、通常の送信・取得の合流を新しく始めない（1.0.142）。
// 設計書: docs/DESIGN-2026-10-21-account-recovery.md §4.4 の 5
//
// 送信待ち（pushQueued）や 503 の再試行が保存の途中で発火すると、保存前の変更（削除記録を含む）が送られ、
// 保存に失敗して取り消しても同期先に残っていた。保存中の pull・409 の合流は、取り消しで他端末の変更を捨てていた。
// 公開HTMLの実物の関数を、通信・保存・時計だけ差し替えて走らせる。
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

const LEGACY = `ws_${"c".repeat(32)}`;
const ROOM = `wr_${"a".repeat(32)}`;
const ROOM_B = `wr_${"b".repeat(32)}`;
const TOMBSTONE = "d1 imported-away";
const copy = (v) => JSON.parse(JSON.stringify(v));
const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };

// 遅延と取り消しを再現する偽の時計
function fakeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout: (fn, ms = 0) => { seq += 1; pending.set(seq, { at: now + (Number(ms) || 0), fn }); return seq; },
    clearTimeout: (id) => { pending.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        let next = null;
        for (const [id, t] of pending) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
      await settle();
    },
  };
}

function sandbox() {
  const clock = fakeClock();
  const puts = [];
  const gets = [];
  const idbWaits = [];
  const ctx = {
    clock,
    puts,
    gets,
    route: ROOM,
    putErrors: [],
    // 同期先（サーバー）の内容。PUT は baseRev が違えば 409 で最新を返す
    server: { rev: 3, state: { words: [{ term: "keep" }], decks: [], deletions: {}, trash: [] } },
    appState: { words: [{ term: "keep" }], decks: [], deletions: {}, trash: [] },
    syncState: {
      connected: true, pushing: false, pulling: false, rev: 3, dirtyGen: 0, syncedGen: 0, requestGen: 0,
      pushQueued: false, pushTimer: 0, retryTimer: 0, applyingRemote: false, abortControllers: new Set(),
      persistInFlight: 0, persistEditGen: 0, syncedEditGen: 0, checkedPersistInFlight: 0, pushHeld: null, pullHeld: null,
      id: "",
    },
    window: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    document: { visibilityState: "visible" },
    STORAGE_KEY: "state",
    SYNC_ID_KEY: "sync-id",
    SYNC_V2_CREDENTIAL_KEY: "cred",
    localStorage: {
      setItem: () => { if (ctx.localFails) throw new Error("quota"); },
      removeItem: () => {},
    },
    // 保存の完了はテストが決める（finishIdb(true/false)、または返さない）
    idb: { set: (key) => new Promise((r) => { idbWaits.push({ key, done: r }); }) },
    sanitizeDeletions: (d) => d || {},
    sanitizeTrash: (t) => t || [],
    showRuntimeStorageWarning: () => {},
    syncRequestRoute: () => ({ expectedSyncId: ctx.route }),
    syncServerAvailable: () => true,
    syncRequest: async (method) => {
      gets.push(method);
      if (ctx.holdGet) await new Promise((r) => { ctx.releaseGet = r; });
      return { stateRev: ctx.server.rev, state: copy(ctx.server.state) };
    },
    // 送信内容は送る瞬間の appState（buildSyncPayloadState と同じく呼ばれた時点で作る）
    syncPutState: async (baseRev, opts = {}) => {
      const body = copy(ctx.appState);
      puts.push({ to: ctx.route, body });
      if (ctx.holdPut) await new Promise((r) => { ctx.releasePut = r; });
      const error = ctx.putErrors.shift();
      if (error) throw error;
      if (!opts.force && baseRev !== ctx.server.rev) {
        throw Object.assign(new Error("conflict"), {
          status: 409, data: { state: copy(ctx.server.state), stateRev: ctx.server.rev, syncId: ctx.route },
        });
      }
      ctx.server = { rev: ctx.server.rev + 1, state: body };
      return { stateRev: ctx.server.rev, verifiedSyncTarget: ctx.route };
    },
    merges: [],
    // 合流: 語を term で和にする（他端末の語を残す）。合流した時点の保存中の件数を記録する
    applyMergedRemoteState: (remote) => {
      ctx.merges.push(ctx.syncState.checkedPersistInFlight);
      const have = new Set(ctx.appState.words.map((w) => w.term));
      const add = (remote.words || []).filter((w) => !have.has(w.term));
      ctx.appState.words.push(...add);
      return add.length > 0;
    },
    recordVerifiedSync: () => {},
    setSyncStatus: (m) => { ctx.status = m; },
    setRestoreHistoryStatus: () => {},
    setSyncBusy: () => {},
    armDangerButton: () => true,
    elements: {},
    isStaleSyncError: () => false,
    validSyncGetResponse: () => true,
    connectWordsnapSync: async () => {},
    writeV2Credential: () => { ctx.route = ROOM; },
    normalizeState: (s) => copy(s),
    persistAppState: () => {},
    renderV2CredentialUi: () => {},
    applySyncIdentityUi: () => {},
    renderAll: () => {},
    removeSyncIdFromUrl: () => {},
    startSyncPolling: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext([
    "let storageWriteGeneration = 0;",
    ...[
      "beginLocalPersist", "endLocalPersist", "persistAppStateCheckedOnce", "persistAppStateChecked",
      "holdSyncPush", "holdSyncPull", "heldSyncTargetMatches", "resumeHeldSync",
      "scheduleSyncPush", "scheduleSyncRetry", "pushWordsnapState", "pullWordsnapState", "bumpSyncRequestGen",
      "forcePushOverwrite", "restoreFromRevision", "restoreNativeV2AfterFailedLegacySwitch",
    ].map(extractFunction),
  ].join("\n"), ctx);
  ctx.finishIdb = (ok) => idbWaits.shift().done(ok);
  return ctx;
}

// 取り込み（置換）と同じ形: 語を消して削除記録を付け、保存の完了を待つ
function importReplace(ctx) {
  const before = copy(ctx.appState);
  ctx.appState.words = [{ term: "imported" }];
  ctx.appState.deletions = { [TOMBSTONE]: 1 };
  const saving = ctx.persistAppStateChecked();
  return { saving, rollback: () => { ctx.appState = before; } };
}

const sentTombstone = (ctx) => ctx.puts.some((p) => p.body.deletions && p.body.deletions[TOMBSTONE]);
const service503 = () => Object.assign(new Error("busy"), { status: 503 });

// PUT の応答待ち中に別の編集で pushQueued が立ち、そのあと取り込みの保存が始まる
async function queuedDuringSave(ctx) {
  ctx.holdPut = true;
  ctx.pushWordsnapState();
  await settle();
  ctx.appState.words.push({ term: "earlier-edit" });
  ctx.scheduleSyncPush();
  assert.equal(ctx.syncState.pushQueued, true);
  const imp = importReplace(ctx);
  ctx.holdPut = false;
  ctx.releasePut();
  await ctx.clock.advance(1000); // 保存が長くかかる間に pushQueued の再送予約（400ms）が発火する
  return imp;
}

// 503 の後の再試行待ちの間に、取り込みの保存が始まる
async function retryDuringSave(ctx) {
  ctx.putErrors.push(service503());
  await ctx.pushWordsnapState();
  assert.equal(ctx.clock.pending.size, 1, "再試行を予約している");
  const imp = importReplace(ctx);
  await ctx.clock.advance(2000); // 再試行（1500ms）の発火
  return imp;
}

test("(a) pushQueued の再送は、保存が終わるまで送らず、保存成功後に 1 回だけ送る", async () => {
  const ctx = sandbox();
  const imp = await queuedDuringSave(ctx);
  assert.equal(ctx.puts.length, 1, "保存の途中は新しく送らない");
  assert.ok(ctx.syncState.pushHeld, "保留にしている");
  ctx.finishIdb(true);
  assert.equal(await imp.saving, true);
  await ctx.clock.advance(1000);
  assert.equal(ctx.puts.length, 2, "1 回だけ送る");
  assert.ok(ctx.puts[1].body.words.some((w) => w.term === "imported"));
  assert.equal(ctx.syncState.pushHeld, null);
  assert.equal(ctx.clock.pending.size, 0);
});

test("(b) 503 の再試行は、発火時に保存中なら送らず、保存成功後に送る", async () => {
  const ctx = sandbox();
  const imp = await retryDuringSave(ctx);
  assert.equal(ctx.puts.length, 1, "保存の途中は再試行を送らない");
  ctx.finishIdb(true);
  assert.equal(await imp.saving, true);
  await ctx.clock.advance(1000);
  assert.equal(ctx.puts.length, 2, "保存後に 1 回だけ送る");
  assert.ok(sentTombstone(ctx), "保存できた削除記録は送る");
});

for (const [name, setup] of [["(a)", queuedDuringSave], ["(b)", retryDuringSave]]) {
  test(`(c) ${name} で保存に失敗して取り消した削除記録は、一度も送られない（それ以前の未送信分は送る）`, async () => {
    const ctx = sandbox();
    ctx.localFails = true;
    const imp = await setup(ctx);
    const gen = ctx.syncState.dirtyGen;
    ctx.finishIdb(false);
    assert.equal(await imp.saving, false);
    assert.equal(ctx.syncState.dirtyGen, gen, "失敗した保存では送信を予約しない");
    imp.rollback(); // 呼び出し側（取り込み）の取り消し
    const before = ctx.puts.length;
    await ctx.clock.advance(1000);
    assert.equal(sentTombstone(ctx), false, "取り消した削除記録を送らない");
    assert.equal(ctx.puts.length, before + 1, "止めていた送信は取り消し後の状態で送る");
    assert.ok(ctx.puts.at(-1).body.words.some((w) => w.term === "keep"));
  });
}

test("(d) 保存が無い通常の編集・PUT 中の編集・pull・409 の合流は従来どおり", async () => {
  const ctx = sandbox();
  ctx.scheduleSyncPush();
  await ctx.clock.advance(399);
  assert.equal(ctx.puts.length, 0, "送信の間隔 400ms は変えない");
  await ctx.clock.advance(1);
  assert.equal(ctx.puts.length, 1, "編集は 1 回送る");

  ctx.holdPut = true;
  ctx.pushWordsnapState();
  await settle();
  ctx.scheduleSyncPush();
  ctx.holdPut = false;
  ctx.releasePut();
  await ctx.clock.advance(400);
  assert.equal(ctx.puts.length, 3, "PUT 中の編集は応答後に送り直す");

  ctx.server.state.words.push({ term: "other-device" });
  ctx.server.rev += 1;
  assert.equal(await ctx.pullWordsnapState({ silent: true }), true, "pull は合流する");
  assert.equal(ctx.puts.length, 4, "合流後に送る");

  ctx.server.rev += 1; // 他端末が先に送った
  await ctx.pushWordsnapState();
  assert.equal(ctx.merges.length, 2, "409 は合流する");
  assert.equal(ctx.puts.length, 6, "合流後に再送する");
  assert.equal(ctx.syncState.pushHeld, null);
  assert.equal(ctx.syncState.pullHeld, null);
  assert.equal(ctx.clock.pending.size, 0);
});

test("(e) 保存待ちの間の pull・409 は合流せず、取り消しの後に合流する（他端末の変更を同期先から消さない）", async () => {
  const ctx = sandbox();
  ctx.localFails = true;
  // PUT の応答待ちの間に他端末が送っている（この PUT は 409 になる）
  ctx.server.state.words.push({ term: "other-device" });
  ctx.server.rev += 1;
  ctx.holdPut = true;
  ctx.holdGet = true;
  ctx.pushWordsnapState();
  const pulling = ctx.pullWordsnapState({ silent: true }); // 応答待ちの間に保存が始まる
  await settle();
  const imp = importReplace(ctx);
  ctx.holdPut = false;
  ctx.holdGet = false;
  ctx.releasePut();
  ctx.releaseGet();
  assert.equal(await pulling, false, "保存中に届いた pull の応答は合流しない");
  assert.equal(await ctx.pullWordsnapState({ silent: true }), false, "保存中の pull は保留");
  await ctx.clock.advance(1000);
  assert.deepEqual(ctx.merges, [], "保存待ちの間は合流しない");
  assert.equal(ctx.syncState.rev, 3, "rev も進めない");
  ctx.finishIdb(false);
  assert.equal(await imp.saving, false);
  imp.rollback();
  await ctx.clock.advance(1000);
  assert.ok(ctx.merges.length >= 1 && ctx.merges.every((n) => n === 0), "取り消しの後に合流する");
  assert.ok(ctx.appState.words.some((w) => w.term === "other-device"), "他端末の語が手元に残る");
  assert.ok(ctx.server.state.words.some((w) => w.term === "other-device"), "同期先から消さない");
  assert.equal(sentTombstone(ctx), false);
});

test("(f) 強制上書き・過去の版の復元は、保存待ちの間は受け付けない", async () => {
  const ctx = sandbox();
  const imp = importReplace(ctx);
  await ctx.forcePushOverwrite();
  assert.equal(ctx.puts.length, 0, "保存待ちの内容で同期先を上書きしない");
  assert.match(ctx.status, /保存の完了を待って/);
  ctx.status = "";
  await ctx.restoreFromRevision(2);
  assert.deepEqual(ctx.gets, [], "復元を始めない");
  assert.match(ctx.status, /保存の完了を待って/);
  ctx.finishIdb(true);
  await imp.saving;
  await ctx.forcePushOverwrite();
  assert.equal(ctx.puts.length, 1, "保存後は従来どおり上書きする");
});

test("(g) 保留した送信・取得は、再開時に同期先が変わっていたら行わず、同期先の切り替えで捨てる", async () => {
  const ctx = sandbox();
  // 保存成功後の通常の予約（従来どおりの経路）と混ぜないため、送信を予約しない保存で確かめる
  const saving = ctx.persistAppStateChecked({ sync: false });
  ctx.pushWordsnapState();
  ctx.pullWordsnapState({ silent: true });
  ctx.finishIdb(true);
  await saving;
  ctx.route = ROOM_B; // 再開のタイマーまでに同期先が変わった（別タブ・復元など）
  await ctx.clock.advance(1000);
  assert.deepEqual(ctx.puts, [], "別の部屋へ送らない");
  assert.deepEqual(ctx.gets, [], "別の部屋から取り込まない");

  const ctx2 = sandbox();
  const imp2 = importReplace(ctx2);
  ctx2.pushWordsnapState();
  ctx2.pullWordsnapState({ silent: true });
  ctx2.bumpSyncRequestGen();
  assert.equal(ctx2.syncState.pushHeld, null, "同期先の切り替えで送信の保留を捨てる");
  assert.equal(ctx2.syncState.pullHeld, null, "取得の保留も捨てる");
  ctx2.finishIdb(true);
  await imp2.saving;
});

test("(h) native→legacy 切替の失敗復元で、元の V2 の部屋へ legacy 側の内容を送らない", async () => {
  const ctx = sandbox();
  ctx.route = LEGACY;
  ctx.localFails = true;
  ctx.appState = { words: [{ term: "legacy-only" }], decks: [], deletions: {}, trash: [] };
  // 切替先の保存（sync:false）の途中に、再接続の送信が来る
  const saving = ctx.persistAppStateChecked({ sync: false });
  ctx.pushWordsnapState({ force: true });
  assert.ok(ctx.syncState.pushHeld);
  ctx.finishIdb(false);
  assert.equal(await saving, false);
  // 切替の catch と同じ: 資格情報を戻し、IndexedDB への資格情報の保存を待ってから rev と appState を戻す
  const restoring = ctx.restoreNativeV2AfterFailedLegacySwitch({ roomId: ROOM }, 3, { words: [{ term: "keep" }] });
  assert.equal(ctx.syncState.pushTimer, 0, "再開の予約を無効にする");
  assert.equal(ctx.syncState.requestGen, 1, "世代を進める");
  await ctx.clock.advance(2000); // 資格情報の保存が遅い
  assert.deepEqual(ctx.puts, [], "元の V2 の部屋へ legacy の内容を送らない");
  ctx.finishIdb(true);
  assert.equal(await restoring, true);
});

test("(i) IndexedDB が応答しなくても、10 秒で localStorage の結果で確定し、止めていた送信を再開する", { timeout: 5000 }, async () => {
  for (const localFails of [false, true]) {
    const ctx = sandbox();
    ctx.localFails = localFails;
    const saving = ctx.persistAppStateChecked({ sync: false });
    ctx.pushWordsnapState();
    await ctx.clock.advance(9999);
    assert.equal(ctx.syncState.checkedPersistInFlight, 1);
    await ctx.clock.advance(1);
    assert.equal(await saving, !localFails, "localStorage に書けていれば成功、書けていなければ失敗");
    assert.equal(ctx.syncState.checkedPersistInFlight, 0, "件数を戻す");
    await ctx.clock.advance(400);
    assert.equal(ctx.puts.length, 1, "通常の同期が止まり続けない");
  }
});

test("(j) 背面に回っているときは、保存後の再開をすぐ送る（400ms 待ちで凍結されない）", async () => {
  const ctx = sandbox();
  const imp = importReplace(ctx);
  ctx.document.visibilityState = "hidden";
  ctx.pushWordsnapState(); // flushPendingSyncPush から
  ctx.finishIdb(true);
  await imp.saving;
  await ctx.clock.advance(0);
  assert.equal(ctx.puts.length, 1, "待たずに送る");
  await ctx.clock.advance(1000);
  assert.equal(ctx.puts.length, 1, "二重に送らない");
});
