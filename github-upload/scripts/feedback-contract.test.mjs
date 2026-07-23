// フィードバックAPI（書き込み専用）の契約テスト。
// 不変条件を固定する: POSTだけ受理・GETや他メソッドは405・読み取り経路は存在しない・
// 入力は検証と上限で守る・保存は同期キーやIPを含まない・テーブル不在は503。
import assert from "node:assert/strict";
import test from "node:test";

import { onRequest } from "../functions/api/feedback.js";

const API_URL = "https://wordbank.example/api/feedback";

// INSERT を記録するだけの最小D1スタブ。
class FakeD1 {
  constructor({ hasTable = true } = {}) {
    this.hasTable = hasTable;
    this.inserted = [];
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
      async run() {
        if (!self.hasTable) throw new Error("no such table: feedback");
        if (!/^INSERT INTO feedback /i.test(this.sql)) {
          throw new Error(`unexpected sql: ${this.sql}`);
        }
        const [created_at, category, message, contact, app_version, user_agent] = this.args;
        self.inserted.push({ created_at, category, message, contact, app_version, user_agent });
        return { success: true };
      },
    };
  }
}

async function post(db, body, { headers = {}, method = "POST" } = {}) {
  const init = { method, headers: { "content-type": "application/json", ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const response = await onRequest({ request: new Request(API_URL, init), env: { DB: db } });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { response, data };
}

test("valid POST stores the feedback and returns ok", async () => {
  const db = new FakeD1();
  const { response, data } = await post(db, {
    category: "request",
    message: "音声を追加してほしい",
    contact: "me@example.com",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(data, { ok: true });
  assert.equal(db.inserted.length, 1);
  const row = db.inserted[0];
  assert.equal(row.category, "request");
  assert.equal(row.message, "音声を追加してほしい");
  assert.equal(row.contact, "me@example.com");
  assert.ok(Number.isInteger(row.created_at) && row.created_at > 0);
});

test("GET has no read path (405) and never touches the table", async () => {
  const db = new FakeD1();
  const { response } = await post(db, undefined, { method: "GET" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal(db.inserted.length, 0);
});

test("PUT/DELETE/PATCH are rejected as method not allowed", async () => {
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const db = new FakeD1();
    const { response } = await post(db, { message: "x" }, { method });
    assert.equal(response.status, 405, `${method} should be 405`);
    assert.equal(db.inserted.length, 0);
  }
});

test("POST without an application/json Content-Type is rejected (415)", async () => {
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded"]) {
    const db = new FakeD1();
    const { response, data } = await post(
      db,
      JSON.stringify({ message: "hi" }),
      { headers: { "content-type": contentType } },
    );
    assert.equal(response.status, 415);
    assert.equal(data.error, "unsupported media type");
    assert.equal(db.inserted.length, 0);
  }

  const db = new FakeD1();
  const response = await onRequest({
    request: new Request(API_URL, { method: "POST", body: JSON.stringify({ message: "hi" }) }),
    env: { DB: db },
  });
  assert.equal(response.status, 415);
  assert.equal(db.inserted.length, 0);
});

test("empty or whitespace-only message is rejected", async () => {
  const db = new FakeD1();
  for (const message of ["", "   ", "\n\t"]) {
    const { response } = await post(db, { message });
    assert.equal(response.status, 400);
  }
  assert.equal(db.inserted.length, 0);
});

test("unknown category falls back to 'other'", async () => {
  const db = new FakeD1();
  await post(db, { category: "spam-injection", message: "hi" });
  assert.equal(db.inserted[0].category, "other");
});

test("message is capped at 2000 chars", async () => {
  const db = new FakeD1();
  await post(db, { message: "あ".repeat(5000) });
  assert.ok(db.inserted[0].message.length <= 2000);
});

test("control characters (e.g. bell 0x07) are stripped from the message", async () => {
  const db = new FakeD1();
  const bell = String.fromCharCode(7);
  await post(db, { message: `安全${bell}な文字` });
  assert.equal(db.inserted[0].message, "安全な文字");
  assert.ok(!db.inserted[0].message.includes(bell));
});

test("DEL (0x7F) and C1 controls (0x80-0x9F) are stripped", async () => {
  const db = new FakeD1();
  const del = String.fromCharCode(0x7f);
  const nel = String.fromCharCode(0x85); // C1: Next Line
  const c1b = String.fromCharCode(0x9f); // C1 上限
  await post(db, { message: `a${del}b${nel}c${c1b}d` });
  assert.equal(db.inserted[0].message, "abcd");
});

test("user_agent is never stored (privacy: empty even when UA header is sent)", async () => {
  const db = new FakeD1();
  await post(db, { message: "hi" }, { headers: { "user-agent": "Mozilla/5.0 SpyBot" } });
  assert.equal(db.inserted[0].user_agent, "");
});

test("newlines and tabs survive in the message body", async () => {
  const db = new FakeD1();
  await post(db, { message: "行1\n行2\tタブ" });
  assert.equal(db.inserted[0].message, "行1\n行2\tタブ");
});

test("oversized body is rejected before parsing (413)", async () => {
  const db = new FakeD1();
  const huge = JSON.stringify({ message: "x".repeat(20000) });
  const { response } = await post(db, huge);
  assert.equal(response.status, 413);
  assert.equal(db.inserted.length, 0);
});

test("oversized body without Content-Length is still capped via streaming (413)", async () => {
  const db = new FakeD1();
  const big = "x".repeat(20000);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(big));
      controller.close();
    },
  });
  // ストリームbodyは Content-Length を持たない＝readBodyCapped の逐次打ち切りだけが頼り。
  const request = new Request(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  });
  const response = await onRequest({ request, env: { DB: db } });
  assert.equal(response.status, 413);
  assert.equal(db.inserted.length, 0);
});

test("invalid JSON is rejected (400)", async () => {
  const db = new FakeD1();
  const { response } = await post(db, "{not json");
  assert.equal(response.status, 400);
  assert.equal(db.inserted.length, 0);
});

test("missing feedback table degrades to 503, never crashes", async () => {
  const db = new FakeD1({ hasTable: false });
  const { response } = await post(db, { message: "hello" });
  assert.equal(response.status, 503);
});

test("no DB binding returns 503 without throwing", async () => {
  const response = await onRequest({
    request: new Request(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    }),
    env: {},
  });
  assert.equal(response.status, 503);
});

test("contact and appVersion are length-capped", async () => {
  const db = new FakeD1();
  await post(db, { message: "hi", contact: "c".repeat(1000), appVersion: "v".repeat(1000) });
  assert.ok(db.inserted[0].contact.length <= 200);
  assert.ok(db.inserted[0].app_version.length <= 40);
});
