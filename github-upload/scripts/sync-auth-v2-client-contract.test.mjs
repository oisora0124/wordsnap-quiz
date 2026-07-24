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
  assert.deepEqual(Object.keys(credential), ["v", "status", "roomId", "secret"]);
  assert.equal(credential.v, 2);
  assert.equal(credential.status, "pending");
  assert.match(credential.roomId, /^wr_[0-9a-f]{32}$/);
  assert.match(credential.secret, /^wk_[0-9a-f]{60}$/);
  assert.deepEqual(requestedByteLengths, [30, 16]);
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
