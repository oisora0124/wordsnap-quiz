// WordBank の匿名利用統計・エラー情報を受け取る Pages Function（書き込み専用）。
//
// 契約:
//   POST /api/telemetry  body: { events: [{ kind, name, detail?, count? }], appRev? }
//        -> 200 { ok: true }
//   その他のメソッド     -> 405
//
// 読み取り用エンドポイントは意図的に作らない。保存行にはIP・UAを含めず、
// 開発者が D1 の SQL を直接実行した場合だけ閲覧できる。

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

// 最大20件すべてが日本語・絵文字でも契約上の文字数を受け入れられる上限。
const MAX_RAW_BODY = 80_000;
const MAX_EVENTS = 20;
const MAX_NAME = 120;
const MAX_DETAIL = 600;
const MAX_APP_REV = 40;
const KINDS = new Set(["usage", "error"]);
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
// wv_ はAIキー暗号化同期のvault key。封筒の復号鍵そのものなので、
// 万一エラー文へ混ざっても保存・表示されないよう伏せる対象に含める。
const SECRET_PATTERN = /w(s|k|r|v)?_[0-9a-f]{16,}/gi;
const URL_QUERY_PATTERN = /\b(https?:\/\/[^\s?#]+)\?[^#\s]*/gi;
const W_QUERY_PATTERN = /([?&]w=)[^&#\s]*/gi;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...HEADERS, ...extraHeaders },
  });
}

// 表示に不要な制御文字を落とす。タブ・改行・復帰はstackの可読性のため残す。
function cleanText(value) {
  if (typeof value !== "string") return "";
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (code >= 0x7f && code <= 0x9f) continue;
    out += ch;
  }
  return out;
}

// 同期用の個人キーと、URLに残った従来形式の ?w= 値を保存前に必ず消す。
function redactSecrets(value) {
  return String(value || "")
    .replace(URL_QUERY_PATTERN, "$1?[redacted]")
    .replace(W_QUERY_PATTERN, "$1[redacted]")
    .replace(SECRET_PATTERN, "[redacted]");
}

async function readBodyCapped(request, maxBytes) {
  if (!request.body) {
    const text = await request.text();
    if (text.length > maxBytes) {
      const error = new Error("payload too large");
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
        // 読み取り中断の失敗は無視し、上限超過として処理を終える。
      }
      const error = new Error("payload too large");
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

// wordsnap-state.js の固定窓レート制限と同じ方式。補助テーブルが無い場合や
// 一時的なD1障害では、匿名統計の保存を優先してfail-openにする。
async function consumeTelemetryRateLimit(db, request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateLimitKey = `telemetry:${ip}`;
  const now = Date.now();
  try {
    const current = await db
      .prepare("SELECT window_start, count FROM rate_limits WHERE rl_key = ?")
      .bind(rateLimitKey)
      .first();
    const expired = !current || now >= Number(current.window_start) + RATE_WINDOW_MS;
    if (!expired && Number(current.count) >= RATE_LIMIT) return true;

    const expiryCutoff = now - RATE_WINDOW_MS;
    const result = await db
      .prepare(
        `INSERT INTO rate_limits (rl_key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(rl_key) DO UPDATE SET
           window_start = CASE
             WHEN rate_limits.window_start <= ? THEN excluded.window_start
             ELSE rate_limits.window_start
           END,
           count = CASE
             WHEN rate_limits.window_start <= ? THEN 1
             ELSE rate_limits.count + 1
           END
         WHERE rate_limits.window_start <= ? OR rate_limits.count < ?`,
      )
      .bind(
        rateLimitKey,
        now,
        expiryCutoff,
        expiryCutoff,
        expiryCutoff,
        RATE_LIMIT,
      )
      .run();
    // 窓が明けた行はもう上限判定に使われないが、IP単位のキーなので放置すると
    // 行が増え続ける（IPv6は端末側で無尽蔵に変えられるため、意図的に膨らませられる）。
    // 掃除するのは自分の窓が明けたときだけ＝IPごとに高々1窓に1回。
    if (expired) {
      try {
        await db
          .prepare("DELETE FROM rate_limits WHERE rl_key LIKE 'telemetry:%' AND window_start <= ?")
          .bind(expiryCutoff)
          .run();
      } catch {
        // 掃除の失敗は握り潰す（次に窓が明けた誰かが再試行する）。
      }
    }
    return Number(result?.meta?.changes) === 0;
  } catch {
    return false;
  }
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (!Array.isArray(payload.events) || payload.events.length > MAX_EVENTS) return null;

  const rawAppRev = payload.appRev === undefined ? "" : payload.appRev;
  if (typeof rawAppRev !== "string") return null;
  const appRev = cleanText(rawAppRev).trim();
  if (appRev.length > MAX_APP_REV) return null;

  const events = [];
  for (const rawEvent of payload.events) {
    if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) return null;
    if (!KINDS.has(rawEvent.kind)) return null;

    if (typeof rawEvent.name !== "string") return null;
    const name = cleanText(rawEvent.name).trim();
    if (name.length < 1 || name.length > MAX_NAME) return null;

    const rawDetail = rawEvent.detail === undefined ? "" : rawEvent.detail;
    if (typeof rawDetail !== "string") return null;
    const detail = cleanText(rawDetail);
    if (detail.length > MAX_DETAIL) return null;

    const count = rawEvent.count === undefined ? 1 : rawEvent.count;
    if (!Number.isInteger(count) || count < 1 || count > 1000) return null;

    events.push({
      kind: rawEvent.kind,
      name: redactSecrets(name),
      detail: redactSecrets(detail),
      count,
    });
  }

  return { events, appRev: redactSecrets(appRev) };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405, { allow: "POST" });
  }

  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return json({ error: "unsupported media type" }, 415);
  }

  if (!env || !env.DB) {
    return json({ error: "storage unavailable" }, 503);
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RAW_BODY) {
    return json({ error: "payload too large" }, 413);
  }

  let raw;
  try {
    raw = await readBodyCapped(request, MAX_RAW_BODY);
  } catch (error) {
    if (error && error.tooLarge) return json({ error: "payload too large" }, 413);
    return json({ error: "invalid body" }, 400);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const validated = validatePayload(payload);
  if (!validated) return json({ error: "invalid events" }, 400);

  if (await consumeTelemetryRateLimit(env.DB, request)) {
    return json({ error: "rate limited", code: "rate-limited" }, 429);
  }

  const createdAt = Date.now();
  try {
    if (validated.events.length > 0) {
      const statements = validated.events.map((event) => (
        env.DB
          .prepare(
            "INSERT INTO telemetry (kind, name, detail, count, app_rev, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(
            event.kind,
            event.name,
            event.detail,
            event.count,
            validated.appRev,
            createdAt,
          )
      ));
      await env.DB.batch(statements);
    }
  } catch (error) {
    const missingTable = /no such table/i.test(String(error && error.message));
    return json(
      { error: missingTable ? "storage unavailable" : "could not save" },
      missingTable ? 503 : 500,
    );
  }

  return json({ ok: true });
}
