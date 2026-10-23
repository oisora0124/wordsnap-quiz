// パスキーによる復旧（「パスキーで控える」）のアカウント API。
// 設計: docs/DESIGN-2026-10-21-account-recovery.md（§4・§5・§6.1）。
//
//   POST /api/account  body: { op, ... }   認証が要る op は `authorization: Bearer <token>`
//
// 守ること（§6.1 の不変条件）:
//   - states / state_revisions / rooms には一切書かない。読むのは rooms（照合）と states（語数）だけ。
//   - rooms.auth_hash を変えない（rekey しない）。照合は副作用の無い matchRoomSecret だけで行う。
//   - ACCOUNTS_ENABLED !== "1"、または ACCOUNT_KEK が未設定・解析不能なら、全 op が 503。
//   - 認証・照合の失敗はすべて同じ 403（列挙対策）。
//
// wordsnap-state.js の verifyRoomSecret / consumeV2RateLimit は流用しない
// （前者は旧鍵一致で rooms を書き換え、後者は規則表に無い op を無制限にし、失敗時は常に fail-open）。
import { rateLimitClientKey } from "./wordsnap-state.js";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const MAX_RAW_BODY = 64_000;
const CHALLENGE_TTL_MS = 10 * MINUTE;
const TOKEN_TTL_MS = 10 * MINUTE;
const FRESH_TOKEN_MS = 2 * MINUTE;
const CLOCK_SKEW_MS = MINUTE;
const MAX_PASSKEYS = 10;
const MAX_ROOMS = 10;
const CHALLENGE_SWEEP_LIMIT = 100;
// states の解凍上限は wordsnap-state.js と同じ（語数を数えるだけでも解凍爆弾は防ぐ）。
const MAX_INFLATED_JSON = 24_000_000;

const DEFAULT_ORIGINS = "https://wordbank.pages.dev";
const DEFAULT_RP_ID = "wordbank.pages.dev";
const RP_NAME = "WordBank";

const ACCOUNT_ID_PATTERN = /^wa_[0-9a-f]{32}$/;
const ROOM_ID_PATTERN = /^wr_[0-9a-f]{32}$/;
const ROOM_SECRET_PATTERN = /^wk_[0-9a-f]{60}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// WebAuthn の credential id は最大 1023 byte（base64url で 1364 文字）。
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{16,1364}$/;
const B64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

// 同期 V2 の auth_hash と同じ入力形式（wordsnap-state.js の authHmacHex）。ずれると結びつけが全件 403 になる。
const SYNC_AUTH_DOMAIN = "wordsnap-sync-auth-v2\0";
const DUMMY_ROOM_ID = `wr_${"0".repeat(32)}`;
const DUMMY_AUTH_HASH = "0".repeat(64);

const ENVELOPE_INFO = "wordbank-account-envelope-v1";
const TOKEN_INFO = "wordbank-account-token-v1";

const ALG_ES256 = -7;
const ALG_RS256 = -257;

// 接頭辞ごとに窓を固定する。窓明けの掃除が接頭辞単位なので、同じ接頭辞に別の窓を混ぜない。
const RATE_RULES = {
  "acct-options": { limit: 20, windowMs: 10 * MINUTE },
  "acct-register": { limit: 5, windowMs: HOUR },
  "acct-login-fail": { limit: 10, windowMs: 10 * MINUTE },
  "acct-link-fail": { limit: 10, windowMs: 10 * MINUTE },
  "acct-recover-ip": { limit: 20, windowMs: HOUR, failClosed: true },
  "acct-recover-acct": { limit: 20, windowMs: 24 * HOUR, failClosed: true },
  "acct-read": { limit: 60, windowMs: 10 * MINUTE },
  "acct-write": { limit: 30, windowMs: HOUR },
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extraHeaders } });
}
const unavailable = () => json({ error: "accounts unavailable" }, 503);
const forbidden = () => json({ error: "forbidden" }, 403);
const rateLimited = () => json({ error: "rate limited", code: "rate-limited" }, 429);

// 認証・照合の失敗。どこで投げても応答は同じ 403。
class Deny extends Error {}
// 運用側の不備（鍵が無い・ストレージ障害）。データを守るため 503 に倒す。
class Unavailable extends Error {}
class Limited extends Error {}

// ---- バイト列 ----

const encoder = new TextEncoder();

function bytesToHex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex) {
  if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function b64urlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text) {
  if (typeof text !== "string" || !B64URL_PATTERN.test(text) || text.length % 4 === 1) throw new Deny();
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

// 長さが同じなら内容に依らず同じ手数で比べる（Workers 専用の timingSafeEqual に頼らない）。
function constantTimeEqual(a, b) {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

// ---- CBOR（WebAuthn が使う範囲だけ。浮動小数・タグ・不定長は受け付けない） ----

function decodeCbor(bytes, start = 0, depth = 0) {
  if (depth > 16) throw new Deny();
  let offset = start;
  const need = (n) => {
    if (offset + n > bytes.byteLength) throw new Deny();
  };
  need(1);
  const initial = bytes[offset];
  offset += 1;
  const major = initial >> 5;
  const info = initial & 0x1f;
  let length;
  if (info < 24) length = info;
  else if (info === 24) { need(1); length = bytes[offset]; offset += 1; }
  else if (info === 25) { need(2); length = (bytes[offset] << 8) | bytes[offset + 1]; offset += 2; }
  else if (info === 26) {
    need(4);
    length = ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
    offset += 4;
  } else throw new Deny();

  switch (major) {
    case 0: return { value: length, offset };
    case 1: return { value: -1 - length, offset };
    case 2: need(length); return { value: bytes.slice(offset, offset + length), offset: offset + length };
    case 3: {
      need(length);
      const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, offset + length));
      return { value, offset: offset + length };
    }
    case 4: {
      const value = [];
      for (let i = 0; i < length; i += 1) {
        const item = decodeCbor(bytes, offset, depth + 1);
        value.push(item.value);
        offset = item.offset;
      }
      return { value, offset };
    }
    case 5: {
      const value = new Map();
      for (let i = 0; i < length; i += 1) {
        const key = decodeCbor(bytes, offset, depth + 1);
        if (typeof key.value !== "number" && typeof key.value !== "string") throw new Deny();
        if (value.has(key.value)) throw new Deny();
        const item = decodeCbor(bytes, key.offset, depth + 1);
        value.set(key.value, item.value);
        offset = item.offset;
      }
      return { value, offset };
    }
    case 7:
      if (info === 20) return { value: false, offset };
      if (info === 21) return { value: true, offset };
      if (info === 22) return { value: null, offset };
      throw new Deny();
    default:
      throw new Deny();
  }
}

// ---- WebAuthn 検証（§5.2） ----

function parseClientData(clientDataBytes, expectedType, origins) {
  const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clientDataBytes));
  if (!data || typeof data !== "object") throw new Deny();
  if (data.type !== expectedType) throw new Deny();
  if (typeof data.challenge !== "string" || !CHALLENGE_PATTERN.test(data.challenge)) throw new Deny();
  if (typeof data.origin !== "string" || !origins.includes(data.origin)) throw new Deny();
  if (data.crossOrigin === true) throw new Deny();
  return data;
}

async function parseAuthenticatorData(authData, rpId, { expectCredential }) {
  if (authData.byteLength < 37) throw new Deny();
  if (!constantTimeEqual(authData.subarray(0, 32), await sha256(encoder.encode(rpId)))) throw new Deny();
  const flags = authData[32];
  const up = Boolean(flags & 0x01);
  const uv = Boolean(flags & 0x04);
  const be = Boolean(flags & 0x08);
  const bs = Boolean(flags & 0x10);
  const at = Boolean(flags & 0x40);
  const ed = Boolean(flags & 0x80);
  if (!up || !uv) throw new Deny();
  // 仕様上あり得ない組（同期済みなのに同期不可）。
  if (bs && !be) throw new Deny();
  if (at !== expectCredential) throw new Deny();
  const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
  let offset = 37;
  let credentialId = null;
  let coseKey = null;
  if (at) {
    if (authData.byteLength < offset + 18) throw new Deny();
    offset += 16; // aaguid（attestation none なので使わない）
    const idLength = (authData[offset] << 8) | authData[offset + 1];
    offset += 2;
    if (idLength < 1 || idLength > 1023 || authData.byteLength < offset + idLength) throw new Deny();
    credentialId = authData.slice(offset, offset + idLength);
    offset += idLength;
    const key = decodeCbor(authData, offset);
    coseKey = { map: key.value, bytes: authData.slice(offset, key.offset) };
    offset = key.offset;
  }
  if (ed) offset = decodeCbor(authData, offset).offset;
  if (offset !== authData.byteLength) throw new Deny();
  return { be, bs, signCount, credentialId, coseKey };
}

// COSE 公開鍵 → WebCrypto。許すのは EC2 P-256 ＋ ES256、RSA ＋ RS256 だけ。
async function importCoseKey(map) {
  if (!(map instanceof Map)) throw new Deny();
  const kty = map.get(1);
  const alg = map.get(3);
  const isBytes = (v, n) => v instanceof Uint8Array && (n === undefined || v.byteLength === n);
  try {
    if (kty === 2 && alg === ALG_ES256) {
      if (map.get(-1) !== 1 || !isBytes(map.get(-2), 32) || !isBytes(map.get(-3), 32)) throw new Deny();
      const jwk = { kty: "EC", crv: "P-256", x: b64urlEncode(map.get(-2)), y: b64urlEncode(map.get(-3)), ext: true };
      return { alg, key: await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]) };
    }
    if (kty === 3 && alg === ALG_RS256) {
      const n = map.get(-1);
      const e = map.get(-2);
      if (!isBytes(n) || n.byteLength < 256 || !isBytes(e) || e.byteLength === 0) throw new Deny();
      const jwk = { kty: "RSA", n: b64urlEncode(n), e: b64urlEncode(e), alg: "RS256", ext: true };
      return {
        alg,
        key: await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
      };
    }
  } catch {
    throw new Deny(); // 曲線外の点など、取り込めない鍵
  }
  throw new Deny();
}

// ES256 の署名は ASN.1 DER。WebCrypto は r||s（各 32 byte）を要求する。
function derToRawSignature(der) {
  if (der.byteLength < 8 || der[0] !== 0x30 || der[1] !== der.byteLength - 2) throw new Deny();
  let offset = 2;
  const readInt = () => {
    if (der[offset] !== 0x02) throw new Deny();
    const length = der[offset + 1];
    if (length < 1 || length > 33 || offset + 2 + length > der.byteLength) throw new Deny();
    let value = der.subarray(offset + 2, offset + 2 + length);
    offset += 2 + length;
    while (value.byteLength > 1 && value[0] === 0) value = value.subarray(1);
    if (value.byteLength > 32) throw new Deny();
    const out = new Uint8Array(32);
    out.set(value, 32 - value.byteLength);
    return out;
  };
  const r = readInt();
  const s = readInt();
  if (offset !== der.byteLength) throw new Deny();
  return concatBytes(r, s);
}

async function verifyRegistration(credential, rpId, origins) {
  const response = credential && credential.response;
  if (!response || typeof response !== "object") throw new Deny();
  const clientDataBytes = b64urlDecode(response.clientDataJSON);
  const clientData = parseClientData(clientDataBytes, "webauthn.create", origins);
  const attestation = decodeCbor(b64urlDecode(response.attestationObject));
  const att = attestation.value;
  if (!(att instanceof Map)) throw new Deny();
  if (att.get("fmt") !== "none") throw new Deny();
  const attStmt = att.get("attStmt");
  if (!(attStmt instanceof Map) || attStmt.size !== 0) throw new Deny();
  const authData = att.get("authData");
  if (!(authData instanceof Uint8Array)) throw new Deny();
  const parsed = await parseAuthenticatorData(authData, rpId, { expectCredential: true });
  const { alg } = await importCoseKey(parsed.coseKey.map);
  const credentialId = b64urlEncode(parsed.credentialId);
  if (credential.id !== undefined && credential.id !== credentialId) throw new Deny();
  return {
    challenge: clientData.challenge,
    credentialId,
    publicKey: b64urlEncode(parsed.coseKey.bytes),
    alg,
    be: parsed.be,
    bs: parsed.bs,
    signCount: parsed.signCount,
  };
}

function parseAssertion(credential, origins) {
  const response = credential && credential.response;
  if (!response || typeof response !== "object") throw new Deny();
  if (typeof credential.id !== "string" || !CREDENTIAL_ID_PATTERN.test(credential.id)) throw new Deny();
  const clientDataBytes = b64urlDecode(response.clientDataJSON);
  const clientData = parseClientData(clientDataBytes, "webauthn.get", origins);
  return {
    credentialId: credential.id,
    challenge: clientData.challenge,
    clientDataBytes,
    authData: b64urlDecode(response.authenticatorData),
    signature: b64urlDecode(response.signature),
    userHandle: response.userHandle,
  };
}

async function verifyAssertion(assertion, passkey, rpId) {
  const parsed = await parseAuthenticatorData(assertion.authData, rpId, { expectCredential: false });
  if (parsed.be !== Boolean(passkey.backup_eligible)) throw new Deny();
  if (typeof assertion.userHandle !== "string" || assertion.userHandle !== passkey.user_handle) throw new Deny();
  const cose = decodeCbor(b64urlDecode(passkey.public_key));
  const { alg, key } = await importCoseKey(cose.value);
  if (alg !== Number(passkey.alg)) throw new Deny();
  const signed = concatBytes(assertion.authData, await sha256(assertion.clientDataBytes));
  const ok = alg === ALG_ES256
    ? await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRawSignature(assertion.signature), signed)
    : await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, assertion.signature, signed);
  if (!ok) throw new Deny();
  // sign_count は減っても拒否しない（Apple のパスキーは常に 0）。記録だけする。
  return parsed;
}

// 解析・検証の途中で出た例外（壊れた base64・JSON・CBOR）はすべて同じ 403 にする。
async function denyOnError(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Unavailable || error instanceof Limited) throw error;
    throw new Deny();
  }
}

// ---- 鍵リング（ACCOUNT_KEK・SYNC_AUTH_SECRETS。形式は [{kid, secret}]） ----

function parseKeyRing(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const seen = new Set();
    const ring = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      if (typeof entry.kid !== "string" || entry.kid === "" || seen.has(entry.kid)) return null;
      if (typeof entry.secret !== "string" || encoder.encode(entry.secret).byteLength < 32) return null;
      seen.add(entry.kid);
      ring.push({ kid: entry.kid, secret: entry.secret });
    }
    return ring;
  } catch {
    return null;
  }
}

// 封筒の鍵とトークンの鍵を同じ秘密から用途別に導く（同じ鍵を AES と HMAC に兼用しない）。
async function deriveKey(secret, info, algorithm, usages) {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: encoder.encode(info) },
    base,
    algorithm,
    false,
    usages,
  );
}

const envelopeKey = (entry) => deriveKey(entry.secret, ENVELOPE_INFO, { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]);
const tokenKey = (entry) => deriveKey(entry.secret, TOKEN_INFO, { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign", "verify"]);

// AAD に結びつけ先を入れ、封筒を別アカウント・別部屋の行へ写しても開けないようにする。
async function sealSecret(kek, accountId, roomId, secret) {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(accountId + roomId) },
    await envelopeKey(kek[0]),
    encoder.encode(secret),
  );
  return { secretEnv: b64urlEncode(concatBytes(iv, new Uint8Array(ciphertext))), envKid: kek[0].kid };
}

async function openSecret(kek, accountId, roomId, secretEnv, envKid) {
  const entry = kek.find((k) => k.kid === envKid);
  // 鍵を外したあとに残った封筒。消さずに 503 で止める（KEK を戻せば開ける）。
  if (!entry) throw new Unavailable();
  let bytes;
  try {
    bytes = b64urlDecode(secretEnv);
  } catch {
    return null;
  }
  if (bytes.byteLength < 13) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: encoder.encode(accountId + roomId) },
      await envelopeKey(entry),
      bytes.subarray(12),
    );
    const secret = new TextDecoder().decode(plain);
    return ROOM_SECRET_PATTERN.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

async function openWithRewrap(db, kek, accountId, row) {
  const secret = await openSecret(kek, accountId, row.room_id, row.secret_env, row.env_kid);
  if (secret && row.env_kid !== kek[0].kid) {
    try {
      const sealed = await sealSecret(kek, accountId, row.room_id, secret);
      await db
        .prepare(
          "UPDATE account_rooms SET secret_env = ?, env_kid = ? WHERE account_id = ? AND room_id = ? AND env_kid = ?",
        )
        .bind(sealed.secretEnv, sealed.envKid, accountId, row.room_id, row.env_kid)
        .run();
    } catch {
      // 包み直しの失敗では復旧を止めない。次に開いたときに再試行する。
    }
  }
  return secret;
}

// ---- 部屋の照合（副作用なし。§4.4） ----

async function syncAuthHash(keySecret, roomId, roomSecret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(keySecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${SYNC_AUTH_DOMAIN}${roomId}\0${roomSecret}`)));
}

// 鍵リングの全鍵を常に試し、部屋の有無でも手数を変えない。旧鍵で一致しても rooms は書き換えない
// （再ハッシュは次に同期本体が通ったときに従来どおり行われる）。
async function matchRoomSecret(room, roomId, roomSecret, syncKeyRing) {
  const stored = hexToBytes(room ? room.auth_hash : DUMMY_AUTH_HASH);
  const id = room ? roomId : DUMMY_ROOM_ID;
  let matched = false;
  for (const entry of syncKeyRing) {
    const candidate = await syncAuthHash(entry.secret, id, roomSecret);
    if (stored && stored.byteLength === 32 && constantTimeEqual(stored, candidate)) matched = true;
  }
  return Boolean(room) && matched;
}

// ---- レート制限（§4.6） ----

// "ok" | "limited" | "error"
async function consumeRate(db, prefix, subject, now) {
  const rule = RATE_RULES[prefix];
  const key = `${prefix}:${subject}`;
  const cutoff = now - rule.windowMs;
  try {
    const current = await db.prepare("SELECT window_start, count FROM rate_limits WHERE rl_key = ?").bind(key).first();
    const expired = !current || Number(current.window_start) <= cutoff;
    if (!expired && Number(current.count) >= rule.limit) return "limited";
    const result = await db
      .prepare(
        `INSERT INTO rate_limits (rl_key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(rl_key) DO UPDATE SET
           window_start = CASE WHEN rate_limits.window_start <= ? THEN excluded.window_start ELSE rate_limits.window_start END,
           count = CASE WHEN rate_limits.window_start <= ? THEN 1 ELSE rate_limits.count + 1 END
         WHERE rate_limits.window_start <= ? OR rate_limits.count < ?`,
      )
      .bind(key, now, cutoff, cutoff, cutoff, rule.limit)
      .run();
    if (expired) {
      try {
        await db
          .prepare("DELETE FROM rate_limits WHERE rl_key LIKE ? AND window_start <= ?")
          .bind(`${prefix}:%`, cutoff)
          .run();
      } catch {
        // 掃除の失敗は上限判定に影響させない。
      }
    }
    return Number(result?.meta?.changes) === 0 ? "limited" : "ok";
  } catch {
    return "error";
  }
}

async function peekRate(db, prefix, subject, now) {
  const rule = RATE_RULES[prefix];
  try {
    const current = await db.prepare("SELECT window_start, count FROM rate_limits WHERE rl_key = ?").bind(`${prefix}:${subject}`).first();
    if (!current || Number(current.window_start) <= now - rule.windowMs) return "ok";
    return Number(current.count) >= rule.limit ? "limited" : "ok";
  } catch {
    return "error";
  }
}

function enforce(prefix, outcome) {
  if (outcome === "limited") throw new Limited();
  if (outcome === "error" && RATE_RULES[prefix].failClosed) throw new Unavailable();
}

async function limit(ctx, prefix, subject) {
  enforce(prefix, await consumeRate(ctx.db, prefix, subject, ctx.now));
}

async function checkFailLimit(ctx, prefix, subject) {
  enforce(prefix, await peekRate(ctx.db, prefix, subject, ctx.now));
}

// ---- challenge（§4.3） ----

async function sweepChallenges(db, now) {
  try {
    await db
      .prepare(
        "DELETE FROM auth_challenges WHERE challenge IN (SELECT challenge FROM auth_challenges WHERE created_at <= ? ORDER BY created_at LIMIT ?)",
      )
      .bind(now - CHALLENGE_TTL_MS, CHALLENGE_SWEEP_LIMIT)
      .run();
  } catch {
    // 期限は消費時に必ず判定するので、掃除の失敗は安全側。
  }
}

async function issueChallenge(db, now, purpose, accountId = null, userHandle = null) {
  const challenge = b64urlEncode(randomBytes(32));
  await db
    .prepare("INSERT INTO auth_challenges (challenge, purpose, account_id, user_handle, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(challenge, purpose, accountId, userHandle, now)
    .run();
  return challenge;
}

// 消費と取得を 1 文で行う。SELECT→DELETE に分けると並行 2 リクエストで二重に使える。
async function consumeChallenge(db, now, challenge, purpose, accountId = null) {
  const row = accountId === null
    ? await db
      .prepare(
        "DELETE FROM auth_challenges WHERE challenge = ? AND purpose = ? AND created_at > ? RETURNING account_id, user_handle",
      )
      .bind(challenge, purpose, now - CHALLENGE_TTL_MS)
      .first()
    : await db
      .prepare(
        "DELETE FROM auth_challenges WHERE challenge = ? AND purpose = ? AND created_at > ? AND account_id = ? RETURNING account_id, user_handle",
      )
      .bind(challenge, purpose, now - CHALLENGE_TTL_MS, accountId)
      .first();
  if (!row) throw new Deny();
  return row;
}

// ---- トークン（§4.5） ----

async function issueToken(kek, accountId, credentialId, now) {
  const payload = b64urlEncode(encoder.encode(JSON.stringify({ accountId, cid: credentialId, iat: now, exp: now + TOKEN_TTL_MS })));
  const mac = await crypto.subtle.sign("HMAC", await tokenKey(kek[0]), encoder.encode(payload));
  return `${payload}.${b64urlEncode(new Uint8Array(mac))}`;
}

async function authenticate(ctx, { fresh }) {
  const header = ctx.request.headers.get("authorization") || "";
  const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header);
  if (!match) throw new Deny();
  const payload = await denyOnError(async () => {
    const ok = await crypto.subtle.verify("HMAC", await tokenKey(ctx.kek[0]), b64urlDecode(match[2]), encoder.encode(match[1]));
    if (!ok) throw new Deny();
    return JSON.parse(new TextDecoder().decode(b64urlDecode(match[1])));
  });
  const { accountId, cid, iat, exp } = payload || {};
  if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) throw new Deny();
  if (typeof cid !== "string" || !CREDENTIAL_ID_PATTERN.test(cid)) throw new Deny();
  if (!Number.isFinite(iat) || !Number.isFinite(exp) || exp <= ctx.now || iat > ctx.now + CLOCK_SKEW_MS) throw new Deny();
  if (fresh && ctx.now - iat > FRESH_TOKEN_MS) throw new Deny();
  // 消したパスキーのトークン・消したアカウントのトークンはここで無効になる。
  const row = await ctx.db
    .prepare(
      `SELECT a.user_handle AS user_handle FROM passkeys AS p
       INNER JOIN accounts AS a ON a.account_id = p.account_id
       WHERE p.credential_id = ? AND p.account_id = ?`,
    )
    .bind(cid, accountId)
    .first();
  if (!row) throw new Deny();
  return { accountId, cid, userHandle: row.user_handle };
}

async function accountBackedUp(db, accountId) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM passkeys WHERE account_id = ? AND backed_up = 1")
    .bind(accountId)
    .first();
  return Number(row?.n) > 0;
}

// ---- states の語数（state 本体は返さない） ----

async function gunzipBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_INFLATED_JSON) {
      await reader.cancel().catch(() => {});
      throw new Error("too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concatBytes(...chunks));
}

async function countState(stored) {
  try {
    let state = JSON.parse(stored);
    if (state && typeof state.__gz === "string") state = JSON.parse(await gunzipBase64(state.__gz));
    if (!state || !Array.isArray(state.words) || !Array.isArray(state.decks)) return { wordCount: null, deckCount: null };
    return { wordCount: state.words.length, deckCount: state.decks.length };
  } catch {
    // 破損行は 0 語と区別する（0 と見せると「空の部屋」と誤認させる）。
    return { wordCount: null, deckCount: null };
  }
}

// ---- op ----

function creationOptions(ctx, challenge, userHandle, exclude) {
  return {
    rp: { id: ctx.rpId, name: RP_NAME },
    user: { id: userHandle, name: RP_NAME, displayName: RP_NAME },
    challenge,
    pubKeyCredParams: [
      { type: "public-key", alg: ALG_ES256 },
      { type: "public-key", alg: ALG_RS256 },
    ],
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    attestation: "none",
    excludeCredentials: exclude.map((id) => ({ type: "public-key", id })),
  };
}

const OPS = {
  async "register-options"(ctx) {
    await limit(ctx, "acct-options", ctx.ip);
    await sweepChallenges(ctx.db, ctx.now);
    const accountId = `wa_${bytesToHex(randomBytes(16))}`;
    const userHandle = b64urlEncode(randomBytes(32));
    const challenge = await issueChallenge(ctx.db, ctx.now, "register", accountId, userHandle);
    return json(creationOptions(ctx, challenge, userHandle, []));
  },

  async register(ctx, body) {
    await limit(ctx, "acct-register", ctx.ip);
    const reg = await denyOnError(() => verifyRegistration(body.credential, ctx.rpId, ctx.origins));
    // account_id・user_handle はクライアントの申告ではなく、消費した行から取る。
    const row = await consumeChallenge(ctx.db, ctx.now, reg.challenge, "register");
    if (!ACCOUNT_ID_PATTERN.test(row.account_id || "") || !row.user_handle) throw new Deny();
    try {
      await ctx.db.batch([
        ctx.db
          .prepare("INSERT INTO accounts (account_id, user_handle, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
          .bind(row.account_id, row.user_handle, ctx.now, ctx.now),
        ctx.db
          .prepare(
            `INSERT INTO passkeys (credential_id, account_id, public_key, alg, sign_count, backup_eligible, backed_up, created_at, last_used_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(reg.credentialId, row.account_id, reg.publicKey, reg.alg, reg.signCount, reg.be ? 1 : 0, reg.bs ? 1 : 0, ctx.now, ctx.now),
      ]);
    } catch {
      throw new Deny(); // credential_id の重複など
    }
    return json({ accountId: row.account_id, token: await issueToken(ctx.kek, row.account_id, reg.credentialId, ctx.now) });
  },

  async "add-passkey-options"(ctx) {
    const auth = await authenticate(ctx, { fresh: true });
    await limit(ctx, "acct-options", ctx.ip);
    await sweepChallenges(ctx.db, ctx.now);
    const existing = await ctx.db
      .prepare("SELECT credential_id FROM passkeys WHERE account_id = ? LIMIT 20")
      .bind(auth.accountId)
      .all();
    const challenge = await issueChallenge(ctx.db, ctx.now, "add-passkey", auth.accountId, auth.userHandle);
    return json(creationOptions(ctx, challenge, auth.userHandle, (existing.results || []).map((r) => r.credential_id)));
  },

  async "add-passkey"(ctx, body) {
    const auth = await authenticate(ctx, { fresh: true });
    await limit(ctx, "acct-write", auth.accountId);
    const reg = await denyOnError(() => verifyRegistration(body.credential, ctx.rpId, ctx.origins));
    const row = await consumeChallenge(ctx.db, ctx.now, reg.challenge, "add-passkey", auth.accountId);
    if (row.user_handle !== auth.userHandle) throw new Deny();
    let result;
    try {
      result = await ctx.db
        .prepare(
          `INSERT OR IGNORE INTO passkeys (credential_id, account_id, public_key, alg, sign_count, backup_eligible, backed_up, created_at, last_used_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0
           WHERE EXISTS (SELECT 1 FROM accounts WHERE account_id = ?)
             AND (SELECT COUNT(*) FROM passkeys WHERE account_id = ?) < ?`,
        )
        .bind(reg.credentialId, auth.accountId, reg.publicKey, reg.alg, reg.signCount, reg.be ? 1 : 0, reg.bs ? 1 : 0, ctx.now,
          auth.accountId, auth.accountId, MAX_PASSKEYS)
        .run();
    } catch {
      throw new Deny();
    }
    if (Number(result?.meta?.changes) !== 1) throw new Deny();
    return json({ ok: true });
  },

  async "login-options"(ctx) {
    await limit(ctx, "acct-options", ctx.ip);
    await sweepChallenges(ctx.db, ctx.now);
    const challenge = await issueChallenge(ctx.db, ctx.now, "login");
    return json({ challenge, rpId: ctx.rpId, userVerification: "required" });
  },

  async login(ctx, body) {
    await checkFailLimit(ctx, "acct-login-fail", ctx.ip);
    try {
      const assertion = await denyOnError(() => parseAssertion(body.credential, ctx.origins));
      await consumeChallenge(ctx.db, ctx.now, assertion.challenge, "login");
      const passkey = await ctx.db
        .prepare(
          `SELECT p.account_id AS account_id, p.public_key AS public_key, p.alg AS alg, p.backup_eligible AS backup_eligible,
                  a.user_handle AS user_handle
           FROM passkeys AS p INNER JOIN accounts AS a ON a.account_id = p.account_id
           WHERE p.credential_id = ?`,
        )
        .bind(assertion.credentialId)
        .first();
      if (!passkey) throw new Deny();
      const parsed = await denyOnError(() => verifyAssertion(assertion, passkey, ctx.rpId));
      await ctx.db.batch([
        ctx.db
          .prepare("UPDATE passkeys SET sign_count = ?, backed_up = ?, last_used_at = ? WHERE credential_id = ?")
          .bind(parsed.signCount, parsed.bs ? 1 : 0, ctx.now, assertion.credentialId),
        ctx.db.prepare("UPDATE accounts SET last_seen_at = ? WHERE account_id = ?").bind(ctx.now, passkey.account_id),
      ]);
      return json({
        accountId: passkey.account_id,
        token: await issueToken(ctx.kek, passkey.account_id, assertion.credentialId, ctx.now),
        backedUp: parsed.bs,
      });
    } catch (error) {
      if (error instanceof Deny) {
        if ((await consumeRate(ctx.db, "acct-login-fail", ctx.ip, ctx.now)) === "limited") throw new Limited();
      }
      throw error;
    }
  },

  async "link-room"(ctx, body) {
    const auth = await authenticate(ctx, { fresh: false });
    await limit(ctx, "acct-write", auth.accountId);
    await checkFailLimit(ctx, "acct-link-fail", ctx.ip);
    const syncRing = parseKeyRing(ctx.env.SYNC_AUTH_SECRETS);
    if (!syncRing) throw new Unavailable();
    try {
      const { roomId, secret } = body;
      if (!ROOM_ID_PATTERN.test(roomId || "") || !ROOM_SECRET_PATTERN.test(secret || "")) {
        await matchRoomSecret(null, DUMMY_ROOM_ID, "", syncRing);
        throw new Deny();
      }
      const room = await ctx.db.prepare("SELECT room_id, auth_hash FROM rooms WHERE room_id = ?").bind(roomId).first();
      if (!(await matchRoomSecret(room, roomId, secret, syncRing))) throw new Deny();
      const sealed = await sealSecret(ctx.kek, auth.accountId, roomId, secret);
      // アカウント存在・10 部屋まで・1 部屋 1 アカウント（room_id の UNIQUE）を同じ 1 文で守る。
      await ctx.db
        .prepare(
          `INSERT OR IGNORE INTO account_rooms (account_id, room_id, secret_env, env_kid, linked_at)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM accounts WHERE account_id = ?)
             AND (SELECT COUNT(*) FROM account_rooms WHERE account_id = ?) < ?`,
        )
        .bind(auth.accountId, roomId, sealed.secretEnv, sealed.envKid, ctx.now, auth.accountId, auth.accountId, MAX_ROOMS)
        .run();
      const row = await ctx.db
        .prepare("SELECT room_id, secret_env, env_kid FROM account_rooms WHERE account_id = ? AND room_id = ?")
        .bind(auth.accountId, roomId)
        .first();
      if (!row) throw new Deny();
      // 封筒が本当に開けて元の秘密に戻ることを確かめてから成功を返す。
      if ((await openWithRewrap(ctx.db, ctx.kek, auth.accountId, row)) !== secret) throw new Deny();
      return json({ ok: true, backedUp: await accountBackedUp(ctx.db, auth.accountId) });
    } catch (error) {
      if (error instanceof Deny) {
        if ((await consumeRate(ctx.db, "acct-link-fail", ctx.ip, ctx.now)) === "limited") throw new Limited();
      }
      throw error;
    }
  },

  async rooms(ctx) {
    const auth = await authenticate(ctx, { fresh: false });
    await limit(ctx, "acct-read", auth.accountId);
    const result = await ctx.db
      .prepare(
        `SELECT ar.room_id AS room_id, ar.linked_at AS linked_at, s.state AS state, s.rev AS rev, s.updatedAt AS updated_at
         FROM account_rooms AS ar
         LEFT JOIN rooms AS r ON r.room_id = ar.room_id
         LEFT JOIN states AS s ON s.key = r.state_key
         WHERE ar.account_id = ?
         ORDER BY ar.linked_at
         LIMIT ?`,
      )
      .bind(auth.accountId, MAX_ROOMS)
      .all();
    const rooms = [];
    for (const row of result.results || []) {
      const counts = row.state == null ? { wordCount: null, deckCount: null } : await countState(row.state);
      rooms.push({
        roomId: row.room_id,
        linkedAt: Number(row.linked_at),
        stateRev: Number(row.rev) || 0,
        updatedAt: Number(row.updated_at) || 0,
        ...counts,
      });
    }
    return json(rooms);
  },

  async "recover-room"(ctx, body) {
    const auth = await authenticate(ctx, { fresh: true });
    await limit(ctx, "acct-recover-ip", ctx.ip);
    await limit(ctx, "acct-recover-acct", auth.accountId);
    if (!ROOM_ID_PATTERN.test(body.roomId || "")) throw new Deny();
    const row = await ctx.db
      .prepare("SELECT room_id, secret_env, env_kid FROM account_rooms WHERE account_id = ? AND room_id = ?")
      .bind(auth.accountId, body.roomId)
      .first();
    if (!row) throw new Deny();
    const secret = await openWithRewrap(ctx.db, ctx.kek, auth.accountId, row);
    if (!secret) throw new Deny();
    return json({ roomId: row.room_id, secret });
  },

  async passkeys(ctx) {
    const auth = await authenticate(ctx, { fresh: false });
    await limit(ctx, "acct-read", auth.accountId);
    const result = await ctx.db
      .prepare("SELECT credential_id, created_at, last_used_at, backed_up FROM passkeys WHERE account_id = ? ORDER BY created_at LIMIT 20")
      .bind(auth.accountId)
      .all();
    return json((result.results || []).map((r) => ({
      credentialId: r.credential_id,
      createdAt: Number(r.created_at),
      lastUsedAt: Number(r.last_used_at),
      backedUp: Boolean(r.backed_up),
    })));
  },

  async "remove-passkey"(ctx, body) {
    const auth = await authenticate(ctx, { fresh: true });
    await limit(ctx, "acct-write", auth.accountId);
    if (typeof body.credentialId !== "string" || !CREDENTIAL_ID_PATTERN.test(body.credentialId)) throw new Deny();
    // 最後の 1 本は消さない（アカウントへ入れなくなる。消すなら delete-account）。
    const result = await ctx.db
      .prepare(
        "DELETE FROM passkeys WHERE credential_id = ? AND account_id = ? AND (SELECT COUNT(*) FROM passkeys WHERE account_id = ?) > 1",
      )
      .bind(body.credentialId, auth.accountId, auth.accountId)
      .run();
    if (Number(result?.meta?.changes) !== 1) throw new Deny();
    return json({ ok: true });
  },

  async "unlink-room"(ctx, body) {
    const auth = await authenticate(ctx, { fresh: true });
    await limit(ctx, "acct-write", auth.accountId);
    if (!ROOM_ID_PATTERN.test(body.roomId || "")) throw new Deny();
    const result = await ctx.db
      .prepare("DELETE FROM account_rooms WHERE account_id = ? AND room_id = ?")
      .bind(auth.accountId, body.roomId)
      .run();
    if (Number(result?.meta?.changes) !== 1) throw new Deny();
    return json({ ok: true });
  },

  async "delete-account"(ctx) {
    const auth = await authenticate(ctx, { fresh: true });
    // 消すのは自分の 4 テーブルの行だけ。rooms / states は触らない。
    await ctx.db.batch([
      ctx.db.prepare("DELETE FROM account_rooms WHERE account_id = ?").bind(auth.accountId),
      ctx.db.prepare("DELETE FROM auth_challenges WHERE account_id = ?").bind(auth.accountId),
      ctx.db.prepare("DELETE FROM passkeys WHERE account_id = ?").bind(auth.accountId),
      ctx.db.prepare("DELETE FROM accounts WHERE account_id = ?").bind(auth.accountId),
    ]);
    return json({ ok: true });
  },
};

// ---- 入口 ----

function isJsonContentType(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase() === "application/json";
}

// 許可リストに無い配信元（未登録のプレビューを含む）は弾く。Origin の無い要求も通さない
// （ブラウザの POST は必ず付ける。パスキー操作に非ブラウザの正当な呼び出し元は無い）。
function originAllowed(request, origins) {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin") return false;
  const origin = request.headers.get("Origin");
  return Boolean(origin) && origins.includes(origin);
}

async function readBody(request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RAW_BODY) return null;
  const reader = request.body ? request.body.getReader() : null;
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RAW_BODY) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concatBytes(...chunks));
}

export async function onRequest({ request, env }) {
  // フラグ OFF・KEK 不備では、何も読まず書かず 503 だけを返す（§6.1 の 7）。
  if (env.ACCOUNTS_ENABLED !== "1") return unavailable();
  const kek = parseKeyRing(env.ACCOUNT_KEK);
  if (!kek || !env.DB) return unavailable();
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { allow: "POST" });

  const origins = String(env.ACCOUNT_ORIGINS ?? DEFAULT_ORIGINS).split(",").map((o) => o.trim()).filter(Boolean);
  if (!originAllowed(request, origins)) return forbidden();
  if (!isJsonContentType(request.headers.get("content-type"))) return json({ error: "unsupported media type" }, 415);

  let body;
  try {
    const raw = await readBody(request);
    if (raw === null) return json({ error: "body too large" }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid body" }, 400);
  const handler = Object.prototype.hasOwnProperty.call(OPS, body.op) ? OPS[body.op] : null;
  if (!handler) return json({ error: "unknown op" }, 400);

  const ctx = {
    request,
    env,
    db: env.DB,
    kek,
    origins,
    rpId: String(env.ACCOUNT_RP_ID || DEFAULT_RP_ID),
    ip: rateLimitClientKey(request.headers.get("CF-Connecting-IP")),
    now: Date.now(),
  };
  try {
    return await handler(ctx, body);
  } catch (error) {
    if (error instanceof Deny) return forbidden();
    if (error instanceof Limited) return rateLimited();
    return unavailable();
  }
}
