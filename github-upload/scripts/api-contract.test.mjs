import assert from "node:assert/strict";
import test from "node:test";

import { onRequest } from "../functions/api/wordsnap-state.js";

const API_URL = "https://wordbank.example/api/wordsnap-state";
const LEGACY_SYNC_ID = "legacy-room_42";

function sampleState(label = "first") {
  return {
    learningSchemaVersion: 1,
    words: [{ id: `word-${label}`, term: label, meaning: `meaning-${label}` }],
    decks: [{ id: "deck-1", name: "単語帳1" }],
  };
}

async function gzipBase64(value) {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream("gzip"));
  return Buffer.from(await new Response(stream).arrayBuffer()).toString("base64");
}

class FakeD1Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async first() {
    this.db.calls.push({ sql: this.sql, args: this.args });
    const rows = this.db.rows;

    if (/^SELECT state, rev, updatedAt FROM states WHERE key = \?$/i.test(this.sql)) {
      const row = rows.get(this.args[0]);
      return row ? { state: row.state, rev: row.rev, updatedAt: row.updatedAt } : null;
    }
    if (/^SELECT rev, updatedAt FROM states WHERE key = \?$/i.test(this.sql)) {
      const row = rows.get(this.args[0]);
      return row ? { rev: row.rev, updatedAt: row.updatedAt } : null;
    }
    if (/^SELECT 1 FROM states WHERE key = \?$/i.test(this.sql)) {
      return rows.has(this.args[0]) ? { 1: 1 } : null;
    }
    if (/^SELECT state, rev, created_at FROM state_revisions WHERE key = \? AND rev = \?$/i.test(this.sql)) {
      this.db.requireHistoryTable();
      const row = this.db.revisions.get(this.args[0])?.get(this.args[1]);
      return row ? { ...row } : null;
    }
    if (/^INSERT OR IGNORE INTO states /i.test(this.sql)) {
      const [key, state, updatedAt] = this.args;
      if (rows.has(key)) return null;
      const row = { state, rev: 1, updatedAt };
      rows.set(key, row);
      return { rev: row.rev, updatedAt: row.updatedAt };
    }
    if (/^UPDATE states SET state = \?, rev = rev \+ 1, updatedAt = \? WHERE key = \? AND rev = \?/i.test(this.sql)) {
      const [state, updatedAt, key, expectedRev] = this.args;
      const row = rows.get(key);
      if (!row || row.rev !== expectedRev) return null;
      row.state = state;
      row.rev += 1;
      row.updatedAt = updatedAt;
      return { rev: row.rev, updatedAt: row.updatedAt };
    }
    if (/^UPDATE states SET state = \?, rev = rev \+ 1, updatedAt = \? WHERE key = \? RETURNING/i.test(this.sql)) {
      const [state, updatedAt, key] = this.args;
      const row = rows.get(key);
      if (!row) return null;
      row.state = state;
      row.rev += 1;
      row.updatedAt = updatedAt;
      return { rev: row.rev, updatedAt: row.updatedAt };
    }

    throw new Error(`FakeD1 received an unsupported statement: ${this.sql}`);
  }

  async all() {
    this.db.calls.push({ sql: this.sql, args: this.args });
    if (/^SELECT rev, created_at AS createdAt, reason FROM state_revisions /i.test(this.sql)) {
      this.db.requireHistoryTable();
      const rows = [...(this.db.revisions.get(this.args[0])?.values() || [])]
        .sort((a, b) => b.created_at - a.created_at)
        .map((row) => ({ rev: row.rev, createdAt: row.created_at, reason: row.reason }));
      return { results: rows };
    }
    throw new Error(`FakeD1 received an unsupported all(): ${this.sql}`);
  }

  async run() {
    this.db.calls.push({ sql: this.sql, args: this.args });
    this.db.requireHistoryTable();
    if (/^INSERT OR IGNORE INTO state_revisions /i.test(this.sql)) {
      if (this.db.historyInsertError) throw new Error("history insert failed");
      const [key, rev, state, created_at, reason] = this.args;
      if (!this.db.revisions.has(key)) this.db.revisions.set(key, new Map());
      const revisions = this.db.revisions.get(key);
      if (!revisions.has(rev)) revisions.set(rev, { state, rev, created_at, reason });
      return { success: true };
    }
    if (/^DELETE FROM state_revisions /i.test(this.sql)) {
      const [key, , , firstDailyUtcDay] = this.args;
      const revisions = this.db.revisions.get(key);
      if (!revisions) return { success: true };
      const rows = [...revisions.values()];
      const keep = new Set(rows.sort((a, b) => b.rev - a.rev).slice(0, 5).map((row) => row.rev));
      const daily = new Map();
      for (const row of rows) {
        const utcDay = Math.floor(row.created_at / 86400000);
        if (utcDay < firstDailyUtcDay) continue;
        const current = daily.get(utcDay);
        if (!current || row.created_at > current.created_at
          || (row.created_at === current.created_at && row.rev > current.rev)) daily.set(utcDay, row);
      }
      for (const row of daily.values()) keep.add(row.rev);
      for (const rev of revisions.keys()) {
        if (!keep.has(rev)) revisions.delete(rev);
      }
      return { success: true };
    }
    throw new Error(`FakeD1 received an unsupported run(): ${this.sql}`);
  }
}

class FakeD1 {
  constructor(seed = [], { historyTable = true, historyInsertError = false } = {}) {
    this.rows = new Map(seed);
    this.revisions = new Map();
    this.calls = [];
    this.historyTable = historyTable;
    this.historyInsertError = historyInsertError;
  }

  prepare(sql) {
    return new FakeD1Statement(this, sql);
  }

  requireHistoryTable() {
    if (!this.historyTable) throw new Error("no such table: state_revisions");
  }
}

async function requestApi(db, { method = "GET", sync = LEGACY_SYNC_ID, query = {}, body, headers = {} } = {}) {
  const url = new URL(API_URL);
  if (sync !== null) url.searchParams.set("sync", sync);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const response = await onRequest({ request: new Request(url, init), env: { DB: db } });
  return { response, data: await response.json() };
}

test("GET preserves legacy arbitrary sync ids and the initial empty-state contract", async () => {
  const db = new FakeD1();
  const { response, data } = await requestApi(db);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(data, { syncId: LEGACY_SYNC_ID, state: null, stateRev: 0, updatedAt: 0 });

  db.calls.length = 0;
  const unchanged = await requestApi(db, { query: { sinceRev: 0 } });
  assert.equal(unchanged.response.status, 200);
  assert.deepEqual(unchanged.data, {
    syncId: LEGACY_SYNC_ID,
    state: null,
    stateRev: 0,
    updatedAt: 0,
    notModified: true,
  });
  assert.equal(db.calls.length, 1, "not-modified polling should only read the revision");
});

test("old plaintext D1 rows remain readable", async () => {
  const oldState = sampleState("old-row");
  const db = new FakeD1([
    [LEGACY_SYNC_ID, { state: JSON.stringify(oldState), rev: 7, updatedAt: 1234 }],
  ]);
  const { response, data } = await requestApi(db);
  assert.equal(response.status, 200);
  assert.deepEqual(data, {
    syncId: LEGACY_SYNC_ID,
    state: oldState,
    stateRev: 7,
    updatedAt: 1234,
  });
});

test("a corrupt stored row fails closed instead of looking like an empty room", async () => {
  for (const stored of ["{broken-json", "", "null", "{}", JSON.stringify({ words: [], decks: null })]) {
    const db = new FakeD1([
      [LEGACY_SYNC_ID, { state: stored, rev: 7, updatedAt: 1234 }],
    ]);
    const { response, data } = await requestApi(db);
    assert.equal(response.status, 500);
    assert.equal(data.code, "corrupt_state");
    assert.equal("state" in data, false, "a corrupt row must not be returned as state:null");
    assert.equal(db.rows.get(LEGACY_SYNC_ID).state, stored,
      "a read failure must not rewrite the stored row");
  }

  const recoverDb = new FakeD1([
    [LEGACY_SYNC_ID, { state: "{broken-json", rev: 7, updatedAt: 1234 }],
  ]);
  const replacement = sampleState("manual-recovery");
  const recovered = await requestApi(recoverDb, { method: "PUT", body: { state: replacement } });
  assert.equal(recovered.response.status, 200,
    "an explicit force write from a current client must remain available for recovery");
  assert.equal(recovered.data.stateRev, 8);
  assert.deepEqual((await requestApi(recoverDb)).data.state, replacement);
});

test("legacy v0 clients can update v0 rooms but cannot erase a stored v1 schema", async () => {
  const oldState = sampleState("legacy-before");
  delete oldState.learningSchemaVersion;
  const oldRow = { state: JSON.stringify(oldState), rev: 4, updatedAt: 1000 };
  const db = new FakeD1([[LEGACY_SYNC_ID, oldRow]]);

  const legacyUpdate = sampleState("legacy-after");
  delete legacyUpdate.learningSchemaVersion;
  const updated = await requestApi(db, { method: "PUT", body: { state: legacyUpdate } });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.data.stateRev, 5);
  assert.deepEqual((await requestApi(db)).data.state, legacyUpdate);

  const currentState = sampleState("current-v1");
  const upgraded = await requestApi(db, { method: "PUT", body: { state: currentState } });
  assert.equal(upgraded.response.status, 200);
  assert.equal(upgraded.data.stateRev, 6);

  const blocked = await requestApi(db, { method: "PUT", body: { state: legacyUpdate } });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.data.code, "downgrade_conflict");
  assert.equal(blocked.data.stateRev, 6);
  assert.deepEqual(blocked.data.state, currentState);
});

test("plaintext and gzip PUTs keep the revision, force-write, and conflict contracts", async () => {
  const db = new FakeD1();
  const firstState = sampleState("plain-put");
  const created = await requestApi(db, {
    method: "PUT",
    body: { baseRev: 0, state: firstState },
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.data.ok, true);
  assert.equal(created.data.stateRev, 1);

  const secondState = sampleState("gzip-put");
  const updated = await requestApi(db, {
    method: "PUT",
    body: { baseRev: 1, stateGz: await gzipBase64(secondState), format: "gzip-base64" },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.data.stateRev, 2);

  const stale = await requestApi(db, {
    method: "PUT",
    body: { baseRev: 1, state: sampleState("stale") },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.data.error, "conflict");
  assert.equal(stale.data.stateRev, 2);
  assert.deepEqual(stale.data.state, secondState);

  const forcedState = sampleState("force");
  const forced = await requestApi(db, { method: "PUT", body: { state: forcedState } });
  assert.equal(forced.response.status, 200);
  assert.equal(forced.data.stateRev, 3);

  const latest = await requestApi(db);
  assert.deepEqual(latest.data.state, forcedState);
  assert.equal(latest.data.stateRev, 3);
});

test("a 10,000-word compressed state survives a full D1 round trip", async () => {
  const largeState = {
    learningSchemaVersion: 1,
    words: Array.from({ length: 10_000 }, (_, index) => ({
      id: `word-${index}`,
      term: `term-${index}`,
      meaning: `meaning-${index}`,
      stats: { correct: index % 7, wrong: index % 3 },
    })),
    decks: [{ id: "deck-1", name: "Large deck" }],
  };
  const stateGz = await gzipBase64(largeState);
  assert.ok(stateGz.length < 1_900_000, "the large-state fixture must exercise the supported path");

  const db = new FakeD1();
  const saved = await requestApi(db, {
    method: "PUT",
    body: { baseRev: 0, stateGz, format: "gzip-base64" },
  });
  assert.equal(saved.response.status, 200);
  const loaded = await requestApi(db);
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.data.state.words.length, 10_000);
  assert.deepEqual(loaded.data.state.words.at(-1), largeState.words.at(-1));
});

test("a new room with a mismatched baseRev is not created", async () => {
  const db = new FakeD1();
  const result = await requestApi(db, {
    method: "PUT",
    body: { baseRev: 99, state: sampleState("wrong-base") },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.data.stateRev, 0);
  assert.equal(result.data.state, null);
  assert.equal(db.rows.has(LEGACY_SYNC_ID), false);
});

test("simultaneous first writes create one revision and return the winner to the loser", async () => {
  const db = new FakeD1();
  const leftState = sampleState("concurrent-left");
  const rightState = sampleState("concurrent-right");
  const results = await Promise.all([
    requestApi(db, { method: "PUT", body: { baseRev: 0, state: leftState } }),
    requestApi(db, { method: "PUT", body: { baseRev: 0, state: rightState } }),
  ]);

  const success = results.find((result) => result.response.status === 200);
  const conflict = results.find((result) => result.response.status === 409);
  assert.ok(success, "exactly one concurrent create must succeed");
  assert.ok(conflict, "the other concurrent create must receive a conflict");
  assert.equal(results.filter((result) => result.response.status === 200).length, 1);
  assert.equal(results.filter((result) => result.response.status === 409).length, 1);
  assert.equal(success.data.stateRev, 1);
  assert.equal(conflict.data.stateRev, 1);

  const latest = await requestApi(db);
  assert.equal(latest.data.stateRev, 1, "the race must advance the revision only once");
  assert.deepEqual(conflict.data.state, latest.data.state,
    "the losing writer must receive the complete winning state for safe merge");

  const updates = await Promise.all([
    requestApi(db, { method: "PUT", body: { baseRev: 1, state: sampleState("update-left") } }),
    requestApi(db, { method: "PUT", body: { baseRev: 1, state: sampleState("update-right") } }),
  ]);
  const updateSuccess = updates.find((result) => result.response.status === 200);
  const updateConflict = updates.find((result) => result.response.status === 409);
  assert.ok(updateSuccess && updateConflict,
    "concurrent updates from the same revision must produce one success and one conflict");
  assert.equal(updateSuccess.data.stateRev, 2);
  assert.equal(updateConflict.data.stateRev, 2);
  const updatedLatest = await requestApi(db);
  assert.equal(updatedLatest.data.stateRev, 2,
    "the concurrent update race must advance the revision only once");
  assert.deepEqual(updateConflict.data.state, updatedLatest.data.state,
    "the losing updater must receive the complete winning state for safe merge");
});

test("unsupported methods and oversized input are rejected before D1 access", async () => {
  const methodDb = new FakeD1();
  const disallowed = await requestApi(methodDb, { method: "POST", body: {} });
  assert.equal(disallowed.response.status, 405);
  assert.equal(disallowed.response.headers.get("allow"), "GET, PUT");
  assert.equal(disallowed.response.headers.get("access-control-allow-origin"), null,
    "sync data must not become readable cross-origin");
  assert.equal(methodDb.calls.length, 0);

  const preflightDb = new FakeD1();
  const preflight = await requestApi(preflightDb, {
    method: "OPTIONS",
    headers: {
      origin: "https://untrusted.example",
      "access-control-request-method": "PUT",
    },
  });
  assert.equal(preflight.response.status, 405);
  assert.equal(preflight.response.headers.get("access-control-allow-origin"), null);
  assert.equal(preflightDb.calls.length, 0);

  for (const baseRev of [-1, 1.5, "not-a-revision"]) {
    const invalidRevisionDb = new FakeD1();
    const invalidRevision = await requestApi(invalidRevisionDb, {
      method: "PUT",
      body: { baseRev, state: sampleState(`invalid-rev-${baseRev}`) },
    });
    assert.equal(invalidRevision.response.status, 400);
    assert.equal(invalidRevision.data.error, "invalid baseRev");
    assert.equal(invalidRevisionDb.calls.length, 0);
  }

  const lengthDb = new FakeD1();
  const tooLong = await requestApi(lengthDb, {
    method: "PUT",
    headers: { "content-length": "4000001" },
    body: "{}",
  });
  assert.equal(tooLong.response.status, 413);
  assert.equal(lengthDb.calls.length, 0);

  const gzipDb = new FakeD1();
  const oversizedGzip = await requestApi(gzipDb, {
    method: "PUT",
    body: { format: "gzip-base64", stateGz: "A".repeat(1_900_001) },
  });
  assert.equal(oversizedGzip.response.status, 413);
  assert.equal(oversizedGzip.data.error, "compressed state too large");
  assert.equal(gzipDb.calls.length, 0);

  const invalidDb = new FakeD1();
  const invalidGzip = await requestApi(invalidDb, {
    method: "PUT",
    body: { format: "gzip-base64", stateGz: "not-gzip" },
  });
  assert.equal(invalidGzip.response.status, 400);
  assert.equal(invalidDb.calls.length, 0);
});

test("a chunked PUT body is cancelled and rejected as soon as it exceeds 4MB", async () => {
  const db = new FakeD1();
  let cancelled = false;
  const chunk = new Uint8Array(2_100_000).fill(0x78);
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request(`${API_URL}?sync=${LEGACY_SYNC_ID}`, {
    method: "PUT",
    body: stream,
    duplex: "half",
  });
  const response = await onRequest({ request, env: { DB: db } });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "body too large" });
  assert.equal(cancelled, true);
  assert.equal(db.calls.length, 0);
});

test("states above the word or deck count limits are rejected before D1 access", async () => {
  for (const state of [
    { learningSchemaVersion: 1, words: Array(60_001).fill(null), decks: [] },
    { learningSchemaVersion: 1, words: [], decks: Array(2_001).fill(null) },
  ]) {
    const db = new FakeD1();
    const result = await requestApi(db, { method: "PUT", body: { state } });
    assert.equal(result.response.status, 413);
    assert.equal(result.data.error, "state too large");
    assert.equal(db.calls.length, 0);
  }
});

test("successful PUT archives the committed revision with the exact stored state", async () => {
  const db = new FakeD1();
  const saved = await requestApi(db, { method: "PUT", body: { state: sampleState("archived") } });
  assert.equal(saved.response.status, 200);
  const archived = db.revisions.get(LEGACY_SYNC_ID)?.get(1);
  assert.ok(archived);
  assert.equal(archived.state, db.rows.get(LEGACY_SYNC_ID).state);
  assert.equal(archived.reason, "update");
  assert.equal(typeof archived.created_at, "number");
});

test("history lists metadata only and revision GET restores the normal GET shape", async () => {
  const db = new FakeD1();
  const firstState = sampleState("history-first");
  await requestApi(db, { method: "PUT", body: { state: firstState } });
  await requestApi(db, { method: "PUT", body: { baseRev: 1, state: sampleState("history-second") } });
  db.revisions.get(LEGACY_SYNC_ID).get(1).created_at = 1000;
  db.revisions.get(LEGACY_SYNC_ID).get(2).created_at = 2000;

  const history = await requestApi(db, { query: { history: 1 } });
  assert.equal(history.response.status, 200);
  assert.deepEqual(history.data, {
    syncId: LEGACY_SYNC_ID,
    revisions: [
      { rev: 2, createdAt: 2000, reason: "update" },
      { rev: 1, createdAt: 1000, reason: "update" },
    ],
  });
  assert.equal("state" in history.data.revisions[0], false);

  const revision = await requestApi(db, { query: { revision: 1 } });
  assert.equal(revision.response.status, 200);
  assert.deepEqual(revision.data, {
    syncId: LEGACY_SYNC_ID,
    state: firstState,
    stateRev: 1,
    updatedAt: 1000,
  });
  const missing = await requestApi(db, { query: { revision: 999 } });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.data.code, "no_such_revision");
});

test("missing history table and history INSERT failures never break normal GET or PUT", async () => {
  const missingTableDb = new FakeD1([], { historyTable: false });
  const missingPut = await requestApi(missingTableDb, {
    method: "PUT",
    body: { state: sampleState("without-migration") },
  });
  assert.equal(missingPut.response.status, 200);
  assert.equal((await requestApi(missingTableDb)).response.status, 200);
  const missingHistory = await requestApi(missingTableDb, { query: { history: 1 } });
  assert.deepEqual(missingHistory.data, { syncId: LEGACY_SYNC_ID, revisions: [] });

  const insertErrorDb = new FakeD1([], { historyInsertError: true });
  const insertErrorPut = await requestApi(insertErrorDb, {
    method: "PUT",
    body: { state: sampleState("history-error") },
  });
  assert.equal(insertErrorPut.response.status, 200);
  assert.equal(insertErrorPut.data.stateRev, 1);
  assert.equal((await requestApi(insertErrorDb)).response.status, 200);
});

test("history INSERT failure is logged only for the force-overwrite path", async () => {
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    const forceDb = new FakeD1([
      [LEGACY_SYNC_ID, { state: JSON.stringify(sampleState("force-before")), rev: 2, updatedAt: 1 }],
    ], { historyInsertError: true });
    const forced = await requestApi(forceDb, {
      method: "PUT",
      body: { state: sampleState("force-after") },
    });
    assert.equal(forced.response.status, 200);
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][0]), /強制上書き後の履歴保存に失敗しました/);

    const casDb = new FakeD1([
      [LEGACY_SYNC_ID, { state: JSON.stringify(sampleState("cas-before")), rev: 2, updatedAt: 1 }],
    ], { historyInsertError: true });
    const cas = await requestApi(casDb, {
      method: "PUT",
      body: { baseRev: 2, state: sampleState("cas-after") },
    });
    assert.equal(cas.response.status, 200);
    assert.equal(logged.length, 1, "CASの履歴失敗は従来どおり黙殺する");
  } finally {
    console.error = originalConsoleError;
  }
});

test("prune keeps the top five revisions plus one latest revision for each recent UTC day", async () => {
  const state = sampleState("prune");
  const stored = JSON.stringify(state);
  const db = new FakeD1([[LEGACY_SYNC_ID, { state: stored, rev: 16, updatedAt: 1 }]]);
  const utcToday = Math.floor(Date.now() / 86400000) * 86400000;
  const revisions = new Map();
  for (let rev = 1; rev <= 16; rev += 1) {
    revisions.set(rev, {
      rev,
      state: stored,
      created_at: utcToday - 20 * 86400000 + rev,
      reason: "update",
    });
  }
  for (const [rev, daysAgo] of [[2, 6], [4, 5], [6, 4], [8, 3], [10, 2], [12, 1]]) {
    revisions.get(rev).created_at = utcToday - daysAgo * 86400000 + 2000;
  }
  // 同じ日の最大時刻が同値でも、revが大きい1件だけを日次枠に残す。
  revisions.get(1).created_at = revisions.get(2).created_at;
  db.revisions.set(LEGACY_SYNC_ID, revisions);

  const saved = await requestApi(db, { method: "PUT", body: { state: sampleState("pruned-new") } });
  assert.equal(saved.data.stateRev, 17);
  assert.deepEqual(
    [...db.revisions.get(LEGACY_SYNC_ID).keys()].sort((a, b) => a - b),
    [2, 4, 6, 8, 10, 12, 13, 14, 15, 16, 17],
  );
});

test("restoring an archived state through force PUT creates a new revision", async () => {
  const db = new FakeD1();
  const original = sampleState("restore-original");
  await requestApi(db, { method: "PUT", body: { state: original } });
  await requestApi(db, { method: "PUT", body: { baseRev: 1, state: sampleState("restore-newer") } });

  const archived = await requestApi(db, { query: { revision: 1 } });
  const restored = await requestApi(db, { method: "PUT", body: { state: archived.data.state } });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.data.stateRev, 3);
  const latest = await requestApi(db);
  assert.equal(latest.data.stateRev, 3);
  assert.deepEqual(latest.data.state, original);
});
