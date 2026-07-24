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

function startupDecisionSource() {
  const start = html.indexOf("function syncStartupIdentityDecision");
  const end = html.indexOf("\nfunction initWordsnapSync", start);
  assert.ok(start >= 0, "起動時identity判定関数が見つかること");
  assert.ok(end > start, "起動時identity判定関数の終端が見つかること");
  return html.slice(start, end);
}

function retireNativeCredentialSource() {
  const start = html.indexOf("async function retireNativeV2Credential");
  const end = html.indexOf("\n// 【他人の共有リンク対策】", start);
  assert.ok(start >= 0, "V2ネイティブ資格情報の退役関数が見つかること");
  assert.ok(end > start, "V2ネイティブ資格情報の退役関数の終端が見つかること");
  return html.slice(start, end);
}

function checkedPersistenceSource() {
  const start = html.indexOf("async function persistAppStateChecked");
  const end = html.indexOf("\nfunction defaultState", start);
  assert.ok(start >= 0, "identity切替用の保存確認関数が見つかること");
  assert.ok(end > start, "identity切替用の保存確認関数の終端が見つかること");
  return html.slice(start, end);
}

function evaluateStartupDecision(identity, idFromUrl = "", storedSyncId = "") {
  const context = {};
  vm.runInNewContext(
    `${startupDecisionSource()}
     globalThis.__decision = syncStartupIdentityDecision(
       ${JSON.stringify(identity)},
       ${JSON.stringify(idFromUrl)},
       ${JSON.stringify(storedSyncId)}
     );`,
    context,
  );
  return { ...context.__decision };
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
    SYNC_V2_NATIVE_PROVENANCE: "native-default:v1",
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
      };
      syncState.id = "";
      localStorage.setItem(SYNC_V2_CREDENTIAL_KEY, JSON.stringify({
        v: 2,
        status: "active",
        roomId: "wr_${"7".repeat(32)}",
        secret: "wk_${"7".repeat(60)}",
        origin: "create",
        provenance: SYNC_V2_NATIVE_PROVENANCE,
      }));
      globalThis.__native = {
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

test("V2ネイティブ専用印だけを保持し、既存資格情報へはフィールドを追加しない", () => {
  const result = evaluateRoutes();
  const base = {
    v: 2,
    status: "active",
    roomId: `wr_${"8".repeat(32)}`,
    secret: `wk_${"8".repeat(60)}`,
    origin: "create",
  };
  assert.deepEqual(
    Object.keys(result.normalizeV2Credential(base)),
    ["v", "status", "roomId", "secret", "origin"],
    "印のない既存資格情報のキー集合を変えないこと",
  );
  assert.equal(
    result.normalizeV2Credential({
      ...base,
      provenance: "native-default:v1",
    }).provenance,
    "native-default:v1",
  );
  for (const invalid of ["", "create", "native-default:v2", true]) {
    assert.equal(
      Object.hasOwn(result.normalizeV2Credential({ ...base, provenance: invalid }), "provenance"),
      false,
      `未知の印 ${String(invalid)} を保持しないこと`,
    );
  }
  const generateStart = html.indexOf("function generateV2Credential");
  const generateEnd = html.indexOf("\nfunction v2TransferCode", generateStart);
  assert.ok(generateStart >= 0 && generateEnd > generateStart);
  assert.doesNotMatch(
    html.slice(generateStart, generateEnd),
    /provenance|SYNC_V2_NATIVE_PROVENANCE/,
    "段階2ではV2ネイティブ印を新規生成しないこと",
  );
});

test("legacyを持たない専用印付きactive資格情報だけをV2ネイティブidentityにする", () => {
  const result = evaluateRoutes();
  assert.equal(result.__native.route.isV2Native, true);
  assert.equal(result.__native.route.legacyId, "");
  assert.equal(result.__native.route.expectedSyncId, `wr_${"7".repeat(32)}`);
  assert.equal(result.__native.route.endpoint, `/api/wordsnap-state?room=wr_${"7".repeat(32)}`);

  const originOnly = {
    v: 2,
    status: "active",
    roomId: `wr_${"9".repeat(32)}`,
    secret: `wk_${"9".repeat(60)}`,
    origin: "create",
  };
  result.localStorage.setItem("wordsnap-sync-credential:v2", JSON.stringify(originOnly));
  assert.equal(
    result.syncRequestRoute().isV2Native,
    false,
    "既存Phase 1のorigin:createだけではネイティブ扱いしないこと",
  );

  const switchedCredential = {
    v: 2,
    status: "pending",
    roomId: `wr_${"6".repeat(32)}`,
    secret: `wk_${"6".repeat(60)}`,
    origin: "",
  };
  assert.equal(
    result.preserveV2NativeProvenance(switchedCredential, result.__native.route).provenance,
    "native-default:v1",
    "V2ネイティブが別のV2 roomへ合流しても印を失わないこと",
  );
  assert.equal(
    Object.hasOwn(
      result.preserveV2NativeProvenance(switchedCredential, result.__active.route),
      "provenance",
    ),
    false,
    "既存legacy+V2の合流へ印を付けないこと",
  );
  assert.match(
    html,
    /function activateV2Credential\(credential, stateRev\) \{\s*const credentialWithProvenance = preserveV2NativeProvenance\(credential\);/,
    "全V2 active化経路が印の継承境界を通ること",
  );
});

test("V2ネイティブはlegacy自動生成を抑止し、任意の?w=を必ず確認待ちにする", () => {
  const identity = evaluateRoutes().__native.route;
  const noUrl = evaluateStartupDecision(identity);
  assert.equal(noUrl.shouldAutoGenerateLegacy, false);
  assert.equal(noUrl.foreignSyncId, "");
  assert.equal(noUrl.legacyId, "");

  const openedLegacy = "ws_foreign-native-link";
  const withUrl = evaluateStartupDecision(identity, openedLegacy, "");
  assert.equal(withUrl.shouldAutoGenerateLegacy, false);
  assert.equal(withUrl.foreignSyncId, openedLegacy);
  assert.equal(withUrl.shouldStoreUrlId, false);
  assert.equal(withUrl.legacyId, "");
});

test("既存3状態はlegacy生成抑止も同一?w=への追加確認も起こさない", () => {
  const result = evaluateRoutes();
  for (const [label, captured] of [
    ["legacyのみ", result.__before],
    ["legacy+V2 pending", result.__pending],
    ["legacy+V2 active", result.__active],
  ]) {
    assert.equal(captured.route.isV2Native, false, label);
    const decision = evaluateStartupDecision(
      captured.route,
      "legacy-room_42",
      "legacy-room_42",
    );
    assert.equal(decision.shouldAutoGenerateLegacy, false, `${label}: legacyを再生成しない`);
    assert.equal(decision.foreignSyncId, "", `${label}: 同じ?w=は確認不要`);
    assert.equal(decision.legacyId, "legacy-room_42", `${label}: 従来legacyを維持`);
  }
});

test("V2ネイティブからlegacyへはIDB退役を確認した後だけlocal資格情報を削除する", async () => {
  const roomId = `wr_${"a".repeat(32)}`;
  const events = [];
  let active = true;
  const context = {
    SYNC_V2_CREDENTIAL_KEY: "wordsnap-sync-credential:v2",
    syncRequestRoute() {
      return { isV2Native: true, roomId };
    },
    idb: {
      async delete() {
        events.push("idb.delete");
        return true;
      },
      async get() {
        events.push("idb.get");
        return null;
      },
    },
    localStorage: {
      removeItem() {
        events.push("localStorage.removeItem");
        active = false;
      },
    },
    getActiveV2Credential() {
      return active ? { roomId } : null;
    },
  };
  vm.runInNewContext(retireNativeCredentialSource(), context);
  assert.equal(await context.retireNativeV2Credential(roomId), true);
  assert.deepEqual(events, ["idb.delete", "idb.get", "localStorage.removeItem"]);

  const failedEvents = [];
  context.idb.delete = async () => {
    failedEvents.push("idb.delete");
    return false;
  };
  context.localStorage.removeItem = () => failedEvents.push("localStorage.removeItem");
  assert.equal(await context.retireNativeV2Credential(roomId), false);
  assert.deepEqual(failedEvents, ["idb.delete"], "IDB退役失敗時はlocal資格情報を残すこと");
});

test("native切替先stateはlocalStorageかIndexedDBの保存成功をawaitして確定する", async () => {
  async function runCheckedPersistence({ localSucceeds, idbSucceeds }) {
    const warnings = [];
    const context = {
      appState: { deletions: [], trash: [], words: [], decks: [] },
      sanitizeDeletions(value) {
        return value;
      },
      sanitizeTrash(value) {
        return value;
      },
      storageWriteGeneration: 0,
      localStorage: {
        setItem() {
          if (!localSucceeds) throw new Error("local unavailable");
        },
      },
      STORAGE_KEY: "state",
      idb: {
        async set() {
          return idbSucceeds;
        },
      },
      showRuntimeStorageWarning(visible) {
        warnings.push(visible);
      },
      scheduleSyncPush() {
        throw new Error("sync:falseでは呼ばないこと");
      },
    };
    vm.runInNewContext(checkedPersistenceSource(), context);
    const saved = await context.persistAppStateChecked({ sync: false });
    return { saved, warnings };
  }

  assert.deepEqual(
    await runCheckedPersistence({ localSucceeds: true, idbSucceeds: false }),
    { saved: true, warnings: [false] },
    "localStorage成功なら確定できること",
  );
  assert.deepEqual(
    await runCheckedPersistence({ localSucceeds: false, idbSucceeds: true }),
    { saved: true, warnings: [false] },
    "IndexedDB成功なら確定できること",
  );
  assert.deepEqual(
    await runCheckedPersistence({ localSucceeds: false, idbSucceeds: false }),
    { saved: false, warnings: [true] },
    "両方失敗ならrollback可能なfalseを返すこと",
  );
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
    SYNC_V2_NATIVE_PROVENANCE: "native-default:v1",
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

test("V2ネイティブの文言とlegacy UIはidentityスナップショットだけで出し分ける", () => {
  const start = html.indexOf("function applySyncIdentityUi");
  const end = html.indexOf("\nasync function readJsonResponse", start);
  assert.ok(start >= 0 && end > start, "identity UI関数が見つかること");
  const source = html.slice(start, end);
  assert.match(source, /identity = syncRequestRoute\(\)/);
  assert.match(source, /Boolean\(identity\?\.isV2Native\)/);
  assert.match(source, /data-sync-identity-ui="legacy"/);
  assert.match(source, /data-sync-identity-ui="v2-native"/);

  assert.match(
    html,
    /<div class="sync-controls" data-sync-identity-ui="legacy">[\s\S]*?id="syncIdInput"[\s\S]*?id="syncKeyToggleButton"[\s\S]*?id="syncCopyLinkButton"[\s\S]*?id="syncPullButton"/,
    "個人キー入力・表示切替・個人リンクコピー・今すぐ読み込むをlegacy側へ閉じ込めること",
  );
  assert.match(
    html,
    /id="syncKeySecurityWarning"[\s\S]*?function updateSyncKeySecurityWarning[\s\S]*?syncRequestRoute\(\)\.isV2Native/,
    "旧形式キー警告をnativeで抑止すること",
  );
});

test("V2ネイティブの起動接続とforeign ?w=承諾は単一identityを維持する", () => {
  assert.match(
    html,
    /async function connectWordsnapSync\(options = \{\}\) \{[\s\S]*?syncRequestRoute\(\)\.isV2Native\) return connectV2NativeSync\(options\);/,
    "空のlegacy入力欄を通らずV2 routeで初回接続すること",
  );
  assert.match(
    html,
    /async function retireNativeV2Credential\(expectedRoomId\)[\s\S]*?await idb\.delete\(SYNC_V2_CREDENTIAL_KEY\)[\s\S]*?await idb\.get\(SYNC_V2_CREDENTIAL_KEY\)[\s\S]*?localStorage\.removeItem\(SYNC_V2_CREDENTIAL_KEY\)/,
    "IndexedDBとlocalStorageのV2資格情報を退役させること",
  );
  assert.match(
    html,
    /elements\.syncSwitchKeepButton\.disabled = true;[\s\S]*?await switchNativeV2ToForeignLegacy\(foreignId, retireRoomId\)[\s\S]*?elements\.syncSwitchKeepButton\.disabled = false;/,
    "V2退役中はKeep操作との競合を防ぐこと",
  );
  const switchStart = html.indexOf("async function switchNativeV2ToForeignLegacy");
  const switchEnd = html.indexOf("\n// 【他人の共有リンク対策】", switchStart);
  assert.ok(switchStart >= 0 && switchEnd > switchStart, "native専用legacy切替関数が見つかること");
  const switchSource = html.slice(switchStart, switchEnd);
  const preflightAt = switchSource.indexOf("loadForeignLegacyStateForNativeSwitch(foreignId)");
  const retireAt = switchSource.indexOf("retireNativeV2Credential(expectedRoomId)");
  const adoptAt = switchSource.indexOf("localStorage.setItem(SYNC_ID_KEY, foreignId)");
  assert.ok(preflightAt >= 0 && retireAt > preflightAt, "リンク先GET成功後にV2を退役すること");
  assert.ok(adoptAt > retireAt, "V2退役成功後だけlegacy identityを保存すること");
  assert.match(
    html,
    /async function loadForeignLegacyStateForNativeSwitch[\s\S]*?syncStateExceedsLimits\(data\.state\)/,
    "先行GETも共通の同期state件数上限を適用すること",
  );
  assert.match(
    switchSource,
    /const persisted = await persistAppStateChecked\(\{ sync: false \}\);\s*if \(!persisted\) throw/,
    "切替先stateを耐久保存できた場合だけ成功を確定すること",
  );
  assert.match(
    switchSource,
    /restoreNativeV2AfterFailedLegacySwitch\([\s\S]*?credential,[\s\S]*?previousRev,[\s\S]*?previousSnapshot/,
    "適用失敗時は元のV2資格情報とローカルstateを復元すること",
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
