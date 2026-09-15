// 同期設定の見せ方（1.0.132、および直後のレビュー反映分）を固定する。
//
// 「🔄 データの保存・引き継ぎ」内で、引き継ぎコード（V2）を先頭・既定で開いた状態にし、
// 旧方式（個人キー・個人リンク）の操作は details「旧方式（個人キー・個人リンク）の操作」へ畳む。
// 加えて、
//   ・旧方式の操作結果が#syncStatusミラー（#syncStatusLegacyMirror）にも出ること
//   ・「新方式（V2）で発行」が確認なしで実行されないこと（armDangerButton）
//   ・移行済み利用者（V2資格情報あり＋legacyIdあり）に「これから移行できます」の
//     見出し・勧誘文・ボタンが出続けないこと（renderV2CredentialUiがactiveで出し分け）
// を固定する。同期のJSロジック・エンドポイント・保存キーは一切変えていないため、
// このテストはHTMLの並び・属性・文言と、表示条件だけを扱う関数の挙動を確認する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

// #syncSettingsBody の範囲だけを取り出す（他のdetailsやscriptを誤って拾わないため）。
// 終端は次のsettings-section（バックアップ）の開始直前までとする（多少余分に含んでもindexOf比較には影響しない）。
const syncBodyStart = html.indexOf('<div id="syncSettingsBody"');
const syncBodyEnd = html.indexOf('data-settings-section="backup"');
assert.ok(syncBodyStart >= 0, "#syncSettingsBody が見つかること");
assert.ok(syncBodyEnd > syncBodyStart, "バックアップ節が同期節の後に見つかること");
const syncBody = html.slice(syncBodyStart, syncBodyEnd);

// .sync-legacy-tools の開始 〜 .share-tool の開始、の範囲（旧方式の操作一式が収まっているか用）。
const legacyToolsStart = html.indexOf('class="sync-fix sync-legacy-tools"');
const shareToolStart = html.indexOf('class="share-tool"', legacyToolsStart);
assert.ok(legacyToolsStart >= 0, ".sync-legacy-tools が見つかること");
assert.ok(shareToolStart > legacyToolsStart, ".share-tool は .sync-legacy-tools の後にあること");
const legacyToolsRange = html.slice(legacyToolsStart, shareToolStart);

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const paramOpen = html.indexOf("(", start);
  let paren = 0;
  let paramEnd = paramOpen;
  for (let i = paramOpen; i < html.length; i += 1) {
    if (html[i] === "(") paren += 1;
    else if (html[i] === ")") {
      paren -= 1;
      if (paren === 0) {
        paramEnd = i;
        break;
      }
    }
  }
  const bodyBrace = html.indexOf("{", paramEnd);
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

// ============================================================================
// HTML構造: 並び順（変更なし。詳細セクションを新設しても大枠の順序は保つ）
// ============================================================================

test("並び順: #syncStatus → #syncV2Section → .sync-legacy-tools → .share-tool → 端末ごとに単語が違うとき → 過去の状態から復元", () => {
  const statusIdx = syncBody.indexOf('id="syncStatus"');
  const v2SectionIdx = syncBody.indexOf('id="syncV2Section"');
  const legacyToolsIdx = syncBody.indexOf('class="sync-fix sync-legacy-tools"');
  const shareToolIdx = syncBody.indexOf('class="share-tool"');
  const deviceMismatchIdx = syncBody.indexOf("端末ごとに単語が違うとき");
  const restoreIdx = syncBody.indexOf("過去の状態から復元");

  assert.ok(statusIdx >= 0, "#syncStatus が見つかること");
  assert.ok(v2SectionIdx > statusIdx, "#syncV2Section は #syncStatus の後にあること");
  assert.ok(legacyToolsIdx > v2SectionIdx, ".sync-legacy-tools は #syncV2Section の後にあること");
  assert.ok(shareToolIdx > legacyToolsIdx, ".share-tool は .sync-legacy-tools の後にあること");
  assert.ok(deviceMismatchIdx > shareToolIdx, "「端末ごとに単語が違うとき」は .share-tool の後にあること");
  assert.ok(restoreIdx > deviceMismatchIdx, "「過去の状態から復元」は「端末ごとに単語が違うとき」の後にあること");
});

// ============================================================================
// HTML構造: 開閉の既定と識別属性
// ============================================================================

test("#syncV2Section は既定でopen、.sync-legacy-toolsは既定で閉じてdata-sync-identity-ui=legacy", () => {
  assert.match(syncBody, /<details id="syncV2Section" class="sync-fix" open>/, "#syncV2Sectionにopen属性があること");
  assert.match(
    syncBody,
    /<details class="sync-fix sync-legacy-tools" data-sync-identity-ui="legacy">/,
    ".sync-legacy-toolsにopen属性が無く、data-sync-identity-ui=legacyであること",
  );
});

// ============================================================================
// HTML構造: 旧方式の操作一式は .sync-legacy-tools の内側にある
// ============================================================================

test(".sync-controls・#syncIdInput・#syncKeyToggleButton・#syncCopyLinkButton・#syncPullButton・#syncNewKeyButton・#syncJoinInput・#syncJoinButton は .sync-legacy-tools の内側にある", () => {
  const needles = [
    'class="sync-controls" data-sync-identity-ui="legacy"',
    'id="syncIdInput"',
    'id="syncKeyToggleButton"',
    'id="syncCopyLinkButton"',
    'id="syncPullButton"',
    'id="syncNewKeyButton"',
    'id="syncJoinInput"',
    'id="syncJoinButton"',
  ];
  for (const needle of needles) {
    assert.ok(legacyToolsRange.includes(needle), `${needle} が .sync-legacy-tools 〜 .share-tool の範囲内にあること`);
  }
});

test("#syncKeySecurityWarning と #syncStatus は .sync-legacy-tools の外側にある", () => {
  const warningIdx = syncBody.indexOf('id="syncKeySecurityWarning"');
  const statusIdx = syncBody.indexOf('id="syncStatus"');

  assert.ok(warningIdx >= 0 && warningIdx < legacyToolsStart, "#syncKeySecurityWarning は .sync-legacy-tools より前にあること");
  assert.ok(statusIdx >= 0 && statusIdx < legacyToolsStart, "#syncStatus は .sync-legacy-tools より前にあること");
});

test("#syncStatusLegacyMirror は .sync-legacy-tools の内側（本文末尾）にあり、aria-hiddenが付いている", () => {
  assert.ok(legacyToolsRange.includes('id="syncStatusLegacyMirror"'), "#syncStatusLegacyMirror が .sync-legacy-tools 内にあること");
  assert.match(legacyToolsRange, /<p id="syncStatusLegacyMirror" class="sync-status" aria-hidden="true"><\/p>/);
});

// ============================================================================
// HTML構造: 移行済み利用者に「これから移行できます」を出し続けない下地
// ============================================================================

test(".sync-legacy-tools 内の data-sync-identity-ui は常に legacy（v2-native は無い）", () => {
  const matches = [...legacyToolsRange.matchAll(/data-sync-identity-ui="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(matches.length > 0, "data-sync-identity-ui付き要素が.sync-legacy-tools内に見つかること");
  assert.ok(matches.every((value) => value === "legacy"), `すべてlegacyであること（実際: ${matches.join(", ")}）`);
});

test("V2パネル内の「これから移行できます」系（見出し・2段落・ボタン列）に data-sync-v2-state=unmigrated が付いている", () => {
  assert.match(syncBody, /<h3 data-sync-identity-ui="legacy" data-sync-v2-state="unmigrated">秘密をURLに載せない新しい同期方式<\/h3>/);
  assert.match(
    syncBody,
    /<div class="sync-v2-actions" data-sync-identity-ui="legacy" data-sync-v2-state="unmigrated">/,
  );
  const unmigratedParagraphs = [...syncBody.matchAll(/<p data-sync-identity-ui="legacy" data-sync-v2-state="unmigrated">/g)];
  assert.ok(unmigratedParagraphs.length >= 3, "移行の説明・発行の説明・注意文の3段落がunmigrated属性を持つこと");
});

test("「引き継ぎコードで他の端末と合流」ブロックは data-sync-v2-state=migrated（data-sync-identity-uiは外れている）", () => {
  assert.match(syncBody, /<div data-sync-v2-state="migrated" hidden>\s*<h3>引き継ぎコードで他の端末と合流<\/h3>/);
  const migratedBlockStart = syncBody.indexOf('<div data-sync-v2-state="migrated" hidden>');
  const migratedBlockEnd = syncBody.indexOf("</div>", migratedBlockStart);
  const migratedBlock = syncBody.slice(migratedBlockStart, migratedBlockEnd);
  assert.doesNotMatch(migratedBlock, /data-sync-identity-ui/, "data-sync-identity-uiが残っていないこと");
});

// ============================================================================
// 文言
// ============================================================================

test("「既定の同期方式はこれまでどおりです」の文は残っていない（移行後はV2経路になるため事実と合わないので削除済み）", () => {
  assert.doesNotMatch(syncBody, /既定の同期方式はこれまでどおりです/);
});

test("#syncV2Section の summary は「🔑 引き継ぎコード（おすすめの引き継ぎ方法）」", () => {
  assert.match(syncBody, /<summary>🔑 引き継ぎコード（おすすめの引き継ぎ方法）<\/summary>/);
});

test(".sync-legacy-tools の summary は「旧方式（個人キー・個人リンク）の操作」", () => {
  assert.match(syncBody, /<summary>旧方式（個人キー・個人リンク）の操作<\/summary>/);
});

test("チュートリアル文中のV2案内は新しいsummary名「🔑 引き継ぎコード（おすすめの引き継ぎ方法）」を指している", () => {
  assert.match(html, /設定の「🔑 引き継ぎコード（おすすめの引き継ぎ方法）」にある引き継ぎコードで合流します/);
  assert.doesNotMatch(html, /新方式（V2）の同期と引き継ぎ」にある引き継ぎコードで合流します/);
});

test("#syncKeySecurityWarning は「新しい個人キーを発行」の在り処（旧方式（個人キー・個人リンク）の操作）を示す", () => {
  const warningIdx = syncBody.indexOf('id="syncKeySecurityWarning"');
  const warningEnd = syncBody.indexOf("</p>", warningIdx);
  const warningText = syncBody.slice(warningIdx, warningEnd);
  assert.match(warningText, /下の「旧方式（個人キー・個人リンク）の操作」にある「新しい個人キーを発行」/);
});

// ============================================================================
// #syncV2CreateButton: 確認なしで実行されない（armDangerButton）
// ============================================================================

test("#syncV2CreateButton のクリック経路に armDangerButton がある（確認なし実行を防ぐ）", () => {
  const handlerStart = html.indexOf('elements.syncV2CreateButton?.addEventListener("click"');
  assert.ok(handlerStart >= 0, "syncV2CreateButtonのクリックハンドラが見つかること");
  const handlerEnd = html.indexOf("});", handlerStart);
  const handlerSrc = html.slice(handlerStart, handlerEnd);
  assert.match(handlerSrc, /armDangerButton\(elements\.syncV2CreateButton, "もう一度押すと発行"\)/);
  assert.match(handlerSrc, /createV2Room\(\);/, "確定後はcreateV2Room()を呼ぶこと（同期のJSロジック自体は変えない）");
});

// ============================================================================
// setSyncStatus: #syncStatusLegacyMirror にも同じ文・クラスを書く
// ============================================================================

function makeClassList() {
  const set = new Set();
  return {
    toggle(name, force) {
      if (force) set.add(name);
      else set.delete(name);
    },
    has: (name) => set.has(name),
  };
}

function setSyncStatusSandbox({ withMirror = true } = {}) {
  const syncStatus = { textContent: "", classList: makeClassList() };
  const syncStatusLegacyMirror = withMirror ? { textContent: "", classList: makeClassList() } : undefined;
  const elements = { syncStatus, syncStatusLegacyMirror };
  const context = {
    elements,
    syncState: {},
    updateSyncBadge() {},
  };
  const source = [extractFunction("setSyncStatus"), "globalThis.__setStatus = setSyncStatus;"].join("\n\n");
  vm.runInNewContext(source, context);
  return { context, syncStatus, syncStatusLegacyMirror };
}

test("setSyncStatus: #syncStatusと同じ文・同じクラスを#syncStatusLegacyMirrorにも書く", () => {
  const { context, syncStatus, syncStatusLegacyMirror } = setSyncStatusSandbox();
  context.__setStatus("テスト文言", "error");
  assert.equal(syncStatus.textContent, "テスト文言");
  assert.equal(syncStatusLegacyMirror.textContent, "テスト文言");
  assert.equal(syncStatus.classList.has("is-error"), true);
  assert.equal(syncStatusLegacyMirror.classList.has("is-error"), true);
  assert.equal(syncStatus.classList.has("is-live"), false);
  assert.equal(syncStatusLegacyMirror.classList.has("is-live"), false);

  context.__setStatus("完了しました", "live");
  assert.equal(syncStatusLegacyMirror.textContent, "完了しました");
  assert.equal(syncStatusLegacyMirror.classList.has("is-live"), true);
  assert.equal(syncStatusLegacyMirror.classList.has("is-error"), false);
});

test("setSyncStatus: ミラー要素が無い環境（テスト砂場など）でも例外を投げない", () => {
  const { context, syncStatus } = setSyncStatusSandbox({ withMirror: false });
  assert.doesNotThrow(() => context.__setStatus("文言", "live"));
  assert.equal(syncStatus.textContent, "文言");
});

// ============================================================================
// applySyncIdentityUi / renderV2CredentialUi 用の最小DOMスタブ
// ============================================================================

function parseSimpleSelector(selector) {
  const m = selector.match(/^\[([\w-]+)="([^"]+)"\](?::not\(\[([\w-]+)\]\))?$/);
  if (!m) throw new Error(`unsupported selector in test stub: ${selector}`);
  const [, attr, value, notAttr] = m;
  return { attr, value, notAttr };
}

function makeFakeDocument(elements, byId = {}) {
  return {
    querySelectorAll(selector) {
      const { attr, value, notAttr } = parseSimpleSelector(selector);
      return elements.filter((el) => el.attrs[attr] === value && (!notAttr || !(notAttr in el.attrs)));
    },
    querySelector(selector) {
      const idMatch = selector.match(/^#([\w-]+)$/);
      if (idMatch) return byId[idMatch[1]] || null;
      return null;
    },
  };
}

// ============================================================================
// applySyncIdentityUi: V2ネイティブ／旧キーのみ／移行済み の3種
// ============================================================================

function identityUiSandbox() {
  const legacyPlain = { attrs: { "data-sync-identity-ui": "legacy" }, hidden: false };
  const v2nativePlain = { attrs: { "data-sync-identity-ui": "v2-native" }, hidden: false };
  // data-sync-v2-state付きの要素はrenderV2CredentialUi側が出し分けるので、
  // applySyncIdentityUiでは触られないはず（"sentinel"のまま変化しないことで確認する）。
  const legacyUnmigrated = {
    attrs: { "data-sync-identity-ui": "legacy", "data-sync-v2-state": "unmigrated" },
    hidden: "sentinel",
  };
  const migrated = { attrs: { "data-sync-v2-state": "migrated" }, hidden: "sentinel" };
  const syncSettingsBodyEl = { attrs: {}, setAttribute(name, value) { this[name] = value; } };
  const elements = {
    syncV2Section: { open: false },
    syncKeySecurityWarning: { hidden: false },
  };
  const context = {
    elements,
    refreshAiKeySyncToggleVisibility() {},
    document: makeFakeDocument(
      [legacyPlain, v2nativePlain, legacyUnmigrated, migrated],
      { syncSettingsBody: syncSettingsBodyEl },
    ),
  };
  const source = [extractFunction("applySyncIdentityUi"), "globalThis.__apply = applySyncIdentityUi;"].join("\n\n");
  vm.runInNewContext(source, context);
  return { context, elements, legacyPlain, v2nativePlain, legacyUnmigrated, migrated, syncSettingsBodyEl };
}

test("applySyncIdentityUi: V2ネイティブ（isV2Native=true）はlegacyを隠しv2-nativeを出し、syncNativeTitleを参照する", () => {
  const { context, elements, legacyPlain, v2nativePlain, legacyUnmigrated, migrated, syncSettingsBodyEl } =
    identityUiSandbox();
  context.__apply({ isV2Native: true, legacyId: "" });
  assert.equal(legacyPlain.hidden, true);
  assert.equal(v2nativePlain.hidden, false);
  assert.equal(syncSettingsBodyEl["aria-labelledby"], "syncNativeTitle");
  assert.equal(elements.syncV2Section.open, true);
  assert.equal(elements.syncKeySecurityWarning.hidden, true);
  // data-sync-v2-state付きはrenderV2CredentialUiの管轄。ここでは触られない。
  assert.equal(legacyUnmigrated.hidden, "sentinel");
  assert.equal(migrated.hidden, "sentinel");
});

test("applySyncIdentityUi: 旧キーのみ（isV2Native=false・legacyIdあり・V2資格情報なし）はlegacyを出しv2-nativeを隠す", () => {
  const { context, legacyPlain, v2nativePlain, legacyUnmigrated, migrated, syncSettingsBodyEl } = identityUiSandbox();
  context.__apply({ isV2Native: false, legacyId: "legacy123" });
  assert.equal(legacyPlain.hidden, false);
  assert.equal(v2nativePlain.hidden, true);
  assert.equal(syncSettingsBodyEl["aria-labelledby"], "syncTitle");
  assert.equal(legacyUnmigrated.hidden, "sentinel");
  assert.equal(migrated.hidden, "sentinel");
});

test("applySyncIdentityUi: 移行済み（isV2Native=false・legacyIdあり・V2資格情報あり）もlegacy扱いのまま変わらない（区別はrenderV2CredentialUi側の責務）", () => {
  const { context, legacyPlain, v2nativePlain, legacyUnmigrated, migrated, syncSettingsBodyEl } = identityUiSandbox();
  // isV2Nativeは「!legacyId && hasV2NativeProvenance」で決まるため、legacyIdが残る移行済み利用者は
  // V2資格情報があっても偽のまま。applySyncIdentityUi単体では旧キーのみの利用者と区別できない。
  context.__apply({ isV2Native: false, legacyId: "legacy123" });
  assert.equal(legacyPlain.hidden, false);
  assert.equal(v2nativePlain.hidden, true);
  assert.equal(syncSettingsBodyEl["aria-labelledby"], "syncTitle");
  assert.equal(legacyUnmigrated.hidden, "sentinel");
  assert.equal(migrated.hidden, "sentinel");
});

// ============================================================================
// renderV2CredentialUi: activeの有無で unmigrated/migrated ブロックを出し分ける
// ============================================================================

function credentialUiSandbox({ credential = null, v2Busy = false } = {}) {
  const unmigratedEl = { attrs: { "data-sync-v2-state": "unmigrated" }, hidden: false };
  const migratedEl = { attrs: { "data-sync-v2-state": "migrated" }, hidden: true };
  const elements = {
    syncV2CredentialPanel: { hidden: false },
    syncV2TransferCode: { value: "" },
    syncV2CredentialWarning: { textContent: "" },
    exportV2CredentialOption: { hidden: false },
    exportV2CredentialToggle: { checked: false },
    syncV2UpgradeButton: { disabled: false },
    syncV2CreateButton: { disabled: false },
  };
  const context = {
    elements,
    syncState: { v2Busy },
    refreshAiKeySyncToggleVisibility() {},
    readV2Credential: () => credential,
    v2TransferCode: () => "",
    renderV2RecoveryNotice() {},
    document: makeFakeDocument([unmigratedEl, migratedEl]),
  };
  const source = [extractFunction("renderV2CredentialUi"), "globalThis.__render = renderV2CredentialUi;"].join("\n\n");
  vm.runInNewContext(source, context);
  return { context, elements, unmigratedEl, migratedEl };
}

test("renderV2CredentialUi: activeがあるとき、unmigratedブロックは隠れ、migratedブロックが出て、両ボタンが無効化される", () => {
  const { context, elements, unmigratedEl, migratedEl } = credentialUiSandbox({
    credential: { status: "active", origin: "upgrade", roomId: "wr_x" },
  });
  context.__render();
  assert.equal(unmigratedEl.hidden, true, "「これから移行できます」系は隠れること");
  assert.equal(migratedEl.hidden, false, "「引き継ぎコードで他の端末と合流」が出ること");
  assert.equal(elements.syncV2UpgradeButton.disabled, true);
  assert.equal(elements.syncV2CreateButton.disabled, true);
});

test("renderV2CredentialUi: activeが無いとき、unmigratedブロックが出て、migratedブロックは隠れ、両ボタンは有効", () => {
  const { context, elements, unmigratedEl, migratedEl } = credentialUiSandbox({ credential: null });
  context.__render();
  assert.equal(unmigratedEl.hidden, false, "「これから移行できます」系が出ること");
  assert.equal(migratedEl.hidden, true, "「引き継ぎコードで他の端末と合流」は隠れること");
  assert.equal(elements.syncV2UpgradeButton.disabled, false);
  assert.equal(elements.syncV2CreateButton.disabled, false);
});

test("renderV2CredentialUi: pending状態（activeではない）でもunmigratedブロックは出たまま", () => {
  const { unmigratedEl, migratedEl, context } = credentialUiSandbox({
    credential: { status: "pending", roomId: "wr_x" },
  });
  context.__render();
  assert.equal(unmigratedEl.hidden, false);
  assert.equal(migratedEl.hidden, true);
});
