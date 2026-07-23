// WordBank のユーザー要望・フィードバックを受け取る Pages Function（書き込み専用）。
//
// 契約:
//   POST /api/feedback  body: { category, message, contact?, appVersion? }
//        -> 200 { ok: true }
//   その他のメソッド     -> 405
//
// 【設計方針: 開発者だけが読める】
//   読み取り用のエンドポイントは意図的に用意しない。GET も 405。
//   投稿された内容は Cloudflare D1 の feedback テーブルに入るだけで、閲覧は
//   D1 ダッシュボードの SQL（Cloudflareアカウント所有者のみ実行可能）で行う。
//   これにより「他のユーザーがフィードバックを読む経路」が構造的に存在しない。
//
// 【プライバシー】
//   同期キー（?w=）・IPアドレスは受け取らないし保存もしない。
//   連絡先は任意。UAはデバッグ目的で切り詰めて保存する。
//
// 同期API（wordsnap-state.js）とは完全に別ファイル・別テーブルで、既存の保存・
// 同期の経路には一切触れない。feedback テーブルが無い場合は 503 を返すだけ。

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

// 受信bodyの上限。本文2000＋連絡先200＋JSONの装飾でも十分収まる小さめの値にして、
// 巨大なペイロードはJSONパース前に弾く（スパム・DoS対策）。
const MAX_RAW_BODY = 16_000;
const MAX_MESSAGE = 2000;
const MAX_CONTACT = 200;
const MAX_APP_VERSION = 40;
const CATEGORIES = new Set(["request", "bug", "other"]);

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...HEADERS, ...extraHeaders },
  });
}

// 制御文字を除いた文字列を最大長で切り詰めて返す。タブ(0x09)・改行(0x0A)・復帰(0x0D)
// は本文の体裁として許可し、それ以外の C0 制御文字・DEL(0x7F)・C1 制御文字(0x80-0x9F)を落とす。
// 正規表現リテラルに生の制御文字を書くとソースが壊れるため、コードポイントで判定する。
function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (code >= 0x7f && code <= 0x9f) continue; // DEL と C1 制御文字
    out += ch;
  }
  return out.slice(0, maxLength);
}

// body をストリームで読み、上限バイトを超えた時点で打ち切る（Content-Length 詐称・
// chunked 送信でも request.text() で全量をバッファせずに済ませる DoS 対策）。
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
        // 中断失敗は無視（例外で処理は打ち切られる）
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

export async function onRequest(context) {
  const { request, env } = context;

  // 書き込み専用: POST 以外は一律 405（GET を含む＝公開の読み取り経路を作らない）。
  if (request.method !== "POST") {
    return json({ error: "method not allowed" }, 405, { allow: "POST" });
  }

  // 現行クライアントはJSONで送信する。simple POSTになり得る非JSON本文は、
  // クロスサイトからの踏み台利用を防ぐためストレージへ触れる前に拒否する。
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return json({ error: "unsupported media type" }, 415);
  }

  if (!env || !env.DB) {
    return json({ error: "storage unavailable" }, 503);
  }

  // bodyサイズの上限。Content-Length があれば先に、無ければ読み取ったテキスト長で確認。
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
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return json({ error: "invalid json" }, 400);
  }

  const message = cleanText(payload.message, MAX_MESSAGE).trim();
  if (!message) {
    return json({ error: "message required" }, 400);
  }
  const rawCategory = String(payload.category || "").trim();
  const category = CATEGORIES.has(rawCategory) ? rawCategory : "other";
  const contact = cleanText(payload.contact, MAX_CONTACT).trim();
  const appVersion = cleanText(payload.appVersion, MAX_APP_VERSION).trim();
  // プライバシー優先: User-Agent は保存しない（開示を増やさず、最小データに徹する）。
  // 列はスキーマ安定のため残し、常に空文字を入れる。
  const userAgent = "";

  try {
    await env.DB.prepare(
      "INSERT INTO feedback (created_at, category, message, contact, app_version, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(Date.now(), category, message, contact, appVersion, userAgent)
      .run();
  } catch (error) {
    // feedback テーブル未適用や一時障害。内部詳細は返さない。
    const missingTable = /no such table/i.test(String(error && error.message));
    return json(
      { error: missingTable ? "storage unavailable" : "could not save" },
      missingTable ? 503 : 500,
    );
  }

  return json({ ok: true });
}
