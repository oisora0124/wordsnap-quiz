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

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

// bodyの上限は従来どおり4MB（gzip後のstateはこの中に余裕で収まる）
const MAX_RAW_BODY = 4_000_000;
// 解凍後JSONの上限。正当な数万語データでも到達しない値にして「解凍爆弾」を防ぐ
const MAX_INFLATED_JSON = 50_000_000;
// D1 は1行あたり約2MBの制限があるため、保存する base64 はその手前で拒否する
const MAX_STORED_BASE64 = 1_900_000;
// サーバーが認識している最新の learning スキーマ版。新しい learning スキーマを
// リリースするたびに +1 する。これ未満の版で来た PUT だけ、保存済みより低い版
// （＝未知フィールドを落とすダウングレード）でないかを確認する。最新版クライアントは
// 追加の read/decompress 無しで通過するため、通常 PUT のコストは変わらない。
const HIGHEST_LEARNING_VERSION = 1;

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

// DBの1行を読み、stateを「解凍済みプレーン」で返す。
// 保存形式は2通りを受理する（後方互換）:
//   新: {"__gz":"<base64>"} マーカー → 解凍してJSONパース
//   旧: プレーンなstate JSONそのまま → そのまま採用
async function readRow(db, syncId, includeState = true) {
  const row = await db
    .prepare(includeState
      ? "SELECT state, rev, updatedAt FROM states WHERE key = ?"
      : "SELECT rev, updatedAt FROM states WHERE key = ?")
    .bind(syncId)
    .first();
  if (!row) return { state: null, rev: 0, updatedAt: 0 };
  let state = null;
  if (includeState) {
    try {
      state = row.state ? JSON.parse(row.state) : null;
      if (state && typeof state === "object" && !Array.isArray(state) && typeof state.__gz === "string") {
        state = JSON.parse(await gunzipBase64ToText(state.__gz));
      }
    } catch {
      state = null; // 万一DB内が壊れていても500にせず null 扱い
    }
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
  // まずrevisionだけを読む。未変更ポーリングや成功PUTでは巨大stateの解凍が不要。
  const current = await readRow(db, syncId, false);

  if (request.method === "GET") {
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
    return json({ syncId, state: latest.state, stateRev: latest.rev, updatedAt: latest.updatedAt });
  }

  if (request.method === "PUT") {
    // --- 入力検証（すべて「拒否する」方向のみ。正しいクライアントの動きは変えない） ---
    let raw = "";
    try {
      raw = await request.text();
    } catch {
      return json({ error: "unreadable body" }, 400);
    }
    if (raw.length > MAX_RAW_BODY) return json({ error: "body too large" }, 413);
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

    // --- state の取り出し：圧縮形式（新クライアント）とプレーン（旧クライアント）の両対応 ---
    let state;
    if (body.format === "gzip-base64" && typeof body.stateGz === "string") {
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
    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      !Array.isArray(state.words) ||
      !Array.isArray(state.decks)
    ) {
      return json({ error: "invalid state" }, 422);
    }

    // SRS対応stateを一度保存したキーへ、古い版のクライアントが未知フィールドを
    // 落としたstateを上書きするのを防ぐ。最新版クライアント（incoming == HIGHEST）は
    // この分岐に入らないため、通常PUTでは巨大stateの追加read/decompressは発生しない。
    const incomingLearningVersion = Math.max(
      0,
      Math.floor(Number(state.learningSchemaVersion) || 0),
    );
    if (incomingLearningVersion < HIGHEST_LEARNING_VERSION) {
      const latest = await readRow(db, syncId);
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
      return json(
        { error: "conflict", syncId, state: latest.state, stateRev: latest.rev, updatedAt: latest.updatedAt },
        409,
      );
    }
    return json({ ok: true, syncId, stateRev: savedRev, updatedAt: savedUpdatedAt });
  }

  return json({ error: "method not allowed" }, 405);
}

async function rowExists(db, syncId) {
  const row = await db.prepare("SELECT 1 FROM states WHERE key = ?").bind(syncId).first();
  return !!row;
}
