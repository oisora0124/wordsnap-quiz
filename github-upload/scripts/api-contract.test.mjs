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
}

class FakeD1 {
  constructor(seed = []) {
    this.rows = new Map(seed);
    this.calls = [];
  }

  prepare(sql) {
    return new FakeD1Statement(this, sql);
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
