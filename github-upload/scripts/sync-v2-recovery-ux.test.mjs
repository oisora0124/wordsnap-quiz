// Phase 2 段階4（回復UX）の凍結ゲート。
// V2ネイティブには個人リンク（?w=）が無く、引き継ぎコードが唯一のアクセス手段になる。
// その保管を促す導線が、
//   ・roomIdごとに保存済みを持つこと（単一booleanだと部屋を替えても注意が消えたままになる）
//   ・端末外へ出す操作だけを「保存済み」とみなすこと（コピーは不可）
//   ・守る価値のあるデータができた後にだけ出ること
//   ・個人リンクを持つ既存ユーザーには一切出ないこと
// を固定する。実装側を直すこと。テストを緩めない。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(scriptDir, "..", "publish", "index.html"), "utf8");

const SAVED_KEY = "wordsnap-v2-code-saved:v1";
const ROOM_A = `wr_${"a".repeat(32)}`;
const ROOM_B = `wr_${"b".repeat(32)}`;

function recoveryUxSource() {
  const start = html.indexOf("const V2_CODE_SAVED_KEY");
  const end = html.indexOf("\nfunction renderV2CredentialUi", start);
  assert.ok(start >= 0, "回復UXの定義が見つかること");
  assert.ok(end > start, "回復UXの終端が見つかること");
  return html.slice(start, end);
}

// identity と appState / syncState を差し替えて条件判定だけを評価する。
function makeRecoveryUx({
  identity,
  words = 0,
  verifiedSyncTarget = "",
  verifiedWordCount = 1,
  stored = null,
} = {}) {
  const store = new Map();
  if (stored !== null) store.set(SAVED_KEY, stored);
  const context = {
    JSON,
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
    appState: { words: Array.from({ length: words }, (_, i) => ({ id: `w${i}` })) },
    syncState: {},
    elements: { syncV2RecoveryNotice: { hidden: true }, syncV2Section: { open: false } },
    document: { querySelector: () => null },
    syncRequestRoute: () => identity,
  };
  vm.runInNewContext(recoveryUxSource(), context);
  if (verifiedSyncTarget) context.recordVerifiedSync(verifiedSyncTarget, verifiedWordCount);
  return { context, store };
}

const NATIVE = { kind: "v2", isV2: true, isV2Native: true, roomId: ROOM_A, legacyId: "" };
const UPGRADED = { kind: "v2", isV2: true, isV2Native: false, roomId: ROOM_A, legacyId: "ws_x" };
const LEGACY = { kind: "legacy", isV2: false, isV2Native: false, roomId: "", legacyId: "ws_x" };

test("V2ネイティブで単語があり同期に成功していれば保管を促す", () => {
  const { context } = makeRecoveryUx({ identity: NATIVE, words: 3, verifiedSyncTarget: ROOM_A });
  assert.equal(context.shouldPromptV2CodeBackup(), true);
});

test("個人リンクを持つ既存ユーザーには絶対に出さない", () => {
  for (const [name, identity] of [
    ["upgrade済みV2（legacy+V2 active）", UPGRADED],
    ["legacyのみ", LEGACY],
  ]) {
    const { context } = makeRecoveryUx({ identity, words: 50, verifiedSyncTarget: ROOM_A });
    assert.equal(context.shouldPromptV2CodeBackup(), false, name);
  }
});

test("単語が無い、またはこの部屋への保存が検証できていない間は出さない", () => {
  const noWords = makeRecoveryUx({ identity: NATIVE, words: 0, verifiedSyncTarget: ROOM_A });
  assert.equal(noWords.context.shouldPromptV2CodeBackup(), false, "単語なし");
  const noSync = makeRecoveryUx({ identity: NATIVE, words: 3 });
  assert.equal(noSync.context.shouldPromptV2CodeBackup(), false, "この部屋への保存が未検証");
});

test("create時点で既に単語がある場合も、同期成功と同時に出る", () => {
  // 「初めて単語を保存した瞬間」だけを条件にすると、この経路で永久に出ない
  const { context } = makeRecoveryUx({ identity: NATIVE, words: 120, verifiedSyncTarget: ROOM_A });
  assert.equal(context.shouldPromptV2CodeBackup(), true);
});

test("保存済みはroomIdごとに持ち、別の部屋へ移ると未保存へ戻る", () => {
  const { context, store } = makeRecoveryUx({ identity: NATIVE, words: 3, verifiedSyncTarget: ROOM_A });
  assert.equal(context.shouldPromptV2CodeBackup(), true, "保存前は出る");
  context.markV2CodeSavedFor(ROOM_A);
  assert.equal(context.isV2CodeSavedFor(ROOM_A), true);
  assert.equal(context.shouldPromptV2CodeBackup(), false, "保存後は出ない");
  assert.equal(context.isV2CodeSavedFor(ROOM_B), false, "別の部屋は未保存のまま");
  assert.deepEqual(JSON.parse(store.get(SAVED_KEY)), [ROOM_A]);
});

test("保存済みの記録は上限で古いものから捨て、重複を増やさない", () => {
  const { context, store } = makeRecoveryUx({ identity: NATIVE });
  const rooms = Array.from({ length: 12 }, (_, i) => `wr_${String(i).padStart(2, "0").repeat(16)}`);
  rooms.forEach((room) => context.markV2CodeSavedFor(room));
  const saved = JSON.parse(store.get(SAVED_KEY));
  assert.equal(saved.length, 8, "上限8件");
  assert.deepEqual(saved, rooms.slice(-8), "新しい方を残す");
  context.markV2CodeSavedFor(rooms[rooms.length - 1]);
  assert.equal(JSON.parse(store.get(SAVED_KEY)).length, 8, "再保存しても増えない");
});

test("壊れた保存記録・不正なroomIdは安全側（未保存）として扱う", () => {
  for (const stored of ["{こわれた", '{"a":1}', '["wr_short", 42, null]', "null"]) {
    const { context } = makeRecoveryUx({ identity: NATIVE, words: 3, verifiedSyncTarget: ROOM_A, stored });
    assert.equal(context.isV2CodeSavedFor(ROOM_A), false, stored);
    assert.equal(context.shouldPromptV2CodeBackup(), true, stored);
  }
});

test("不正なroomIdは保存済みとして記録しない", () => {
  const { context, store } = makeRecoveryUx({ identity: NATIVE });
  for (const bad of ["", null, undefined, "ws_legacy", "wr_XYZ", `wr_${"a".repeat(31)}`]) {
    context.markV2CodeSavedFor(bad);
  }
  assert.equal(store.has(SAVED_KEY), false);
});

test("localStorageが書けない環境でも落ちず、未保存のまま注意が残る", () => {
  const { context } = makeRecoveryUx({ identity: NATIVE, words: 3, verifiedSyncTarget: ROOM_A });
  context.localStorage.setItem = () => {
    throw new Error("quota");
  };
  context.markV2CodeSavedFor(ROOM_A);
  assert.equal(context.shouldPromptV2CodeBackup(), true);
});

// --- 「保存済み」とみなす操作を実コードで固定する ---

function handlerSource(startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  assert.ok(start >= 0, `${startNeedle} が見つかること`);
  const end = html.indexOf(endNeedle, start);
  assert.ok(end > start, `${startNeedle} の終端が見つかること`);
  return html.slice(start, end);
}

test("コードのコピーでは保存済みにしない", () => {
  const body = handlerSource(
    "elements.syncV2CopyCodeButton?.addEventListener",
    "elements.syncV2DownloadCodeButton?.addEventListener",
  );
  assert.match(body, /navigator\.clipboard\.writeText/, "コピー処理であること");
  assert.doesNotMatch(
    body,
    /^\s*markV2CodeSavedFor\(/m,
    "コピーからは markV2CodeSavedFor を呼ばないこと",
  );
});

test("テキストで保存したときは保存済みにする", () => {
  const body = handlerSource(
    "elements.syncV2DownloadCodeButton?.addEventListener",
    "\n// 経過時間を",
  );
  assert.match(body, /downloadBlob\(/, "ダウンロード処理であること");
  assert.match(body, /markV2CodeSavedFor\(getActiveV2Credential\(\)\?\.roomId\)/);
});

test("JSON書き出しは引き継ぎコードを同梱したときだけ保存済みにする", () => {
  const body = handlerSource(
    "elements.exportButton.addEventListener",
    "elements.importDeckShareInput",
  );
  assert.match(
    body,
    /if \(includeV2Credential\) markV2CodeSavedFor\(getActiveV2Credential\(\)\?\.roomId\)/,
    "同梱したときだけ保存済みにすること",
  );
});

test("注意表示は同期状態と単語数の更新に追随する", () => {
  assert.match(handlerSource("function updateSyncBadge", "\n  const badge"), /renderV2RecoveryNotice\(\)/);
  assert.match(handlerSource("function renderAll", "\n  // 学習カレンダー"), /renderV2RecoveryNotice\(\)/);
});

test("段階4の時点でもV2ネイティブ資格情報の発行経路は存在しない", () => {
  assert.equal(
    (html.match(/v2NativeIssueAllowed/g) || []).length,
    1,
    "発行ゲートは定義のみで呼び出し側を作らない",
  );
});

// --- 敵対的レビュー(NO_GO)で見つかった2件の回帰テスト ---
// どちらも「表示用の状態(lastSyncedAt)を回復UXの判断に使っていた」ことが原因だった。

test("別の部屋への保存成功を根拠にしない", () => {
  const { context } = makeRecoveryUx({ identity: NATIVE, words: 3, verifiedSyncTarget: ROOM_B });
  assert.equal(context.shouldPromptV2CodeBackup(), false, "別の部屋の成功では出さない");
  context.recordVerifiedSync(ROOM_A, 3);
  assert.equal(context.shouldPromptV2CodeBackup(), true, "この部屋の成功なら出る");
});

test("legacyキーへの保存成功を根拠にしない", () => {
  const { context } = makeRecoveryUx({ identity: NATIVE, words: 3, verifiedSyncTarget: "ws_legacykey" });
  assert.equal(context.shouldPromptV2CodeBackup(), false);
});

test("保存先が空の記録要求は無視する", () => {
  const { context } = makeRecoveryUx({ identity: NATIVE, words: 3 });
  for (const bad of ["", null, undefined, 0]) context.recordVerifiedSync(bad, 5);
  assert.equal(context.shouldPromptV2CodeBackup(), false);
});

// 実コード側: 何を「保存が検証できた」とみなすかを固定する。
test("同期成功の記録は表示用のsetSyncStatusから独立している", () => {
  // setSyncStatus(..., "live") は共有リンクのコピー・共有の成功でも呼ばれる。
  // 同期通信をしていない操作が、保管を促す条件を満たしてはいけない。
  const setStatus = handlerSource("function setSyncStatus", "\n\nfunction ");
  assert.doesNotMatch(
    setStatus,
    /recordVerifiedSync/,
    "表示関数から同期成功を記録しないこと",
  );
  assert.doesNotMatch(
    html.slice(html.indexOf("const V2_CODE_SAVED_KEY"), html.indexOf("\nfunction renderV2CredentialUi")),
    /syncState\.lastSyncedAt/,
    "回復UXの判定に表示用のlastSyncedAtを使わないこと",
  );
});

test("PUT成功は、応答が示す保存先（無ければ送信開始時のidentity）で記録する", () => {
  const body = handlerSource("async function pushWordsnapState", "\n  } catch (error) {");
  assert.match(
    body,
    /recordVerifiedSync\(result\.verifiedSyncTarget \|\| identity\.expectedSyncId, sentWordCount\)/,
    "送信中に切り替わった場合に切替先を誤って記録しないこと",
  );
});

test("createの成功も保存が検証できたものとして記録する", () => {
  // これが無いと、既に単語がある人がcreateしても注意が永久に出ない
  const body = handlerSource(
    "if (response.status === 200 && validSyncPutResponse(data, credential.roomId)) {",
    "if (response.status === 503) {",
  );
  assert.match(body, /activateV2Credential\(credential, data\.stateRev\)/);
  assert.match(body, /recordVerifiedSync\(credential\.roomId, createdWordCount\)/);
});

// 空の状態でcreateしただけの保存先を「単語が守られている」根拠にしてはいけない。
// その後オフラインで追加した単語は、まだサーバーに入っていない。
test("空のcreate成功は、その後に追加した未送信の単語を守った証拠にならない", () => {
  const { context } = makeRecoveryUx({
    identity: NATIVE,
    words: 5, // createの後にオフラインで追加された想定
    verifiedSyncTarget: ROOM_A,
    verifiedWordCount: 0, // create時点では空だった
  });
  assert.equal(context.shouldPromptV2CodeBackup(), false);
  // 実際に単語を送れた時点で初めて出る
  context.recordVerifiedSync(ROOM_A, 5);
  assert.equal(context.shouldPromptV2CodeBackup(), true);
});

test("送信中に増えた分は、その成功では保証しない（送信時点の語数で記録する）", () => {
  const push = handlerSource("async function pushWordsnapState", "\n  } catch (error) {");
  assert.match(
    push,
    /const sentWordCount = appState\?\.words\?\.length \|\| 0;/,
    "送信開始時に語数を固定すること",
  );
  assert.match(push, /recordVerifiedSync\([^)]*, sentWordCount\)/);
  const create = handlerSource(
    "if (response.status === 200 && validSyncPutResponse(data, credential.roomId)) {",
    "if (response.status === 503) {",
  );
  assert.match(create, /recordVerifiedSync\(credential\.roomId, createdWordCount\)/);
});

// 再読込で記録は空へ戻る。起動時のGETで「送信不要＝サーバーと一致」と確認できた場合に
// 記録し直さないと、コード未保存のまま注意が二度と出なくなる。
test("送信不要と確認できた起動接続でも検証済みとして記録し直す", () => {
  // 再読込で記録は空へ戻る。ここで記録し直さないと、コード未保存のまま
  // 注意が二度と出なくなる（抑止が永久化する）。
  const body = handlerSource("async function connectV2NativeSync", "\n  } catch (error) {");
  assert.match(body, /引き継ぎコードまたはJSON/, "V2ネイティブ側の関数であること");
  assert.match(
    body,
    /recordVerifiedSync\(requestedId, appState\?\.words\?\.length \|\| 0\)/,
    "送信不要と確認できた分岐で記録すること",
  );
  const requestedAt = body.indexOf("const requestedId");
  assert.ok(requestedAt >= 0 && requestedAt < body.indexOf("await syncRequest"),
    "保存先は通信前に固定すること");
});

// force系は応答後に保存先を取り直してはいけない。別タブが資格情報を切り替えていると、
// 「通信していない保存先」を検証済みとして記録してしまう。
test("強制上書き・強制取得は通信前に保存先を固定して記録する", () => {
  for (const [name, fn] of [
    ["forcePushOverwrite", "async function forcePushOverwrite"],
    ["forcePullReplace", "async function forcePullReplace"],
  ]) {
    const body = handlerSource(fn, "\n  } catch (error) {");
    assert.match(body, /recordVerifiedSync\(/, `${name}: 記録すること`);
    assert.doesNotMatch(
      body,
      /recordVerifiedSync\(syncRequestRoute\(\)/,
      `${name}: 応答後に保存先を取り直さないこと`,
    );
    assert.match(
      body,
      /recordVerifiedSync\((?:result|remote)\.verifiedSyncTarget \|\| [A-Za-z0-9_$]+/,
      `${name}: 実際に通信した保存先（応答が示すもの）を優先すること`,
    );
    const fallback = body.match(/verifiedSyncTarget \|\| ([A-Za-z0-9_$]+)/)[1];
    const declaredAt = body.indexOf(`const ${fallback} =`);
    assert.ok(declaredAt >= 0, `${name}: 予備の保存先も変数へ固定すること`);
    assert.ok(declaredAt < body.indexOf("await "), `${name}: 固定は最初の通信より前に行うこと`);
  }
});

test("join・JSON資格情報接続・履歴復元も検証済みとして記録する", () => {
  const join = handlerSource("async function joinV2Room", "\n  } catch {");
  assert.match(join, /recordVerifiedSync\(credential\.roomId, appState\.words\.length\)/);
  const imported = handlerSource("async function connectImportedV2Credential", "\n  } catch {");
  assert.match(imported, /else recordVerifiedSync/, "送信不要側で分岐していること");
  assert.match(imported, /recordVerifiedSync\(credential\.roomId/, "送信不要側で記録すること");
  const restore = handlerSource("async function restoreFromRevision", "\n  } catch (error) {");
  assert.match(restore, /recordVerifiedSync\([^)]*restoredTarget, restoredWordCount\)/);
});

// legacy専用の起動接続は回復UXの対象外。ここへ記録を足すと、legacy側に存在しない変数を
// 参照してReferenceErrorになり、既存ユーザーの通常接続が壊れる（実際に一度壊した）。
test("legacy専用の起動接続からは記録しない", () => {
  const legacy = handlerSource("async function connectWordsnapSync", "\n  } catch (error) {");
  assert.match(legacy, /個人リンクまたはJSON/, "legacy側の関数であること");
  assert.doesNotMatch(legacy, /recordVerifiedSync/);
});

// まれにしか通らない分岐でのReferenceErrorは、テストがgreenでも本番で壊れる。
// recordVerifiedSync に渡す識別子が、その関数の中で必ず宣言されていることを機械的に確かめる。
test("recordVerifiedSyncの引数は、通常function内の単純識別子として宣言されている", () => {
  // 注意: これは一般的な字句スコープ解析ではない。通常の function 宣言の中で
  // 単純な識別子を渡す形（現在の8箇所すべて）だけを対象にした検査。
  // アロー関数・関数式・generator・ブロックスコープ・宣言順・分割代入は解析しない。
  // 呼び出しをそれらへ広げるときはAST解析へ移行すること。
  // 除外するのは本物のグローバルだけ。credential / result / remote は実ファイルでは
  // 仮引数かローカルなので、除外するとその未宣言を見逃す。
  const KNOWN_GLOBALS = new Set(["appState", "syncState"]);
  const starts = [];
  const fnRe = /^(?:async )?function ([A-Za-z0-9_$]+)\(/gm;
  for (let m; (m = fnRe.exec(html)); ) starts.push({ index: m.index, name: m[1] });
  let checked = 0;
  const callRe = /recordVerifiedSync\(([^)]*)\)/g;
  for (let m; (m = callRe.exec(html)); ) {
    if (html.slice(m.index - 9, m.index) === "function ") continue;
    const owner = starts.filter((f) => f.index < m.index).pop();
    assert.ok(owner, "呼び出し元の関数を特定できること");
    const bodyStart = owner.index;
    const next = starts.find((f) => f.index > owner.index);
    const body = html.slice(bodyStart, next ? next.index : m.index + 200);
    for (const raw of m[1].split(",")) {
      const root = raw.trim().split(/[.?[(]/)[0];
      if (!root || /^[0-9"'`]/.test(root) || KNOWN_GLOBALS.has(root)) continue;
      const declared =
        new RegExp(`(?:const|let|var)\\s+${root}\\b`).test(body) ||
        new RegExp(`function ${owner.name}\\([^)]*\\b${root}\\b`).test(body);
      assert.ok(declared, `${owner.name} 内で ${root} が宣言されていないまま使われている`);
    }
    checked += 1;
  }
  assert.ok(checked >= 8, `呼び出しを検査できていること（検査数 ${checked}）`);
});

// gzip圧縮のawaitを跨いで別タブが資格情報を切り替えると、通信前に取った identity では
// 送信先と記録先がずれる。syncRequest は応答の syncId と照合済みの保存先を返すので、
// 記録はそれを最優先で使う。
test("記録は、実際に通信した保存先（応答で照合済み）を最優先で使う", () => {
  const req = handlerSource("async function syncRequest", "\n// 【同期用ビュー】");
  assert.match(
    req,
    /data\.verifiedSyncTarget = expectedSyncId;/,
    "syncRequestが実際の保存先を応答へ載せること",
  );
  // expectedSyncId は応答の syncId と照合されたあとに載ること
  const validated = req.indexOf('validSyncPutResponse(data, expectedSyncId)');
  const attached = req.indexOf("data.verifiedSyncTarget = expectedSyncId;");
  assert.ok(validated >= 0 && validated < attached, "PUT応答の照合より後に載せること");

  for (const [name, fn, end, holder] of [
    ["pushWordsnapState", "async function pushWordsnapState", "\n  } catch (error) {", "result"],
    ["forcePushOverwrite", "async function forcePushOverwrite", "\n  } catch (error) {", "result"],
    ["forcePullReplace", "async function forcePullReplace", "\n  } catch (error) {", "remote"],
    ["restoreFromRevision", "async function restoreFromRevision", "\n  } catch (error) {", "result"],
  ]) {
    const body = handlerSource(fn, end);
    assert.match(
      body,
      new RegExp(`recordVerifiedSync\\(${holder}\\.verifiedSyncTarget \\|\\|`),
      `${name}: 応答が示す保存先を優先すること`,
    );
  }
});

// verifiedSyncTarget が付かない成功応答が生まれると、記録は通信前スナップショットへ
// 黙って戻り、修正した別タブ競合が復活する。付与の取りこぼしを字句で塞ぐ。
test("syncRequestの成功returnは、必ず保存先を付けてから返す", () => {
  const req = handlerSource("async function syncRequest", "\n// 【同期用ビュー】");
  const returns = req.match(/^\s*return [^;]+;/gm) || [];
  assert.equal(returns.length, 1, `成功returnは1箇所であること（${returns.length}箇所）`);
  const attach = req.indexOf("data.verifiedSyncTarget = expectedSyncId;");
  const ret = req.lastIndexOf("return data;");
  assert.ok(attach >= 0 && attach < ret, "付与は成功returnより前であること");
  // 付与は全ての応答検証を通過した後であること
  for (const guard of ["validSyncGetResponse", "validSyncPutResponse", "if (!response.ok)"]) {
    assert.ok(req.indexOf(guard) < attach, `${guard} の検証より後に付与すること`);
  }
});
