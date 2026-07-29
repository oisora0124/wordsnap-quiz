// フィードバックのメール通知の凍結ゲート。
//
// 守りたい不変条件:
//  ・宛先アドレスはリポジトリにもクライアントにも書かない（このリポジトリは公開）
//  ・設定が無ければ何も送らない＝現行どおり D1 保存のみ（挙動不変）
//  ・保存が失敗したら送らない（保存できていない要望をメールだけ通すと二重管理になる）
//  ・送信が失敗しても投稿は失われず、ユーザーには 200 を返す（fail-open）
//  ・件名にユーザー入力を入れない／連絡先を Reply-To に置かない
//  ・公開・無認証の投稿口なので、受信箱へのフラッドに上限を掛ける
//    （上限を確かめられないときは送らない＝メールだけ fail-closed）
//  ・生のIPアドレスを保存しない
//
// D1スタブは本物のSQLite（node:sqlite）に実SQLを流す。UPSERTの条件や bind 順を
// JSで再実装すると、SQLを壊してもテストが通ってしまうため。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { onRequest } from "../functions/api/feedback.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const API_URL = "https://wordbank.example/api/feedback";

// 本番と同じスキーマ（migrations/0003_feedback.sql, 0005_rate_limits.sql）を使う。
const SCHEMA = readFileSync(join(repoRoot, "migrations", "0003_feedback.sql"), "utf8")
  + "\n"
  + readFileSync(join(repoRoot, "migrations", "0005_rate_limits.sql"), "utf8");

// D1 の最小互換ラッパ。prepare/bind/first/run と meta.changes だけを提供する。
class FakeD1 {
  constructor({ hasTable = true, hasRateLimits = true } = {}) {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(SCHEMA);
    if (!hasTable) this.db.exec("DROP TABLE feedback");
    if (!hasRateLimits) this.db.exec("DROP TABLE rate_limits");
  }
  get inserted() {
    try {
      return this.db.prepare("SELECT * FROM feedback ORDER BY rowid").all();
    } catch {
      return [];
    }
  }
  limitRows() {
    return this.db.prepare("SELECT * FROM rate_limits").all();
  }
  prepare(sql) {
    const self = this;
    return {
      args: [],
      bind(...args) {
        this.args = args;
        return this;
      },
      async first() {
        return self.db.prepare(sql).get(...this.args) ?? null;
      },
      async run() {
        const result = self.db.prepare(sql).run(...this.args);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
  }
}

// fetch を差し替えて送信要求を記録する。テスト中に実ネットワークへ出ないことも兼ねる。
function captureFetch(responder = () => new Response("{}", { status: 200 })) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return responder(calls.length);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const RESEND_ENV = {
  FEEDBACK_MAIL_TO: "owner@example.org",
  FEEDBACK_MAIL_FROM: "WordBank <no-reply@example.com>",
  RESEND_API_KEY: "re_test_key",
};

async function post(db, body, { env = {}, headers = {}, waitUntil } = {}) {
  const request = new Request(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const context = { request, env: { DB: db, ...env } };
  const pending = [];
  if (waitUntil !== false) {
    context.waitUntil = (promise) => pending.push(promise);
  }
  const response = await onRequest(context);
  await Promise.allSettled(pending);
  return { response, data: await response.json(), pending };
}

test("診断ログに宛先・APIキー・投稿本文を出さない", () => {
  const source = readFileSync(join(repoRoot, "functions", "api", "feedback.js"), "utf8");
  const start = source.indexOf("function mailLog");
  const end = source.indexOf("export async function onRequest");
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  for (const forbidden of [
    /console\.\w+\([^)]*config\.key/,
    /console\.\w+\([^)]*config\.to\b/,
    /console\.\w+\([^)]*config\.from\b/,
    /mailLog\([^)]*\b(?:config\.key|to\.address|from\.address|record\.|text|message)\b/,
  ]) {
    assert.doesNotMatch(block, forbidden, `ログが ${forbidden} を含まないこと`);
  }
  // 設定の有無は真偽だけで示す（値をそのまま出さない）。
  assert.match(block, /state\(env\?\.FEEDBACK_MAIL_TO\)/);
  assert.doesNotMatch(block, /\$\{env\?\.\w+\}/, "環境変数の値を直接埋め込まないこと");
});

// ---- 宛先を書かない ----

test("宛先アドレスはリポジトリのどこにも書かれていない", () => {
  // 例示用ドメイン以外のメールアドレスがソースにあれば、設定に置くべきものが
  // ソースへ漏れている。公開リポジトリなのでここは常に空でなければならない。
  const allowed = /@(example\.(com|org|net|jp)|.*\.example)$/;
  const targets = [
    join(repoRoot, "publish", "index.html"),
    join(repoRoot, "wrangler.jsonc"),
    join(repoRoot, ".env.example"),
    ...readdirSync(join(repoRoot, "functions", "api"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => join(repoRoot, "functions", "api", name)),
  ];
  for (const file of targets) {
    const found = readFileSync(file, "utf8").match(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    ) || [];
    for (const address of found) {
      assert.match(address, allowed, `${file} に実在のアドレスが書かれている: ${address}`);
    }
  }
});

test("宛先・差出人・APIキーは env からしか読まない", () => {
  const source = readFileSync(join(repoRoot, "functions", "api", "feedback.js"), "utf8");
  for (const name of ["FEEDBACK_MAIL_TO", "FEEDBACK_MAIL_FROM", "RESEND_API_KEY", "BREVO_API_KEY"]) {
    assert.ok(source.includes(`env?.${name}`), `${name} は env 経由で読むこと`);
  }
});

// ---- 設定が無いときは挙動不変 ----

test("メール設定が無ければ一切送信しない（現行どおりD1保存のみ）", async () => {
  const fetchStub = captureFetch();
  try {
    const db = new FakeD1();
    const { response } = await post(db, { message: "設定なし" });
    assert.equal(response.status, 200);
    assert.equal(db.inserted.length, 1);
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    fetchStub.restore();
  }
});

test("宛先・差出人・APIキーのいずれかが欠けたら送らない", async () => {
  const cases = [
    { FEEDBACK_MAIL_FROM: RESEND_ENV.FEEDBACK_MAIL_FROM, RESEND_API_KEY: "re_x" },
    { FEEDBACK_MAIL_TO: RESEND_ENV.FEEDBACK_MAIL_TO, RESEND_API_KEY: "re_x" },
    { FEEDBACK_MAIL_TO: RESEND_ENV.FEEDBACK_MAIL_TO, FEEDBACK_MAIL_FROM: RESEND_ENV.FEEDBACK_MAIL_FROM },
    { FEEDBACK_MAIL_TO: "   ", FEEDBACK_MAIL_FROM: "   ", RESEND_API_KEY: "re_x" },
  ];
  for (const env of cases) {
    const fetchStub = captureFetch();
    try {
      const db = new FakeD1();
      const { response } = await post(db, { message: "欠け" }, { env });
      assert.equal(response.status, 200);
      assert.equal(db.inserted.length, 1);
      assert.equal(fetchStub.calls.length, 0, JSON.stringify(env));
    } finally {
      fetchStub.restore();
    }
  }
});

// ---- 送信内容 ----

test("Resend 設定なら Resend の形式で1通送る", async () => {
  const fetchStub = captureFetch();
  try {
    const db = new FakeD1();
    await post(
      db,
      { category: "request", message: "音声を追加してほしい", contact: "me@example.com", appVersion: "1.2.3" },
      { env: RESEND_ENV },
    );
    assert.equal(fetchStub.calls.length, 1);
    const [call] = fetchStub.calls;
    assert.equal(call.url, "https://api.resend.com/emails");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers.authorization, "Bearer re_test_key");
    const body = JSON.parse(call.init.body);
    assert.equal(body.from, "WordBank <no-reply@example.com>");
    assert.deepEqual(body.to, ["owner@example.org"]);
    assert.ok(body.text.includes("音声を追加してほしい"), "本文が入ること");
    assert.ok(body.text.includes("me@example.com"), "連絡先が本文に入ること");
    assert.ok(body.text.includes("1.2.3"), "アプリ版が入ること");
  } finally {
    fetchStub.restore();
  }
});

test("Brevo 設定なら Brevo の形式で送り、表示名とアドレスを分ける", async () => {
  const fetchStub = captureFetch();
  try {
    const db = new FakeD1();
    await post(db, { category: "bug", message: "落ちる" }, {
      env: {
        FEEDBACK_MAIL_TO: "WordBank Owner <owner@example.org>",
        FEEDBACK_MAIL_FROM: "WordBank <no-reply@example.com>",
        BREVO_API_KEY: "xkeysib_test",
      },
    });
    assert.equal(fetchStub.calls.length, 1);
    const [call] = fetchStub.calls;
    assert.equal(call.url, "https://api.brevo.com/v3/smtp/email");
    assert.equal(call.init.headers["api-key"], "xkeysib_test");
    const body = JSON.parse(call.init.body);
    assert.deepEqual(body.sender, { email: "no-reply@example.com", name: "WordBank" });
    assert.deepEqual(body.to, [{ email: "owner@example.org" }]);
    assert.ok(body.textContent.includes("落ちる"));
  } finally {
    fetchStub.restore();
  }
});

test("両方のキーがあれば Resend を使う（宛先が二重に届かない）", async () => {
  const fetchStub = captureFetch();
  try {
    const db = new FakeD1();
    await post(db, { message: "どちらか一方" }, {
      env: { ...RESEND_ENV, BREVO_API_KEY: "xkeysib_test" },
    });
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(fetchStub.calls[0].url, "https://api.resend.com/emails");
  } finally {
    fetchStub.restore();
  }
});

test("件名にユーザー入力は入らない（ヘッダ経由の混入を作らない）", async () => {
  const fetchStub = captureFetch();
  try {
    const db = new FakeD1();
    const nasty = "件名を乗っ取る\nBcc: attacker@example.net";
    await post(db, { category: "other", message: nasty }, { env: RESEND_ENV });
    const body = JSON.parse(fetchStub.calls[0].init.body);
    assert.ok(!body.subject.includes("乗っ取る"), "本文が件名に混ざらないこと");
    assert.ok(!/[\r\n]/.test(body.subject), "件名に改行が入らないこと");
    assert.ok(body.subject.startsWith("[WordBank]"));
  } finally {
    fetchStub.restore();
  }
});

test("ユーザー申告の連絡先を Reply-To / 差出人に使わない", async () => {
  const fetchStub = captureFetch();
  try {
    const db = new FakeD1();
    await post(db, { message: "なりすまし試験", contact: "victim@example.net" }, { env: RESEND_ENV });
    const body = JSON.parse(fetchStub.calls[0].init.body);
    assert.equal(body.reply_to, undefined);
    assert.equal(body.replyTo, undefined);
    assert.equal(body.from, RESEND_ENV.FEEDBACK_MAIL_FROM);
  } finally {
    fetchStub.restore();
  }
});

// ---- 失敗時の扱い ----

test("保存に失敗したらメールは送らない", async () => {
  const fetchStub = captureFetch();
  try {
    const db = new FakeD1({ hasTable: false });
    const request = new Request(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "保存できない" }),
    });
    const response = await onRequest({ request, env: { DB: db, ...RESEND_ENV } });
    assert.equal(response.status, 503);
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    fetchStub.restore();
  }
});

test("送信が失敗しても投稿は保存され 200 を返す（fail-open）", async () => {
  for (const responder of [
    () => new Response("nope", { status: 500 }),
    () => {
      throw new Error("network down");
    },
  ]) {
    const fetchStub = captureFetch(responder);
    try {
      const db = new FakeD1();
      const { response, data } = await post(db, { message: "落ちても消えない" }, { env: RESEND_ENV });
      assert.equal(response.status, 200);
      assert.deepEqual(data, { ok: true });
      assert.equal(db.inserted.length, 1);
    } finally {
      fetchStub.restore();
    }
  }
});

test("waitUntil が無い環境でも例外が外へ出ない", async () => {
  const fetchStub = captureFetch(() => {
    throw new Error("network down");
  });
  try {
    const db = new FakeD1();
    const { response } = await post(db, { message: "waitUntilなし" }, {
      env: RESEND_ENV,
      waitUntil: false,
    });
    assert.equal(response.status, 200);
    assert.equal(db.inserted.length, 1);
  } finally {
    fetchStub.restore();
  }
});

test("waitUntil 自体が投げても、保存済みの投稿を失敗扱いにしない", async () => {
  const fetchStub = captureFetch();
  try {
    const db = new FakeD1();
    const response = await onRequest({
      request: new Request(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "waitUntilが壊れている" }),
      }),
      env: { DB: db, ...RESEND_ENV },
      waitUntil() {
        throw new Error("waitUntil unavailable");
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(db.inserted.length, 1);
  } finally {
    fetchStub.restore();
  }
});

test("waitUntil があれば応答をブロックしない", async () => {
  // 送信を止めたまま応答が返ることを見る。fetch は応答後に呼ばれるので、
  // 解放用の Promise は先に作っておく。
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(new Response("{}", { status: 200 }));
  });
  const fetchStub = captureFetch(() => gate);
  try {
    const db = new FakeD1();
    const request = new Request(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "非同期" }),
    });
    const pending = [];
    const response = await onRequest({
      request,
      env: { DB: db, ...RESEND_ENV },
      waitUntil: (promise) => pending.push(promise),
    });
    // 送信が未完了のまま応答が返っていること
    assert.equal(response.status, 200);
    assert.equal(pending.length, 1);
    release();
    await Promise.allSettled(pending);
  } finally {
    fetchStub.restore();
  }
});

// ---- フラッド対策 ----

test("同一IPからの通知は時間あたりの上限で止まる（保存は続く）", async () => {
  const fetchStub = captureFetch();
  try {
    const db = new FakeD1();
    for (let i = 0; i < 8; i += 1) {
      const { response } = await post(db, { message: `連投${i}` }, {
        env: RESEND_ENV,
        headers: { "CF-Connecting-IP": "203.0.113.9" },
      });
      assert.equal(response.status, 200);
    }
    assert.equal(db.inserted.length, 8, "投稿はすべて保存されること");
    assert.equal(fetchStub.calls.length, 5, "メールは上限まで");
  } finally {
    fetchStub.restore();
  }
});

test("IPを変えても全体上限で止まる", async () => {
  const fetchStub = captureFetch();
  try {
    const db = new FakeD1();
    for (let i = 0; i < 70; i += 1) {
      await post(db, { message: `分散${i}` }, {
        env: RESEND_ENV,
        headers: { "CF-Connecting-IP": `198.51.100.${i}` },
      });
    }
    assert.equal(db.inserted.length, 70);
    assert.equal(fetchStub.calls.length, 60, "全体上限を超えて送らないこと");
  } finally {
    fetchStub.restore();
  }
});

test("上限を確認できないときは送らない（メールだけ fail-closed）", async () => {
  // rate_limits が読めないまま送ると、公開・無認証の投稿口が無制限の送信路になる。
  // 通知を見送っても投稿は D1 に残るので、要望そのものは失われない。
  const fetchStub = captureFetch();
  try {
    const db = new FakeD1({ hasRateLimits: false });
    const { response } = await post(db, { message: "補助テーブル無し" }, { env: RESEND_ENV });
    assert.equal(response.status, 200);
    assert.equal(db.inserted.length, 1, "投稿は保存されること");
    assert.equal(fetchStub.calls.length, 0, "上限不明なら送らないこと");
  } finally {
    fetchStub.restore();
  }
});

test("生のIPアドレスは保存しない（rate_limits のキーは不可逆）", async () => {
  const fetchStub = captureFetch();
  try {
    const db = new FakeD1();
    const ip = "203.0.113.77";
    await post(db, { message: "IP保存の確認" }, {
      env: RESEND_ENV,
      headers: { "CF-Connecting-IP": ip },
    });
    const keys = db.limitRows().map((row) => row.rl_key);
    assert.ok(keys.length > 0, "上限行が作られること");
    for (const key of keys) {
      assert.ok(!key.includes(ip), `キーに生IPが入っている: ${key}`);
    }
    assert.ok(keys.includes("fb-mail:all"), "全体上限の行があること");
    assert.ok(
      keys.some((key) => /^fb-mail:[0-9a-f]{16}$/.test(key)),
      "IP側のキーはハッシュ済みであること",
    );
  } finally {
    fetchStub.restore();
  }
});

test("胡椒があればIPキーはHMACになり、素のSHA-256と一致しない", async () => {
  const fetchStub = captureFetch();
  try {
    const ipKey = async (env) => {
      const db = new FakeD1();
      await post(db, { message: "鍵の違い" }, {
        env,
        headers: { "CF-Connecting-IP": "203.0.113.1" },
      });
      return db.limitRows().map((row) => row.rl_key).find((key) => key !== "fb-mail:all");
    };
    const plain = await ipKey(RESEND_ENV);
    const peppered = await ipKey({ ...RESEND_ENV, FEEDBACK_RATE_LIMIT_SECRET: "pepper" });
    const peppered2 = await ipKey({ ...RESEND_ENV, FEEDBACK_RATE_LIMIT_SECRET: "other" });
    assert.ok(plain && peppered && peppered2);
    assert.notEqual(peppered, plain, "胡椒を入れたら別のキーになること");
    assert.notEqual(peppered, peppered2, "胡椒ごとに別のキーになること");
  } finally {
    fetchStub.restore();
  }
});

test("窓が明けた上限行は掃除して溜めない", async () => {
  const fetchStub = captureFetch();
  try {
    const db = new FakeD1();
    const stale = Date.now() - 3 * 60 * 60 * 1000;
    for (let i = 0; i < 5; i += 1) {
      db.db
        .prepare("INSERT INTO rate_limits (rl_key, window_start, count) VALUES (?, ?, ?)")
        .run(`fb-mail:dead${i}`, stale, 3);
    }
    // 同期API側の行は掃除の対象外（別機能の状態を壊さない）。
    db.db
      .prepare("INSERT INTO rate_limits (rl_key, window_start, count) VALUES (?, ?, ?)")
      .run("v2-create:1.2.3.4", stale, 3);

    await post(db, { message: "掃除" }, { env: RESEND_ENV });

    const keys = db.limitRows().map((row) => row.rl_key);
    assert.ok(!keys.some((key) => key.startsWith("fb-mail:dead")), "期限切れ行が残らないこと");
    assert.ok(keys.includes("v2-create:1.2.3.4"), "同期API側の行に触らないこと");
  } finally {
    fetchStub.restore();
  }
});

test("上限の書き込みだけが失敗する場合も送らない", async () => {
  const fetchStub = captureFetch();
  try {
    const db = new FakeD1();
    const inner = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/^INSERT INTO rate_limits/i.test(sql.trim())) {
        return {
          bind() { return this; },
          async run() { throw new Error("d1 write failed"); },
        };
      }
      return inner(sql);
    };
    const { response } = await post(db, { message: "書き込みだけ失敗" }, { env: RESEND_ENV });
    assert.equal(response.status, 200);
    assert.equal(db.inserted.length, 1);
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    fetchStub.restore();
  }
});

test("全体上限で止まったとき、IP側の枠を無駄に減らさない", async () => {
  const fetchStub = captureFetch();
  try {
    const db = new FakeD1();
    db.db
      .prepare("INSERT INTO rate_limits (rl_key, window_start, count) VALUES (?, ?, ?)")
      .run("fb-mail:all", Date.now(), 60);
    await post(db, { message: "全体が満杯" }, {
      env: RESEND_ENV,
      headers: { "CF-Connecting-IP": "203.0.113.5" },
    });
    assert.equal(fetchStub.calls.length, 0);
    // 保存側の枠（fb-save:*）は保存が成立した分だけ消費されるので対象外。
    // ここで見るのはメール枠のIP側だけ。
    const ipRows = db.limitRows()
      .filter((row) => row.rl_key.startsWith("fb-mail:") && row.rl_key !== "fb-mail:all");
    assert.equal(ipRows.length, 0, "送っていないのにIP側を消費しないこと");
  } finally {
    fetchStub.restore();
  }
});

test("時間窓が明けたら再び送れる", async () => {
  const fetchStub = captureFetch();
  try {
    const db = new FakeD1();
    // 1時間より前に埋まった枠は失効しているはず。
    db.db
      .prepare("INSERT INTO rate_limits (rl_key, window_start, count) VALUES (?, ?, ?)")
      .run("fb-mail:all", Date.now() - 2 * 60 * 60 * 1000, 60);
    await post(db, { message: "窓明け" }, { env: RESEND_ENV });
    assert.equal(fetchStub.calls.length, 1);
  } finally {
    fetchStub.restore();
  }
});

// ---- 設定値の検証 ----

test("宛先・差出人が壊れていたら送らない（改行・複数アドレス・不正形式）", async () => {
  for (const broken of [
    "owner@example.org\nBcc: attacker@example.net",
    "a@example.org, b@example.org",
    "owner(at)example.org",
    "WordBank <owner@example.org",
    "<>",
  ]) {
    const fetchStub = captureFetch();
    try {
      const db = new FakeD1();
      const { response } = await post(db, { message: "壊れた設定" }, {
        env: { ...RESEND_ENV, FEEDBACK_MAIL_TO: broken },
      });
      assert.equal(response.status, 200);
      assert.equal(db.inserted.length, 1);
      assert.equal(fetchStub.calls.length, 0, `送ってはいけない: ${broken}`);
      // 設定不備は送信を試みる前に弾く。後段で例外任せにすると、送っていないのに
      // 送信枠だけが減り、設定を直した直後に上限で止まる。
      // 保存側の枠（fb-save:*）は保存が成立した分だけ消費される。ここで見るのはメール枠だけ。
      assert.deepEqual(
        db.limitRows().filter((row) => row.rl_key.startsWith("fb-mail:")),
        [],
        `設定不備で送信枠を消費しないこと: ${broken}`,
      );
    } finally {
      fetchStub.restore();
    }
  }
});

test("Resend への直接HTTP呼び出しには User-Agent を付ける（無いと403）", async () => {
  const fetchStub = captureFetch();
  try {
    const db = new FakeD1();
    await post(db, { message: "UA確認" }, { env: RESEND_ENV });
    const headers = fetchStub.calls[0].init.headers;
    assert.ok(headers["user-agent"], "User-Agent が必要");
    assert.ok(!/re_test_key/.test(headers["user-agent"]), "UAに秘密情報を入れない");
  } finally {
    fetchStub.restore();
  }
});
