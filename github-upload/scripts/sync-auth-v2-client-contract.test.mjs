import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(scriptDir, "..", "publish", "index.html"), "utf8");

function routingFunctionsSource() {
  const start = html.indexOf("function normalizeV2Credential");
  const end = html.indexOf("// キー切替で無効になった同期応答", start);
  assert.ok(start >= 0, "V2資格情報関数が見つかること");
  assert.ok(end > start, "同期経路関数の終端が見つかること");
  return html.slice(start, end);
}

function evaluateRoutes() {
  const storage = new Map();
  const context = {
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    syncState: {
      id: "legacy-room_42",
      accessKey: "legacy-access-key",
    },
    SYNC_V2_CREDENTIAL_KEY: "wordsnap-sync-credential:v2",
  };
  vm.runInNewContext(
    `${routingFunctionsSource()}
      globalThis.__before = {
        route: syncRequestRoute(),
        headers: syncHeaders(),
      };
      localStorage.setItem(SYNC_V2_CREDENTIAL_KEY, JSON.stringify({
        v: 2,
        status: "pending",
        roomId: "wr_${"1".repeat(32)}",
        secret: "wk_${"a".repeat(60)}",
      }));
      globalThis.__pending = {
        route: syncRequestRoute(),
        headers: syncHeaders(),
      };
      localStorage.setItem(SYNC_V2_CREDENTIAL_KEY, JSON.stringify({
        v: 2,
        status: "active",
        roomId: "wr_${"2".repeat(32)}",
        secret: "wk_${"b".repeat(60)}",
      }));
      globalThis.__active = {
        route: syncRequestRoute(),
        headers: syncHeaders(),
      };`,
    context,
  );
  return context;
}

test("pendingのV2資格情報を保存してもlegacyのsyncパラメータ集合と値は不変", () => {
  const result = evaluateRoutes();
  assert.equal(result.__before.route.endpoint, "/api/wordsnap-state?sync=legacy-room_42");
  assert.equal(result.__pending.route.endpoint, result.__before.route.endpoint);
  assert.equal(result.__pending.route.expectedSyncId, "legacy-room_42");
  assert.equal(result.__pending.route.isV2, false);
  assert.deepEqual(
    [...new URL(result.__pending.route.endpoint, "https://wordbank.example").searchParams.entries()],
    [["sync", "legacy-room_42"]],
  );
  assert.deepEqual(
    { ...result.__pending.headers },
    { "Content-Type": "application/json", "x-room-key": "legacy-access-key" },
  );
});

test("activeのV2資格情報はroomとヘッダだけを使いsync・wへ流さない", () => {
  const result = evaluateRoutes();
  const url = new URL(result.__active.route.endpoint, "https://wordbank.example");
  assert.deepEqual([...url.searchParams.keys()], ["room"]);
  assert.equal(url.searchParams.get("room"), `wr_${"2".repeat(32)}`);
  assert.equal(url.searchParams.has("sync"), false);
  assert.equal(url.searchParams.has("w"), false);
  assert.equal(result.__active.route.expectedSyncId, `wr_${"2".repeat(32)}`);
  assert.equal(result.__active.headers["x-room-key"], `wk_${"b".repeat(60)}`);
});

test("roomIdとsecretはgetRandomValuesから指定ビット長で生成する", () => {
  const result = evaluateRoutes();
  const requestedByteLengths = [];
  result.crypto = {
    getRandomValues(bytes) {
      requestedByteLengths.push(bytes.length);
      bytes.forEach((_, index) => {
        bytes[index] = (index + requestedByteLengths.length) % 256;
      });
      return bytes;
    },
  };
  const credential = result.generateV2Credential();
  assert.deepEqual(Object.keys(credential), ["v", "status", "roomId", "secret", "origin"]);
  assert.equal(credential.v, 2);
  assert.equal(credential.status, "pending");
  assert.equal(credential.origin, "");
  assert.match(credential.roomId, /^wr_[0-9a-f]{32}$/);
  assert.match(credential.secret, /^wk_[0-9a-f]{60}$/);
  assert.deepEqual(requestedByteLengths, [30, 16]);
});

test("origin追加前のV2資格情報も有効で、不明として安全側へ正規化する", () => {
  const result = evaluateRoutes();
  const base = {
    v: 2,
    status: "active",
    roomId: `wr_${"3".repeat(32)}`,
    secret: `wk_${"c".repeat(60)}`,
  };
  assert.deepEqual(
    { ...result.normalizeV2Credential(base) },
    { ...base, origin: "" },
  );
  assert.equal(result.normalizeV2Credential({ ...base, origin: "upgrade" }).origin, "upgrade");
  assert.equal(result.normalizeV2Credential({ ...base, origin: "create" }).origin, "create");
  assert.equal(result.normalizeV2Credential({ ...base, origin: "invalid" }).origin, "");
});

test("IndexedDB復元は既存localStorage資格情報を最優先し上書きしない", async () => {
  const storage = new Map();
  const local = {
    v: 2,
    status: "active",
    roomId: `wr_${"4".repeat(32)}`,
    secret: `wk_${"d".repeat(60)}`,
    origin: "create",
  };
  const durable = {
    v: 2,
    status: "active",
    roomId: `wr_${"5".repeat(32)}`,
    secret: `wk_${"e".repeat(60)}`,
    origin: "upgrade",
  };
  storage.set("wordsnap-sync-credential:v2", JSON.stringify(local));
  let getCalls = 0;
  const context = {
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    idb: {
      async get() {
        getCalls += 1;
        return JSON.stringify(durable);
      },
      async set() {
        return true;
      },
      async delete() {
        return true;
      },
    },
    syncState: { id: "", accessKey: "" },
    SYNC_V2_CREDENTIAL_KEY: "wordsnap-sync-credential:v2",
  };
  vm.runInNewContext(routingFunctionsSource(), context);
  const restored = await context.recoverV2CredentialFromIdb();
  assert.equal(restored, false);
  assert.equal(getCalls, 0);
  assert.deepEqual(JSON.parse(storage.get("wordsnap-sync-credential:v2")), local);
});

test("active資格情報の書き込みだけを既存IndexedDBの専用キーへ自動退避する", () => {
  const result = evaluateRoutes();
  const backups = [];
  result.idb = {
    set(key, value) {
      backups.push([key, JSON.parse(value)]);
      return Promise.resolve(true);
    },
  };
  const base = {
    v: 2,
    roomId: `wr_${"6".repeat(32)}`,
    secret: `wk_${"f".repeat(60)}`,
    origin: "upgrade",
  };
  result.writeV2Credential({ ...base, status: "pending" });
  assert.equal(backups.length, 0);
  result.writeV2Credential({ ...base, status: "active" });
  assert.equal(backups.length, 1);
  assert.equal(backups[0][0], "wordsnap-sync-credential:v2");
  assert.deepEqual(backups[0][1], { ...base, status: "active" });
});

test("JSONへの引き継ぎコード同梱はチェックボックスも処理も既定OFF", () => {
  assert.match(
    html,
    /<label id="exportV2CredentialOption" class="settings-check" hidden>[\s\S]*?<input id="exportV2CredentialToggle" type="checkbox" \/>/,
  );
  assert.doesNotMatch(
    html,
    /<input id="exportV2CredentialToggle"[^>]*\schecked(?:\s|>|=)/,
  );
  assert.match(html, /function buildJsonBackupPayload\(includeV2Credential = false\)/);
  assert.match(
    html,
    /const includeV2Credential = elements\.exportV2CredentialToggle\?\.checked === true;/,
  );
});

test("V2合流後のインラインUndoは既存undoButtonハンドラを呼び二重実装しない", () => {
  assert.match(
    html,
    /elements\.syncV2UndoButton\?\.addEventListener\("click", \(\) => \{[\s\S]*?elements\.undoButton\?\.click\(\);[\s\S]*?\}\);/,
  );
  assert.equal(
    (html.match(/elements\.undoButton\.addEventListener\("click", performUndo\);/g) || []).length,
    1,
  );
  assert.doesNotMatch(
    html,
    /elements\.syncV2UndoButton\?\.addEventListener\("click", performUndo\)/,
  );
});

test("normalizeStateはJSONのsyncCredentialV2を学習stateへ取り込まない", () => {
  const start = html.indexOf("function normalizeState(state)");
  const end = html.indexOf("function normalizeWord(word)", start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(html.slice(start, end), /syncCredentialV2/);
});

test("JSON資格情報は取得済みremote stateを既存マージで保全してからactive化する", () => {
  const start = html.indexOf("async function connectImportedV2Credential");
  const end = html.indexOf("elements.importJsonInput.addEventListener", start);
  assert.ok(start >= 0 && end > start);
  const source = html.slice(start, end);
  const mergeAt = source.indexOf("mergeAppStates(appState, normalizedRemote");
  const activateAt = source.indexOf("activateV2Credential(credential, data.stateRev)");
  assert.ok(mergeAt >= 0, "既存mergeAppStatesを使うこと");
  assert.ok(activateAt > mergeAt, "remote stateのマージ後にactive化すること");
  assert.match(source, /applyMergedRemoteState\([\s\S]*?sync: false,/);
  assert.match(source, /if \(needsPush\) await pushWordsnapState\(\);/);
});

test("upgradeだけは明示したlegacy IDをsyncへ送り、V2値はbodyとヘッダに分離する", () => {
  assert.match(
    html,
    /v2Fetch\(`\$\{legacySyncEndpoint\(syncState\.id\)\}&op=upgrade`,\s*\{/,
  );
  assert.match(html, /"x-room-key": credential\.secret/);
  assert.match(html, /body: JSON\.stringify\(\{ roomId: credential\.roomId \}\)/);
});

test("V2の強制上書きと復元送信はforce指定を通す", () => {
  const forceCalls = html.match(/syncPutState\(null, \{ force: true \}\)/g) || [];
  assert.equal(forceCalls.length, 2);
  assert.match(
    html,
    /if \(isV2Route && requestOptions\.force === true\) \{\s*endpoint \+= "&force=1";/,
  );
});

// ---------------------------------------------------------------------------
// 段階1（同期identity抽象化）の凍結ゲート
//
// 今日到達可能な同期状態は次の3つだけで、いずれも legacyキーを持つ:
//   1. legacyのみ
//   2. legacy + V2 pending
//   3. legacy + V2 active（upgrade / join 済み）
// identityリファクタは「この3状態の出力を1文字も変えない」ことが成立条件。
// 下の凍結スナップショットが1バイトでも動いたらリファクタが挙動を変えている。
//
// 「legacyなしのV2」は現時点で生成経路が存在しない状態であり、ここには含めない
// （段階2以降で別途テストを足す）。
// ---------------------------------------------------------------------------
test("到達可能な3状態の同期経路が凍結スナップショットと完全一致する", () => {
  const result = evaluateRoutes();
  const snapshot = (captured) => ({
    endpoint: captured.route.endpoint,
    expectedSyncId: captured.route.expectedSyncId,
    isV2: captured.route.isV2,
    secret: captured.route.secret,
    headers: { ...captured.headers },
  });

  assert.deepEqual(snapshot(result.__before), {
    endpoint: "/api/wordsnap-state?sync=legacy-room_42",
    expectedSyncId: "legacy-room_42",
    isV2: false,
    secret: "legacy-access-key",
    headers: {
      "Content-Type": "application/json",
      "x-room-key": "legacy-access-key",
    },
  }, "状態1（legacyのみ）");

  assert.deepEqual(snapshot(result.__pending), {
    endpoint: "/api/wordsnap-state?sync=legacy-room_42",
    expectedSyncId: "legacy-room_42",
    isV2: false,
    secret: "legacy-access-key",
    headers: {
      "Content-Type": "application/json",
      "x-room-key": "legacy-access-key",
    },
  }, "状態2（legacy + V2 pending）: pendingは通信経路を切り替えない");

  assert.deepEqual(snapshot(result.__active), {
    endpoint: `/api/wordsnap-state?room=wr_${"2".repeat(32)}`,
    expectedSyncId: `wr_${"2".repeat(32)}`,
    isV2: true,
    secret: `wk_${"b".repeat(60)}`,
    headers: {
      "Content-Type": "application/json",
      "x-room-key": `wk_${"b".repeat(60)}`,
    },
  }, "状態3（legacy + V2 active）: room経路とヘッダのみを使う");
});

// 段階1の事後条件: 通信identityは syncRequestRoute に集約し、
// legacyキーの保持に必要な代入以外では syncState.id を直読しない。
test("syncState.id の読み取りは同期identity関数の外に存在しない", () => {
  const scheduleStart = html.indexOf("function scheduleSyncPush");
  const scheduleEnd = html.indexOf("function flushPendingSyncPush", scheduleStart);
  assert.ok(scheduleStart >= 0 && scheduleEnd > scheduleStart, "scheduleSyncPush が見つかること");
  assert.doesNotMatch(
    html.slice(scheduleStart, scheduleEnd),
    /syncState\.id/,
    "scheduleSyncPush が syncState.id を参照しないこと",
  );

  const identityStart = html.indexOf("function syncRequestRoute");
  const identityEnd = html.indexOf("function syncEndpoint", identityStart);
  assert.ok(identityStart >= 0 && identityEnd > identityStart, "syncRequestRoute が見つかること");
  const outsideIdentity =
    html.slice(0, identityStart) +
    html.slice(identityEnd);
  assert.doesNotMatch(
    outsideIdentity,
    /syncState\.id(?!\s*=(?!=))/,
    "syncState.id の読み取りが syncRequestRoute の外に無いこと",
  );
});
