// 既存ユーザーへのV2お知らせ（1回だけ表示）の凍結ゲート。
//
// 出す相手を間違えると害が大きい:
//  ・移行済みの人に「移行しませんか」と出す → 混乱する
//  ・新規ユーザーに出す → 意味が通らない（5-4以降は新方式で始まるので特に）
//  ・データがまだ戻っていない起動直後に出す → 空の端末に出てしまう
//  ・毎回出す → 単なる邪魔
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(scriptDir, "..", "publish", "index.html"), "utf8");

const ANNOUNCE_KEY = "wordsnap-v2-announce:v1";

function announceSource() {
  const start = html.indexOf("const V2_ANNOUNCE_KEY");
  const end = html.indexOf("\nfunction maybeShowInitialTutorial", start);
  assert.ok(start >= 0, "お知らせの定義が見つかること");
  assert.ok(end > start, "お知らせの終端が見つかること");
  // イベント配線はDOM依存なので、判定ロジック部分だけを取り出す
  const block = html.slice(start, end);
  return block.slice(0, block.indexOf("elements.v2AnnounceLaterButton"));
}

function makeAnnounce({
  dismissed = false,
  serverAvailable = true,
  hadStoredKey = true,
  kind = "legacy",
  words = 5,
  tutorialOpen = false,
  storageThrows = false,
} = {}) {
  const store = new Map();
  if (dismissed) store.set(ANNOUNCE_KEY, "1");
  const context = {
    localStorage: {
      getItem(key) {
        if (storageThrows) throw new Error("blocked");
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        if (storageThrows) throw new Error("blocked");
        store.set(key, String(value));
      },
      removeItem: (key) => { store.delete(key); },
    },
    appState: { words: Array.from({ length: words }, (_, i) => ({ id: `w${i}` })) },
    syncServerAvailable: () => serverAvailable,
    syncRequestRoute: () => ({ kind }),
    elements: {
      tutorialBackdrop: { hidden: !tutorialOpen },
      v2AnnounceBackdrop: { hidden: true },
      v2AnnounceOpenButton: { focus() {} },
    },
    document: { activeElement: null, body: { classList: { add() {}, remove() {} } } },
    trackUsage: () => {},
    HTMLElement: class {},
  };
  vm.runInNewContext(announceSource(), context);
  context.hadStoredLegacyKeyAtStartup = hadStoredKey;
  return { context, store };
}

test("個人リンクで使い続けている既存ユーザーには出す", () => {
  const { context } = makeAnnounce();
  assert.equal(context.shouldShowV2Announce(), true);
});

test("すでにV2へ移行した人には出さない", () => {
  for (const kind of ["v2", "v2-native"]) {
    const { context } = makeAnnounce({ kind });
    assert.equal(context.shouldShowV2Announce(), false, kind);
  }
});

test("このセッションで初めてキーを持った人（新規）には出さない", () => {
  const { context } = makeAnnounce({ hadStoredKey: false });
  assert.equal(context.shouldShowV2Announce(), false);
});

test("単語がまだ戻っていない起動直後には出さない", () => {
  const { context } = makeAnnounce({ words: 0 });
  assert.equal(context.shouldShowV2Announce(), false);
});

test("同期が使えない環境（file://等）には出さない", () => {
  const { context } = makeAnnounce({ serverAvailable: false });
  assert.equal(context.shouldShowV2Announce(), false);
});

test("初回チュートリアルとは重ねない", () => {
  const { context } = makeAnnounce({ tutorialOpen: true });
  assert.equal(context.shouldShowV2Announce(), false);
});

test("一度閉じたら二度と出さない", () => {
  const { context, store } = makeAnnounce();
  assert.equal(context.shouldShowV2Announce(), true);
  context.dismissV2Announce();
  assert.equal(store.get(ANNOUNCE_KEY), "1");
  assert.equal(context.shouldShowV2Announce(), false);
});

test("localStorageが読めない環境では出さない（毎回出るより害が少ない）", () => {
  const { context } = makeAnnounce({ storageThrows: true });
  assert.equal(context.shouldShowV2Announce(), false);
});

test("閉じる処理はlocalStorageが書けなくても落ちない", () => {
  const { context } = makeAnnounce();
  context.localStorage.setItem = () => {
    throw new Error("quota");
  };
  assert.doesNotThrow(() => context.dismissV2Announce());
});

// --- 実コード側 ---

function handlerSource(startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  assert.ok(start >= 0, `${startNeedle} が見つかること`);
  const end = html.indexOf(endNeedle, start);
  assert.ok(end > start, `${startNeedle} の終端が見つかること`);
  return html.slice(start, end);
}

test("起動時点でキーを持っていたかを、新規発行より前に記録する", () => {
  // 段階5-3a で新規発行は establishLegacyIdentity() へ切り出した。守る性質は同じで、
  // 「このセッションで発行したキー」を「元から持っていたキー」と取り違えないこと。
  const init = handlerSource("function initWordsnapSync", "\n  initV2SyncUi();");
  const record = init.indexOf("hadStoredLegacyKeyAtStartup = Boolean(storedSyncId)");
  const generate = init.indexOf("establishLegacyIdentity()");
  assert.ok(record >= 0, "起動時点の有無を記録すること");
  assert.ok(generate > record, "このセッションでの新規発行より前に記録すること");
  // 発行そのものは1か所に集約されていること（別経路で増やすと記録より前に走りうる）
  assert.equal(
    (html.match(/localStorage\.setItem\(SYNC_ID_KEY, generatedId\)/g) || []).length,
    1,
    "起動時のlegacy発行は establishLegacyIdentity の1か所だけであること",
  );
});

test("お知らせは同期状態が動いたタイミングで判定する", () => {
  // 起動直後だけの判定にすると、サーバーから単語が戻る前に0件で見送ってしまう
  const badge = handlerSource("function updateSyncBadge", "\n  const badge");
  assert.match(badge, /maybeShowV2Announce\(\)/);
});

test("お知らせのダイアログは閉じる手段を複数持つ", () => {
  const block = handlerSource("const V2_ANNOUNCE_KEY", "\nfunction maybeShowInitialTutorial");
  assert.match(block, /v2AnnounceLaterButton\?\.addEventListener/, "「あとで」で閉じられること");
  assert.match(block, /event\.key === "Escape"/, "Escapeで閉じられること");
  assert.match(block, /event\.target === elements\.v2AnnounceBackdrop/, "背景クリックで閉じられること");
  // 「設定を開く」も閉じたうえで移動すること
  const open = block.slice(block.indexOf("v2AnnounceOpenButton?.addEventListener"));
  assert.ok(
    open.indexOf("dismissV2Announce()") < open.indexOf("data-settings-section"),
    "設定へ移動する前に閉じること",
  );
});

test("お知らせは同期・identityの状態を書き換えない", () => {
  const block = handlerSource("const V2_ANNOUNCE_KEY", "\nfunction maybeShowInitialTutorial");
  for (const forbidden of [
    /syncState\.\w+\s*=/,
    /localStorage\.setItem\(SYNC_ID_KEY/,
    /localStorage\.setItem\(SYNC_V2_CREDENTIAL_KEY/,
    /localStorage\.removeItem\(/,
    /pushWordsnapState|pullWordsnapState|connectWordsnapSync/,
  ]) {
    assert.doesNotMatch(block, forbidden, `お知らせが ${forbidden} に触れないこと`);
  }
});
