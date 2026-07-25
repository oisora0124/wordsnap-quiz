// Phase 2 段階3の凍結ゲート。
// 目的: 「保存された資格情報が無い＝新規ユーザー」という判定を、IndexedDBからの復元が
// 確定する前に行わせないこと。4秒フォールバックはその確定を待たずに同期を開始するため、
// バリアが settled になるまではV2ネイティブ資格情報の発行を一切許してはならない。
// このファイルは段階5まで編集しない（実装側を直す。テストを緩めない）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(scriptDir, "..", "publish", "index.html"), "utf8");

const CREDENTIAL_KEY = "wordsnap-sync-credential:v2";

function barrierSource() {
  const start = html.indexOf("let v2RecoveryBarrierState");
  const end = html.indexOf("\n// Hardens data against eviction", start);
  assert.ok(start >= 0, "起動バリアの定義が見つかること");
  assert.ok(end > start, "起動バリアの終端が見つかること");
  return html.slice(start, end);
}

function recoverPersistedSource() {
  const start = html.indexOf("async function recoverPersisted");
  const end = html.indexOf("\n// 学習・努力にまつわる偉人の名言", start);
  assert.ok(start >= 0, "復元関数が見つかること");
  assert.ok(end > start, "復元関数の終端が見つかること");
  return html.slice(start, end);
}

function idbHelperSource() {
  const start = html.indexOf("const idb = {");
  const end = html.indexOf("\nlet storageWriteGeneration", start);
  assert.ok(start >= 0, "idbヘルパが見つかること");
  assert.ok(end > start, "idbヘルパの終端が見つかること");
  return html.slice(start, end);
}

// バリアだけを切り出して評価する。idb / recoverV2CredentialFromIdb は差し替え可能にし、
// 遅延・失敗を注入できるようにする。
// 注意: 実際の idb.get は失敗も null に畳んで例外を投げない。したがってバリアの
// 「読めなかった」判定は getChecked の成否だけに依存していなければならない。
// このスタブも同じ性質（get は投げない）にしてある。
function makeBarrier({ localCredential = null, probeOk = true, probePresent = false, probeValue = null, recover } = {}) {
  const store = new Map();
  if (localCredential !== null) store.set(CREDENTIAL_KEY, localCredential);
  const calls = { idbGet: 0, probe: 0, recover: 0 };
  const context = {
    SYNC_V2_CREDENTIAL_KEY: CREDENTIAL_KEY,
    localStorage: {
      getItem(key) {
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        store.set(key, String(value));
      },
      removeItem(key) {
        store.delete(key);
      },
    },
    idb: {
      // 実装と同じく、失敗しても例外を投げず null を返す
      async get() {
        calls.idbGet += 1;
        return null;
      },
      async getChecked() {
        calls.probe += 1;
        return { ok: probeOk, present: probePresent, value: probeValue };
      },
    },
    async recoverV2CredentialFromIdb() {
      calls.recover += 1;
      return recover ? await recover() : false;
    },
  };
  vm.runInNewContext(barrierSource(), context);
  return { context, calls, store };
}


// getChecked が解決しない実装だと、テストは落ちずにハングしてしまう（CIで最悪の失敗モード）。
// 期限を付けて「解決しないこと」自体を失敗として扱う。
async function getCheckedWithin(idbLike, key, ms = 1000) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("__timeout__"), ms);
  });
  const result = await Promise.race([idbLike.getChecked(key), timeout]);
  clearTimeout(timer);
  assert.notEqual(result, "__timeout__", "getCheckedが解決しない（Promiseが宙に浮いている）");
  return result;
}

test("復元が確定するまではV2ネイティブ発行を許さない（4秒フォールバックの状態）", () => {
  const { context } = makeBarrier();
  assert.equal(context.v2RecoveryBarrierStatus(), "pending");
  assert.equal(context.v2NativeIssueAllowed(), false);
});

test("IndexedDBを実際に読めて耐久コピーが無いと分かったときだけ発行を許す", async () => {
  const { context, calls } = makeBarrier();
  const restored = await context.settleV2RecoveryFromIdb();
  assert.equal(restored, false);
  assert.equal(context.v2RecoveryBarrierStatus(), "settled");
  assert.equal(context.v2NativeIssueAllowed(), true);
  // 復元されなかった場合は、IndexedDBが本当に読めたのかを成否付きで確かめてから確定させる
  assert.equal(calls.probe, 1, "getCheckedで耐久コピーの可読性を確認していること");
});

test("耐久コピーから復元できた人も発行対象外として閉じ、余計な確認読みをしない", async () => {
  const { context, calls } = makeBarrier({ recover: async () => true });
  const restored = await context.settleV2RecoveryFromIdb();
  assert.equal(restored, true);
  assert.equal(context.v2RecoveryBarrierStatus(), "inconclusive");
  assert.equal(context.v2NativeIssueAllowed(), false);
  assert.equal(calls.probe, 0);
});

test("すでに資格情報を持つ人は発行対象外として閉じ、確認読みもしない（既存V2ユーザー）", async () => {
  const { context, calls } = makeBarrier({ localCredential: '{"v":2,"status":"active"}' });
  await context.settleV2RecoveryFromIdb();
  assert.equal(context.v2RecoveryBarrierStatus(), "inconclusive");
  assert.equal(context.v2NativeIssueAllowed(), false);
  assert.equal(calls.probe, 0, "既存ユーザーへIndexedDB読み取りを増やさないこと");
});

test("障害注入: IndexedDBが読めないときは確定させず発行も許さない", async () => {
  const { context } = makeBarrier({ probeOk: false });
  const restored = await context.settleV2RecoveryFromIdb();
  assert.equal(restored, false);
  assert.equal(context.v2RecoveryBarrierStatus(), "inconclusive");
  assert.equal(context.v2NativeIssueAllowed(), false);
});

// 実装が idb.get の例外に依存していたら、実ブラウザでは inconclusive に到達できない
// （実際の get は open失敗もトランザクション失敗も null に畳んで投げない）。
// 本物のヘルパを壊れた indexedDB の上で動かし、成否が正しく出ることを確かめる。
test("本物のidbヘルパは、読めなかったことをgetCheckedで報告する", async () => {
  for (const [name, indexedDBStub] of [
    ["openが例外", { open() { throw new Error("blocked"); } }],
    [
      "openがonerror",
      {
        open() {
          const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: null };
          queueMicrotask(() => req.onerror && req.onerror());
          return req;
        },
      },
    ],
  ]) {
    const context = { indexedDB: indexedDBStub, queueMicrotask, Promise };
    vm.runInNewContext(`${idbHelperSource()}\nglobalThis.__idb = idb;`, context);
    assert.equal(await context.__idb.get(CREDENTIAL_KEY), null, `${name}: getはnullに畳む`);
    const probe = await context.__idb.getChecked(CREDENTIAL_KEY);
    assert.equal(probe.ok, false, `${name}: getCheckedは読めなかったと報告する`);
  }
});

test("本物のidbヘルパは、読めて値が無い場合をokかつnullで返す", async () => {
  const context = {
    indexedDB: {
      open() {
        const req = { onsuccess: null, onerror: null, onupgradeneeded: null };
        req.result = {
          transaction: () => ({
            objectStore: () => ({
              count() {
                const r = { onsuccess: null, onerror: null, result: 0 };
                queueMicrotask(() => r.onsuccess && r.onsuccess());
                return r;
              },
              get() {
                const r = { onsuccess: null, onerror: null, result: undefined };
                queueMicrotask(() => r.onsuccess && r.onsuccess());
                return r;
              },
            }),
          }),
        };
        queueMicrotask(() => req.onsuccess && req.onsuccess());
        return req;
      },
    },
    queueMicrotask,
    Number,
    Promise,
  };
  vm.runInNewContext(`${idbHelperSource()}\nglobalThis.__idb = idb;`, context);
  // vmは別realmのため、オブジェクトそのものではなく値で比較する
  const probe = await context.__idb.getChecked(CREDENTIAL_KEY);
  assert.equal(probe.ok, true);
  assert.equal(probe.value, null);
});

test("障害注入: 復元関数自体が投げてもバリアはinconclusiveで閉じる", async () => {
  const { context } = makeBarrier({
    recover: async () => {
      throw new Error("recover failed");
    },
  });
  await context.settleV2RecoveryFromIdb();
  assert.equal(context.v2RecoveryBarrierStatus(), "inconclusive");
  assert.equal(context.v2NativeIssueAllowed(), false);
});

test("障害注入: IndexedDBが遅い間はpendingのままで、確定してから初めて許可へ変わる", async () => {
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { context } = makeBarrier({
    recover: async () => {
      await gate;
      return false;
    },
  });
  const pending = context.settleV2RecoveryFromIdb();
  // 遅延中に「新規ユーザー」判定が走っても、発行は許されない
  assert.equal(context.v2RecoveryBarrierStatus(), "pending");
  assert.equal(context.v2NativeIssueAllowed(), false);
  release();
  await pending;
  assert.equal(context.v2RecoveryBarrierStatus(), "settled");
  assert.equal(context.v2NativeIssueAllowed(), true);
});

test("バリアは単調で、一度閉じた確定は後から覆らない", async () => {
  const { context } = makeBarrier({ probeOk: false });
  await context.settleV2RecoveryFromIdb();
  assert.equal(context.v2RecoveryBarrierStatus(), "inconclusive");
  context.settleV2RecoveryBarrier("settled");
  assert.equal(context.v2RecoveryBarrierStatus(), "inconclusive", "unreadableをsettledへ戻さない");
  assert.equal(context.v2NativeIssueAllowed(), false);
});

test("既知でない確定要求は安全側（inconclusive）へ倒す", () => {
  const { context } = makeBarrier();
  context.settleV2RecoveryBarrier("done");
  assert.equal(context.v2RecoveryBarrierStatus(), "inconclusive");
  assert.equal(context.v2NativeIssueAllowed(), false);
});

test("recoverPersistedはバリア経由で復元し、素の復元関数を直接呼ばない", () => {
  const body = recoverPersistedSource();
  assert.match(
    body,
    /v2CredentialRecoveredFromIdb = await settleV2RecoveryFromIdb\(\)/,
    "復元はバリア経由で行うこと",
  );
  assert.doesNotMatch(
    body,
    /await recoverV2CredentialFromIdb\(/,
    "バリアを迂回する直接呼び出しを残さないこと",
  );
});

test("4秒フォールバックは復元完了を待たない前提が維持されている", () => {
  // この前提が消えるとバリア自体が不要になるため、前提ごと凍結する
  assert.match(html, /window\.setTimeout\(startWordsnapSync, 4000\)/);
  assert.match(html, /recoverPersisted\(\)\s*\n\s*\.then\(/);
});

// 段階5-3bで発行経路が生えた。バリアの意味は「発行してよいかの唯一の判定」なので、
// 番兵の役割は「経路が無いこと」から「経路が必ずバリアを通ること」へ移る。
test("V2ネイティブの発行は、必ず回復バリアの確定を通ってから行われる", () => {
  const issue = html.slice(
    html.indexOf("async function issueV2NativeCredential"),
    html.indexOf("async function bootstrapNewUserIdentity"),
  );
  assert.ok(issue.length > 0, "発行関数が見つかること");
  const gate = issue.indexOf("v2NativeIssueAllowed()");
  assert.ok(gate >= 0, "バリアを見ること");
  // ネットワークにも資格情報の保存にも、バリアより先に触れないこと
  for (const needle of ["writeV2Credential", "v2Fetch", "acquireIdentityClaim"]) {
    assert.ok(issue.indexOf(needle) > gate, `${needle} はバリアより後であること`);
  }
  // 発行リクエストの組み立ては1か所だけ（別経路でバリアを迂回させない）
  assert.equal((html.match(/create=1&native=1/g) || []).length, 1);
  // ネイティブ印を付ける場所は2つだけ。マジックな参照数ではなく、書き込み側を直接数える。
  //   ・preserveV2NativeProvenance … 既にネイティブなら印を保つ
  //   ・issueV2NativeCredential    … 自動発行のときに印を付ける（段階5-3b）
  // ここが増えたら、バリアを通らない別の生成経路が生えている。
  assert.equal(
    (html.match(/provenance: SYNC_V2_NATIVE_PROVENANCE/g) || []).length,
    2,
    "ネイティブ印の書き込み側が増えていない",
  );
  assert.match(issue, /provenance: SYNC_V2_NATIVE_PROVENANCE/, "自動発行では印を付けること");
});

// --- Codexの敵対的レビュー(NO_GO)で見つかった2件の回帰テスト ---

// 1) recoverV2CredentialFromIdb 内の読み取りが一時的に失敗すると、復元されないまま false が返る。
//    その直後の確認読みが成功して耐久コピーを見つけた場合、それは「読めなかった証拠」であり
//    新規ユーザーではない。ここを settled にすると段階5で別の部屋を発行してしまう。
test("読めたのに復元されていない耐久コピーが残っていたら発行を許さない", async () => {
  const durable = JSON.stringify({
    v: 2,
    status: "active",
    roomId: `wr_${"7".repeat(32)}`,
    secret: `wk_${"8".repeat(60)}`,
  });
  const { context } = makeBarrier({ probeOk: true, probePresent: true, probeValue: durable });
  const restored = await context.settleV2RecoveryFromIdb();
  assert.equal(restored, false);
  assert.equal(context.v2RecoveryBarrierStatus(), "inconclusive");
  assert.equal(context.v2NativeIssueAllowed(), false);
});

// 2) 壊れた／未activeの耐久レコードは「痕跡があった」という唯一の証拠なので、消してはいけない。
//    メモリ上のフラグで代用すると、再読込や別タブでは失われて次の起動でsettledになる。
//    値がnull/undefinedで保存されている場合も、キーの存在で痕跡と分かること。
test("壊れた耐久レコードが残っていれば発行を許さない", async () => {
  const { context } = makeBarrier({ probeOk: true, probePresent: true, probeValue: "{こわれた" });
  await context.settleV2RecoveryFromIdb();
  assert.equal(context.v2RecoveryBarrierStatus(), "inconclusive");
  assert.equal(context.v2NativeIssueAllowed(), false);
});

test("値がnullで保存された耐久レコードも、キーの存在で痕跡として扱う", async () => {
  const { context } = makeBarrier({ probeOk: true, probePresent: true, probeValue: null });
  await context.settleV2RecoveryFromIdb();
  assert.equal(context.v2RecoveryBarrierStatus(), "inconclusive");
  assert.equal(context.v2NativeIssueAllowed(), false);
});

test("復元経路は壊れた耐久レコードを削除せず、証跡として残す", async () => {
  const start = html.indexOf("function normalizeV2Credential");
  const end = html.indexOf("// キー切替で無効になった同期応答", start);
  assert.ok(end > start, "同期経路関数を切り出せること");
  for (const durable of ["{こわれたJSON", JSON.stringify({ v: 2, status: "pending" })]) {
    const deleted = [];
    const context = {
      SYNC_V2_CREDENTIAL_KEY: CREDENTIAL_KEY,
      SYNC_V2_NATIVE_PROVENANCE: "native-default:v1",
      syncState: { id: "", accessKey: "" },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      idb: {
        async get() {
          return durable;
        },
        async set() {
          return true;
        },
        async delete(key) {
          deleted.push(key);
          return true;
        },
      },
    };
    vm.runInNewContext(html.slice(start, end), context);
    assert.equal(await context.recoverV2CredentialFromIdb(), false);
    assert.deepEqual(deleted, [], `${durable}: 証跡を消さないこと（再起動・別タブでも痕跡が残る）`);
  }
});

test("本物のidbヘルパは、読み取り要求のエラーもgetCheckedで報告する", async () => {
  const context = {
    indexedDB: {
      open() {
        const req = { onsuccess: null, onerror: null, onupgradeneeded: null };
        req.result = {
          transaction: () => ({
            objectStore: () => ({
              count() {
                const r = { onsuccess: null, onerror: null, result: 0 };
                queueMicrotask(() => r.onsuccess && r.onsuccess());
                return r;
              },
              get() {
                const r = { onsuccess: null, onerror: null };
                queueMicrotask(() => r.onerror && r.onerror());
                return r;
              },
            }),
          }),
        };
        queueMicrotask(() => req.onsuccess && req.onsuccess());
        return req;
      },
    },
    queueMicrotask,
    Number,
    Promise,
  };
  vm.runInNewContext(`${idbHelperSource()}\nglobalThis.__idb = idb;`, context);
  assert.equal(await context.__idb.get(CREDENTIAL_KEY), null, "getは失敗をnullに畳む");
  assert.equal((await context.__idb.getChecked(CREDENTIAL_KEY)).ok, false);
});

test("本物のidbヘルパは、トランザクション生成の例外もgetCheckedで報告する", async () => {
  const context = {
    indexedDB: {
      open() {
        const req = { onsuccess: null, onerror: null, onupgradeneeded: null };
        req.result = {
          transaction() {
            throw new Error("store missing");
          },
        };
        queueMicrotask(() => req.onsuccess && req.onsuccess());
        return req;
      },
    },
    queueMicrotask,
    Number,
    Promise,
  };
  vm.runInNewContext(`${idbHelperSource()}\nglobalThis.__idb = idb;`, context);
  assert.equal((await context.__idb.getChecked(CREDENTIAL_KEY)).ok, false);
});

test("本物のidbヘルパは、値がある場合をokかつその値で返す", async () => {
  const stored = '{"v":2,"status":"active"}';
  const context = {
    indexedDB: {
      open() {
        const req = { onsuccess: null, onerror: null, onupgradeneeded: null };
        req.result = {
          transaction: () => ({
            objectStore: () => ({
              count() {
                const r = { onsuccess: null, onerror: null, result: 1 };
                queueMicrotask(() => r.onsuccess && r.onsuccess());
                return r;
              },
              get() {
                const r = { onsuccess: null, onerror: null, result: stored };
                queueMicrotask(() => r.onsuccess && r.onsuccess());
                return r;
              },
            }),
          }),
        };
        queueMicrotask(() => req.onsuccess && req.onsuccess());
        return req;
      },
    },
    queueMicrotask,
    Number,
    Promise,
  };
  vm.runInNewContext(`${idbHelperSource()}\nglobalThis.__idb = idb;`, context);
  const probe = await context.__idb.getChecked(CREDENTIAL_KEY);
  assert.equal(probe.ok, true);
  assert.equal(probe.value, stored);
});

// 実ヘルパで「キーはあるが値がnull」を present:true として報告できること。
// ここが値だけの判定に戻ると、明示的なnull保存が「キー不存在」に見えてしまう。
test("本物のidbヘルパは、キーの有無を値と独立に報告する", async () => {
  const make = (count, value) => ({
    indexedDB: {
      open() {
        const req = { onsuccess: null, onerror: null, onupgradeneeded: null };
        req.result = {
          transaction: () => ({
            objectStore: () => ({
              count() {
                const r = { onsuccess: null, onerror: null, result: count };
                queueMicrotask(() => r.onsuccess && r.onsuccess());
                return r;
              },
              get() {
                const r = { onsuccess: null, onerror: null, result: value };
                queueMicrotask(() => r.onsuccess && r.onsuccess());
                return r;
              },
            }),
          }),
        };
        queueMicrotask(() => req.onsuccess && req.onsuccess());
        return req;
      },
    },
    queueMicrotask,
    Number,
    Promise,
  });
  const absent = make(0, undefined);
  vm.runInNewContext(`${idbHelperSource()}\nglobalThis.__idb = idb;`, absent);
  const a = await absent.__idb.getChecked(CREDENTIAL_KEY);
  assert.equal(a.ok, true);
  assert.equal(a.present, false, "キーが無ければ present:false");

  const nullStored = make(1, null);
  vm.runInNewContext(`${idbHelperSource()}\nglobalThis.__idb = idb;`, nullStored);
  const n = await nullStored.__idb.getChecked(CREDENTIAL_KEY);
  assert.equal(n.ok, true);
  assert.equal(n.present, true, "値がnullでもキーがあれば present:true");
  assert.equal(n.value, null);
});

// トランザクションが abort すると count/get の onerror はどちらも発火しない。
// 拾い損ねると Promise が永久に解決せず、起動処理がそこで止まる。
test("本物のidbヘルパは、トランザクションabortでも必ず解決する", async () => {
  const context = {
    indexedDB: {
      open() {
        const req = { onsuccess: null, onerror: null, onupgradeneeded: null };
        req.result = {
          transaction() {
            const tx = { onabort: null, onerror: null };
            tx.objectStore = () => ({
              count() {
                return { onsuccess: null, onerror: null };
              },
              get() {
                return { onsuccess: null, onerror: null };
              },
            });
            queueMicrotask(() => tx.onabort && tx.onabort());
            return tx;
          },
        };
        queueMicrotask(() => req.onsuccess && req.onsuccess());
        return req;
      },
    },
    queueMicrotask,
    Number,
    Promise,
  };
  vm.runInNewContext(`${idbHelperSource()}\nglobalThis.__idb = idb;`, context);
  const probe = await getCheckedWithin(context.__idb, CREDENTIAL_KEY);
  assert.equal(probe.ok, false);
  assert.equal(probe.present, false);
});

// 片方のリクエストだけが失敗した場合も、成功側の値で settled にしてはいけない。
test("本物のidbヘルパは、count/getの片方だけ失敗しても読めなかったと報告する", async () => {
  for (const failing of ["count", "get"]) {
    const context = {
      indexedDB: {
        open() {
          const req = { onsuccess: null, onerror: null, onupgradeneeded: null };
          req.result = {
            transaction: () => ({
              objectStore: () => ({
                count() {
                  const r = { onsuccess: null, onerror: null, result: 0 };
                  queueMicrotask(() =>
                    failing === "count" ? r.onerror && r.onerror() : r.onsuccess && r.onsuccess(),
                  );
                  return r;
                },
                get() {
                  const r = { onsuccess: null, onerror: null, result: undefined };
                  queueMicrotask(() =>
                    failing === "get" ? r.onerror && r.onerror() : r.onsuccess && r.onsuccess(),
                  );
                  return r;
                },
              }),
            }),
          };
          queueMicrotask(() => req.onsuccess && req.onsuccess());
          return req;
        },
      },
      queueMicrotask,
      Number,
      Promise,
    };
    vm.runInNewContext(`${idbHelperSource()}\nglobalThis.__idb = idb;`, context);
    const probe = await getCheckedWithin(context.__idb, CREDENTIAL_KEY);
    assert.equal(probe.ok, false, `${failing} が失敗したら ok:false`);
  }
});

// 両方失敗・成功順の入れ替わりでも、解決は1回だけで結論が変わらないこと。
test("本物のidbヘルパは、count/get両方失敗でも一度だけok:falseで解決する", async () => {
  let resolveCount = 0;
  const context = {
    indexedDB: {
      open() {
        const req = { onsuccess: null, onerror: null, onupgradeneeded: null };
        req.result = {
          transaction: () => ({
            objectStore: () => ({
              count() {
                const r = { onsuccess: null, onerror: null };
                queueMicrotask(() => r.onerror && r.onerror());
                return r;
              },
              get() {
                const r = { onsuccess: null, onerror: null };
                queueMicrotask(() => r.onerror && r.onerror());
                return r;
              },
            }),
          }),
        };
        queueMicrotask(() => req.onsuccess && req.onsuccess());
        return req;
      },
    },
    queueMicrotask,
    Number,
    Promise,
  };
  vm.runInNewContext(`${idbHelperSource()}\nglobalThis.__idb = idb;`, context);
  const probe = await getCheckedWithin(context.__idb, CREDENTIAL_KEY);
  resolveCount += 1;
  assert.equal(probe.ok, false);
  assert.equal(resolveCount, 1);
});

test("本物のidbヘルパは、count/getの成功順が入れ替わっても同じ結論になる", async () => {
  const build = (countFirst) => ({
    indexedDB: {
      open() {
        const req = { onsuccess: null, onerror: null, onupgradeneeded: null };
        req.result = {
          transaction: () => ({
            objectStore: () => ({
              count() {
                const r = { onsuccess: null, onerror: null, result: 1 };
                const fire = () => r.onsuccess && r.onsuccess();
                countFirst ? queueMicrotask(fire) : queueMicrotask(() => queueMicrotask(fire));
                return r;
              },
              get() {
                const r = { onsuccess: null, onerror: null, result: "x" };
                const fire = () => r.onsuccess && r.onsuccess();
                countFirst ? queueMicrotask(() => queueMicrotask(fire)) : queueMicrotask(fire);
                return r;
              },
            }),
          }),
        };
        queueMicrotask(() => req.onsuccess && req.onsuccess());
        return req;
      },
    },
    queueMicrotask,
    Number,
    Promise,
  });
  for (const countFirst of [true, false]) {
    const context = build(countFirst);
    vm.runInNewContext(`${idbHelperSource()}\nglobalThis.__idb = idb;`, context);
    const probe = await getCheckedWithin(context.__idb, CREDENTIAL_KEY);
    assert.equal(probe.ok, true, `countFirst=${countFirst}`);
    assert.equal(probe.present, true, `countFirst=${countFirst}`);
    assert.equal(probe.value, "x", `countFirst=${countFirst}`);
  }
});
