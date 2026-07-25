// Phase 2 段階5-1（identity操作の排他基盤）の凍結ゲート。
//
// 解く問題:
//  (a) native→legacy切替は V2資格情報を消してから legacy ID を保存する。その間に別タブが
//      起動すると identity が完全に不在に見え、段階5-4以降なら新規発行の対象になる。
//  (b) 新規ユーザーが2タブを同時に開くと、両方が発行条件を満たしうる。
//
// claim を見た側は legacy へ倒さず「何もしない」。倒すこと自体が別の決定になり、
// V2とlegacyが同一端末に並立してデータが割れるため。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(scriptDir, "..", "publish", "index.html"), "utf8");

const CLAIM_KEY = "wordsnap-sync-identity-claim:v1";

function claimSource() {
  const start = html.indexOf("const IDENTITY_CLAIM_KEY");
  const end = html.indexOf("\n// ---- 起動時レースのガード", start);
  assert.ok(start >= 0, "identity claimの定義が見つかること");
  assert.ok(end > start, "identity claimの終端が見つかること");
  return html.slice(start, end);
}

function makeClaim({ stored = null, now = 1_000_000 } = {}) {
  const store = new Map();
  if (stored !== null) store.set(CLAIM_KEY, stored);
  let clock = now;
  let tokenSeed = 11;
  const context = {
    JSON,
    Math,
    Date: { now: () => clock },
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
    // 毎回同じ token になると複数タブの模擬で偽陰性を生むため、呼ぶたびに変える
    crypto: {
      getRandomValues(arr) {
        for (let i = 0; i < arr.length; i += 1) arr[i] = (tokenSeed + i * 7 + 3) % 256;
        tokenSeed += 29;
        return arr;
      },
    },
    // Locks非対応環境の経路を通す（navigator を置かない）
    window: { setTimeout: (fn) => { fn(); return 0; } },
    Promise,
  };
  vm.runInNewContext(claimSource(), context);
  return { context, store, advance: (ms) => { clock += ms; } };
}

test("claimが無ければ、identityの決定は許される", () => {
  const { context } = makeClaim();
  assert.equal(context.identityClaimBlocksDecision(), false);
});

test("自分が取ったclaimは自分の決定を妨げない", async () => {
  const { context } = makeClaim();
  const token = await context.acquireIdentityClaim("issue");
  assert.ok(token, "claimを取得できること");
  assert.equal(context.identityClaimBlocksDecision(token), false, "自分のclaimでは止まらない");
  assert.equal(context.identityClaimBlocksDecision(), true, "他タブから見ると止まる");
});

test("他タブのclaimが新しい間は、identityの決定をさせない", async () => {
  const { context } = makeClaim();
  await context.acquireIdentityClaim("switch");
  assert.equal(context.identityClaimBlocksDecision(), true);
});

test("claimは解放すると即座に効かなくなる", async () => {
  const { context, store } = makeClaim();
  const token = await context.acquireIdentityClaim("issue");
  context.releaseIdentityClaim(token);
  assert.equal(context.identityClaimBlocksDecision(), false);
  assert.equal(store.has(CLAIM_KEY), false, "解放時に残骸を残さない");
});

test("他タブのclaimは解放できない（取り違えで排他が壊れないこと）", async () => {
  const { context } = makeClaim();
  await context.acquireIdentityClaim("issue");
  context.releaseIdentityClaim("someone-elses-token");
  assert.equal(context.identityClaimBlocksDecision(), true, "他人のtokenでは解放されない");
});

test("claimは期限切れで自動的に効かなくなる（タブが落ちても詰まらない）", async () => {
  const { context, advance } = makeClaim();
  await context.acquireIdentityClaim("switch");
  assert.equal(context.identityClaimBlocksDecision(), true);
  advance(31_000);
  assert.equal(context.identityClaimBlocksDecision(), false, "30秒程度で失効すること");
});

test("先に取られているclaimは重ねて取れない", async () => {
  const { context } = makeClaim();
  const first = await context.acquireIdentityClaim("issue");
  assert.ok(first);
  assert.equal(await context.acquireIdentityClaim("issue"), "", "二重取得できないこと");
});

test("期限切れのclaimは奪える", async () => {
  const { context, advance } = makeClaim();
  await context.acquireIdentityClaim("issue");
  advance(31_000);
  assert.ok(await context.acquireIdentityClaim("switch"), "失効後は取得できること");
});

test("壊れたclaimは決定を止めず、取得も妨げない", async () => {
  for (const stored of ["{こわれた", '"文字列"', "[]", '{"at":"いつか"}', "null"]) {
    const { context } = makeClaim({ stored });
    assert.equal(context.identityClaimBlocksDecision(), false, stored);
    assert.ok(await context.acquireIdentityClaim("issue"), stored);
  }
});

test("未来時刻のclaimも上限を超えて効き続けない", () => {
  // 端末時計のずれや別タブの誤書き込みで、永久に決定できなくなるのを防ぐ
  const { context } = makeClaim({ stored: JSON.stringify({ at: 9_999_999_999_999, kind: "issue", token: "x" }) });
  assert.equal(context.identityClaimBlocksDecision(), false);
});

test("localStorageが使えない環境でも例外を投げず、決定を止めない", () => {
  const { context } = makeClaim();
  context.localStorage.getItem = () => {
    throw new Error("blocked");
  };
  context.localStorage.setItem = () => {
    throw new Error("blocked");
  };
  assert.equal(context.identityClaimBlocksDecision(), false);
  assert.doesNotThrow(() => context.releaseIdentityClaim("x"));
});

// --- 実コード側: 切替のタブ間空白期間を claim で覆う ---

function handlerSource(startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  assert.ok(start >= 0, `${startNeedle} が見つかること`);
  const end = html.indexOf(endNeedle, start);
  assert.ok(end > start, `${startNeedle} の終端が見つかること`);
  return html.slice(start, end);
}

test("native→legacy切替は、退役の前にclaimを取り、完了・中止のいずれでも解放する", () => {
  const body = handlerSource(
    "async function switchNativeV2ToForeignLegacy",
    "\nfunction showSyncSwitchConfirm",
  );
  const acquired = body.indexOf("acquireIdentityClaim(");
  const retired = body.indexOf("await retireNativeV2Credential(");
  assert.ok(acquired >= 0, "claimを取得すること");
  assert.ok(retired > acquired, "退役より前に取得すること");
  assert.match(body, /finally\s*\{[\s\S]*releaseIdentityClaim\(/, "finallyで必ず解放すること");
});

test("claimを取れなかったら切替を始めない（別タブが同じ端末のidentityを操作中）", () => {
  const body = handlerSource(
    "async function switchNativeV2ToForeignLegacy",
    "\nfunction showSyncSwitchConfirm",
  );
  const acquired = body.indexOf("acquireIdentityClaim(");
  const guard = body.indexOf("if (!", acquired);
  assert.ok(guard >= 0 && guard - acquired < 200, "取得直後に失敗を確認すること");
});

test("段階5-1の時点ではV2ネイティブ資格情報の発行経路が存在しない", () => {
  assert.equal(
    (html.match(/v2NativeIssueAllowed/g) || []).length,
    1,
    "発行ゲートは定義のみで、呼び出し側を作らない",
  );
});

// --- レビュー(GO_WITH_FIXES)で指摘されたギャップの回帰テスト ---

test("setItemだけが失敗する環境では、排他を諦めてtokenを返す", () => {
  // 旧Safariのプライベートモードや容量逼迫では getItem は動き setItem だけが失敗する。
  // ここで空を返すと切替自体ができなくなる。切替は後段の SYNC_ID_KEY 保存失敗で安全に中止される。
  const { context } = makeClaim();
  context.localStorage.setItem = () => {
    throw new Error("quota");
  };
  return context.acquireIdentityClaim("switch").then((token) => {
    assert.ok(token, "tokenを返して続行すること");
  });
});

test("claim基盤はWeb Locksを一次手段にし、非対応時だけlocalStorageへ倒す", () => {
  const src = claimSource();
  assert.match(src, /navigator\?\.locks\?\.request/, "Locksを使うこと");
  assert.match(src, /ifAvailable: true/, "保持中なら即座に諦める意味論であること");
  assert.match(src, /typeof navigator === "undefined"/, "navigator不在で例外にしないこと");
  // 定義があるだけでは意味がない。acquireIdentityClaim が実際にロックを取ること。
  const acquire = src.slice(src.indexOf("async function acquireIdentityClaim"));
  const locked = acquire.indexOf("await acquireIdentityLock()");
  const wrote = acquire.indexOf("localStorage.setItem(IDENTITY_CLAIM_KEY");
  assert.ok(locked >= 0, "acquireIdentityClaim がロックを取ること");
  assert.ok(wrote > locked, "ロックはclaim書き込みより前に取ること");
  assert.match(acquire.slice(0, locked + 60), /if \(!\(await acquireIdentityLock\(\)\)\) return ""/,
    "ロックを取れなければ即座に失敗を返すこと");
  // 解放はlocalStorageのclaimとLocksの両方
  assert.match(src, /function releaseIdentityClaim[\s\S]*releaseIdentityLock\(\)/);
  // 書き込み後に沈静化を待ってから所有者を再確認すること
  const write = src.indexOf("localStorage.setItem(IDENTITY_CLAIM_KEY");
  const settle = src.indexOf("IDENTITY_CLAIM_SETTLE_MS", write);
  const recheck = src.indexOf("stored.token === token", settle);
  assert.ok(write >= 0 && settle > write && recheck > settle, "書く→待つ→確認 の順であること");
});

test("退役に失敗した早期returnでも、claimを解放してから戻る", () => {
  // ここを落とすとclaimがTTLの30秒間残り、その間この端末のidentity決定が止まる
  const body = handlerSource(
    "async function switchNativeV2ToForeignLegacy",
    "\nfunction showSyncSwitchConfirm",
  );
  const retired = body.indexOf("if (!retired) {");
  const block = body.slice(retired, body.indexOf("return false;", retired));
  assert.match(block, /releaseIdentityClaim\(claimToken\)/, "退役失敗の早期returnで解放すること");
});

test("claimを取れなかったら、退役を実行せずに戻る", () => {
  const body = handlerSource(
    "async function switchNativeV2ToForeignLegacy",
    "\nfunction showSyncSwitchConfirm",
  );
  const acquired = body.indexOf("await acquireIdentityClaim(");
  const guardEnd = body.indexOf("return false;", acquired);
  const retire = body.indexOf("await retireNativeV2Credential(");
  assert.ok(acquired >= 0 && guardEnd > acquired, "取得直後に早期returnがあること");
  assert.ok(retire > guardEnd, "退役はそのガードより後であること");
  assert.match(body.slice(acquired, guardEnd), /if \(!claimToken\)/, "取得失敗を条件にすること");
});

// claimは「取る側」だけでは何も守らない。見る側が配線されていることを固定する。
test("別タブがidentityを操作中は、起動時のlegacy自動発行を行わない", () => {
  const init = handlerSource("function initWordsnapSync", "\n  // 現在の個人キーをURLに反映");
  assert.match(
    init,
    /const identityDecisionDeferred = identityClaimBlocksDecision\(\) && !storedSyncId/,
    "確定したidentityが無い場合に限って決定を保留すること",
  );
  assert.match(
    init,
    /if \(startupDecision\.shouldAutoGenerateLegacy && !identityDecisionDeferred && syncServerAvailable\(\)\)/,
    "自動発行の条件にclaimを含めること",
  );
});

test("identityClaimBlocksDecision は実際に使われている（定義だけにしない）", () => {
  const uses = (html.match(/identityClaimBlocksDecision\(/g) || []).length;
  assert.ok(uses >= 2, `定義と呼び出しの両方があること（出現 ${uses}）`);
});

// 「準備中」のままだと待てば直ると誤解される。再読み込みが要ることを伝える分岐が要る。
test("claim中のタブには、再読み込みが必要だと伝える", () => {
  const init = handlerSource("function initWordsnapSync", "\nfunction saveState");
  const branch = init.slice(init.indexOf("} else if (identityDecisionDeferred) {"));
  assert.ok(branch.length > 0, "claim中の専用分岐があること");
  assert.match(branch, /再読み込み/, "再読み込みを促すこと");
  // 「準備中」より前に判定されること（後段で上書きされない）
  assert.ok(
    init.indexOf("} else if (identityDecisionDeferred) {") < init.indexOf("サーバー保存の準備中です"),
    "汎用の準備中メッセージより前に分岐すること",
  );
});

// claimが守るべき決定点は3つある。1つでも素通りすると、切替タブが SYNC_ID_KEY を
// 上書きしても、このタブは別の保存先へ送り続けてデータが割れる。
test("claim中は URLキーの永続化・採用・legacy自動発行のすべてを行わない", () => {
  const init = handlerSource("function initWordsnapSync", "\n  // 現在の個人キーをURLに反映");
  // ① URLキーの永続化
  assert.match(
    init,
    /if \(startupDecision\.shouldStoreUrlId && !identityDecisionDeferred\)/,
    "URLキーの永続化を抑止すること",
  );
  // ② メモリidentityとしての採用
  assert.match(
    init,
    /syncState\.id = identityDecisionDeferred \? "" : startupDecision\.legacyId/,
    "URLキーをidentityとして採用しないこと",
  );
  // ③ legacy自動発行
  assert.match(init, /!identityDecisionDeferred && syncServerAvailable\(\)/);
  // 判定は startupDecision の適用より前で行うこと（後だと①が先に走ってしまう）
  assert.ok(
    init.indexOf("const identityDecisionDeferred") < init.indexOf("shouldStoreUrlId"),
    "判定を適用より前で行うこと",
  );
});

// --- Web Locks の経路を実際に走らせる（正規表現照合だけにしない） ---

function makeClaimWithLocks({ heldByOther = false, requestThrows = false, rejects = false } = {}) {
  const store = new Map();
  let clock = 1_000_000;
  let tokenSeed = 41;
  const state = { released: 0, requests: 0 };
  const context = {
    JSON,
    Math,
    Date: { now: () => clock },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    crypto: {
      getRandomValues(arr) {
        for (let i = 0; i < arr.length; i += 1) arr[i] = (tokenSeed + i) % 256;
        tokenSeed += 17;
        return arr;
      },
    },
    window: { setTimeout: (fn) => { fn(); return 0; } },
    Promise,
    navigator: {
      locks: {
        request(name, opts, cb) {
          state.requests += 1;
          if (requestThrows) throw new Error("locks unavailable");
          if (rejects) return Promise.reject(new Error("denied"));
          if (heldByOther) return Promise.resolve(cb(null));
          // 保持: コールバックの返すPromiseが解決するまで握り続ける
          const held = cb({ name });
          if (held && typeof held.then === "function") held.then(() => { state.released += 1; });
          return Promise.resolve(held);
        },
      },
    },
  };
  vm.runInNewContext(claimSource(), context);
  return { context, state, store };
}

test("Locksを他タブが保持していれば、claimを取得できない", async () => {
  const { context, state, store } = makeClaimWithLocks({ heldByOther: true });
  assert.equal(await context.acquireIdentityClaim("issue"), "", "取得できないこと");
  assert.equal(state.requests, 1, "Locksを実際に呼んでいること");
  assert.equal(store.has(CLAIM_KEY), false, "取れなかったらclaimを書き残さないこと");
});

test("Locks APIが例外・拒否を返す環境では、排他なしで続行する（恒久不能にしない）", async () => {
  for (const opts of [{ requestThrows: true }, { rejects: true }]) {
    const { context } = makeClaimWithLocks(opts);
    const token = await context.acquireIdentityClaim("switch");
    assert.ok(token, `${JSON.stringify(opts)}: tokenを返して続行すること`);
  }
});

test("claimの解放でWeb Lockも解放される", async () => {
  const { context, state } = makeClaimWithLocks();
  const token = await context.acquireIdentityClaim("switch");
  assert.ok(token);
  assert.equal(state.released, 0, "保持中は解放されていないこと");
  context.releaseIdentityClaim(token);
  await Promise.resolve(); // ロック解放は保持Promiseの解決（マイクロタスク）で起きる
  assert.equal(state.released, 1, "解放されること");
});

test("他タブのtokenで呼ばれたら、claimもWeb Lockも解放しない", async () => {
  const { context, state, store } = makeClaimWithLocks();
  await context.acquireIdentityClaim("switch");
  context.releaseIdentityClaim("someone-else");
  await Promise.resolve();
  assert.equal(state.released, 0, "lockを落とさないこと");
  assert.equal(store.has(CLAIM_KEY), true, "claimも残ること");
});

test("沈静化後の再確認で負けたら、Web Lockも解放して失敗を返す", async () => {
  const { context, state, store } = makeClaimWithLocks();
  // 沈静化待ちの間に他タブが上書きした状況を作る
  context.window.setTimeout = (fn) => {
    store.set(CLAIM_KEY, JSON.stringify({ at: 1_000_000, kind: "issue", token: "other-tab" }));
    fn();
    return 0;
  };
  assert.equal(await context.acquireIdentityClaim("switch"), "", "敗者は空を返すこと");
  await Promise.resolve();
  assert.equal(state.released, 1, "負けたらlockも解放すること");
});
