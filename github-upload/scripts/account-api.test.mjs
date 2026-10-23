// パスキーによる復旧のアカウント API（functions/api/account.js）の契約テスト。
// 設計: docs/DESIGN-2026-10-21-account-recovery.md §6.2。
//
// 実 SQLite（migrations を全部適用）に onRequest を直接流す。FakeD1 は新しい SQL
// （DELETE … RETURNING・INSERT … SELECT … WHERE の件数上限）を解釈できないため。
//
// 守りたいもの:
//   - iPhone 実機の登録・認証データ（DER 署名のまま）が通る
//   - §5.2 の検証を 1 つでも外した応答は同じ 403
//   - 不変条件 1・2: states / rooms / state_revisions に一切書かない（鍵ローテーション後も）
//   - フラグ OFF・KEK 不備では 503 だけ
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createTestDatabase } from "./sqlite-d1.mjs";
import { onRequest as accountRequest } from "../functions/api/account.js";
import { onRequest as stateRequest } from "../functions/api/wordsnap-state.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures", "passkey-iphone-2026-10-23.json"), "utf8"));

const ORIGIN = "https://wordbank.pages.dev";
const RP_ID = "wordbank.pages.dev";
const MINUTE = 60 * 1000;
const enc = new TextEncoder();
const SYNC_KEY_OLD = { kid: "s1", secret: "s".repeat(48) };
const SYNC_KEY_NEW = { kid: "s2", secret: "t".repeat(48) };
const KEK1 = { kid: "k1", secret: "a".repeat(48) };
const KEK2 = { kid: "k2", secret: "b".repeat(48) };

// ---- バイト列・CBOR（テスト側の組み立て用） ----

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const fromB64url = (text) => new Uint8Array(Buffer.from(text, "base64url"));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

function cbor(value) {
  const head = (major, n) => Uint8Array.from(
    n < 24 ? [(major << 5) | n]
      : n < 256 ? [(major << 5) | 24, n]
        : [(major << 5) | 25, n >> 8, n & 255],
  );
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") { const b = enc.encode(value); return concat(head(3, b.length), b); }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return concat(...parts);
  }
  throw new Error(`cbor: 未対応の値 ${value}`);
}

// WebCrypto の ECDSA 署名は r||s。認証器は ASN.1 DER で返すので、それを再現する。
function rawToDer(raw) {
  const int = (bytes) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i += 1;
    let v = bytes.slice(i);
    if (v[0] & 0x80) v = concat(Uint8Array.of(0), v);
    return concat(Uint8Array.of(0x02, v.length), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 };

// Node の WebCrypto で P-256 鍵を持ち、attestationObject と assertion を組み立てる偽の認証器。
class FakeAuthenticator {
  static async create({ rpId = RP_ID, origin = ORIGIN, be = true, bs = true } = {}) {
    const self = new FakeAuthenticator();
    self.rpId = rpId;
    self.origin = origin;
    self.be = be;
    self.bs = bs;
    self.keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", self.keys.publicKey);
    self.x = fromB64url(jwk.x);
    self.y = fromB64url(jwk.y);
    self.credId = crypto.getRandomValues(new Uint8Array(20));
    self.id = b64url(self.credId);
    return self;
  }

  flags(o) {
    if (o.flags !== undefined) return o.flags;
    return FLAG.UP | FLAG.UV | (this.be ? FLAG.BE : 0) | (this.bs ? FLAG.BS : 0);
  }

  clientData(type, challenge, o) {
    return enc.encode(JSON.stringify({
      type: o.type ?? type,
      challenge: o.challenge ?? challenge,
      origin: o.origin ?? this.origin,
      crossOrigin: o.crossOrigin ?? false,
    }));
  }

  async makeCredential(options, o = {}) {
    this.userHandle = options.user.id;
    const cose = cbor(new Map([[1, 2], [3, o.alg ?? -7], [-1, 1], [-2, this.x], [-3, this.y]]));
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, o.signCount ?? 0);
    const authData = concat(
      await sha256(enc.encode(o.rpId ?? this.rpId)),
      Uint8Array.of(this.flags(o) | FLAG.AT),
      count,
      new Uint8Array(16),
      Uint8Array.of(this.credId.length >> 8, this.credId.length & 255),
      this.credId,
      cose,
    );
    const attestation = cbor(new Map([["fmt", o.fmt ?? "none"], ["attStmt", new Map()], ["authData", authData]]));
    return {
      id: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(this.clientData("webauthn.create", options.challenge, o)),
        attestationObject: b64url(attestation),
      },
    };
  }

  async getAssertion(challenge, o = {}) {
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, o.signCount ?? 0);
    const authData = concat(await sha256(enc.encode(o.rpId ?? this.rpId)), Uint8Array.of(this.flags(o)), count);
    const clientData = this.clientData("webauthn.get", challenge, o);
    const raw = new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      this.keys.privateKey,
      concat(authData, await sha256(clientData)),
    ));
    return {
      id: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(rawToDer(raw)),
        userHandle: o.userHandle ?? this.userHandle,
      },
    };
  }
}

// ---- 呼び出し ----

function makeEnv(db, overrides = {}) {
  return {
    DB: db,
    ACCOUNTS_ENABLED: "1",
    ACCOUNT_KEK: JSON.stringify([KEK1]),
    ACCOUNT_ORIGINS: ORIGIN,
    ACCOUNT_RP_ID: RP_ID,
    SYNC_AUTH_SECRETS: JSON.stringify([SYNC_KEY_OLD]),
    ...overrides,
  };
}

async function call(env, op, body = {}, { token, ip = "203.0.113.10", origin = ORIGIN, method = "POST" } = {}) {
  const headers = { "content-type": "application/json", "CF-Connecting-IP": ip };
  if (origin) headers.Origin = origin;
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await accountRequest({
    request: new Request(`${ORIGIN}/api/account`, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify({ op, ...body }) : undefined,
    }),
    env,
  });
  let data = null;
  try { data = await response.json(); } catch { /* 本文なし */ }
  return { status: response.status, data };
}

async function signUp(env, { ip, authenticator } = {}) {
  const auth = authenticator ?? await FakeAuthenticator.create();
  const options = await call(env, "register-options", {}, { ip });
  assert.equal(options.status, 200, JSON.stringify(options.data));
  const credential = await auth.makeCredential(options.data);
  const res = await call(env, "register", { credential }, { ip });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return { auth, accountId: res.data.accountId, token: res.data.token };
}

async function signIn(env, auth, o = {}, ip) {
  const options = await call(env, "login-options", {}, { ip });
  assert.equal(options.status, 200);
  return call(env, "login", { credential: await auth.getAssertion(options.data.challenge, o) }, { ip });
}

let roomCounter = 0;
async function createRoom(db, { words = 3, syncKeys = [SYNC_KEY_OLD] } = {}) {
  roomCounter += 1;
  const roomId = `wr_${roomCounter.toString(16).padStart(32, "0")}`;
  const secret = `wk_${roomCounter.toString(16).padStart(60, "f")}`;
  const res = await stateRequest({
    request: new Request(`${ORIGIN}/api/wordsnap-state?room=${roomId}&create=1`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": `198.51.100.${roomCounter % 250}`,
        "x-room-key": secret,
      },
      body: JSON.stringify({
        state: { words: Array.from({ length: words }, (_, i) => ({ id: `w${i}`, term: `t${i}` })), decks: [{ id: "d1" }] },
      }),
    }),
    env: { DB: db, SYNC_V2_ENABLED: "1", SYNC_AUTH_SECRETS: JSON.stringify(syncKeys) },
  });
  assert.equal(res.status, 200, await res.text());
  return { roomId, secret };
}

const snapshot = (db) => JSON.stringify([
  db.db.prepare("SELECT * FROM rooms ORDER BY room_id").all(),
  db.db.prepare("SELECT * FROM states ORDER BY key").all(),
  db.db.prepare("SELECT * FROM state_revisions ORDER BY key, rev").all(),
]);
const FORBIDDEN_WRITE = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(?:states|rooms|state_revisions)\b/i;

function withClock(offsetMs, fn) {
  const real = Date.now;
  const base = real();
  Date.now = () => base + offsetMs;
  return Promise.resolve(fn()).finally(() => { Date.now = real; });
}

const ALL_OPS = [
  "register-options", "register", "add-passkey-options", "add-passkey", "login-options", "login",
  "link-room", "rooms", "recover-room", "passkeys", "remove-passkey", "unlink-room", "delete-account",
];

// ---- フラグと鍵 ----

test("ACCOUNTS_ENABLED 未設定・ACCOUNT_KEK 未設定／壊れた値では、全 op が 503 で DB に触れない", async () => {
  const db = createTestDatabase();
  try {
    for (const overrides of [
      { ACCOUNTS_ENABLED: undefined },
      { ACCOUNTS_ENABLED: "0" },
      { ACCOUNT_KEK: undefined },
      { ACCOUNT_KEK: "not json" },
      { ACCOUNT_KEK: JSON.stringify([{ kid: "k1", secret: "short" }]) },
      { ACCOUNT_KEK: "[]" },
    ]) {
      const env = makeEnv(db, overrides);
      for (const op of ALL_OPS) {
        const before = db.log.length;
        const res = await call(env, op);
        assert.equal(res.status, 503, `${JSON.stringify(overrides)} ${op}`);
        assert.equal(db.log.length, before, `${op}: 503 の前に SQL を流している`);
      }
      assert.equal((await call(env, "rooms", {}, { method: "GET" })).status, 503, "GET も 503");
    }
  } finally {
    db.close();
  }
});

test("Origin が許可リストに無い・無い・別サイトからの要求は 403", async () => {
  const db = createTestDatabase();
  try {
    const env = makeEnv(db);
    assert.equal((await call(env, "login-options", {}, { origin: "https://feature.wordbank.pages.dev" })).status, 403);
    assert.equal((await call(env, "login-options", {}, { origin: null })).status, 403);
    assert.equal((await call(env, "login-options")).status, 200);
  } finally {
    db.close();
  }
});

// ---- 実機データ ----

test("iPhone 実機の登録・認証データ（DER 署名のまま）が検証を通る", async () => {
  const db = createTestDatabase();
  try {
    const origin = `https://${fixture.register.rpId}`;
    const env = makeEnv(db, { ACCOUNT_ORIGINS: origin, ACCOUNT_RP_ID: fixture.register.rpId });
    const accountId = `wa_${"1".repeat(32)}`;
    // 実機の challenge はスパイクのサーバーが出したもの。消費される行をその値で用意する。
    db.db.prepare("INSERT INTO auth_challenges (challenge, purpose, account_id, user_handle, created_at) VALUES (?, 'register', ?, ?, ?)")
      .run(fixture.register.challenge, accountId, fixture.register.userId, Date.now());
    const reg = await call(env, "register", {
      credential: {
        id: fixture.register.id,
        response: { clientDataJSON: fixture.register.clientDataJSON, attestationObject: fixture.register.attestationObject },
      },
    }, { origin });
    assert.equal(reg.status, 200, JSON.stringify(reg.data));
    assert.equal(reg.data.accountId, accountId);
    const stored = db.db.prepare("SELECT alg, backup_eligible, backed_up, sign_count FROM passkeys WHERE credential_id = ?").get(fixture.register.id);
    assert.deepEqual({ ...stored }, { alg: -7, backup_eligible: 1, backed_up: 1, sign_count: 0 });

    for (const name of ["login", "loginAgain", "loginAfterFetch"]) {
      const sample = fixture[name];
      db.db.prepare("INSERT INTO auth_challenges (challenge, purpose, created_at) VALUES (?, 'login', ?)").run(sample.challenge, Date.now());
      const res = await call(env, "login", {
        credential: {
          id: sample.id,
          response: {
            clientDataJSON: sample.clientDataJSON,
            authenticatorData: sample.authenticatorData.raw,
            signature: sample.signature,
            userHandle: sample.userHandle,
          },
        },
      }, { origin });
      assert.equal(res.status, 200, `${name}: ${JSON.stringify(res.data)}`);
      assert.equal(res.data.accountId, accountId);
      assert.equal(res.data.backedUp, true);
    }

    // 1 byte 変えた署名は通らない（検証が実際に効いていること）
    db.db.prepare("INSERT INTO auth_challenges (challenge, purpose, created_at) VALUES (?, 'login', ?)").run(fixture.login.challenge, Date.now());
    const sig = fromB64url(fixture.login.signature);
    sig[sig.length - 1] ^= 1;
    const bad = await call(env, "login", {
      credential: {
        id: fixture.login.id,
        response: {
          clientDataJSON: fixture.login.clientDataJSON,
          authenticatorData: fixture.login.authenticatorData.raw,
          signature: b64url(sig),
          userHandle: fixture.login.userHandle,
        },
      },
    }, { origin });
    assert.equal(bad.status, 403);
  } finally {
    db.close();
  }
});

// ---- 一連の流れ ----

test("登録 → 結びつけ → 一覧（語数）→ 復旧で秘密が返る → 外す → 削除。部屋と単語は残る", async () => {
  const db = createTestDatabase();
  try {
    const env = makeEnv(db);
    const room = await createRoom(db, { words: 7 });
    const before = snapshot(db);
    const mark = db.log.length;

    const { auth, accountId, token } = await signUp(env);
    assert.match(accountId, /^wa_[0-9a-f]{32}$/);
    const link = await call(env, "link-room", room, { token });
    assert.equal(link.status, 200, JSON.stringify(link.data));
    assert.deepEqual(link.data, { ok: true, backedUp: true });

    const env_row = db.db.prepare("SELECT secret_env, env_kid FROM account_rooms WHERE room_id = ?").get(room.roomId);
    assert.ok(!env_row.secret_env.includes(room.secret.slice(3)), "封筒に平文の秘密が入っている");
    assert.equal(env_row.env_kid, "k1");

    const rooms = await call(env, "rooms", {}, { token });
    assert.equal(rooms.status, 200);
    assert.equal(rooms.data.length, 1);
    assert.equal(rooms.data[0].roomId, room.roomId);
    assert.equal(rooms.data[0].wordCount, 7);
    assert.equal(rooms.data[0].deckCount, 1);
    assert.equal(rooms.data[0].stateRev, 1);
    assert.ok(!JSON.stringify(rooms.data).includes(room.secret), "一覧に秘密が出ている");

    const login = await signIn(env, auth);
    assert.equal(login.status, 200);
    const recovered = await call(env, "recover-room", { roomId: room.roomId }, { token: login.data.token });
    assert.deepEqual(recovered, { status: 200, data: { roomId: room.roomId, secret: room.secret } });

    const passkeys = await call(env, "passkeys", {}, { token });
    assert.equal(passkeys.status, 200);
    assert.deepEqual(passkeys.data.map((p) => [p.credentialId, p.backedUp]), [[auth.id, true]]);

    assert.equal((await call(env, "remove-passkey", { credentialId: auth.id }, { token })).status, 403, "最後の 1 本は消せない");
    assert.equal((await call(env, "unlink-room", room, { token })).status, 200);
    assert.equal((await call(env, "recover-room", { roomId: room.roomId }, { token })).status, 403);
    assert.equal((await call(env, "link-room", room, { token })).status, 200, "外した部屋は結びつけ直せる");
    assert.equal((await call(env, "delete-account", {}, { token })).status, 200);
    for (const table of ["accounts", "passkeys", "account_rooms", "auth_challenges"]) {
      assert.equal(db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} が残っている`);
    }

    // 不変条件 1・2
    assert.equal(snapshot(db), before, "rooms / states / state_revisions が変わった");
    const writes = db.log.slice(mark).filter((sql) => FORBIDDEN_WRITE.test(sql));
    assert.deepEqual(writes, []);
  } finally {
    db.close();
  }
});

test("不変条件 1・2: 同期の鍵リングが 2 本で旧鍵の部屋を結びつけても rooms へ書かない", async () => {
  const db = createTestDatabase();
  try {
    const room = await createRoom(db, { syncKeys: [SYNC_KEY_OLD] });
    const env = makeEnv(db, { SYNC_AUTH_SECRETS: JSON.stringify([SYNC_KEY_NEW, SYNC_KEY_OLD]) });
    const before = snapshot(db);
    const mark = db.log.length;
    const { token, auth } = await signUp(env);
    assert.equal((await call(env, "link-room", room, { token })).status, 200);
    const fresh = (await signIn(env, auth)).data.token;
    assert.equal((await call(env, "recover-room", { roomId: room.roomId }, { token: fresh })).data.secret, room.secret);
    assert.equal((await call(env, "rooms", {}, { token })).status, 200);
    assert.equal(snapshot(db), before, "旧鍵一致で auth_hash を張り替えた（verifyRoomSecret の流用）");
    assert.deepEqual(db.log.slice(mark).filter((sql) => FORBIDDEN_WRITE.test(sql)), []);
    assert.equal(db.db.prepare("SELECT auth_kid FROM rooms").get().auth_kid, "s1");
  } finally {
    db.close();
  }
});

test("不変条件 1: account.js の SQL は自分の 4 テーブル以外へ書かず、wordsnap-state.js から rateLimitClientKey しか取り込まない", () => {
  const source = readFileSync(join(here, "..", "functions", "api", "account.js"), "utf8");
  assert.ok(!FORBIDDEN_WRITE.test(source), "states / rooms / state_revisions への書き込みがある");
  const writes = [...source.matchAll(/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi)].map((m) => m[1])
    .filter((name) => name.toUpperCase() !== "SET"); // ON CONFLICT … DO UPDATE SET
  assert.ok(writes.length >= 8, "抽出が効いていない");
  for (const table of writes) {
    assert.ok(["accounts", "passkeys", "account_rooms", "auth_challenges", "rate_limits"].includes(table), `書き込み先: ${table}`);
  }
  const imports = [...source.matchAll(/^import\s+(.+?)\s+from\s+"([^"]+)";$/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(imports, [["{ rateLimitClientKey }", "./wordsnap-state.js"]]);
  assert.ok(!/verifyRoomSecret|updateAuthHashLazily|consumeV2RateLimit/.test(source.replace(/^\s*\/\/.*$/gm, "")),
    "同期本体の照合・レート制限を流用している");
});

// ---- §6.2 の異常系（すべて同じ 403） ----

async function expectRegisterDenied(name, o, { authOpts, mutateRow } = {}) {
  const db = createTestDatabase();
  try {
    const env = makeEnv(db);
    const auth = await FakeAuthenticator.create(authOpts);
    const options = await call(env, "register-options");
    if (mutateRow) mutateRow(db, options.data.challenge);
    const res = await call(env, "register", { credential: await auth.makeCredential(options.data, o) });
    assert.deepEqual(res, { status: 403, data: { error: "forbidden" } }, name);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 0, `${name}: アカウントが作られた`);
  } finally {
    db.close();
  }
}

test("登録の異常系: rpIdHash・origin・type・fmt・UP/UV・BS=1&BE=0・alg・期限切れ・purpose 不一致はすべて 403", async () => {
  await expectRegisterDenied("rpIdHash 不一致", { rpId: "evil.example" });
  await expectRegisterDenied("origin 不一致", { origin: "https://evil.example" });
  await expectRegisterDenied("type 不一致", { type: "webauthn.get" });
  await expectRegisterDenied("crossOrigin", { crossOrigin: true });
  await expectRegisterDenied("未知 fmt", { fmt: "packed" });
  await expectRegisterDenied("UP 無し", { flags: FLAG.UV });
  await expectRegisterDenied("UV 無し", { flags: FLAG.UP });
  await expectRegisterDenied("BS=1 かつ BE=0", { flags: FLAG.UP | FLAG.UV | FLAG.BS });
  await expectRegisterDenied("alg 不一致（EC 鍵に RS256）", { alg: -257 });
  await expectRegisterDenied("alg 不一致（EdDSA）", { alg: -8 });
  await expectRegisterDenied("challenge 改ざん", { challenge: b64url(new Uint8Array(32)) });
  await expectRegisterDenied("期限切れ", {}, {
    mutateRow: (db, challenge) => db.db.prepare("UPDATE auth_challenges SET created_at = ? WHERE challenge = ?").run(Date.now() - 11 * MINUTE, challenge),
  });
  await expectRegisterDenied("purpose 不一致（login の challenge で登録）", {}, {
    mutateRow: (db, challenge) => db.db.prepare("UPDATE auth_challenges SET purpose = 'login' WHERE challenge = ?").run(challenge),
  });
});

test("認証の異常系: rpIdHash・origin・type・UP/UV・BE 不一致・userHandle・署名・purpose・期限切れ・再利用はすべて 403", async () => {
  const db = createTestDatabase();
  try {
    const env = makeEnv(db);
    const { auth } = await signUp(env);
    const cases = [
      ["rpIdHash 不一致", { rpId: "evil.example" }],
      ["origin 不一致", { origin: "https://evil.example" }],
      ["type 不一致", { type: "webauthn.create" }],
      ["UP 無し", { flags: FLAG.UV | FLAG.BE | FLAG.BS }],
      ["UV 無し", { flags: FLAG.UP | FLAG.BE | FLAG.BS }],
      ["BS=1 かつ BE=0", { flags: FLAG.UP | FLAG.UV | FLAG.BS }],
      ["BE 不一致", { flags: FLAG.UP | FLAG.UV }],
      ["userHandle 不一致", { userHandle: b64url(new Uint8Array(32)) }],
    ];
    for (const [index, [name, o]] of cases.entries()) {
      const res = await signIn(env, auth, o, `192.0.2.${index}`);
      assert.deepEqual(res, { status: 403, data: { error: "forbidden" } }, name);
    }

    // 未知の credential
    const stranger = await FakeAuthenticator.create();
    stranger.userHandle = auth.userHandle;
    assert.equal((await signIn(env, stranger, {}, "192.0.2.50")).status, 403, "未知の credential");

    // purpose 不一致（登録用の challenge で認証）
    const regOptions = await call(env, "register-options", {}, { ip: "192.0.2.51" });
    const wrongPurpose = await call(env, "login", { credential: await auth.getAssertion(regOptions.data.challenge) }, { ip: "192.0.2.51" });
    assert.equal(wrongPurpose.status, 403, "purpose 不一致");

    // 期限切れ
    const old = await call(env, "login-options", {}, { ip: "192.0.2.52" });
    db.db.prepare("UPDATE auth_challenges SET created_at = ? WHERE challenge = ?").run(Date.now() - 11 * MINUTE, old.data.challenge);
    assert.equal((await call(env, "login", { credential: await auth.getAssertion(old.data.challenge) }, { ip: "192.0.2.52" })).status, 403, "期限切れ");

    // 再利用
    const options = await call(env, "login-options", {}, { ip: "192.0.2.53" });
    const assertion = await auth.getAssertion(options.data.challenge);
    assert.equal((await call(env, "login", { credential: assertion }, { ip: "192.0.2.53" })).status, 200);
    assert.equal((await call(env, "login", { credential: assertion }, { ip: "192.0.2.53" })).status, 403, "challenge 再利用");

    // 署名の改ざん
    const o2 = await call(env, "login-options", {}, { ip: "192.0.2.54" });
    const tampered = await auth.getAssertion(o2.data.challenge);
    const sig = fromB64url(tampered.response.signature);
    sig[sig.length - 1] ^= 1;
    tampered.response.signature = b64url(sig);
    assert.equal((await call(env, "login", { credential: tampered }, { ip: "192.0.2.54" })).status, 403, "署名の改ざん");

    // 壊れた入力も 403（500 にしない）
    const o3 = await call(env, "login-options", {}, { ip: "192.0.2.55" });
    const broken = await auth.getAssertion(o3.data.challenge);
    broken.response.authenticatorData = "!!!";
    assert.equal((await call(env, "login", { credential: broken }, { ip: "192.0.2.55" })).status, 403);
    assert.equal((await call(env, "login", { credential: "x" }, { ip: "192.0.2.55" })).status, 403);
  } finally {
    db.close();
  }
});

test("sign_count が減っても拒否せず記録する。BS は最後の値を記録する", async () => {
  const db = createTestDatabase();
  try {
    const env = makeEnv(db);
    const auth = await FakeAuthenticator.create();
    const options = await call(env, "register-options");
    assert.equal((await call(env, "register", { credential: await auth.makeCredential(options.data, { signCount: 5 }) })).status, 200);
    assert.equal((await signIn(env, auth, { signCount: 10 })).status, 200);
    const res = await signIn(env, auth, { signCount: 3, flags: FLAG.UP | FLAG.UV | FLAG.BE });
    assert.equal(res.status, 200);
    assert.equal(res.data.backedUp, false);
    const row = db.db.prepare("SELECT sign_count, backed_up FROM passkeys").get();
    assert.deepEqual({ ...row }, { sign_count: 3, backed_up: 0 });
  } finally {
    db.close();
  }
});

test("BE=0 で登録したパスキーは BE=0 の認証だけ通る", async () => {
  const db = createTestDatabase();
  try {
    const env = makeEnv(db);
    const auth = await FakeAuthenticator.create({ be: false, bs: false });
    await signUp(env, { authenticator: auth });
    assert.equal((await signIn(env, auth)).status, 200);
    assert.equal((await signIn(env, auth, { flags: FLAG.UP | FLAG.UV | FLAG.BE })).status, 403);
  } finally {
    db.close();
  }
});

test("challenge の消費は原子的: 同じ assertion の並行 2 リクエストは 1 つだけ通る", async () => {
  const db = createTestDatabase();
  try {
    const env = makeEnv(db);
    const { auth } = await signUp(env);
    const options = await call(env, "login-options");
    const assertion = await auth.getAssertion(options.data.challenge);
    const results = await Promise.all([1, 2, 3].map(() => call(env, "login", { credential: assertion })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 403, 403]);
  } finally {
    db.close();
  }
});

// ---- トークン ----

test("トークン: 改ざん・期限切れ・delete-account 後・2 分超の破壊的 op は 403", async () => {
  const db = createTestDatabase();
  try {
    const env = makeEnv(db);
    const room = await createRoom(db);
    const { token, auth } = await signUp(env);
    assert.equal((await call(env, "link-room", room, { token })).status, 200);

    const [payload, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), iat: Date.now() + 1 })).toString("base64url");
    assert.equal((await call(env, "rooms", {}, { token: `${forged}.${mac}` })).status, 403, "改ざん");
    assert.equal((await call(env, "rooms", {}, { token: "garbage" })).status, 403);
    assert.equal((await call(env, "rooms")).status, 403, "トークン無し");

    const addOptions = await call(env, "add-passkey-options", {}, { token });
    const credential = await (await FakeAuthenticator.create()).makeCredential(addOptions.data);
    await withClock(3 * MINUTE, async () => {
      assert.equal((await call(env, "rooms", {}, { token })).status, 200, "読み取りは 10 分まで");
      for (const op of ["recover-room", "add-passkey-options", "remove-passkey", "unlink-room", "delete-account"]) {
        assert.equal((await call(env, op, { roomId: room.roomId, credentialId: auth.id }, { token })).status, 403, `${op}: 2 分超`);
      }
      assert.equal((await call(env, "add-passkey", { credential }, { token })).status, 403, "add-passkey: 2 分超");
    });
    // 同じ要求が 2 分以内なら通る＝拒否の理由はトークンの古さ
    assert.equal((await call(env, "add-passkey", { credential }, { token })).status, 200);
    assert.equal((await call(env, "recover-room", { roomId: room.roomId }, { token })).status, 200);
    await withClock(11 * MINUTE, async () => {
      assert.equal((await call(env, "rooms", {}, { token })).status, 403, "10 分で失効");
    });

    assert.equal((await call(env, "delete-account", {}, { token })).status, 200);
    assert.equal((await call(env, "link-room", room, { token })).status, 403, "削除後のトークンで結びつけ");
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM account_rooms").get().n, 0, "孤児の封筒ができた");
  } finally {
    db.close();
  }
});

test("トークン: remove-passkey 後はそのパスキーのトークンが 403。A の challenge を B のトークンで使えない", async () => {
  const db = createTestDatabase();
  try {
    const env = makeEnv(db);
    const a = await signUp(env);
    const second = await FakeAuthenticator.create();
    const addOptions = await call(env, "add-passkey-options", {}, { token: a.token });
    assert.equal(addOptions.status, 200);
    assert.equal(addOptions.data.user.id, a.auth.userHandle, "追加のパスキーも同じ userHandle");
    assert.deepEqual(addOptions.data.excludeCredentials, [{ type: "public-key", id: a.auth.id }]);
    assert.equal((await call(env, "add-passkey", { credential: await second.makeCredential(addOptions.data) }, { token: a.token })).status, 200);
    const secondLogin = await signIn(env, second);
    assert.equal(secondLogin.status, 200);
    assert.equal(secondLogin.data.accountId, a.accountId);

    assert.equal((await call(env, "remove-passkey", { credentialId: second.id }, { token: a.token })).status, 200);
    assert.equal((await call(env, "rooms", {}, { token: secondLogin.data.token })).status, 403, "消したパスキーのトークン");
    assert.equal((await signIn(env, second)).status, 403, "消したパスキーで認証");

    // B のトークンで A の add-passkey challenge を使う
    const b = await signUp(env, { ip: "203.0.113.20" });
    const aOptions = await call(env, "add-passkey-options", {}, { token: a.token });
    const intruder = await FakeAuthenticator.create();
    const res = await call(env, "add-passkey", { credential: await intruder.makeCredential(aOptions.data) }, { token: b.token });
    assert.equal(res.status, 403);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE credential_id = ?").get(intruder.id).n, 0);
  } finally {
    db.close();
  }
});

// ---- KEK ----

test("KEK ローテーション: 新鍵を先頭に足すと開けたときに包み直し、旧鍵を外しても開ける", async () => {
  const db = createTestDatabase();
  try {
    const room = await createRoom(db);
    const env1 = makeEnv(db, { ACCOUNT_KEK: JSON.stringify([KEK1]) });
    const { auth, token } = await signUp(env1);
    assert.equal((await call(env1, "link-room", room, { token })).status, 200);
    const kid = () => db.db.prepare("SELECT env_kid FROM account_rooms").get().env_kid;
    assert.equal(kid(), "k1");

    // 旧鍵を先に外すと開けない。封筒は消さず 503（KEK を戻せば開ける）
    const envOnly2 = makeEnv(db, { ACCOUNT_KEK: JSON.stringify([KEK2]) });
    const t0 = (await signIn(envOnly2, auth)).data.token;
    assert.equal((await call(envOnly2, "recover-room", { roomId: room.roomId }, { token: t0 })).status, 503);
    assert.equal(kid(), "k1");

    const env2 = makeEnv(db, { ACCOUNT_KEK: JSON.stringify([KEK2, KEK1]) });
    const t1 = (await signIn(env2, auth)).data.token;
    assert.equal((await call(env2, "recover-room", { roomId: room.roomId }, { token: t1 })).data.secret, room.secret);
    assert.equal(kid(), "k2", "lazy re-wrap されていない");

    const t2 = (await signIn(envOnly2, auth)).data.token;
    assert.equal((await call(envOnly2, "recover-room", { roomId: room.roomId }, { token: t2 })).data.secret, room.secret);
  } finally {
    db.close();
  }
});

test("封筒は結びつけ先に束縛される（別アカウントの行へ写しても開けない）", async () => {
  const db = createTestDatabase();
  try {
    const env = makeEnv(db);
    const room = await createRoom(db);
    const a = await signUp(env);
    const b = await signUp(env, { ip: "203.0.113.30" });
    assert.equal((await call(env, "link-room", room, { token: a.token })).status, 200);
    db.db.prepare("UPDATE account_rooms SET account_id = ?").run(b.accountId);
    assert.equal((await call(env, "recover-room", { roomId: room.roomId }, { token: b.token })).status, 403);
  } finally {
    db.close();
  }
});

// ---- 件数と結びつけの規則 ----

test("1 部屋は 1 アカウントだけ。秘密を知っていても別アカウントの link-room は 403", async () => {
  const db = createTestDatabase();
  try {
    const env = makeEnv(db);
    const room = await createRoom(db);
    const a = await signUp(env);
    const b = await signUp(env, { ip: "203.0.113.40" });
    assert.equal((await call(env, "link-room", room, { token: a.token })).status, 200);
    assert.equal((await call(env, "link-room", room, { token: b.token }, { ip: "203.0.113.40" })).status, 403);
    assert.equal((await call(env, "link-room", room, { token: a.token })).status, 200, "同じアカウントの再結びつけは通る");
    const rows = db.db.prepare("SELECT account_id FROM account_rooms").all();
    assert.deepEqual(rows.map((r) => r.account_id), [a.accountId]);
  } finally {
    db.close();
  }
});

test("link-room: 秘密違い・存在しない部屋・形式違いは同じ 403", async () => {
  const db = createTestDatabase();
  try {
    const env = makeEnv(db);
    const room = await createRoom(db);
    const { token } = await signUp(env);
    for (const body of [
      { roomId: room.roomId, secret: `wk_${"0".repeat(60)}` },
      { roomId: `wr_${"e".repeat(32)}`, secret: room.secret },
      { roomId: "ws_legacy", secret: room.secret },
      {},
    ]) {
      assert.deepEqual(await call(env, "link-room", body, { token }), { status: 403, data: { error: "forbidden" } }, JSON.stringify(body));
    }
    assert.equal((await call(env, "link-room", room, { token, ip: "203.0.113.11" })).status, 200);
    // 同期の鍵リングが無ければ照合できないので 503
    assert.equal((await call(makeEnv(db, { SYNC_AUTH_SECRETS: undefined }), "link-room", room, { token })).status, 503);
  } finally {
    db.close();
  }
});

test("件数上限: パスキー 10 本・部屋 10 件まで", async () => {
  const db = createTestDatabase();
  try {
    const env = makeEnv(db);
    const a = await signUp(env);
    for (let i = 2; i <= 11; i += 1) {
      const fresh = (await signIn(env, a.auth, {}, `10.0.${i}.1`)).data.token;
      const options = await call(env, "add-passkey-options", {}, { token: fresh, ip: `10.0.${i}.1` });
      const res = await call(env, "add-passkey", { credential: await (await FakeAuthenticator.create()).makeCredential(options.data) }, { token: fresh });
      assert.equal(res.status, i <= 10 ? 200 : 403, `${i} 本目`);
    }
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM passkeys").get().n, 10);

    for (let i = 1; i <= 11; i += 1) {
      const room = await createRoom(db);
      const res = await call(env, "link-room", room, { token: a.token, ip: `10.1.${i}.1` });
      assert.equal(res.status, i <= 10 ? 200 : 403, `${i} 部屋目`);
    }
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM account_rooms").get().n, 10);
    assert.equal((await call(env, "rooms", {}, { token: a.token })).data.length, 10);
  } finally {
    db.close();
  }
});

// ---- レート制限 ----

test("レート制限: 各鍵の上限に達すると 429", async () => {
  const db = createTestDatabase();
  try {
    const env = makeEnv(db);
    // acct-options: 20 / 10 分
    for (let i = 0; i < 20; i += 1) assert.equal((await call(env, "login-options", {}, { ip: "10.9.0.1" })).status, 200);
    assert.equal((await call(env, "register-options", {}, { ip: "10.9.0.1" })).status, 429);
    // acct-register: 5 / 時（失敗も数える）
    for (let i = 0; i < 5; i += 1) assert.equal((await call(env, "register", { credential: {} }, { ip: "10.9.0.2" })).status, 403);
    assert.equal((await call(env, "register", { credential: {} }, { ip: "10.9.0.2" })).status, 429);
    // acct-login-fail: 失敗 10 回で以後 429（成功は数えない）
    for (let i = 0; i < 10; i += 1) assert.equal((await call(env, "login", { credential: {} }, { ip: "10.9.0.3" })).status, 403);
    assert.equal((await call(env, "login", { credential: {} }, { ip: "10.9.0.3" })).status, 429);

    const { token, auth, accountId } = await signUp(env, { ip: "10.9.0.4" });
    const room = await createRoom(db);
    // acct-link-fail: 失敗 10 回で 429。V2 同期の v2-auth-fail は消費しない
    const bad = { roomId: room.roomId, secret: `wk_${"0".repeat(60)}` };
    for (let i = 0; i < 10; i += 1) assert.equal((await call(env, "link-room", bad, { token, ip: "10.9.0.5" })).status, 403);
    assert.equal((await call(env, "link-room", room, { token, ip: "10.9.0.5" })).status, 429);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE rl_key LIKE 'v2-auth-fail:%'").get().n, 0);
    // acct-write: 30 / 時（アカウント単位。ここまでで 11 回）
    for (let i = 11; i < 30; i += 1) assert.notEqual((await call(env, "link-room", room, { token, ip: `10.8.${i}.1` })).status, 429, `${i}`);
    assert.equal((await call(env, "link-room", room, { token, ip: "10.7.0.1" })).status, 429);
    // acct-read: 60 / 10 分
    for (let i = 0; i < 60; i += 1) assert.equal((await call(env, "passkeys", {}, { token })).status, 200);
    assert.equal((await call(env, "rooms", {}, { token })).status, 429);

    // acct-recover-ip: 20 / 時。acct-recover-acct: 20 / 24 時間
    const fresh = (await signIn(env, auth, {}, "10.9.0.6")).data.token;
    for (let i = 0; i < 20; i += 1) assert.equal((await call(env, "recover-room", { roomId: room.roomId }, { token: fresh, ip: "10.9.0.7" })).status, 200);
    assert.equal((await call(env, "recover-room", { roomId: room.roomId }, { token: fresh, ip: "10.9.0.7" })).status, 429, "IP 上限");
    assert.equal((await call(env, "recover-room", { roomId: room.roomId }, { token: fresh, ip: "10.9.0.8" })).status, 429, "アカウント上限（別 IP でも）");
    const acctRow = db.db.prepare("SELECT count FROM rate_limits WHERE rl_key = ?").get(`acct-recover-acct:${accountId}`);
    assert.equal(acctRow.count, 20);
  } finally {
    db.close();
  }
});

test("recover-room は fail-closed: rate_limits が読めないと 503。一覧は fail-open で動く", async () => {
  const db = createTestDatabase();
  try {
    const env = makeEnv(db);
    const room = await createRoom(db);
    const { token } = await signUp(env);
    assert.equal((await call(env, "link-room", room, { token })).status, 200);
    db.db.exec("DROP TABLE rate_limits");
    assert.equal((await call(env, "recover-room", { roomId: room.roomId }, { token })).status, 503);
    assert.equal((await call(env, "rooms", {}, { token })).status, 200);
    assert.equal((await call(env, "login-options")).status, 200);
  } finally {
    db.close();
  }
});

test("期限切れの challenge は *-options の呼び出しで上限付きで掃除される", async () => {
  const db = createTestDatabase();
  try {
    const env = makeEnv(db);
    const insert = db.db.prepare("INSERT INTO auth_challenges (challenge, purpose, created_at) VALUES (?, 'login', ?)");
    for (let i = 0; i < 150; i += 1) insert.run(`old${i}`, Date.now() - 20 * MINUTE);
    await call(env, "login-options");
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM auth_challenges").get().n, 51, "100 件だけ消して新しい 1 件が残る");
  } finally {
    db.close();
  }
});
