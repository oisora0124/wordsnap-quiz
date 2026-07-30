// フィードバックAPI（書き込み専用）の契約テスト。
// 不変条件を固定する: POSTだけ受理・GETや他メソッドは405・読み取り経路は存在しない・
// 入力は検証と上限で守る・保存は同期キーやIPを含まない・テーブル不在は503。
import assert from "node:assert/strict";
import test from "node:test";

import { onRequest } from "../functions/api/feedback.js";

const API_URL = "https://wordbank.example/api/feedback";

// INSERT を記録するだけの最小D1スタブ。
class FakeD1 {
  // hasTable は feedback テーブルの有無だけを表す。rateLimitsTableExists を false に
  // すると、上限テーブルだけが無い状況（保存側は fail-open で通す）を再現できる。
  constructor({ hasTable = true, rateLimitsTableExists = true } = {}) {
    this.hasTable = hasTable;
    this.rateLimitsTableExists = rateLimitsTableExists;
    this.inserted = [];
    this.rateLimits = new Map();
    this.saveCleanups = [];
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
        if (!/^SELECT window_start, count FROM rate_limits WHERE rl_key = \?$/i.test(this.sql)) {
          throw new Error(`unexpected first sql: ${this.sql}`);
        }
        if (!self.rateLimitsTableExists) throw new Error("no such table: rate_limits");
        const row = self.rateLimits.get(this.args[0]);
        return row ? { ...row } : null;
      },
      async run() {
        // 上限テーブルの固定窓カウンタ。スタブで握り潰すと上限が検証されないので、
        // 実装が投げるSQLと同じ意味をここで再現する。
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
        if (/^DELETE FROM rate_limits WHERE rl_key LIKE '(fb-save|fb-mail):%' AND window_start <= \?$/i.test(this.sql)) {
          if (!self.rateLimitsTableExists) throw new Error("no such table: rate_limits");
          const prefix = this.sql.includes("fb-save") ? "fb-save:" : "fb-mail:";
          const [cutoff] = this.args;
          let changes = 0;
          for (const [key, row] of [...self.rateLimits]) {
            if (!key.startsWith(prefix) || row.window_start > cutoff) continue;
            self.rateLimits.delete(key);
            changes += 1;
          }
          self.saveCleanups.push({ prefix, cutoff });
          return { meta: { changes } };
        }
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

async function post(db, body, { headers = {}, method = "POST", ip = "203.0.113.10" } = {}) {
  const init = {
    method,
    headers: { "content-type": "application/json", "CF-Connecting-IP": ip, ...headers },
  };
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

// `text/plain;x=application/json` は essence が text/plain なので、ブラウザは
// プリフライトなしの simple POST として送れる。部分一致で受理していると
// 任意サイトから投稿・メール通知を発火させられる。essence で判定することを固定する。
test("Content-Type essence が application/json でなければ 415 にする", async () => {
  for (const contentType of [
    "text/plain;x=application/json",
    "text/plain",
    "application/x-www-form-urlencoded",
  ]) {
    const db = new FakeD1();
    const { response } = await post(db, { category: "request", message: "テスト" }, {
      headers: { "content-type": contentType },
    });
    assert.equal(response.status, 415, `${contentType} を通さないこと`);
    assert.equal(db.inserted.length, 0);
  }
  const ok = new FakeD1();
  const { response } = await post(ok, { category: "request", message: "テスト" }, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  assert.equal(response.status, 200, "charset付きは受理すること");
  assert.equal(ok.inserted.length, 1);
});

test("別オリジンからのPOSTは保存せず403にする", async () => {
  for (const headers of [
    { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    { Origin: "https://evil.example" },
    { "Sec-Fetch-Site": "cross-site" },
  ]) {
    const db = new FakeD1();
    const { response } = await post(db, { category: "request", message: "テスト" }, { headers });
    assert.equal(response.status, 403);
    assert.equal(db.inserted.length, 0, "拒否時は1行も書かないこと");
  }

  const same = new FakeD1();
  const sameResult = await post(same, { category: "request", message: "テスト" }, {
    headers: { Origin: "https://wordbank.example", "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(sameResult.response.status, 200);
  assert.equal(same.inserted.length, 1);
});

// 保存そのものの上限。これが無いと、公開・無認証の投稿口から feedback テーブルへ
// 無制限にINSERTできる（メール側の上限は通知しか止めない）。
test("IP単位の保存上限を超えると429にし、それ以上保存しない", async () => {
  const db = new FakeD1();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { response } = await post(db, { category: "request", message: `要望${attempt}` });
    assert.equal(response.status, 200, `${attempt}件目までは保存すること`);
  }
  assert.equal(db.inserted.length, 30);

  const limited = await post(db, { category: "request", message: "31件目" });
  assert.equal(limited.response.status, 429);
  assert.deepEqual(limited.data, { error: "rate limited", code: "rate-limited" });
  assert.equal(db.inserted.length, 30, "上限超過では1行も増やさないこと");
});

test("上限は入力が妥当なときだけ消費する（不正な要求で枠を減らせない）", async () => {
  const db = new FakeD1();
  for (const invalid of [{ message: "" }, { category: "request" }, "not-json-object"]) {
    const { response } = await post(db, invalid);
    assert.ok(response.status >= 400, "不正な要求は拒否すること");
  }
  assert.equal(db.rateLimits.size, 0, "不正な要求で上限の枠を消費しないこと");
});

test("上限テーブルが無い場合は保存を優先してfail-openにする", async () => {
  const db = new FakeD1({ rateLimitsTableExists: false });
  const { response } = await post(db, { category: "request", message: "上限表なし" });
  assert.equal(response.status, 200, "上限を確かめられなくても要望は失わないこと");
  assert.equal(db.inserted.length, 1);
});

test("保存側の期限切れ行を掃除する（IPごとに行が増え続けない）", async () => {
  const db = new FakeD1();
  const stale = Date.now() - 2 * 60 * 60 * 1000; // 1時間の窓より古い
  db.rateLimits.set("fb-save:deadbeefdeadbeef", { window_start: stale, count: 30 });
  db.rateLimits.set("fb-mail:deadbeefdeadbeef", { window_start: stale, count: 5 });

  const { response } = await post(db, { category: "request", message: "掃除" });
  assert.equal(response.status, 200);
  assert.ok(
    db.saveCleanups.some((entry) => entry.prefix === "fb-save:"),
    "保存側の掃除が走ること",
  );
  assert.equal(
    db.rateLimits.has("fb-save:deadbeefdeadbeef"),
    false,
    "期限切れの保存側の行は消えること",
  );
});

// 「動かないので設定を全部貼ります」は必ず起きる。貼られた時点で利用者の手は離れているので、
// 保存とメール送信の前にこちら側で伏せる。拒否ではなく伏せ字にするのは、
// 本文に本物の要望が混じっているため。
test("本文・連絡先に貼られた秘密は保存前に伏せ字にする", async () => {
  const db = new FakeD1();
  const wk = `wk_${"a".repeat(60)}`;
  const wv = `wv_${"b".repeat(64)}`;
  const ws = `ws_${"c".repeat(60)}`;
  const gemini = `AIza${"D".repeat(35)}`;
  const groq = `gsk_${"e".repeat(40)}`;
  const openai = `sk-proj-${"f".repeat(40)}`;

  const { response } = await post(db, {
    category: "bug",
    message: `同期できません。コードは ${wk} と ${wv} です。旧キーは ${ws}。`
      + ` キーは ${gemini} / ${groq} / ${openai} を入れています。`
      + ` URLは https://wordbank.pages.dev/?w=${ws}&mode=x です。`,
    contact: `連絡先: ${gemini}`,
    appVersion: `web-${wk}`,
  });
  assert.equal(response.status, 200);
  assert.equal(db.inserted.length, 1);

  const row = db.inserted[0];
  const saved = `${row.message}\n${row.contact}\n${row.app_version}`;
  for (const secret of [wk, wv, ws, gemini, groq, openai]) {
    assert.ok(!saved.includes(secret), `伏せ字にすること: ${secret.slice(0, 6)}…`);
  }
  assert.ok(saved.includes("[伏せ字]"), "伏せた印が残ること");
  assert.ok(row.message.includes("同期できません"), "本物の要望は残すこと");
});

test("秘密だけの投稿も受理する（伏せ字にしたうえで保存する）", async () => {
  const db = new FakeD1();
  const { response } = await post(db, { category: "other", message: `wk_${"a".repeat(60)}` });
  assert.equal(response.status, 200, "伏せ字にした結果が空扱いにならないこと");
  assert.equal(db.inserted[0].message, "[伏せ字]");
});

test("伏せ字で伸びても保存長は上限を超えない", async () => {
  const db = new FakeD1();
  // 上限いっぱいの本文に秘密を混ぜる。切り詰めてから伏せるので、伏せ字分だけ短くなる。
  const secret = `wk_${"a".repeat(60)}`;
  await post(db, { category: "other", message: `${secret} ${"あ".repeat(2000)}` });
  assert.ok(db.inserted[0].message.length <= 2000, "保存長が上限内であること");
  assert.ok(!db.inserted[0].message.includes(secret), "上限付近でも伏せること");
});

// 日本語には単語間の空白が無い。URLの終端を空白だけで判定すると、
// 「https://…?w=xxx。同期できません」の句点以降が丸ごと消える。
// 伏せるつもりで本文を捨てるのは、要望を受け取る口として最悪の壊れ方。
test("URLの直後に句読点が続いても、本文を消さずにクエリだけ伏せる", async () => {
  const db = new FakeD1();
  const { response } = await post(db, {
    category: "bug",
    message: "https://wordbank.pages.dev/?w=abc123def456。同期が動きません。直してください。",
  });
  assert.equal(response.status, 200);
  const saved = db.inserted[0].message;
  assert.ok(!saved.includes("abc123def456"), "クエリは伏せること");
  assert.ok(saved.includes("同期が動きません"), "句点以降の本文を残すこと");
  assert.ok(saved.includes("直してください"), "末尾まで残すこと");

  const comma = new FakeD1();
  await post(comma, { category: "bug", message: "https://wordbank.pages.dev/?w=zzz999、単語が消えました" });
  assert.ok(comma.inserted[0].message.includes("単語が消えました"), "読点直結でも本文を残すこと");
});

// アプリは `w=...` 断片の貼り付けを正式な入力形式として受理している。
// 利用者はその形のまま貼ってくるので、先頭の `w=` も伏せる必要がある。
test("先頭や行頭の w= も伏せる", async () => {
  const db = new FakeD1();
  const { response } = await post(db, {
    category: "other",
    message: "w=abc123def456ghi789 を貼りました\nw=xyz789012345 も貼ります",
  });
  assert.equal(response.status, 200);
  const saved = db.inserted[0].message;
  assert.ok(!saved.includes("abc123def456ghi789"), "先頭の w= を伏せること");
  assert.ok(!saved.includes("xyz789012345"), "行頭の w= も伏せること");
  assert.ok(saved.includes("を貼りました"), "本文は残すこと");
});
