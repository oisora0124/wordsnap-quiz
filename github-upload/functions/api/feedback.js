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
//   同期キー（?w=）・IPアドレスは受け取らないし保存もしない。連絡先は任意。UAも保存しない。
//   メール通知の送信上限だけは「同じ相手か」を数える必要があるため、IPを
//   不可逆に潰した8バイトを rate_limits のキーに使う（feedback テーブル側には
//   一切入らず、投稿内容とも結び付かない）。窓が明けた行は掃除して残さない。
//
// 【メール通知】
//   保存に成功したら、設定されていれば通知メールを1通送る。宛先・差出人・APIキーは
//   すべて Cloudflare 側の環境変数／シークレットで与える。このリポジトリは公開なので、
//   宛先アドレスをソースにもクライアントにも書かない（未設定なら通知しないだけ）。
//     FEEDBACK_MAIL_TO     宛先（シークレット）
//     FEEDBACK_MAIL_FROM   差出人（プロバイダで許可されたアドレス）
//     RESEND_API_KEY       Resend を使う場合のAPIキー
//     BREVO_API_KEY        Brevo を使う場合のAPIキー（RESEND_API_KEY が優先）
//     FEEDBACK_RATE_LIMIT_SECRET  任意。送信上限のIPキーをHMAC化する胡椒
//   送信は fail-open。失敗しても投稿は D1 に残っており、ユーザーには 200 を返す
//   （送れなかったことでユーザーの要望が消えるほうが害が大きい）。
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

// ---- メール通知 ----

const MAIL_TIMEOUT_MS = 8000;
const MAIL_USER_AGENT = "WordBank-Feedback/1.0";
const CATEGORY_LABELS = { request: "要望", bug: "不具合", other: "その他" };

// 通知は公開・無認証のエンドポイントから発火するため、そのままでは受信箱への
// フラッド経路になる。IP単位と全体の二段で上限を掛け、超えた分は「保存はするが
// メールは出さない」に倒す（投稿自体は D1 に残るので失われない）。
const MAIL_RATE_LIMITS = [
  { scope: "ip", limit: 5, windowMs: 60 * 60 * 1000 },
  { scope: "all", limit: 60, windowMs: 60 * 60 * 1000 },
];

// 送信先が設定されていなければ null を返す＝通知しない（現行どおり D1 保存のみ）。
function mailConfig(env) {
  const to = String(env?.FEEDBACK_MAIL_TO || "").trim();
  const from = String(env?.FEEDBACK_MAIL_FROM || "").trim();
  if (!to || !from) return null;
  const resendKey = String(env?.RESEND_API_KEY || "").trim();
  if (resendKey) return { provider: "resend", to, from, key: resendKey };
  const brevoKey = String(env?.BREVO_API_KEY || "").trim();
  if (brevoKey) return { provider: "brevo", to, from, key: brevoKey };
  return null;
}

// `no-reply@example.com` または `WordBank <no-reply@example.com>` の1件だけを受理する。
// 設定ミス（改行混入・複数アドレス・閉じていない山括弧）は黙って通さず null にして
// 送信自体を見送る — 壊れた値をプロバイダへ渡しても失敗して枠を無駄にするだけ。
const MAILBOX_PATTERN = /^(?:([^<>@\n\r]*?)\s*<\s*([^\s<>@,;]+@[^\s<>@,;]+)\s*>|([^\s<>@,;]+@[^\s<>@,;]+))$/;

function parseMailbox(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || /[\r\n,;]/.test(trimmed)) return null;
  const match = MAILBOX_PATTERN.exec(trimmed);
  if (!match) return null;
  const address = match[2] || match[3];
  if (!address || !/^[^@]+@[^@]+\.[^@]+$/.test(address)) return null;
  const name = (match[1] || "").trim().replace(/^"(.*)"$/, "$1").trim();
  return { address, name: name || "WordBank", raw: trimmed };
}

// 件名にはユーザー入力を一切入れない。ヘッダに本文が混ざる経路を作らないためと、
// 受信箱でのなりすまし（件名だけ見て別サービスの通知に見える）を防ぐため。
function mailSubject(category) {
  return `[WordBank] 新しいフィードバック（${CATEGORY_LABELS[category] || category}）`;
}

function mailBody({ category, message, contact, appVersion, createdAt }) {
  return [
    "WordBank にフィードバックが届きました。",
    "",
    `種別: ${CATEGORY_LABELS[category] || category}（${category}）`,
    `受信: ${new Date(createdAt).toISOString()}`,
    `アプリ版: ${appVersion || "(未記入)"}`,
    `連絡先: ${contact || "(未記入)"}`,
    "",
    "--- 本文 ---",
    message,
    "",
    "--- ",
    "連絡先はユーザーの自己申告であり検証していない。返信する前に内容を確認すること。",
    "全文は D1 の feedback テーブルにも保存されている。",
  ].join("\n");
}

// IPをそのままキーにすると「IPアドレスは保存しない」という本ファイルの契約を破る。
// 上限判定に必要なのは「同じ相手か」だけなので、不可逆なハッシュに落として保存する。
// 素のSHA-256はIPv4なら総当たりで逆引きできる。FEEDBACK_RATE_LIMIT_SECRET があれば
// HMACにして総当たりを封じる。必須にはしない — 未設定で通知が黙って止まるほうが、
// 「rate_limits を読める者（＝アカウント所有者）だけが逆引きできる」より害が大きい。
async function ipBucket(env, ip) {
  const encoder = new TextEncoder();
  const pepper = String(env?.FEEDBACK_RATE_LIMIT_SECRET || "");
  let digest;
  if (pepper) {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(pepper),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    digest = await crypto.subtle.sign("HMAC", key, encoder.encode(ip));
  } else {
    digest = await crypto.subtle.digest("SHA-256", encoder.encode(`wordbank-fb-mail ${ip}`));
  }
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// wordsnap-state.js の同名処理と同じ rate_limits テーブルを使うが、feedback.js は
// 同期APIから独立させる方針なので意図的に別実装として持つ。
//
// 保存（feedback テーブル）と違い、ここは fail-CLOSED にする。上限を確かめられない
// まま送ると、公開・無認証の投稿口が無制限のメール送信路になるため。通知を見送っても
// 投稿本体は D1 に残っているので要望は失われない。
async function mailRateLimited(env, request) {
  const db = env.DB;
  const now = Date.now();
  let keys;
  try {
    const bucket = await ipBucket(env, request.headers.get("CF-Connecting-IP") || "unknown");
    keys = MAIL_RATE_LIMITS.map((rule) => ({
      rule,
      key: rule.scope === "ip" ? `fb-mail:${bucket}` : "fb-mail:all",
    }));
  } catch {
    return true;
  }

  try {
    // まず両方を読んで判定する。片方だけ消費して他方で止まると、送っていないのに
    // 枠が減る（カウンタ同士が食い違う）ため、消費は判定が全部通ってから行う。
    for (const { rule, key } of keys) {
      const current = await db
        .prepare("SELECT window_start, count FROM rate_limits WHERE rl_key = ?")
        .bind(key)
        .first();
      const expired = !current || now >= Number(current.window_start) + rule.windowMs;
      if (!expired && Number(current.count) >= rule.limit) return true;
    }

    for (const { rule, key } of keys) {
      const expiryCutoff = now - rule.windowMs;
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
        .bind(key, now, expiryCutoff, expiryCutoff, expiryCutoff, rule.limit)
        .run();
      // 同時実行で埋まった場合。読み取り判定を通っていても、ここで負けたら送らない。
      if (Number(result?.meta?.changes) === 0) return true;
    }
  } catch {
    return true;
  }

  // 窓が明けた行は上限判定にもう使われない。IPごとに1行増えるので、送信のたびに
  // 期限切れを掃除して滞留させない（送信自体が上限付きなので回数は高々60回/時）。
  try {
    await db
      .prepare("DELETE FROM rate_limits WHERE rl_key LIKE 'fb-mail:%' AND window_start <= ?")
      .bind(now - MAIL_RATE_LIMITS[0].windowMs)
      .run();
  } catch {
    // 掃除に失敗しても上限判定の結果は変わらない。
  }
  return false;
}

async function sendFeedbackMail(env, request, record) {
  const config = mailConfig(env);
  if (!config) return false;
  const to = parseMailbox(config.to);
  const from = parseMailbox(config.from);
  if (!to || !from) return false;
  if (await mailRateLimited(env, request)) return false;

  const subject = mailSubject(record.category);
  const text = mailBody(record);
  // 返信先にユーザー申告の連絡先を入れない（未検証のアドレスを差出人相当に置くと
  // 第三者を騙る踏み台になる）。連絡先は本文にだけ載せる。
  const init = {
    method: "POST",
    signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
  };
  let url;
  if (config.provider === "resend") {
    url = "https://api.resend.com/emails";
    init.headers = {
      authorization: `Bearer ${config.key}`,
      "content-type": "application/json",
      // Resend は直接のHTTP呼び出しに User-Agent を要求し、無いと403を返す。
      // Workers の fetch は自動では付けないので明示する（秘密情報は載せない）。
      "user-agent": MAIL_USER_AGENT,
    };
    init.body = JSON.stringify({ from: from.raw, to: [to.address], subject, text });
  } else {
    url = "https://api.brevo.com/v3/smtp/email";
    init.headers = {
      "api-key": config.key,
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": MAIL_USER_AGENT,
    };
    init.body = JSON.stringify({
      sender: { email: from.address, name: from.name },
      to: [{ email: to.address }],
      subject,
      textContent: text,
    });
  }

  const response = await fetch(url, init);
  if (!response.ok) {
    // 本文にはAPIキーも宛先も含めない。原因追跡はステータスだけで足りる。
    throw new Error(`mail provider responded ${response.status}`);
  }
  return true;
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

  // 時刻は prepare() の後に取る（メール通知の追加前と同じ評価順を保つ）。
  let createdAt;
  try {
    const statement = env.DB.prepare(
      "INSERT INTO feedback (created_at, category, message, contact, app_version, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
    );
    createdAt = Date.now();
    await statement.bind(createdAt, category, message, contact, appVersion, userAgent).run();
  } catch (error) {
    // feedback テーブル未適用や一時障害。内部詳細は返さない。
    const missingTable = /no such table/i.test(String(error && error.message));
    return json(
      { error: missingTable ? "storage unavailable" : "could not save" },
      missingTable ? 503 : 500,
    );
  }

  // 保存が確定してから通知する。送信の成否は応答に影響させない（fail-open）。
  // waitUntil があれば応答を待たせずに裏で送る。無い環境（テスト等）では
  // 応答前に送りきる — どちらの経路でも例外はここで飲み込む。
  try {
    const notify = sendFeedbackMail(env, request, {
      category,
      message,
      contact,
      appVersion,
      createdAt,
    }).catch(() => false);
    if (typeof context.waitUntil === "function") {
      // waitUntil の登録自体が投げる可能性も潰す（保存済みなのに500にしない）。
      context.waitUntil(notify);
    } else {
      await notify;
    }
  } catch {
    // 通知の都合で保存済みの投稿を失敗扱いにはしない。
  }

  return json({ ok: true });
}
