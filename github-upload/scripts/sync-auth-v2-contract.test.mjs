import assert from "node:assert/strict";
import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import test from "node:test";

import { onRequest } from "../functions/api/wordsnap-state.js";

const API_URL = "https://wordbank.example/api/wordsnap-state";
const LEGACY_SYNC_ID = "legacy-room_42";
const FIXED_NOW = 1_700_000_000_000;
const ROOM_ID = `wr_${"1".repeat(32)}`;
const SECOND_ROOM_ID = `wr_${"2".repeat(32)}`;
const ROOM_SECRET = `wk_${"a".repeat(60)}`;
const WRONG_ROOM_SECRET = `wk_${"b".repeat(60)}`;
const OLD_AUTH_KEY = { kid: "old", secret: "o".repeat(32) };
const CURRENT_AUTH_KEY = { kid: "current", secret: "c".repeat(32) };
const AUTH_ENV = JSON.stringify([CURRENT_AUTH_KEY]);

let timingSafeEqualCalls = 0;
if (typeof crypto.subtle.timingSafeEqual !== "function") {
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    configurable: true,
    value(left, right) {
      timingSafeEqualCalls += 1;
      return nodeTimingSafeEqual(Buffer.from(left), Buffer.from(right));
    },
  });
}

function sampleState(label) {
  return {
    learningSchemaVersion: 1,
    words: [{ id: `word-${label}`, term: label, meaning: `meaning-${label}` }],
    decks: [{ id: "deck-1", name: "単語帳1" }],
  };
}

async function expectedAuthHash(keySecret, roomId, roomSecret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(keySecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`wordsnap-sync-auth-v2\0${roomId}\0${roomSecret}`),
  );
  return Buffer.from(digest).toString("hex");
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
    const rows = this.db.rows;
    if (/^SELECT room_id, state_key, auth_hash, auth_kid, created_at, upgraded_from_legacy FROM rooms WHERE room_id = \?$/i.test(this.sql)) {
      const room = this.db.rooms.get(this.args[0]);
      return room ? { ...room } : null;
    }
    if (/^SELECT room_id, state_key, auth_hash, auth_kid, created_at, upgraded_from_legacy FROM rooms WHERE state_key = \?$/i.test(this.sql)) {
      const room = [...this.db.rooms.values()].find((entry) => entry.state_key === this.args[0]);
      return room ? { ...room } : null;
    }
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
    throw new Error(`FakeD1の未対応first文です: ${this.sql}`);
  }

  async all() {
    if (/^SELECT rev, created_at AS createdAt, reason FROM state_revisions /i.test(this.sql)) {
      const rows = [...(this.db.revisions.get(this.args[0])?.values() || [])]
        .sort((a, b) => b.created_at - a.created_at)
        .map((row) => ({ rev: row.rev, createdAt: row.created_at, reason: row.reason }));
      return { results: rows };
    }
    throw new Error(`FakeD1の未対応all文です: ${this.sql}`);
  }

  async run() {
    if (/^INSERT INTO states \(key, state, rev, updatedAt\) VALUES \(\?, \?, 1, \?\)$/i.test(this.sql)) {
      const [key, state, updatedAt] = this.args;
      if (this.db.rows.has(key)) throw new Error("UNIQUE constraint failed: states.key");
      this.db.rows.set(key, { state, rev: 1, updatedAt });
      return { success: true };
    }
    if (/^INSERT INTO rooms \(room_id, state_key, auth_hash, auth_kid, created_at, upgraded_from_legacy\) VALUES \(\?, \?, \?, \?, \?, ([01])\)$/i.test(this.sql)) {
      const [room_id, state_key, auth_hash, auth_kid, created_at] = this.args;
      if (this.db.failRoomInserts > 0) {
        this.db.failRoomInserts -= 1;
        throw new Error("injected rooms insert failure");
      }
      if (this.db.rooms.has(room_id)) throw new Error("UNIQUE constraint failed: rooms.room_id");
      if ([...this.db.rooms.values()].some((entry) => entry.state_key === state_key)) {
        throw new Error("UNIQUE constraint failed: rooms.state_key");
      }
      const upgraded_from_legacy = Number(this.sql.match(/, ([01])\)$/)?.[1]);
      this.db.rooms.set(room_id, {
        room_id,
        state_key,
        auth_hash,
        auth_kid,
        created_at,
        upgraded_from_legacy,
      });
      return { success: true };
    }
    if (/^UPDATE rooms SET auth_hash = \?, auth_kid = \? WHERE room_id = \? AND auth_hash = \? AND auth_kid = \?$/i.test(this.sql)) {
      const [authHash, authKid, roomId, previousHash, previousKid] = this.args;
      const room = this.db.rooms.get(roomId);
      if (room && room.auth_hash === previousHash && room.auth_kid === previousKid) {
        room.auth_hash = authHash;
        room.auth_kid = authKid;
        this.db.lazyRehashes += 1;
      }
      return { success: true };
    }
    if (/^INSERT OR IGNORE INTO state_revisions /i.test(this.sql)) {
      const [key, rev, state, created_at, reason] = this.args;
      if (!this.db.revisions.has(key)) this.db.revisions.set(key, new Map());
      const revisions = this.db.revisions.get(key);
      if (!revisions.has(rev)) revisions.set(rev, { state, rev, created_at, reason });
      return { success: true };
    }
    if (/^DELETE FROM state_revisions /i.test(this.sql)) {
      return { success: true };
    }
    throw new Error(`FakeD1の未対応run文です: ${this.sql}`);
  }
}

class FakeD1 {
  constructor(seed = [], { failRoomInserts = 0, racingRoomAfterRollback = null } = {}) {
    this.rows = new Map(seed);
    this.revisions = new Map();
    this.rooms = new Map();
    this.failRoomInserts = failRoomInserts;
    this.racingRoomAfterRollback = racingRoomAfterRollback;
    this.rolledBackStateKeys = [];
    this.lazyRehashes = 0;
  }

  prepare(sql) {
    return new FakeD1Statement(this, sql);
  }

  async batch(statements) {
    const rowsBefore = new Map([...this.rows].map(([key, row]) => [key, { ...row }]));
    const roomsBefore = new Map([...this.rooms].map(([key, room]) => [key, { ...room }]));
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      for (const key of this.rows.keys()) {
        if (!rowsBefore.has(key)) this.rolledBackStateKeys.push(key);
      }
      this.rows = rowsBefore;
      this.rooms = roomsBefore;
      if (this.racingRoomAfterRollback) {
        const { room, stateRow } = this.racingRoomAfterRollback;
        this.rooms.set(room.room_id, { ...room });
        this.rows.set(room.state_key, { ...stateRow });
        this.racingRoomAfterRollback = null;
      }
      throw error;
    }
  }
}

async function requestLegacy(db, { method = "GET", query = {}, body, headers = {} } = {}) {
  const url = new URL(API_URL);
  url.searchParams.set("sync", LEGACY_SYNC_ID);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const response = await onRequest({ request: new Request(url, init), env: { DB: db } });
  const text = await response.text();
  return {
    status: response.status,
    headers: [...response.headers.entries()],
    body: text,
  };
}

async function requestV2(
  db,
  {
    method = "GET",
    room = ROOM_ID,
    secret = ROOM_SECRET,
    query = {},
    body,
    env = {},
  } = {},
) {
  const url = new URL(API_URL);
  url.searchParams.set("room", room);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const headers = secret === null ? {} : { "x-room-key": secret };
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const response = await onRequest({
    request: new Request(url, init),
    env: { DB: db, SYNC_AUTH_SECRETS: AUTH_ENV, SYNC_V2_ENABLED: "1", ...env },
  });
  return { response, data: await response.json() };
}

async function requestUpgrade(
  db,
  {
    legacyKey = LEGACY_SYNC_ID,
    roomId = ROOM_ID,
    secret = ROOM_SECRET,
    env = {},
  } = {},
) {
  const url = new URL(API_URL);
  url.searchParams.set("sync", legacyKey);
  url.searchParams.set("op", "upgrade");
  const response = await onRequest({
    request: new Request(url, {
      method: "PUT",
      headers: { "x-room-key": secret },
      body: JSON.stringify({ roomId }),
    }),
    env: { DB: db, SYNC_AUTH_SECRETS: AUTH_ENV, SYNC_V2_ENABLED: "1", ...env },
  });
  return { response, data: await response.json() };
}

test("Phase 0前のlegacy代表応答がバイト単位で不変である", async () => {
  const originalNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    const empty = await requestLegacy(new FakeD1());

    const existingState = sampleState("existing");
    const existing = await requestLegacy(new FakeD1([
      [LEGACY_SYNC_ID, { state: JSON.stringify(existingState), rev: 7, updatedAt: 1234 }],
    ]));

    const db = new FakeD1();
    const firstState = sampleState("new");
    const putNew = await requestLegacy(db, {
      method: "PUT",
      body: { baseRev: 0, state: firstState },
    });
    const secondState = sampleState("cas");
    const putCas = await requestLegacy(db, {
      method: "PUT",
      body: { baseRev: 1, state: secondState },
    });
    const conflict = await requestLegacy(db, {
      method: "PUT",
      body: { baseRev: 1, state: sampleState("stale") },
    });
    const history = await requestLegacy(db, { query: { history: 1 } });
    const revision = await requestLegacy(db, { query: { revision: 1 } });
    const restore = await requestLegacy(db, {
      method: "PUT",
      body: { state: firstState },
    });
    const oversized = await requestLegacy(new FakeD1(), {
      method: "PUT",
      headers: { "content-length": "4000001" },
      body: "{}",
    });

    const commonHeaders = [
      ["cache-control", "no-store"],
      ["content-type", "application/json; charset=utf-8"],
      ["x-content-type-options", "nosniff"],
    ];
    assert.deepEqual(
      { empty, existing, putNew, putCas, conflict, history, revision, restore, oversized },
      {
        empty: {
          status: 200,
          headers: commonHeaders,
          body: `{"syncId":"${LEGACY_SYNC_ID}","state":null,"stateRev":0,"updatedAt":0}`,
        },
        existing: {
          status: 200,
          headers: commonHeaders,
          body: `{"syncId":"${LEGACY_SYNC_ID}","state":${JSON.stringify(existingState)},"stateRev":7,"updatedAt":1234}`,
        },
        putNew: {
          status: 200,
          headers: commonHeaders,
          body: `{"ok":true,"syncId":"${LEGACY_SYNC_ID}","stateRev":1,"updatedAt":${FIXED_NOW}}`,
        },
        putCas: {
          status: 200,
          headers: commonHeaders,
          body: `{"ok":true,"syncId":"${LEGACY_SYNC_ID}","stateRev":2,"updatedAt":${FIXED_NOW}}`,
        },
        conflict: {
          status: 409,
          headers: commonHeaders,
          body: `{"error":"conflict","syncId":"${LEGACY_SYNC_ID}","state":${JSON.stringify(secondState)},"stateRev":2,"updatedAt":${FIXED_NOW}}`,
        },
        history: {
          status: 200,
          headers: commonHeaders,
          body: `{"syncId":"${LEGACY_SYNC_ID}","revisions":[{"rev":1,"createdAt":${FIXED_NOW},"reason":"update"},{"rev":2,"createdAt":${FIXED_NOW},"reason":"update"}]}`,
        },
        revision: {
          status: 200,
          headers: commonHeaders,
          body: `{"syncId":"${LEGACY_SYNC_ID}","state":${JSON.stringify(firstState)},"stateRev":1,"updatedAt":${FIXED_NOW}}`,
        },
        restore: {
          status: 200,
          headers: commonHeaders,
          body: `{"ok":true,"syncId":"${LEGACY_SYNC_ID}","stateRev":3,"updatedAt":${FIXED_NOW}}`,
        },
        oversized: {
          status: 413,
          headers: commonHeaders,
          body: '{"error":"body too large"}',
        },
      },
    );
  } finally {
    Date.now = originalNow;
  }
});

test("V2 createからCAS・force・履歴・復元までroomId応答を維持する", async () => {
  const originalNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    const db = new FakeD1();
    const initial = sampleState("v2-initial");
    const created = await requestV2(db, {
      method: "PUT",
      query: { create: 1 },
      body: { state: initial },
    });
    assert.equal(created.response.status, 200);
    assert.deepEqual(created.data, {
      ok: true,
      syncId: ROOM_ID,
      stateRev: 1,
      updatedAt: FIXED_NOW,
    });
    assert.equal(db.rooms.size, 1);
    assert.equal(db.rows.size, 1);
    const room = db.rooms.get(ROOM_ID);
    assert.match(room.state_key, /^v2:[0-9a-f]{32}$/);
    assert.equal(db.rows.has(room.state_key), true);
    assert.equal(room.auth_kid, CURRENT_AUTH_KEY.kid);
    assert.notEqual(room.auth_hash, ROOM_SECRET);
    assert.match(room.auth_hash, /^[0-9a-f]{64}$/);
    assert.equal(
      room.auth_hash,
      await expectedAuthHash(CURRENT_AUTH_KEY.secret, ROOM_ID, ROOM_SECRET),
    );

    const idempotent = await requestV2(db, {
      method: "PUT",
      query: { create: 1 },
      body: "this body is intentionally ignored on retry",
    });
    assert.equal(idempotent.response.status, 200);
    assert.deepEqual(idempotent.data, { ok: true, syncId: ROOM_ID, stateRev: 1 });
    assert.equal(db.rows.size, 1);

    const rejectedRetry = await requestV2(db, {
      method: "PUT",
      secret: WRONG_ROOM_SECRET,
      query: { create: 1 },
      body: { state: initial },
    });
    assert.equal(rejectedRetry.response.status, 403);
    assert.deepEqual(rejectedRetry.data, { error: "forbidden" });
    assert.equal(db.rows.size, 1);

    const loaded = await requestV2(db);
    assert.equal(loaded.response.status, 200);
    assert.deepEqual(loaded.data, {
      syncId: ROOM_ID,
      state: initial,
      stateRev: 1,
      updatedAt: FIXED_NOW,
    });

    const casState = sampleState("v2-cas");
    const cas = await requestV2(db, {
      method: "PUT",
      body: { baseRev: 1, state: casState },
    });
    assert.equal(cas.response.status, 200);
    assert.equal(cas.data.syncId, ROOM_ID);
    assert.equal(cas.data.stateRev, 2);

    const conflict = await requestV2(db, {
      method: "PUT",
      body: { baseRev: 1, state: sampleState("v2-stale") },
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.data.syncId, ROOM_ID);
    assert.equal(conflict.data.stateRev, 2);
    assert.deepEqual(conflict.data.state, casState);

    const missingForce = await requestV2(db, {
      method: "PUT",
      body: { state: sampleState("v2-no-force") },
    });
    assert.equal(missingForce.response.status, 422);
    assert.deepEqual(missingForce.data, { error: "force required", code: "force_required" });

    const forcedState = sampleState("v2-force");
    const forced = await requestV2(db, {
      method: "PUT",
      query: { force: 1 },
      body: { state: forcedState },
    });
    assert.equal(forced.response.status, 200);
    assert.equal(forced.data.syncId, ROOM_ID);
    assert.equal(forced.data.stateRev, 3);

    const history = await requestV2(db, { query: { history: 1 } });
    assert.equal(history.response.status, 200);
    assert.equal(history.data.syncId, ROOM_ID);
    assert.deepEqual(history.data.revisions.map((entry) => entry.rev), [2, 3]);

    const archived = await requestV2(db, { query: { revision: 2 } });
    assert.equal(archived.response.status, 200);
    assert.equal(archived.data.syncId, ROOM_ID);
    assert.deepEqual(archived.data.state, casState);

    const restored = await requestV2(db, {
      method: "PUT",
      query: { force: 1 },
      body: { state: archived.data.state },
    });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.data.syncId, ROOM_ID);
    assert.equal(restored.data.stateRev, 4);
    const afterRestore = await requestV2(db);
    assert.deepEqual(afterRestore.data.state, casState);
    assert.equal(afterRestore.data.stateRev, 4);
  } finally {
    Date.now = originalNow;
  }
});

test("V2認可は誤secret・未存在room・形式不正を同じ403にする", async () => {
  const db = new FakeD1();
  await requestV2(db, {
    method: "PUT",
    query: { create: 1 },
    body: { state: sampleState("auth") },
  });
  timingSafeEqualCalls = 0;

  const wrongSecret = await requestV2(db, { secret: WRONG_ROOM_SECRET });
  const missingRoom = await requestV2(db, { room: SECOND_ROOM_ID });
  const malformedRoom = await requestV2(db, { room: "wr_invalid" });
  const malformedSecret = await requestV2(db, { secret: "wk_invalid" });

  for (const result of [wrongSecret, missingRoom, malformedRoom, malformedSecret]) {
    assert.equal(result.response.status, 403);
    assert.deepEqual(result.data, { error: "forbidden" });
  }
  assert.ok(timingSafeEqualCalls >= 4, "全認可失敗で固定長byte列のtiming-safe比較を実行する");
});

test("鍵リングは全kidを検証し、旧kid一致後に現行kidへlazy re-hashする", async () => {
  const db = new FakeD1();
  const oldRing = JSON.stringify([OLD_AUTH_KEY]);
  const created = await requestV2(db, {
    method: "PUT",
    query: { create: 1 },
    body: { state: sampleState("rotation") },
    env: { SYNC_AUTH_SECRETS: oldRing },
  });
  assert.equal(created.response.status, 200);
  const oldHash = db.rooms.get(ROOM_ID).auth_hash;
  assert.equal(db.rooms.get(ROOM_ID).auth_kid, OLD_AUTH_KEY.kid);

  const rotated = await requestV2(db, {
    env: { SYNC_AUTH_SECRETS: JSON.stringify([CURRENT_AUTH_KEY, OLD_AUTH_KEY]) },
  });
  assert.equal(rotated.response.status, 200);
  assert.equal(db.lazyRehashes, 1);
  assert.equal(db.rooms.get(ROOM_ID).auth_kid, CURRENT_AUTH_KEY.kid);
  assert.notEqual(db.rooms.get(ROOM_ID).auth_hash, oldHash);

  const currentOnly = await requestV2(db);
  assert.equal(currentOnly.response.status, 200);
  assert.equal(db.lazyRehashes, 1);
});

test("V2フラグと鍵設定の503境界、および受付停止中の既存room継続を守る", async () => {
  const db = new FakeD1();
  const disabledCreate = await requestV2(db, {
    method: "PUT",
    query: { create: 1 },
    body: { state: sampleState("disabled") },
    env: { SYNC_V2_ENABLED: undefined },
  });
  assert.equal(disabledCreate.response.status, 503);
  assert.equal(db.rows.size, 0);
  const disabledMalformedCreate = await requestV2(db, {
    method: "PUT",
    room: "invalid-room",
    secret: "invalid-secret",
    query: { create: 1 },
    body: { state: sampleState("disabled-malformed") },
    env: { SYNC_V2_ENABLED: undefined },
  });
  assert.equal(disabledMalformedCreate.response.status, 503);

  const disabledUpgrade = await requestUpgrade(db, {
    env: { SYNC_V2_ENABLED: undefined },
  });
  assert.equal(disabledUpgrade.response.status, 503);
  assert.equal(db.rooms.size, 0);

  const missingSecrets = await requestV2(db, {
    env: { SYNC_AUTH_SECRETS: undefined },
  });
  assert.equal(missingSecrets.response.status, 503);
  const malformedSecrets = await requestV2(db, {
    env: { SYNC_AUTH_SECRETS: "not-json" },
  });
  assert.equal(malformedSecrets.response.status, 503);

  const legacy = await requestLegacy(db);
  assert.equal(legacy.status, 200);
  assert.equal(JSON.parse(legacy.body).syncId, LEGACY_SYNC_ID);

  const created = await requestV2(db, {
    method: "PUT",
    query: { create: 1 },
    body: { state: sampleState("rollback-flag") },
  });
  assert.equal(created.response.status, 200);
  const readWhileClosed = await requestV2(db, {
    env: { SYNC_V2_ENABLED: undefined },
  });
  assert.equal(readWhileClosed.response.status, 200);
  const writeWhileClosed = await requestV2(db, {
    method: "PUT",
    body: { baseRev: 1, state: sampleState("closed-write") },
    env: { SYNC_V2_ENABLED: undefined },
  });
  assert.equal(writeWhileClosed.response.status, 200);
  assert.equal(writeWhileClosed.data.stateRev, 2);
});

test("createのD1 batch失敗はstatesをrollbackし、孤児行を残さない", async () => {
  const retriedDb = new FakeD1([], { failRoomInserts: 1 });
  const retried = await requestV2(retriedDb, {
    method: "PUT",
    query: { create: 1 },
    body: { state: sampleState("batch-retry") },
  });
  assert.equal(retried.response.status, 200);
  assert.equal(retriedDb.rolledBackStateKeys.length, 1);
  assert.equal(retriedDb.rows.size, 1);
  assert.equal(retriedDb.rows.has(retriedDb.rooms.get(ROOM_ID).state_key), true);
  assert.equal(retriedDb.rows.has(retriedDb.rolledBackStateKeys[0]), false);

  const failedDb = new FakeD1([], { failRoomInserts: 3 });
  const failed = await requestV2(failedDb, {
    method: "PUT",
    query: { create: 1 },
    body: { state: sampleState("batch-fail") },
  });
  assert.equal(failed.response.status, 500);
  assert.equal(failedDb.rows.size, 0);
  assert.equal(failedDb.rooms.size, 0);
  assert.equal(failedDb.rolledBackStateKeys.length, 3);
});

test("並行createの制約競合後は再SELECTでtiming-safeな冪等判定を行う", async () => {
  const winningStateKey = `v2:${"f".repeat(32)}`;
  const racingRoom = {
    room_id: ROOM_ID,
    state_key: winningStateKey,
    auth_hash: await expectedAuthHash(CURRENT_AUTH_KEY.secret, ROOM_ID, ROOM_SECRET),
    auth_kid: CURRENT_AUTH_KEY.kid,
    created_at: FIXED_NOW,
    upgraded_from_legacy: 0,
  };
  const makeDb = () => new FakeD1([], {
    failRoomInserts: 1,
    racingRoomAfterRollback: {
      room: racingRoom,
      stateRow: { state: JSON.stringify(sampleState("winner")), rev: 8, updatedAt: FIXED_NOW },
    },
  });

  const idempotentDb = makeDb();
  const idempotent = await requestV2(idempotentDb, {
    method: "PUT",
    query: { create: 1 },
    body: { state: sampleState("loser") },
  });
  assert.equal(idempotent.response.status, 200);
  assert.deepEqual(idempotent.data, { ok: true, syncId: ROOM_ID, stateRev: 8 });
  assert.equal(idempotentDb.rows.size, 1);
  assert.equal(idempotentDb.rows.has(winningStateKey), true);

  const rejectedDb = makeDb();
  const rejected = await requestV2(rejectedDb, {
    method: "PUT",
    secret: WRONG_ROOM_SECRET,
    query: { create: 1 },
    body: { state: sampleState("loser-wrong-secret") },
  });
  assert.equal(rejected.response.status, 403);
  assert.deepEqual(rejected.data, { error: "forbidden" });
  assert.equal(rejectedDb.rows.size, 1);
  assert.equal(rejectedDb.rows.has(winningStateKey), true);
});

test("upgrade判定表とdual-acceptの同一rev系列を完全実装する", async () => {
  const legacyInitial = sampleState("legacy-before-upgrade");
  const db = new FakeD1([
    [LEGACY_SYNC_ID, { state: JSON.stringify(legacyInitial), rev: 4, updatedAt: 1000 }],
  ]);

  const upgraded = await requestUpgrade(db);
  assert.equal(upgraded.response.status, 200);
  assert.deepEqual(upgraded.data, { ok: true, syncId: ROOM_ID });
  assert.equal(db.rooms.get(ROOM_ID).state_key, LEGACY_SYNC_ID);
  assert.equal(db.rooms.get(ROOM_ID).upgraded_from_legacy, 1);

  const lostResponseRetry = await requestUpgrade(db);
  assert.equal(lostResponseRetry.response.status, 200);
  assert.deepEqual(lostResponseRetry.data, { ok: true, syncId: ROOM_ID });

  const wrongSecret = await requestUpgrade(db, { secret: WRONG_ROOM_SECRET });
  assert.equal(wrongSecret.response.status, 403);
  assert.deepEqual(wrongSecret.data, { error: "forbidden" });

  const alreadyUpgraded = await requestUpgrade(db, { roomId: SECOND_ROOM_ID });
  assert.equal(alreadyUpgraded.response.status, 409);
  assert.deepEqual(alreadyUpgraded.data, { error: "conflict", code: "already-upgraded" });

  const otherLegacyKey = "other-legacy-key";
  const roomTaken = await requestUpgrade(db, { legacyKey: otherLegacyKey });
  assert.equal(roomTaken.response.status, 409);
  assert.deepEqual(roomTaken.data, { error: "conflict", code: "room-taken" });

  const legacyWrite = await requestLegacy(db, {
    method: "PUT",
    body: { baseRev: 4, state: sampleState("legacy-after-upgrade") },
  });
  assert.equal(legacyWrite.status, 200);
  assert.equal(JSON.parse(legacyWrite.body).stateRev, 5);

  const v2Read = await requestV2(db);
  assert.equal(v2Read.response.status, 200);
  assert.equal(v2Read.data.stateRev, 5);
  assert.equal(v2Read.data.syncId, ROOM_ID);

  const v2Write = await requestV2(db, {
    method: "PUT",
    body: { baseRev: 5, state: sampleState("v2-after-upgrade") },
  });
  assert.equal(v2Write.response.status, 200);
  assert.equal(v2Write.data.stateRev, 6);
  const legacyRead = await requestLegacy(db);
  assert.equal(JSON.parse(legacyRead.body).stateRev, 6);
  assert.deepEqual(JSON.parse(legacyRead.body).state, sampleState("v2-after-upgrade"));
});

test("並行upgradeは一方だけ成功し、他方をalready-upgradedへ変換する", async () => {
  const db = new FakeD1();
  const results = await Promise.all([
    requestUpgrade(db, { roomId: ROOM_ID }),
    requestUpgrade(db, { roomId: SECOND_ROOM_ID }),
  ]);
  assert.equal(results.filter((result) => result.response.status === 200).length, 1);
  const conflict = results.find((result) => result.response.status === 409);
  assert.ok(conflict);
  assert.equal(conflict.data.code, "already-upgraded");
  assert.equal(db.rooms.size, 1);
});

test("upgradeのD1失敗は5xxとなり、資格情報の再試行余地を残す", async () => {
  const db = new FakeD1([], { failRoomInserts: 1 });
  const failed = await requestUpgrade(db);
  assert.equal(failed.response.status, 500);
  assert.deepEqual(failed.data, { error: "storage unavailable" });
  assert.equal(db.rooms.size, 0);

  const retried = await requestUpgrade(db);
  assert.equal(retried.response.status, 200);
  assert.equal(retried.data.syncId, ROOM_ID);
});
