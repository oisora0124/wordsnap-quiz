// WordBank の保存データを Cloudflare D1（SQLite・強整合）に保管する Pages Function。
// Netlify Functions + Blobs 版（netlify/functions/wordsnap-state.mjs）と「同じ契約」に揃えている：
//
//   GET  /api/wordsnap-state?sync=KEY        -> { syncId, state, stateRev, updatedAt }
//   PUT  /api/wordsnap-state?sync=KEY  body: { baseRev, state }
//        baseRev が最新と一致 -> 保存して { ok, syncId, stateRev, updatedAt }
//        一致しない          -> 409 { error, syncId, state, stateRev, updatedAt }
//
// D1 を使う最大の利点: SQLite の1文の UPDATE ... WHERE rev=? が原子的な
// Compare-And-Swap になるので、「サーバー同時PUTの競合」を追加ロジックなしで防げる
// （Blobs の eventual consistency と手動 rev 比較で起きていた上書き事故が構造的に消える）。
//
// 必要な準備（Cloudflare ダッシュボード/wrangler で1回だけ）:
//   1. D1 データベースを作成（例: wordbank）
//   2. schema.sql を適用（states テーブル作成）
//   3. Pages プロジェクトの Functions バインディングで、変数名 DB に上記 D1 を割り当てる

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

// キーは英数字・ハイフン・アンダーバーのみ、最大64文字（Netlify版 cleanSyncId と同一仕様）
function cleanSyncId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 64);
}

async function readRow(db, syncId) {
  const row = await db
    .prepare("SELECT state, rev, updatedAt FROM states WHERE key = ?")
    .bind(syncId)
    .first();
  if (!row) return { state: null, rev: 0, updatedAt: 0 };
  let state = null;
  try {
    state = row.state ? JSON.parse(row.state) : null;
  } catch {
    state = null; // 万一DB内が壊れていても500にせず null 扱い
  }
  return { state, rev: Number(row.rev) || 0, updatedAt: Number(row.updatedAt) || 0 };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env || !env.DB) {
    return json({ error: "D1 binding 'DB' is not configured" }, 500);
  }
  const url = new URL(request.url);
  const syncId = cleanSyncId(url.searchParams.get("sync"));
  if (!syncId) return json({ error: "sync id required" }, 400);

  const db = env.DB;
  const current = await readRow(db, syncId);

  if (request.method === "GET") {
    return json({ syncId, state: current.state, stateRev: current.rev, updatedAt: current.updatedAt });
  }

  if (request.method === "PUT") {
    // --- 入力検証（すべて「拒否する」方向のみ。正しいクライアントの動きは変えない） ---
    let raw = "";
    try {
      raw = await request.text();
    } catch {
      return json({ error: "unreadable body" }, 400);
    }
    if (raw.length > 4_000_000) return json({ error: "body too large" }, 413);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "invalid body" }, 400);
    }
    if (body.baseRev !== undefined && body.baseRev !== null && !Number.isFinite(Number(body.baseRev))) {
      return json({ error: "invalid baseRev" }, 400);
    }
    const state = body.state;
    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      !Array.isArray(state.words) ||
      !Array.isArray(state.decks)
    ) {
      return json({ error: "invalid state" }, 422);
    }

    const nextRev = current.rev + 1;
    const now = Date.now();
    const stateJson = JSON.stringify(state);
    const hasBase = body.baseRev !== undefined && body.baseRev !== null;
    const baseRev = hasBase ? Number(body.baseRev) : null;

    let applied = false;
    if (current.rev === 0 && !(await rowExists(db, syncId))) {
      // 新規キー: baseRev 未指定 or 0 のときだけ作成（原子的 INSERT）
      if (!hasBase || baseRev === 0) {
        const res = await db
          .prepare("INSERT OR IGNORE INTO states (key, state, rev, updatedAt) VALUES (?, ?, 1, ?)")
          .bind(syncId, stateJson, now)
          .run();
        applied = (res.meta?.changes || 0) > 0;
      }
    } else if (!hasBase) {
      // baseRev 省略 = 強制上書き（「この端末を正にする」）。原子的に rev を進める。
      const res = await db
        .prepare("UPDATE states SET state = ?, rev = rev + 1, updatedAt = ? WHERE key = ?")
        .bind(stateJson, now, syncId)
        .run();
      applied = (res.meta?.changes || 0) > 0;
    } else {
      // 楽観的ロック: 現在の rev が baseRev と一致するときだけ書き込む（原子的 CAS）
      const res = await db
        .prepare("UPDATE states SET state = ?, rev = rev + 1, updatedAt = ? WHERE key = ? AND rev = ?")
        .bind(stateJson, now, syncId, baseRev)
        .run();
      applied = (res.meta?.changes || 0) > 0;
    }

    if (!applied) {
      // 競合: 最新を読み直して 409 で返す（クライアントは pull→マージ→再push する）
      const latest = await readRow(db, syncId);
      return json(
        { error: "conflict", syncId, state: latest.state, stateRev: latest.rev, updatedAt: latest.updatedAt },
        409,
      );
    }
    const saved = await readRow(db, syncId);
    return json({ ok: true, syncId, stateRev: saved.rev, updatedAt: saved.updatedAt });
  }

  return json({ error: "method not allowed" }, 405);
}

async function rowExists(db, syncId) {
  const row = await db.prepare("SELECT 1 FROM states WHERE key = ?").bind(syncId).first();
  return !!row;
}
