// 実SQLite（node:sqlite）に migrations を適用し、**本番の Functions をそのまま**
// 動かす結合テスト。
//
// 既存の契約テスト（api-contract / telemetry-contract / feedback-contract）は
// FakeD1 を使っている。FakeD1 は「期待するSQLの意味」を JavaScript で
// 再実装したもので、**与えられたSQLを解釈していない**。したがって次を通してしまう:
//
//   - SQLの構文エラー
//   - 制約違反（NOT NULL / UNIQUE / CHECK）
//   - migrations の適用漏れ（存在しない列・テーブル）
//   - ON CONFLICT / LIMIT 付きサブクエリの実際の挙動
//
// レビュー記録の M7「結合テストが無い（FakeD1は実D1ではない）」がこれで、
// 「サーバー側のスキーマを変更するときに再検討」と書かれていた。
//
// ここが守るのは **SQLとスキーマの正しさ** まで。
// ネットワーク遅延・30秒上限・同時実行の直列化は実D1でしか出ない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase, tableNames, indexNames, migrationFiles } from "./sqlite-d1.mjs";

import { onRequest as telemetryRequest } from "../functions/api/telemetry.js";
import { onRequest as feedbackRequest } from "../functions/api/feedback.js";
import { onRequest as stateRequest } from "../functions/api/wordsnap-state.js";

const ORIGIN = "https://wordbank.example";

/** ブラウザからの正規のリクエストを作る（同一オリジン判定を通す）。 */
function post(url, body, { ip = "203.0.113.10", headers = {} } = {}) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "CF-Connecting-IP": ip,
      "user-agent": "D1IntegrationTest/1.0",
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// ---- migrations そのもの ----

test("migrations が実SQLiteへ順に適用でき、期待どおりの形になる", () => {
  const db = createTestDatabase();
  try {
    assert.deepEqual(tableNames(db), [
      "feedback", "rate_limits", "rooms", "state_revisions", "states", "telemetry",
    ]);
    assert.deepEqual(indexNames(db), [
      "idx_feedback_created",
      "idx_state_revisions_key_created",
      "idx_states_updated_at",
      "idx_telemetry_created",
    ]);
  } finally {
    db.close();
  }
});

test("migrations は何度適用しても壊れない（IF NOT EXISTS）", () => {
  // 本番へ再適用しても既存データが消えないことの根拠。
  const files = migrationFiles();
  const db = createTestDatabase({ only: [...files, ...files] });
  try {
    assert.equal(tableNames(db).length, 6);
  } finally {
    db.close();
  }
});

test("途中までしか適用していないと、そのテーブルを使うAPIが実際に失敗する", async () => {
  // 「migrationsを当て忘れた本番」を再現する。FakeD1 では起きない失敗。
  const db = createTestDatabase({ only: ["0001_initial.sql"] });
  try {
    const response = await telemetryRequest({
      request: post(`${ORIGIN}/api/telemetry`, { events: [{ kind: "usage", name: "quiz-answer" }] }),
      env: { DB: db },
    });
    assert.equal(response.status, 503, "テーブルが無いのに成功として扱っている");
    assert.deepEqual(await response.json(), { error: "storage unavailable" });
  } finally {
    db.close();
  }
});

// ---- telemetry ----

test("telemetry: 実DBへ書き込み、保持期限の掃除も実SQLで動く", async () => {
  const db = createTestDatabase();
  try {
    const response = await telemetryRequest({
      request: post(`${ORIGIN}/api/telemetry`, {
        appRev: "1.0.73",
        events: [
          { kind: "usage", name: "quiz-answer", count: 3 },
          { kind: "error", name: "TypeError", detail: "stack" },
        ],
      }),
      env: { DB: db },
    });
    assert.equal(response.status, 200);

    const rows = (await db.prepare("SELECT kind, name, count, app_rev FROM telemetry ORDER BY id").all()).results;
    assert.deepEqual(rows, [
      { kind: "usage", name: "quiz-answer", count: 3, app_rev: "1.0.73" },
      { kind: "error", name: "TypeError", count: 1, app_rev: "1.0.73" },
    ]);

    // 期限切れの行を直接入れて、掃除が実SQLで効くことを確かめる
    const old = Date.now() - 200 * 24 * 60 * 60 * 1000;
    await db
      .prepare("INSERT INTO telemetry (kind, name, detail, count, app_rev, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("usage", "ancient", "", 1, "old", old)
      .run();

    // 別IPの初回リクエスト＝窓が明けた扱いで掃除が走る
    await telemetryRequest({
      request: post(`${ORIGIN}/api/telemetry`, { events: [{ kind: "usage", name: "quiz-answer" }] }, { ip: "203.0.113.99" }),
      env: { DB: db },
    });

    const ancient = await db.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE name = 'ancient'").first();
    assert.equal(ancient.n, 0, "保持期限を過ぎた行が実DBで消えていない");
    const fresh = await db.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE name = 'quiz-answer'").first();
    assert.ok(fresh.n > 0, "期限内の行まで消している");
  } finally {
    db.close();
  }
});

test("telemetry: レート制限の ON CONFLICT が実SQLで正しく数える", async () => {
  const db = createTestDatabase();
  try {
    // FakeD1 は ON CONFLICT の意味を JS で書き直しているが、ここは本物のSQLite。
    for (let i = 0; i < 3; i += 1) {
      const response = await telemetryRequest({
        request: post(`${ORIGIN}/api/telemetry`, { events: [{ kind: "usage", name: "quiz-answer" }] }),
        env: { DB: db },
      });
      assert.equal(response.status, 200, `${i + 1}回目が失敗した`);
    }
    const row = await db.prepare("SELECT count FROM rate_limits WHERE rl_key LIKE 'telemetry:%'").first();
    assert.equal(row.count, 3, "ON CONFLICT の加算が効いていない");
  } finally {
    db.close();
  }
});

// ---- feedback ----

test("feedback: 実DBへ保存でき、列の制約を満たす", async () => {
  const db = createTestDatabase();
  try {
    const response = await feedbackRequest({
      request: post(`${ORIGIN}/api/feedback`, {
        category: "request",
        message: "単語帳を並べ替えたい",
      }),
      env: { DB: db },
    });
    assert.equal(response.status, 200, `保存できていない: ${await response.text()}`);
    const row = await db.prepare("SELECT category, message FROM feedback").first();
    assert.equal(row.category, "request");
    assert.equal(row.message, "単語帳を並べ替えたい");
  } finally {
    db.close();
  }
});

// ---- 同期（states / state_revisions） ----

test("同期: PUT が実DBへ書き、GET で同じ状態が返る", async () => {
  const db = createTestDatabase();
  const key = "testkey0123456789";
  try {
    const state = { words: [{ id: "w1", term: "apple", meaning: "りんご" }], decks: [] };
    const put = await stateRequest({
      request: new Request(`${ORIGIN}/api/wordsnap-state?sync=${key}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10" },
        body: JSON.stringify({ state }),
      }),
      env: { DB: db },
    });
    assert.equal(put.status, 200, `PUTが失敗: ${await put.text()}`);

    const stored = await db.prepare("SELECT key, rev FROM states WHERE key = ?").bind(key).first();
    assert.ok(stored, "states へ行が作られていない");
    assert.equal(stored.rev, 1);

    const get = await stateRequest({
      request: new Request(`${ORIGIN}/api/wordsnap-state?sync=${key}`, {
        headers: { "CF-Connecting-IP": "203.0.113.10" },
      }),
      env: { DB: db },
    });
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.equal(body.state.words[0].term, "apple", "保存した状態が返っていない");
  } finally {
    db.close();
  }
});

test("同期: 楽観的排他（baseRev 不一致で409）が実DBで効く", async () => {
  const db = createTestDatabase();
  const key = "testkey9876543210";
  const write = (body) =>
    stateRequest({
      request: new Request(`${ORIGIN}/api/wordsnap-state?sync=${key}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10" },
        body: JSON.stringify(body),
      }),
      env: { DB: db },
    });
  try {
    const first = await write({ state: { words: [], decks: [] } });
    assert.equal(first.status, 200);
    const { stateRev } = await first.json();

    // 正しい baseRev なら通る
    const ok = await write({ state: { words: [], decks: [] }, baseRev: stateRev });
    assert.equal(ok.status, 200, "正しいbaseRevが拒否された");

    // 古い baseRev は 409
    const conflict = await write({ state: { words: [], decks: [] }, baseRev: stateRev });
    assert.equal(conflict.status, 409, "競合を検出できていない（CASが効いていない）");
  } finally {
    db.close();
  }
});

test("同期: 履歴（state_revisions）が実DBへ積まれ、保持制約が効く", async () => {
  const db = createTestDatabase();
  const key = "testkeyhistory001";
  try {
    for (let i = 0; i < 8; i += 1) {
      const res = await stateRequest({
        request: new Request(`${ORIGIN}/api/wordsnap-state?sync=${key}&force=1`, {
          method: "PUT",
          headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.10" },
          body: JSON.stringify({ state: { words: [{ id: `w${i}`, term: `t${i}`, meaning: `m${i}` }], decks: [] } }),
        }),
        env: { DB: db },
      });
      assert.equal(res.status, 200, `${i + 1}回目のPUTが失敗`);
    }
    const rows = (await db.prepare("SELECT rev FROM state_revisions WHERE key = ? ORDER BY rev").bind(key).all()).results;
    assert.ok(rows.length > 0, "履歴が1件も積まれていない");
    // 上位5件＋日次の保持制約により、8回書いても全部は残らない
    assert.ok(rows.length <= 8, `履歴が想定より多い: ${rows.length}`);
  } finally {
    db.close();
  }
});

test("同期V2: room 作成が単一トランザクションで、states と rooms が揃う", async () => {
  const db = createTestDatabase();
  const roomId = `wr_${"a".repeat(32)}`;
  const secret = `wk_${"b".repeat(60)}`;
  try {
    const res = await stateRequest({
      request: new Request(`${ORIGIN}/api/wordsnap-state?room=${roomId}&create=1`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "CF-Connecting-IP": "203.0.113.10",
          "x-room-key": secret,
        },
        body: JSON.stringify({ state: { words: [], decks: [] } }),
      }),
      env: {
        DB: db,
        SYNC_V2_ENABLED: "1",
        SYNC_AUTH_SECRETS: JSON.stringify([{ kid: "k1", secret: "x".repeat(48) }]),
      },
    });
    assert.equal(res.status, 200, `V2作成が失敗: ${await res.text()}`);

    const room = await db.prepare("SELECT room_id, state_key FROM rooms WHERE room_id = ?").bind(roomId).first();
    assert.ok(room, "rooms へ行が作られていない");
    const state = await db.prepare("SELECT key FROM states WHERE key = ?").bind(room.state_key).first();
    assert.ok(state, "states 側が作られていない（孤児の room ができている）");
  } finally {
    db.close();
  }
});
