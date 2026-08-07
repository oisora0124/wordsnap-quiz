// 匿名telemetry APIの契約テスト。
// 入力境界、秘密情報の除去、固定窓レート制限、補助テーブル不在時の
// fail-open、書き込み専用であることを固定する。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { onRequest, TELEMETRY_TTL_MS, TELEMETRY_PRUNE_LIMIT } from "../functions/api/telemetry.js";

const here = dirname(fileURLToPath(import.meta.url));

const API_URL = "https://wordbank.example/api/telemetry";

class FakeD1 {
  constructor({ telemetryTableExists = true, rateLimitsTableExists = true, pruneFails = false } = {}) {
    this.telemetryTableExists = telemetryTableExists;
    this.rateLimitsTableExists = rateLimitsTableExists;
    // 掃除だけを失敗させる。テーブルごと消すと INSERT も落ちてしまい、
    // 「掃除の失敗が応答に響くか」を切り分けられない。
    this.pruneFails = pruneFails;
    this.inserted = [];
    this.rateLimits = new Map();
    this.cleanupCalls = [];
    this.telemetryPrunes = []; // telemetry の保持期限による掃除が呼ばれた回数と cutoff
    this.deletes = []; // 想定外のテーブルへの DELETE を捕まえる
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
        // 期限切れ行の掃除。実装が「自分の接頭辞の、窓が明けた行だけ」を消すことを
        // ここで実際に再現して検査する（未対応SQLとして握り潰すと検証にならない）。
        if (/^DELETE FROM rate_limits WHERE rl_key LIKE 'telemetry:%' AND window_start <= \?$/i.test(this.sql)) {
          if (!self.rateLimitsTableExists) throw new Error("no such table: rate_limits");
          const [cutoff] = this.args;
          let changes = 0;
          for (const [key, row] of [...self.rateLimits]) {
            if (!key.startsWith("telemetry:")) continue;
            if (row.window_start > cutoff) continue;
            self.rateLimits.delete(key);
            changes += 1;
          }
          self.cleanupCalls.push(cutoff);
          return { meta: { changes } };
        }
        if (/^INSERT INTO telemetry /i.test(this.sql)) {
          if (!self.telemetryTableExists) throw new Error("no such table: telemetry");
          const [kind, name, detail, count, app_rev, created_at] = this.args;
          self.inserted.push({ kind, name, detail, count, app_rev, created_at });
          return { meta: { changes: 1 } };
        }
        // 匿名統計の保持期限による掃除。実装の try/catch が例外を握り潰すので、
        // ここで再現しないと「掃除が動いているか」を一切検査できない
        //（未対応SQLで投げさせると、握り潰されて素通りになる）。
        if (/^DELETE FROM telemetry WHERE id IN \( SELECT id FROM telemetry WHERE created_at <= \? ORDER BY created_at LIMIT \? \)$/i.test(this.sql)) {
          if (self.pruneFails) throw new Error("D1_ERROR: prune failed");
          if (!self.telemetryTableExists) throw new Error("no such table: telemetry");
          const [cutoff, limit] = this.args;
          // 上限を実際に効かせる。効かせないと「上限が外れている」変異を検出できない。
          const doomed = new Set(
            self.inserted
              .filter((row) => Number(row.created_at) <= Number(cutoff))
              .sort((a, b) => Number(a.created_at) - Number(b.created_at))
              .slice(0, Number(limit)),
          );
          const before = self.inserted.length;
          self.inserted = self.inserted.filter((row) => !doomed.has(row));
          self.telemetryPrunes.push({ cutoff: Number(cutoff), limit: Number(limit) });
          return { meta: { changes: before - self.inserted.length } };
        }
        // どのテーブルへ DELETE を投げたかを必ず記録する。
        // 進捗の控え（states / rooms）や利用者の要望（feedback）を消していないことの根拠。
        if (/^DELETE /i.test(this.sql)) {
          self.deletes.push(this.sql);
          throw new Error(`unexpected delete sql: ${this.sql}`);
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

async function post(db, body, { method = "POST", ip = "203.0.113.10", headers = {} } = {}) {
  const init = {
    method,
    headers: {
      "content-type": "application/json",
      "CF-Connecting-IP": ip,
      "user-agent": "TelemetryContractTest/1.0",
      ...headers,
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

test("ws_, wk_, wr_, wv_ secrets and URL queries are redacted before storage", async () => {
  const db = new FakeD1();
  const ws = `ws_${"a".repeat(16)}`;
  const wk = `wk_${"b".repeat(20)}`;
  const wr = `wr_${"c".repeat(32)}`;
  // wv_ はAIキー暗号化同期のvault key（封筒の復号鍵）。ここが漏れると
  // サーバー側の封筒がそのまま開けるようになるので、伏せ漏れは致命的。
  const wv = `wv_${"e".repeat(64)}`;
  const querySecret = `query-${"d".repeat(20)}`;
  const { response } = await post(db, {
    events: [{
      kind: "error",
      name: `failed ${ws} ${wk} ${wr}`,
      // wv_ は67文字あり name の120字上限に収まらないので detail 側へ置く
      detail: `vault ${wv} at https://wordbank.example/app?w=${querySecret}&mode=test`,
    }],
  });
  assert.equal(response.status, 200);
  const saved = `${db.inserted[0].name}\n${db.inserted[0].detail}`;
  for (const secret of [ws, wk, wr, wv, querySecret]) assert.ok(!saved.includes(secret));
  assert.ok(saved.includes("[redacted]"));
});

test("クライアント側のredactionもwv_を伏せる（送信前に落とす）", () => {
  const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");
  const line = /const SECRET_PATTERN = \/w\(s\|k\|r\|v\)\?_\[0-9a-f\]\{16,\}\/gi;/.exec(html);
  assert.ok(line, "クライアント側のSECRET_PATTERNがwv_を含むこと");
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

// 呼んでいるのに許可リストへ入れ忘れると、そのイベントは無言で捨てられる。
// 実際にPhase 2の sync-v2-native-issue と告知の3イベントがこれで一度も記録されて
// いなかった。捨てられても誰も気づけない（例外も警告も出ない）ので、ここで固定する。
test("trackUsage で呼ばれている名前は、すべて USAGE_NAMES に入っている", () => {
  const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");
  const listBlock = /const USAGE_NAMES = new Set\(\[([\s\S]*?)\]\);/.exec(html);
  assert.ok(listBlock, "USAGE_NAMES が見つかること");
  const allowed = new Set(
    [...listBlock[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]),
  );
  const called = new Set(
    [...html.matchAll(/trackUsage\("([a-z0-9-]+)"\)/g)].map((m) => m[1]),
  );
  const dropped = [...called].filter((name) => !allowed.has(name));
  assert.deepEqual(dropped, [], `許可リストに無い計測名: ${dropped.join(", ")}`);
  assert.ok(called.size >= 15, "呼び出しが検出できていること");
});

test("Phase 2 と AIキー同期の計測名が許可リストにある", () => {
  const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");
  const listBlock = /const USAGE_NAMES = new Set\(\[([\s\S]*?)\]\);/.exec(html);
  const allowed = new Set([...listBlock[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]));
  for (const name of [
    "sync-v2-native-issue",
    "v2-announce-shown",
    "ai-key-sync-enable",
    "ai-key-sync-adopt",
    "ai-key-sync-mismatch",
  ]) {
    assert.ok(allowed.has(name), `${name} が許可リストにあること`);
  }
});

// レート制限行はIPごとに増える。窓が明けても消えないと、IPを変えるだけで
// rate_limits を無制限に膨らませられる（IPv6は端末側で自由に変えられる）。
test("expired rate-limit rows are pruned, and only expired rows of this endpoint", async () => {
  const db = new FakeD1();
  const now = Date.now();
  const stale = now - 25 * 60 * 60 * 1000; // 24時間の窓より古い
  db.rateLimits.set("telemetry:198.51.100.1", { window_start: stale, count: 60 });
  db.rateLimits.set("telemetry:198.51.100.2", { window_start: now, count: 1 });
  db.rateLimits.set("v2-create:198.51.100.3", { window_start: stale, count: 10 });

  const { response } = await post(db, { events: [{ kind: "usage", name: "quiz-answer" }] });

  assert.equal(response.status, 200, "掃除は本来の処理を妨げないこと");
  assert.equal(db.cleanupCalls.length, 1, "窓が明けたときだけ掃除すること");
  assert.equal(db.rateLimits.has("telemetry:198.51.100.1"), false, "期限切れ行は消えること");
  assert.equal(db.rateLimits.has("telemetry:198.51.100.2"), true, "有効な窓の行は残ること");
  assert.equal(
    db.rateLimits.has("v2-create:198.51.100.3"),
    true,
    "別エンドポイントの行には手を出さないこと",
  );
});

test("a live window does not trigger pruning on every request", async () => {
  const db = new FakeD1();
  await post(db, { events: [{ kind: "usage", name: "quiz-answer" }] });
  assert.equal(db.cleanupCalls.length, 1, "初回は窓が無いので掃除が走る");
  await post(db, { events: [{ kind: "usage", name: "quiz-answer" }] });
  assert.equal(db.cleanupCalls.length, 1, "同じ窓の2回目では全表を走査しないこと");
});

// `text/plain;x=application/json` は essence が text/plain なので、ブラウザは
// プリフライトなしの simple POST として送れる。部分一致で受理していると
// 任意サイトからの書き込み経路になる。essence で判定していることを固定する。
test("Content-Type essence が application/json でなければ 415 にする", async () => {
  for (const contentType of [
    "text/plain;x=application/json",
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=application/json",
  ]) {
    const db = new FakeD1();
    const { response } = await post(db, { events: [{ kind: "usage", name: "quiz-answer" }] }, {
      headers: { "content-type": contentType },
    });
    assert.equal(response.status, 415, `${contentType} を通さないこと`);
    assert.equal(db.inserted.length, 0);
  }
  // パラメータ付きの正しい指定は通す
  const ok = new FakeD1();
  const { response } = await post(ok, { events: [{ kind: "usage", name: "quiz-answer" }] }, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  assert.equal(response.status, 200, "charset付きは受理すること");
  assert.equal(ok.inserted.length, 1);
});

test("別オリジンからのPOSTは保存せず403にする", async () => {
  const cross = new FakeD1();
  const crossResult = await post(cross, { events: [{ kind: "usage", name: "quiz-answer" }] }, {
    headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
  });
  assert.equal(crossResult.response.status, 403);
  assert.equal(cross.inserted.length, 0, "拒否時は1行も書かないこと");

  // Sec-Fetch-Site が無い古いブラウザでも Origin だけで判定できること
  const originOnly = new FakeD1();
  const originResult = await post(originOnly, { events: [{ kind: "usage", name: "quiz-answer" }] }, {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(originResult.response.status, 403);
  assert.equal(originOnly.inserted.length, 0);

  // 自分のオリジンからは通す
  const same = new FakeD1();
  const sameResult = await post(same, { events: [{ kind: "usage", name: "quiz-answer" }] }, {
    headers: { Origin: "https://wordbank.example", "Sec-Fetch-Site": "same-origin" },
  });
  assert.equal(sameResult.response.status, 200);
  assert.equal(same.inserted.length, 1);

  // Origin を付けない非ブラウザ経路は従来どおり通す（CSRFの担い手にならない）
  const noOrigin = new FakeD1();
  const noOriginResult = await post(noOrigin, { events: [{ kind: "usage", name: "quiz-answer" }] });
  assert.equal(noOriginResult.response.status, 200);
  assert.equal(noOrigin.inserted.length, 1);
});

// ---- 匿名統計の保持期限 ----
// telemetry は追記しかしないテーブルで、利用者数×利用頻度で増え続ける
// （上限は 1IPあたり 60req×20件/日）。利用者2名なら数十年先だが、
// 50名で年2GB、1000名なら数週間で無料枠に届く。
//
// **消してよいのは telemetry だけ。** states / rooms は進捗の控えと引き継ぎで、
// 休眠を理由に消すと「久しぶりに再開する人」の復元経路を壊す。
// feedback は利用者が書いた要望そのもの。どちらも対象外であることを固定する。

test("保持期限を過ぎた匿名統計を掃除する（窓が明けたときだけ）", async () => {
  const db = new FakeD1();
  const now = Date.now();

  // 期限内と期限切れの行を仕込む
  db.inserted.push({ kind: "usage", name: "old", detail: "", count: 1, app_rev: "x", created_at: now - TELEMETRY_TTL_MS - 1000 });
  db.inserted.push({ kind: "usage", name: "fresh", detail: "", count: 1, app_rev: "x", created_at: now - 1000 });

  // 1回目＝窓が無い状態なので expired 扱い→掃除が走る
  const result = await post(db, { events: [{ kind: "usage", name: "quiz-answer" }] });
  assert.equal(result.response.status, 200);
  assert.equal(db.telemetryPrunes.length, 1, "窓が明けたときに掃除が走っていない");

  const { cutoff, limit } = db.telemetryPrunes[0];
  assert.ok(
    Math.abs(now - TELEMETRY_TTL_MS - cutoff) < 5000,
    `cutoff が保持期限とずれている: ${now - cutoff}ms`,
  );
  assert.equal(limit, TELEMETRY_PRUNE_LIMIT, "1回の削除に上限が付いていない");
  assert.ok(!db.inserted.some((r) => r.name === "old"), "期限切れの行が残っている");
  assert.ok(db.inserted.some((r) => r.name === "fresh"), "期限内の行まで消している");
});

test("窓が明けていないときは掃除しない（書き込み回数を増やさない）", async () => {
  const db = new FakeD1();
  await post(db, { events: [{ kind: "usage", name: "quiz-answer" }] }); // 1回目で窓が立つ
  const first = db.telemetryPrunes.length;
  await post(db, { events: [{ kind: "usage", name: "quiz-answer" }] }); // 2回目は同じ窓の中
  assert.equal(db.telemetryPrunes.length, first, "同じ窓の中で毎回掃除している");
});

test("掃除が失敗しても、統計の保存と応答は落ちない", async () => {
  // 掃除だけを失敗させる。テーブルごと欠落させると INSERT も落ちて 503 になり
  //（これは元からの正しい挙動）、掃除の影響を切り分けられない。
  const db = new FakeD1({ pruneFails: true });
  const result = await post(db, { events: [{ kind: "usage", name: "quiz-answer" }] });
  assert.equal(result.response.status, 200, "掃除の失敗で応答を落としている");
  assert.equal(db.inserted.length, 1, "掃除の失敗で統計の保存まで落ちている");
});

test("掃除の対象は telemetry だけ（進捗と要望には触れない）", async () => {
  const db = new FakeD1();
  await post(db, { events: [{ kind: "usage", name: "quiz-answer" }] });
  assert.deepEqual(db.deletes, [], `想定外のテーブルへ DELETE している: ${db.deletes.join(" / ")}`);

  // 実装のソースにも、進捗側への DELETE が無いことを固定する。
  const source = readFileSync(join(here, "..", "functions", "api", "telemetry.js"), "utf8");
  for (const table of ["states", "rooms", "feedback", "state_revisions"]) {
    assert.ok(
      !new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, "i").test(source),
      `telemetry.js が ${table} を削除している`,
    );
  }
});

test("保持期限は短すぎない（障害の傾向を追える長さ）", () => {
  const days = TELEMETRY_TTL_MS / (24 * 60 * 60 * 1000);
  assert.ok(days >= 90, `保持期限が短すぎる: ${days}日`);
  assert.ok(days <= 730, `保持期限が長すぎて掃除の意味が薄い: ${days}日`);
});

test("1回の掃除で消す行数に上限がある（D1の30秒制限に当てない）", async () => {
  const db = new FakeD1();
  const now = Date.now();
  const old = now - TELEMETRY_TTL_MS - 1000;
  // 上限の3倍の期限切れ行を仕込む
  const total = TELEMETRY_PRUNE_LIMIT * 3;
  for (let i = 0; i < total; i += 1) {
    db.inserted.push({ kind: "usage", name: `old${i}`, detail: "", count: 1, app_rev: "x", created_at: old - i });
  }

  await post(db, { events: [{ kind: "usage", name: "quiz-answer" }] });
  const remainingOld = db.inserted.filter((r) => Number(r.created_at) <= old).length;
  assert.equal(
    remainingOld,
    total - TELEMETRY_PRUNE_LIMIT,
    `1回で ${total - remainingOld} 行消している。上限 ${TELEMETRY_PRUNE_LIMIT} が効いていない`,
  );

  // 溜まっていても、窓が明けるたびに少しずつ減る（詰まらない）
  db.rateLimits.clear(); // 次の窓へ
  await post(db, { events: [{ kind: "usage", name: "quiz-answer" }] });
  const afterSecond = db.inserted.filter((r) => Number(r.created_at) <= old).length;
  assert.ok(afterSecond < remainingOld, "2回目の掃除で減っていない（溜まったまま詰まる）");
});

test("上限は大きすぎない（1クエリに集中させない）", () => {
  assert.ok(TELEMETRY_PRUNE_LIMIT >= 100, `上限が小さすぎて溜まりが減らない: ${TELEMETRY_PRUNE_LIMIT}`);
  assert.ok(TELEMETRY_PRUNE_LIMIT <= 5000, `上限が大きすぎる: ${TELEMETRY_PRUNE_LIMIT}`);
});
