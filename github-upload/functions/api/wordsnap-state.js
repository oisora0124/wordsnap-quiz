// WordBank の保存データを Cloudflare D1（SQLite・強整合）に保管する Pages Function。
// 契約（旧 Netlify Functions + Blobs 版と同じもの。Netlify版は停止済みのため削除した）：
//
//   GET  /api/wordsnap-state?sync=KEY        -> { syncId, state, stateRev, updatedAt }
//   PUT  /api/wordsnap-state?sync=KEY  body: { baseRev, state }
//        または圧縮形式 body: { baseRev, stateGz: "<base64>", format: "gzip-base64" }
//        baseRev が最新と一致 -> 保存して { ok, syncId, stateRev, updatedAt }
//        一致しない          -> 409 { error, syncId, state, stateRev, updatedAt }
//
// 【圧縮対応】単語1万語規模だと state の生JSONが 4MB（bodyの上限）や
// D1 の1行約2MB制限を超えて保存できなくなる。そこで:
//   - クライアントは gzip+base64 で送れる（旧クライアントのプレーン state も従来どおり受理）
//   - D1 へは常に gzip+base64 を {"__gz":"<base64>"} というマーカーJSONで保存する
//     （スキーマ変更なし。既存のプレーンJSON行も読み出し時にそのまま解釈できる）
//   - GET / 409 の応答は保存形式に関わらず「解凍済みのプレーン state」を返す＝契約は不変
//
// D1 を使う最大の利点: SQLite の1文の UPDATE ... WHERE rev=? が原子的な
// Compare-And-Swap になるので、「サーバー同時PUTの競合」を追加ロジックなしで防げる
// （Blobs の eventual consistency と手動 rev 比較で起きていた上書き事故が構造的に消える）。
//
// 必要な準備（Cloudflare ダッシュボード/wrangler で1回だけ）:
//   1. D1 データベースを作成（例: wordbank）
//   2. schema.sql を適用（states テーブル作成）
//   3. Pages プロジェクトの Functions バインディングで、変数名 DB に上記 D1 を割り当てる

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

// bodyの上限は従来どおり4MB（gzip後のstateはこの中に余裕で収まる）
const MAX_RAW_BODY = 4_000_000;
// クライアントのインポート上限（8MB・5万語）に、学習履歴やメタデータ分の
// 十分な余裕を加えた24MBを解凍上限とし、正規stateを保ちつつ解凍爆弾を防ぐ。
const MAX_INFLATED_JSON = 24_000_000;
// 正規データの上限（5万語）より余裕を持たせ、異常な件数だけを拒否する。
const MAX_STATE_WORDS = 60_000;
const MAX_STATE_DECKS = 2_000;
// 現行クライアントは1.8MBで送信を止める。サーバーではD1保存上限と同じ
// 1.9MBを受信上限にして、巨大なbase64をデコード・解凍する前に拒否する。
// 旧クライアントのプレーンstate受信には影響しない。
const MAX_INCOMING_BASE64 = 1_900_000;
// D1 は1行あたり約2MBの制限があるため、保存する base64 はその手前で拒否する
const MAX_STORED_BASE64 = 1_900_000;
// サーバーが認識している最新の learning スキーマ版。新しい learning スキーマを
// リリースするたびに +1 する。これ未満の版で来た PUT だけ、保存済みより低い版
// （＝未知フィールドを落とすダウングレード）でないかを確認する。最新版クライアントは
// 追加の read/decompress 無しで通過するため、通常 PUT のコストは変わらない。
const HIGHEST_LEARNING_VERSION = 1;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...HEADERS, ...extraHeaders },
  });
}

function methodNotAllowed() {
  return json({ error: "method not allowed" }, 405, { allow: "GET, PUT" });
}

// body をストリームで読み、上限バイトを超えた時点で打ち切る。Content-Length が
// 不明なchunked送信でも、全量をメモリへ載せる前に拒否できる。
async function readBodyCapped(request, maxBytes) {
  if (!request.body) {
    const text = await request.text();
    if (text.length > maxBytes) {
      const error = new Error("body too large");
      error.tooLarge = true;
      throw error;
    }
    return text;
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // 中断失敗は無視（例外で処理自体は打ち切られる）
      }
      const error = new Error("body too large");
      error.tooLarge = true;
      throw error;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

// キーは英数字・ハイフン・アンダーバーのみ、最大64文字（Netlify版 cleanSyncId と同一仕様）
function cleanSyncId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 64);
}

// base64 → gzip解凍 → JSON文字列。壊れたbase64/gzipは例外（呼び出し側で400系に変換）。
// 解凍後サイズが上限を超えたら sizeExceeded 印付きの例外で中断する（解凍爆弾対策）。
async function gunzipBase64ToText(base64) {
  const binary = atob(base64); // 不正なbase64はここで例外
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read(); // 不正なgzipはここで例外
    if (done) break;
    total += value.byteLength;
    if (total > MAX_INFLATED_JSON) {
      try {
        await reader.cancel();
      } catch {
        // 中断失敗は無視（例外で処理自体は打ち切られる）
      }
      const error = new Error("inflated state too large");
      error.sizeExceeded = true;
      throw error;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

// JSON文字列 → gzip → base64（D1保存用）
async function gzipTextToBase64(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000; // String.fromCharcodeの引数上限対策で分割
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function validStateShape(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray(value.words) &&
    Array.isArray(value.decks),
  );
}

// DBの1行を読み、stateを「解凍済みプレーン」で返す。
// 保存形式は2通りを受理する（後方互換）:
//   新: {"__gz":"<base64>"} マーカー → 解凍してJSONパース
//   旧: プレーンなstate JSONそのまま → そのまま採用
async function decodeStoredState(storedState) {
  let state = storedState ? JSON.parse(storedState) : null;
  if (state && typeof state === "object" && !Array.isArray(state) && typeof state.__gz === "string") {
    state = JSON.parse(await gunzipBase64ToText(state.__gz));
  }
  if (!validStateShape(state)) throw new Error("stored state has an invalid shape");
  return state;
}

async function readRow(db, syncId, includeState = true) {
  const row = await db
    .prepare(includeState
      ? "SELECT state, rev, updatedAt FROM states WHERE key = ?"
      : "SELECT rev, updatedAt FROM states WHERE key = ?")
    .bind(syncId)
    .first();
  if (!row) return { state: null, rev: 0, updatedAt: 0, corrupt: false };
  let state = null;
  let corrupt = false;
  if (includeState) {
    try {
      state = await decodeStoredState(row.state);
    } catch {
      // null（新規キー）と破損行を区別する。破損を空状態として200で返すと、
      // 新しい端末が「リモートは空」と判断して空データを自動送信し、復旧不能になる。
      state = null;
      corrupt = true;
    }
  }
  return { state, rev: Number(row.rev) || 0, updatedAt: Number(row.updatedAt) || 0, corrupt };
}

// 履歴テーブルは後から追加されるため、未マイグレーション環境でも主同期を止めない。
// 保存・整理はそれぞれ独立した best-effort とし、履歴側の障害を通常PUTへ伝播させない。
async function archiveRevision(db, key, rev, storedState, reason, logFailure = false) {
  try {
    await db
      .prepare(
        "INSERT OR IGNORE INTO state_revisions (key, rev, state, created_at, reason) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(key, rev, storedState, Date.now(), reason)
      .run();
  } catch (error) {
    // 履歴は復元用の補助データであり、主書き込みの成功を取り消してはならない。
    if (logFailure) {
      console.error("強制上書き後の履歴保存に失敗しました。", error);
    }
  }
}

async function pruneRevisions(db, key) {
  try {
    const firstDailyUtcDay = Math.floor(Date.now() / 86400000) - 6;
    await db
      .prepare(
        `DELETE FROM state_revisions
         WHERE key = ? AND rev NOT IN (
           SELECT rev FROM (
             SELECT rev FROM state_revisions WHERE key = ? ORDER BY rev DESC LIMIT 5
           )
           UNION
           SELECT MAX(daily_row.rev) AS rev
           FROM state_revisions AS daily_row
           INNER JOIN (
             SELECT CAST(created_at / 86400000 AS INTEGER) AS utc_day, MAX(created_at) AS latest_at
             FROM state_revisions
             WHERE key = ? AND CAST(created_at / 86400000 AS INTEGER) >= ?
             GROUP BY utc_day
           ) AS daily
             ON CAST(daily_row.created_at / 86400000 AS INTEGER) = daily.utc_day
            AND daily_row.created_at = daily.latest_at
           WHERE daily_row.key = ?
           GROUP BY daily.utc_day
         )`,
      )
      .bind(key, key, key, firstDailyUtcDay, key)
      .run();
  } catch {
    // 整理に失敗しても同期APIの可用性と、すでにコミット済みの主データを優先する。
  }
}

async function listRevisions(db, key) {
  try {
    const result = await db
      .prepare(
        "SELECT rev, created_at AS createdAt, reason FROM state_revisions WHERE key = ? ORDER BY created_at DESC",
      )
      .bind(key)
      .all();
    return (result.results || []).map((row) => ({
      rev: Number(row.rev),
      createdAt: Number(row.createdAt),
      reason: row.reason,
    }));
  } catch {
    // テーブル未作成を含む履歴参照失敗は、空の履歴として安全に縮退する。
    return [];
  }
}

async function readRevision(db, key, rev) {
  try {
    const row = await db
      .prepare("SELECT state, rev, created_at FROM state_revisions WHERE key = ? AND rev = ?")
      .bind(key, rev)
      .first();
    if (!row) return null;
    return {
      state: await decodeStoredState(row.state),
      rev: Number(row.rev),
      updatedAt: Number(row.updatedAt) || Number(row.created_at) || 0,
    };
  } catch {
    // 履歴テーブル不在や破損履歴は主データへ波及させず、存在しない版として扱う。
    return null;
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env || !env.DB) {
    return json({ error: "storage unavailable" }, 500);
  }
  const url = new URL(request.url);
  const syncId = cleanSyncId(url.searchParams.get("sync"));
  if (!syncId) return json({ error: "sync id required" }, 400);

  // 未対応methodはD1へ触れる前に拒否する。攻撃的なPOST/DELETE等で
  // ポーリング相当の読み取り課金を発生させない（GET/PUTの契約は不変）。
  if (request.method !== "GET" && request.method !== "PUT") {
    return methodNotAllowed();
  }

  const db = env.DB;

  if (request.method === "GET") {
    if (url.searchParams.get("history") === "1") {
      return json({ syncId, revisions: await listRevisions(db, syncId) });
    }
    const revisionRaw = url.searchParams.get("revision");
    if (revisionRaw !== null) {
      const revision = Number(revisionRaw);
      const archived = Number.isInteger(revision) && revision > 0
        ? await readRevision(db, syncId, revision)
        : null;
      if (!archived) return json({ error: "revision not found", code: "no_such_revision" }, 404);
      return json({
        syncId,
        state: archived.state,
        stateRev: archived.rev,
        updatedAt: archived.updatedAt,
      });
    }
    // まずrevisionだけを読む。未変更ポーリングでは巨大stateの解凍が不要。
    const current = await readRow(db, syncId, false);
    const sinceRaw = url.searchParams.get("sinceRev");
    const sinceRev = sinceRaw !== null && sinceRaw !== "" ? Number(sinceRaw) : null;
    if (Number.isFinite(sinceRev) && sinceRev === current.rev) {
      return json({
        syncId,
        state: null,
        stateRev: current.rev,
        updatedAt: current.updatedAt,
        notModified: true,
      });
    }
    const latest = await readRow(db, syncId);
    if (latest.corrupt) {
      return json({ error: "保存データを読み取れません。空データでは上書きしていません。", code: "corrupt_state" }, 500);
    }
    return json({ syncId, state: latest.state, stateRev: latest.rev, updatedAt: latest.updatedAt });
  }

  if (request.method === "PUT") {
    // --- 入力検証（すべて「拒否する」方向のみ。正しいクライアントの動きは変えない） ---
    // Content-Lengthが分かる場合はbodyを読む前に弾き、不要なメモリ確保を避ける。
    // Transfer-Encoding等で不明な場合も、下の実測長チェックが必ず働く。
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RAW_BODY) {
      return json({ error: "body too large" }, 413);
    }
    let raw = "";
    try {
      raw = await readBodyCapped(request, MAX_RAW_BODY);
    } catch (error) {
      if (error && error.tooLarge) return json({ error: "body too large" }, 413);
      return json({ error: "unreadable body" }, 400);
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "invalid body" }, 400);
    }
    if (body.baseRev !== undefined && body.baseRev !== null) {
      const baseRev = Number(body.baseRev);
      if (!Number.isInteger(baseRev) || baseRev < 0) {
        return json({ error: "invalid baseRev" }, 400);
      }
    }

    // --- state の取り出し：圧縮形式（新クライアント）とプレーン（旧クライアント）の両対応 ---
    let state;
    if (body.format === "gzip-base64" && typeof body.stateGz === "string") {
      if (body.stateGz.length > MAX_INCOMING_BASE64) {
        return json({ error: "compressed state too large" }, 413);
      }
      try {
        state = JSON.parse(await gunzipBase64ToText(body.stateGz));
      } catch (error) {
        if (error && error.sizeExceeded) return json({ error: "inflated state too large" }, 413);
        return json({ error: "invalid compressed state" }, 400);
      }
    } else {
      state = body.state;
    }
    // 検証は解凍後のstateに対して行う（プレーン受信時も同一の検証）
    if (!validStateShape(state)) {
      return json({ error: "invalid state" }, 422);
    }
    if (state.words.length > MAX_STATE_WORDS || state.decks.length > MAX_STATE_DECKS) {
      return json({ error: "state too large" }, 413);
    }

    // 有効なPUTであることを確認してから初めてD1へ触れる。不正JSON・巨大body・
    // 壊れたgzipを大量送信されても、D1の読み取り課金を発生させない。
    const current = await readRow(db, syncId, false);

    // SRS対応stateを一度保存したキーへ、古い版のクライアントが未知フィールドを
    // 落としたstateを上書きするのを防ぐ。最新版クライアント（incoming == HIGHEST）は
    // この分岐に入らないため、通常PUTでは巨大stateの追加read/decompressは発生しない。
    const incomingLearningVersion = Math.max(
      0,
      Math.floor(Number(state.learningSchemaVersion) || 0),
    );
    if (incomingLearningVersion < HIGHEST_LEARNING_VERSION) {
      const latest = await readRow(db, syncId);
      if (latest.corrupt) {
        return json({ error: "保存データを読み取れません。自動上書きを中止しました。", code: "corrupt_state" }, 500);
      }
      const storedLearningVersion = Math.max(
        0,
        Math.floor(Number(latest.state?.learningSchemaVersion) || 0),
      );
      // 一般化したダウングレード判定: 保存済みより低い版なら（v0<v1 も、将来の
      // v1<v2 も同様に）未知フィールド欠落での上書きとみなして拒否する。
      if (incomingLearningVersion < storedLearningVersion) {
        // 旧クライアントは data.error をそのまま同期ステータスに表示するため、
        // 機械可読コードは code に分け、error は人間向けの日本語にする。
        return json(
          {
            error: "アプリが古いため保存できません。ページを開き直して最新版に更新してください。",
            code: "downgrade_conflict",
            syncId,
            state: latest.state,
            stateRev: latest.rev,
            updatedAt: latest.updatedAt,
          },
          409,
        );
      }
    }

    // --- D1へは常に圧縮形式で保存する（プレーン受信でもここで圧縮する） ---
    const stateJson = JSON.stringify(state);
    if (stateJson.length > MAX_INFLATED_JSON) return json({ error: "state too large" }, 413);
    const storedBase64 = await gzipTextToBase64(stateJson);
    if (storedBase64.length > MAX_STORED_BASE64) return json({ error: "state too large" }, 413);
    const storedJson = JSON.stringify({ __gz: storedBase64 });

    const now = Date.now();
    const hasBase = body.baseRev !== undefined && body.baseRev !== null;
    const baseRev = hasBase ? Number(body.baseRev) : null;

    // 書き込みの実 rev/updatedAt は RETURNING で「その書き込み文が生成した値」を原子的に受け取る。
    // 別クエリで読み直すと、書き込みと読み直しの間に別クライアントのPUTが割り込み、
    // 他端末の rev を自分の結果として返してしまう（＝他端末更新のロストアップデート）。
    // RETURNING なら競合ウィンドウが無い。
    let savedRev = null;
    let savedUpdatedAt = now;
    let forcedOverwrite = false;
    if (current.rev === 0 && !(await rowExists(db, syncId))) {
      // 新規キー: baseRev 未指定 or 0 のときだけ作成（原子的 INSERT）
      if (!hasBase || baseRev === 0) {
        const row = await db
          .prepare(
            "INSERT OR IGNORE INTO states (key, state, rev, updatedAt) VALUES (?, ?, 1, ?) RETURNING rev, updatedAt",
          )
          .bind(syncId, storedJson, now)
          .first();
        if (row) {
          savedRev = Number(row.rev);
          savedUpdatedAt = Number(row.updatedAt);
        }
      }
    } else if (!hasBase && incomingLearningVersion >= 1) {
      // baseRev 省略 = 強制上書き（「この端末を正にする」）。原子的に rev を進める。
      forcedOverwrite = true;
      const row = await db
        .prepare("UPDATE states SET state = ?, rev = rev + 1, updatedAt = ? WHERE key = ? RETURNING rev, updatedAt")
        .bind(storedJson, now, syncId)
        .first();
      if (row) {
        savedRev = Number(row.rev);
        savedUpdatedAt = Number(row.updatedAt);
      }
    } else {
      // 楽観的ロック: 現在の rev が baseRev と一致するときだけ書き込む（原子的 CAS）
      // 旧クライアントのbaseRev省略は、v1 INSERTとの競合でSRSを消さないよう
      // 最初に読んだrevisionを暗黙のbaseRevとして扱う。
      const expectedRev = hasBase ? baseRev : current.rev;
      const row = await db
        .prepare(
          "UPDATE states SET state = ?, rev = rev + 1, updatedAt = ? WHERE key = ? AND rev = ? RETURNING rev, updatedAt",
        )
        .bind(storedJson, now, syncId, expectedRev)
        .first();
      if (row) {
        savedRev = Number(row.rev);
        savedUpdatedAt = Number(row.updatedAt);
      }
    }

    if (savedRev === null) {
      // 競合: 最新を読み直して 409 で返す（クライアントは pull→マージ→再push する）
      // state は readRow が解凍済みプレーンにして返す＝応答契約は従来と同じ。
      const latest = await readRow(db, syncId);
      if (latest.corrupt) {
        return json({ error: "保存データを読み取れません。自動競合解決を中止しました。", code: "corrupt_state" }, 500);
      }
      return json(
        { error: "conflict", syncId, state: latest.state, stateRev: latest.rev, updatedAt: latest.updatedAt },
        409,
      );
    }
    // 主書き込みがRETURNINGで成功確定した後だけ、その同一文字列を復元履歴へ残す。
    // 履歴の保存・整理はいずれもbest-effortなので、未マイグレーション環境でも200を維持する。
    await archiveRevision(db, syncId, savedRev, storedJson, "update", forcedOverwrite);
    await pruneRevisions(db, syncId);
    return json({ ok: true, syncId, stateRev: savedRev, updatedAt: savedUpdatedAt });
  }

  // methodは上で絞り込んでいるため到達しないが、将来の変更時もfail closedにする。
  return methodNotAllowed();
}

async function rowExists(db, syncId) {
  const row = await db.prepare("SELECT 1 FROM states WHERE key = ?").bind(syncId).first();
  return !!row;
}
