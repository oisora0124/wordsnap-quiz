// AIキー暗号化同期（ロードマップB）の封筒そのものの凍結ゲート。設計: docs/ai-secret-sync-design.md
//
// 公開HTML内の実コードを取り出し、**本物の WebCrypto でそのまま実行**して検査する。
// Node の crypto はブラウザと同じ WebCrypto API なので、スタブを噛ませずに
// 暗号の性質（AAD束縛・GCMタグ・IV・版の厳格一致）を実際に確かめられる。
// 文字列の出現を数えるだけのテストでは、封筒の中身が平文になっていても通ってしまう。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

// 波括弧の対応をとって関数本体を丸ごと切り出す（次の宣言に頼らないので配置変更に強い）。
function extractFunction(name) {
  const found = html.indexOf(`function ${name}(`);
  assert.ok(found >= 0, `function ${name} が見つかること`);
  // async を落とすと vm 側で「await は async 関数でしか使えない」になる。
  const start = html.slice(found - 6, found) === "async " ? found - 6 : found;
  const bodyBrace = html.indexOf("{", html.indexOf(")", found));
  let depth = 0;
  for (let i = bodyBrace; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

function extractSimpleConst(name) {
  const line = new RegExp(`^const ${name} = .*;$`, "m").exec(html);
  assert.ok(line, `const ${name} が見つかること`);
  return line[0];
}

const FUNCTIONS = [
  "aiSecretBytesToBase64",
  "aiSecretBase64ToBytes",
  "deriveAiSecretKey",
  "aiSecretAad",
  "sanitizeAiSecretKeys",
  "aiSecretMaxUpdatedAt",
  "validAiSecretEnvelope",
  "sealAiSecrets",
  "openAiSecrets",
];

const CONSTS = [
  "AI_SECRET_ENVELOPE_VERSION",
  "AI_SECRET_ALG",
  "AI_SECRET_KDF",
  "AI_SECRET_HKDF_INFO",
  "AI_SECRET_ENVELOPE_LIMIT",
  "AI_SECRET_VALUE_LIMIT",
];

const context = {
  crypto: globalThis.crypto,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  JSON,
  Object,
  Number,
  Math,
  String,
  Array,
  Boolean,
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  // 実物と同じ provider 集合。ここが実物とずれるとテストの意味が薄れるため、
  // 下の「実物と一致すること」で照合する。
  AI_PROVIDERS: [{ id: "gemini" }, { id: "groq" }],
};

vm.runInNewContext(
  [...CONSTS.map(extractSimpleConst), ...FUNCTIONS.map(extractFunction)].join("\n"),
  context,
);

const {
  sealAiSecrets,
  openAiSecrets,
  aiSecretBase64ToBytes,
  aiSecretBytesToBase64,
  sanitizeAiSecretKeys,
} = context;

const ROOM_A = `wr_${"1".repeat(32)}`;
const VAULT_A = `wv_${"2".repeat(64)}`;
const ROOM_B = `wr_${"3".repeat(32)}`;
const VAULT_B = `wv_${"4".repeat(64)}`;
const GEMINI = "AIzaTESTKEY-gemini-do-not-use";
const GROQ = "gsk_TESTKEY-groq-do-not-use";
const T1 = 1753500000000;
const T2 = 1753500001000;

function keySet(gemini = GEMINI, groq = GROQ, tg = T1, tq = T1) {
  return { gemini: { value: gemini, updatedAt: tg }, groq: { value: groq, updatedAt: tq } };
}

test("実物のAI_PROVIDERSと、このテストが仮定するprovider集合が一致する", () => {
  const ids = [...html.matchAll(/^\s{4}id: "([a-z0-9-]+)",$/gm)]
    .map((m) => m[1])
    .filter((id) => id === "gemini" || id === "groq");
  assert.ok(ids.includes("gemini") && ids.includes("groq"), "gemini と groq が実在すること");
  assert.deepEqual(
    context.AI_PROVIDERS.map((p) => p.id).sort(),
    ["gemini", "groq"],
  );
});

test("封筒は作れて、正しい部屋と鍵で開ける", async () => {
  const envelope = await sealAiSecrets(ROOM_A, VAULT_A, keySet());
  assert.ok(envelope, "封筒が作れること");
  const opened = await openAiSecrets(ROOM_A, VAULT_A, envelope);
  assert.equal(opened.keys.gemini.value, GEMINI);
  assert.equal(opened.keys.groq.value, GROQ);
});

// G20の一部（封筒そのものに平文が出ない）。送信経路まで含めた検査はB-2側で行う。
test("封筒のどこにも平文のAPIキーが現れない", async () => {
  const envelope = await sealAiSecrets(ROOM_A, VAULT_A, keySet());
  const serialized = JSON.stringify(envelope);
  assert.ok(!serialized.includes(GEMINI), "Geminiキーが平文で出ないこと");
  assert.ok(!serialized.includes(GROQ), "Groqキーが平文で出ないこと");
  assert.ok(!serialized.includes("AIza"), "キーの接頭辞すら出ないこと");
  assert.ok(!serialized.includes("gsk_"), "キーの接頭辞すら出ないこと");
});

test("封筒は上限より十分小さい（同期本文を圧迫しない）", async () => {
  const envelope = await sealAiSecrets(ROOM_A, VAULT_A, keySet());
  assert.ok(
    JSON.stringify(envelope).length < 1024,
    `封筒が1KB未満であること（実測 ${JSON.stringify(envelope).length}B）`,
  );
});

// G3
test("別の部屋の資格情報では復号できない", async () => {
  const envelope = await sealAiSecrets(ROOM_A, VAULT_A, keySet());
  assert.equal(await openAiSecrets(ROOM_B, VAULT_B, envelope), null);
});

// G3: 部屋の束縛は HKDF の salt と AAD の二重で効く。変異検査で確認したとおり、
// 片方だけを壊してもこのテストは通ってしまう（もう片方が守るため）。
// AAD の中身そのものは下の「AADは…を含む」と参照派生テストで固定している。
test("鍵が正しくても部屋IDが違えば復号できない", async () => {
  const envelope = await sealAiSecrets(ROOM_A, VAULT_A, keySet());
  assert.equal(await openAiSecrets(ROOM_B, VAULT_A, envelope), null);
});

test("AADはドメイン・版・アルゴリズム名・部屋IDを含む", () => {
  const aad = new TextDecoder().decode(context.aiSecretAad(ROOM_A));
  assert.equal(aad, `wordsnap-ai-secrets|1|A256GCM|HKDF-SHA-256|${ROOM_A}`);
  assert.notEqual(
    new TextDecoder().decode(context.aiSecretAad(ROOM_B)),
    aad,
    "部屋が違えばAADも違うこと",
  );
});

test("部屋IDが正しくても鍵が違えば復号できない", async () => {
  const envelope = await sealAiSecrets(ROOM_A, VAULT_A, keySet());
  assert.equal(await openAiSecrets(ROOM_A, VAULT_B, envelope), null);
});

// G4
test("暗号文を1ビット改竄すると復号できない（GCMタグ）", async () => {
  const envelope = await sealAiSecrets(ROOM_A, VAULT_A, keySet());
  const bytes = aiSecretBase64ToBytes(envelope.ct);
  bytes[0] ^= 0x01;
  const tampered = { ...envelope, ct: aiSecretBytesToBase64(bytes) };
  assert.equal(await openAiSecrets(ROOM_A, VAULT_A, tampered), null);
});

test("IVを差し替えると復号できない", async () => {
  const envelope = await sealAiSecrets(ROOM_A, VAULT_A, keySet());
  const iv = aiSecretBase64ToBytes(envelope.iv);
  iv[0] ^= 0xff;
  assert.equal(
    await openAiSecrets(ROOM_A, VAULT_A, { ...envelope, iv: aiSecretBytesToBase64(iv) }),
    null,
  );
});

// G5: 外側の updatedAt は復号前に読むため署名対象外。中身と一致しなければ破棄する。
test("外側のupdatedAtだけを新しく書き換えた封筒は採用しない", async () => {
  const envelope = await sealAiSecrets(ROOM_A, VAULT_A, keySet());
  const forged = { ...envelope, updatedAt: envelope.updatedAt + 999999 };
  assert.equal(await openAiSecrets(ROOM_A, VAULT_A, forged), null);
});

test("外側のupdatedAtは中身のprovider時刻の最大値である", async () => {
  const envelope = await sealAiSecrets(ROOM_A, VAULT_A, keySet(GEMINI, GROQ, T1, T2));
  assert.equal(envelope.updatedAt, T2);
  const opened = await openAiSecrets(ROOM_A, VAULT_A, envelope);
  assert.equal(opened.updatedAt, T2);
});

// G19
test("IVは毎回新しく引かれる（同一派生鍵でのIV再利用がない）", async () => {
  const seen = new Set();
  for (let i = 0; i < 25; i += 1) {
    const envelope = await sealAiSecrets(ROOM_A, VAULT_A, keySet());
    assert.ok(!seen.has(envelope.iv), "IVが再利用されないこと");
    seen.add(envelope.iv);
    assert.equal(aiSecretBase64ToBytes(envelope.iv).length, 12, "IVは12バイト");
  }
});

// G19
test("v・alg・kdf は完全一致以外すべて拒否する", async () => {
  const envelope = await sealAiSecrets(ROOM_A, VAULT_A, keySet());
  for (const bad of [
    { ...envelope, v: 2 },
    { ...envelope, v: "1" },
    { ...envelope, alg: "A128GCM" },
    { ...envelope, alg: "A256CBC" },
    { ...envelope, kdf: "PBKDF2" },
    { ...envelope, kdf: "HKDF-SHA-512" },
  ]) {
    assert.equal(await openAiSecrets(ROOM_A, VAULT_A, bad), null, JSON.stringify(bad).slice(0, 60));
  }
});

test("IV長が12でない封筒は拒否する", async () => {
  const envelope = await sealAiSecrets(ROOM_A, VAULT_A, keySet());
  for (const length of [0, 8, 11, 13, 16]) {
    const bad = { ...envelope, iv: aiSecretBytesToBase64(new Uint8Array(length)) };
    assert.equal(await openAiSecrets(ROOM_A, VAULT_A, bad), null, `IV長 ${length}`);
  }
});

test("形の壊れた封筒は例外を投げずに拒否する", async () => {
  for (const bad of [
    null,
    undefined,
    [],
    {},
    "string",
    42,
    { v: 1, alg: "A256GCM", kdf: "HKDF-SHA-256", iv: 1, ct: "x", updatedAt: 1 },
    { v: 1, alg: "A256GCM", kdf: "HKDF-SHA-256", iv: "x", ct: "x", updatedAt: 0 },
    { v: 1, alg: "A256GCM", kdf: "HKDF-SHA-256", iv: "x", ct: "x", updatedAt: -1 },
    { v: 1, alg: "A256GCM", kdf: "HKDF-SHA-256", iv: "x", ct: "x", updatedAt: 1.5 },
    { v: 1, alg: "A256GCM", kdf: "HKDF-SHA-256", iv: "!!!", ct: "!!!", updatedAt: 1 },
  ]) {
    assert.equal(await openAiSecrets(ROOM_A, VAULT_A, bad), null, JSON.stringify(bad));
  }
});

test("空文字のキーは削除として封じられ、開ける", async () => {
  const envelope = await sealAiSecrets(ROOM_A, VAULT_A, keySet("", "", T1, T1));
  const opened = await openAiSecrets(ROOM_A, VAULT_A, envelope);
  assert.equal(opened.keys.gemini.value, "");
  assert.equal(opened.keys.groq.value, "");
});

test("長すぎるキー・不正な時刻は封じない", async () => {
  assert.equal(
    await sealAiSecrets(ROOM_A, VAULT_A, { gemini: { value: "x".repeat(513), updatedAt: T1 } }),
    null,
  );
  assert.equal(
    await sealAiSecrets(ROOM_A, VAULT_A, { gemini: { value: "x", updatedAt: 0 } }),
    null,
  );
  assert.equal(
    await sealAiSecrets(ROOM_A, VAULT_A, { gemini: { value: "x", updatedAt: "abc" } }),
    null,
  );
  assert.equal(await sealAiSecrets(ROOM_A, VAULT_A, {}), null, "空の集合は封じない");
  assert.equal(await sealAiSecrets(ROOM_A, VAULT_A, null), null);
});

test("providerが片方だけの封筒も扱える", async () => {
  const envelope = await sealAiSecrets(ROOM_A, VAULT_A, {
    gemini: { value: GEMINI, updatedAt: T1 },
  });
  const opened = await openAiSecrets(ROOM_A, VAULT_A, envelope);
  assert.equal(opened.keys.gemini.value, GEMINI);
  assert.equal(opened.keys.groq, undefined, "触っていないproviderは封筒に入らない");
});

test("未知のproviderは黙って捨てる（既知のproviderだけを通す）", () => {
  const sanitized = sanitizeAiSecretKeys({
    gemini: { value: GEMINI, updatedAt: T1 },
    evil: { value: "x", updatedAt: T1 },
  });
  assert.deepEqual(Object.keys(sanitized), ["gemini"]);
});

test("値が文字列でない・形が違うキーは封筒ごと拒否する", () => {
  assert.equal(sanitizeAiSecretKeys({ gemini: { value: 123, updatedAt: T1 } }), null);
  assert.equal(sanitizeAiSecretKeys({ gemini: "plain-string" }), null);
  assert.equal(sanitizeAiSecretKeys({ gemini: [] }), null);
  assert.equal(sanitizeAiSecretKeys([]), null);
  assert.equal(sanitizeAiSecretKeys("x"), null);
});

// 鍵派生が仕様どおりであることを、独立に計算した参照値と突き合わせる。
// 実装が別のsalt/infoに変わったら（＝既存の封筒が全部開けなくなる変更）ここで落ちる。
test("鍵派生は roomId をsalt、固定文字列をinfo とする HKDF-SHA-256 である", async () => {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(VAULT_A),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const reference = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(ROOM_A),
      info: encoder.encode("wordsnap-ai-secrets-v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const envelope = await sealAiSecrets(ROOM_A, VAULT_A, keySet());
  const opened = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: aiSecretBase64ToBytes(envelope.iv),
      additionalData: encoder.encode(
        `wordsnap-ai-secrets|1|A256GCM|HKDF-SHA-256|${ROOM_A}`,
      ),
    },
    reference,
    aiSecretBase64ToBytes(envelope.ct),
  );
  const parsed = JSON.parse(new TextDecoder().decode(opened));
  assert.equal(parsed.keys.gemini.value, GEMINI);
});

test("派生鍵は取り出せない（extractable: false）", async () => {
  const source = extractFunction("deriveAiSecretKey");
  assert.ok(
    /\{ name: "AES-GCM", length: 256 \},\s*\n\s*false,/.test(source),
    "deriveKey の extractable が false であること",
  );
});

// ---- vault key と引き継ぎコード（B-1b） -------------------------------------
// 封筒の鍵は room secret ではなく vault key から派生する。vault key はサーバーへ
// 一度も送られず、引き継ぎコードだけで運ぶ。既に配布済みの2要素コードは無効にしない。
const credentialContext = {
  crypto: globalThis.crypto,
  String,
  Number,
  Array,
  Boolean,
  Object,
  Math,
  RegExp,
  SYNC_V2_NATIVE_PROVENANCE: "native",
};
vm.runInNewContext(
  [
    "generateRandomHex",
    "generateVaultKey",
    "generateV2Credential",
    "normalizeV2Credential",
    "v2TransferCode",
    "parseV2TransferCode",
  ]
    .map(extractFunction)
    .join("\n"),
  credentialContext,
);

const {
  generateVaultKey,
  generateV2Credential,
  normalizeV2Credential,
  v2TransferCode,
  parseV2TransferCode,
} = credentialContext;

// G2d: 既にパスワードマネージャへ保存されている2要素コードが無効にならないこと。
test("2要素の旧い引き継ぎコードは今までどおり解析できる", () => {
  const code = `wr_${"a".repeat(32)}.wk_${"b".repeat(60)}`;
  const parsed = parseV2TransferCode(code);
  assert.ok(parsed, "旧コードが解析できること");
  assert.equal(parsed.roomId, `wr_${"a".repeat(32)}`);
  assert.equal(parsed.secret, `wk_${"b".repeat(60)}`);
  assert.equal(parsed.vaultKey, undefined, "vault keyは付かないこと");
});

// G2e
test("3要素コードは vault key ごと解析でき、往復して一致する", () => {
  const vaultKey = `wv_${"c".repeat(64)}`;
  const code = `wr_${"a".repeat(32)}.wk_${"b".repeat(60)}.${vaultKey}`;
  const parsed = parseV2TransferCode(code);
  assert.equal(parsed.vaultKey, vaultKey);
  assert.equal(v2TransferCode({ ...parsed, status: "active" }), code, "文字列化して往復すること");
});

test("壊れた vault key を含むコードは受理しない", () => {
  const base = `wr_${"a".repeat(32)}.wk_${"b".repeat(60)}`;
  for (const bad of [
    `${base}.wv_${"c".repeat(63)}`,
    `${base}.wv_${"c".repeat(65)}`,
    `${base}.wv_${"C".repeat(64)}`,
    `${base}.wx_${"c".repeat(64)}`,
    `${base}.${"c".repeat(64)}`,
    `${base}.wv_${"c".repeat(64)}.extra`,
  ]) {
    assert.equal(parseV2TransferCode(bad), null, bad.slice(-24));
  }
});

test("新しい資格情報は vault key を持ち、形式が正しい", () => {
  const credential = generateV2Credential("", "create");
  assert.match(credential.vaultKey, /^wv_[0-9a-f]{64}$/);
  assert.notEqual(credential.vaultKey, credential.secret);
  assert.match(v2TransferCode({ ...credential, status: "active" }), /^wr_[0-9a-f]{32}\.wk_[0-9a-f]{60}\.wv_[0-9a-f]{64}$/);
});

test("vault key は毎回異なる", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const key = generateVaultKey();
    assert.ok(!seen.has(key), "vault keyが重複しないこと");
    seen.add(key);
  }
});

// 既存ユーザーの保存内容を1バイトも変えないこと。ここが崩れると、
// 既に保存されている資格情報が書き換わって同期経路に波及する。
test("vault key を持たない既存の資格情報には、フィールドを足さない", () => {
  const stored = {
    v: 2,
    status: "active",
    roomId: `wr_${"a".repeat(32)}`,
    secret: `wk_${"b".repeat(60)}`,
    origin: "create",
  };
  const normalized = normalizeV2Credential(stored);
  assert.deepEqual(Object.keys(normalized).sort(), ["origin", "roomId", "secret", "status", "v"]);
  assert.ok(!("vaultKey" in normalized), "vaultKeyキー自体が生えないこと");
  assert.equal(JSON.stringify(normalized), JSON.stringify(stored), "保存内容が不変であること");
});

test("不正な vault key は保持せず、資格情報そのものは有効なままにする", () => {
  for (const bad of ["", "wv_short", `wk_${"b".repeat(60)}`, 123, null, {}]) {
    const normalized = normalizeV2Credential({
      v: 2,
      status: "active",
      roomId: `wr_${"a".repeat(32)}`,
      secret: `wk_${"b".repeat(60)}`,
      origin: "",
      vaultKey: bad,
    });
    assert.ok(normalized, "資格情報自体は有効なままであること");
    assert.ok(!("vaultKey" in normalized), `不正な vault key を保持しないこと: ${String(bad)}`);
  }
});

// G2c: vault key がサーバーへ渡る経路に混ざらないこと（静的な検査）。
// 実際の送信本文まで含めた検査は B-2 側で行う。
test("vault key は同期stateの組み立てに現れない", () => {
  const payloadSource = extractFunction("buildSyncPayloadState");
  assert.ok(!payloadSource.includes("vaultKey"), "送信stateの組み立てに vaultKey が出ないこと");
  const headerSource = extractFunction("syncHeaders");
  assert.ok(!headerSource.includes("vaultKey"), "リクエストヘッダに vaultKey が出ないこと");
});

test("封筒の鍵は room secret からは導けない（vault key が必要）", async () => {
  const roomId = `wr_${"1".repeat(32)}`;
  const secret = `wk_${"2".repeat(60)}`;
  const vaultKey = `wv_${"3".repeat(64)}`;
  const envelope = await sealAiSecrets(roomId, vaultKey, keySet());
  assert.ok(envelope, "vault keyで封筒が作れること");
  assert.equal(
    await openAiSecrets(roomId, secret, envelope),
    null,
    "room secret では開けないこと",
  );
});
