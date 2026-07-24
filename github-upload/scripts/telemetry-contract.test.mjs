// 匿名telemetry APIの契約テスト。
// 入力境界、秘密情報の除去、固定窓レート制限、補助テーブル不在時の
// fail-open、書き込み専用であることを固定する。
import assert from "node:assert/strict";
import test from "node:test";

import { onRequest } from "../functions/api/telemetry.js";

const API_URL = "https://wordbank.example/api/telemetry";

class FakeD1 {
  constructor({ telemetryTableExists = true, rateLimitsTableExists = true } = {}) {
    this.telemetryTableExists = telemetryTableExists;
    this.rateLimitsTableExists = rateLimitsTableExists;
    this.inserted = [];
    this.rateLimits = new Map();
  }

  prepare(sql) {
    const self = this;
    return {
      sql: sql.replace(/\s+/g, " ").trim(),
      args: [],
      bind(...args) {
        this.args = args;
        return this;
      },
      async first() {
        if (!/^SELECT window_start, count FROM rate_limits /i.test(this.sql)) {
          throw new Error(`unexpected first sql: ${this.sql}`);
        }
        if (!self.rateLimitsTableExists) throw new Error("no such table: rate_limits");
        return self.rateLimits.get(this.args[0]) || null;
      },
      async run() {
        if (/^INSERT INTO rate_limits /i.test(this.sql)) {
          if (!self.rateLimitsTableExists) throw new Error("no such table: rate_limits");
          const [key, now, expiryCutoff, , , limit] = this.args;
          const current = self.rateLimits.get(key);
          if (current && current.window_start > expiryCutoff && current.count >= limit) {
            return { meta: { changes: 0 } };
          }
          if (!current || current.window_start <= expiryCutoff) {
            self.rateLimits.set(key, { window_start: now, count: 1 });
          } else {
            self.rateLimits.set(key, {
              window_start: current.window_start,
              count: current.count + 1,
            });
          }
          return { meta: { changes: 1 } };
        }
        if (/^INSERT INTO telemetry /i.test(this.sql)) {
          if (!self.telemetryTableExists) throw new Error("no such table: telemetry");
          const [kind, name, detail, count, app_rev, created_at] = this.args;
          self.inserted.push({ kind, name, detail, count, app_rev, created_at });
          return { meta: { changes: 1 } };
        }
        throw new Error(`unexpected run sql: ${this.sql}`);
      },
    };
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

async function post(db, body, { method = "POST", ip = "203.0.113.10" } = {}) {
  const init = {
    method,
    headers: {
      "content-type": "application/json",
      "CF-Connecting-IP": ip,
      "user-agent": "TelemetryContractTest/1.0",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await onRequest({
    request: new Request(API_URL, init),
    env: { DB: db },
  });
  const data = await response.json();
  return { response, data };
}

test("valid POST stores anonymous rows and returns only ok", async () => {
  const db = new FakeD1();
  const { response, data } = await post(db, {
    appRev: "web-2026.07",
    events: [
      { kind: "usage", name: "quiz-answer", count: 3 },
      { kind: "error", name: "TypeError", detail: "stack" },
    ],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(data, { ok: true });
  assert.equal(db.inserted.length, 2);
  assert.deepEqual(
    db.inserted.map(({ kind, name, detail, count, app_rev }) => ({
      kind,
      name,
      detail,
      count,
      app_rev,
    })),
    [
      {
        kind: "usage",
        name: "quiz-answer",
        detail: "",
        count: 3,
        app_rev: "web-2026.07",
      },
      {
        kind: "error",
        name: "TypeError",
        detail: "stack",
        count: 1,
        app_rev: "web-2026.07",
      },
    ],
  );
  assert.deepEqual(Object.keys(db.inserted[0]).sort(), [
    "app_rev",
    "count",
    "created_at",
    "detail",
    "kind",
    "name",
  ]);
});

test("21 events, an overlong name, and an invalid kind are rejected with 400", async () => {
  const invalidBodies = [
    { events: Array.from({ length: 21 }, () => ({ kind: "usage", name: "quiz-answer" })) },
    { events: [{ kind: "usage", name: "x".repeat(121) }] },
    { events: [{ kind: "notice", name: "quiz-answer" }] },
  ];
  for (const body of invalidBodies) {
    const db = new FakeD1();
    const { response } = await post(db, body);
    assert.equal(response.status, 400);
    assert.equal(db.inserted.length, 0);
    assert.equal(db.rateLimits.size, 0);
  }
});

test("detail, count, and appRev enforce their documented boundaries", async () => {
  const db = new FakeD1();
  const valid = await post(db, {
    appRev: "v".repeat(40),
    events: [{
      kind: "error",
      name: "x".repeat(120),
      detail: "d".repeat(600),
      count: 1000,
    }],
  });
  assert.equal(valid.response.status, 200);
  assert.equal(db.inserted.length, 1);

  for (const body of [
    { events: [{ kind: "error", name: "x", detail: "d".repeat(601) }] },
    { events: [{ kind: "usage", name: "x", count: 0 }] },
    { events: [{ kind: "usage", name: "x", count: 1.5 }] },
    { appRev: "v".repeat(41), events: [{ kind: "usage", name: "x" }] },
  ]) {
    const invalidDb = new FakeD1();
    const { response } = await post(invalidDb, body);
    assert.equal(response.status, 400);
    assert.equal(invalidDb.inserted.length, 0);
  }
});

test("ws_, wk_, wr_ secrets and URL queries are redacted before storage", async () => {
  const db = new FakeD1();
  const ws = `ws_${"a".repeat(16)}`;
  const wk = `wk_${"b".repeat(20)}`;
  const wr = `wr_${"c".repeat(32)}`;
  const querySecret = `query-${"d".repeat(20)}`;
  const { response } = await post(db, {
    events: [{
      kind: "error",
      name: `failed ${ws} ${wk} ${wr}`,
      detail: `at https://wordbank.example/app?w=${querySecret}&mode=test`,
    }],
  });
  assert.equal(response.status, 200);
  const saved = `${db.inserted[0].name}\n${db.inserted[0].detail}`;
  for (const secret of [ws, wk, wr, querySecret]) assert.ok(!saved.includes(secret));
  assert.ok(saved.includes("[redacted]"));
});

test("the 61st request from one IP is rate limited with 429", async () => {
  const db = new FakeD1();
  for (let i = 0; i < 60; i += 1) {
    const { response } = await post(db, {
      events: [{ kind: "usage", name: "quiz-answer" }],
    });
    assert.equal(response.status, 200);
  }
  const { response, data } = await post(db, {
    events: [{ kind: "usage", name: "quiz-answer" }],
  });
  assert.equal(response.status, 429);
  assert.equal(data.code, "rate-limited");
  assert.equal(db.inserted.length, 60);
});

test("a missing rate_limits table fails open and still stores telemetry", async () => {
  const db = new FakeD1({ rateLimitsTableExists: false });
  const { response, data } = await post(db, {
    events: [{ kind: "usage", name: "ocr-run" }],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(data, { ok: true });
  assert.equal(db.inserted.length, 1);
});

test("GET has no read path and never touches D1", async () => {
  const db = new FakeD1();
  const { response } = await post(db, undefined, { method: "GET" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal(db.inserted.length, 0);
  assert.equal(db.rateLimits.size, 0);
});
