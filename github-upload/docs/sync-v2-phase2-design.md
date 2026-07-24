# V2 Phase 2 設計書（新規ユーザーの既定をV2にする）

> **rev1 は NO-GO（2026-07-25、Codex敵対的レビュー）。この設計のまま実装してはいけない。**
> 本文は記録として残す。着手するなら下記「rev1 レビュー結果」を解消した rev2 が必要。

- 版: rev1（2026-07-25）
- 前提: Phase 1 本番稼働中（`SYNC_V2_ENABLED=1`、レート制限あり、鍵リング設定済み）
- リスク区分: **高**（第9章: 同期・データ移行・セキュリティ）

## 目的

**これから初めて使うユーザー**の同期を、既定でV2（秘密がURLに載らない方式）にする。

## 絶対条件

1. **既存ユーザーへの影響ゼロ**。保存済みの資格情報（legacyキー / V2資格情報）がある端末の挙動は1ビットも変えない
2. **新規ユーザーが同期不能にならない**。V2発行が失敗したら必ずlegacyへフォールバックし、従来どおり動く
3. **回復手段の後退を埋める**。legacyでは `?w=` がURL・履歴・ブックマークに残り事実上のバックアップだった。V2ではそれが無いため、引き継ぎコードを保存させる導線を必須で入れる

## 適用条件（この全てを満たすときだけV2で発行）

- URLに `?w=` が無い
- `wordsnap-sync-id:v1`（legacyキー）が未保存
- `wordsnap-sync-credential:v2` が未保存（pendingも含めて無い）
- `syncServerAvailable()` が true（`file://` ではない）
- `crypto.getRandomValues` が使える

1つでも欠けたら**従来の経路をそのまま通す**。とくに「legacyキーが保存済み」＝既存ユーザーなので、絶対に触らない。

## 発行フロー

```
資格情報を生成（roomId + secret, status:"pending", origin:"create"）
  → localStorage へ保存（永続化してから通信する。応答喪失時も同じ値で再試行できる）
  → PUT /api/wordsnap-state?room=<roomId>&create=1
      200 かつ validSyncPutResponse → status:"active" に更新。V2経路で同期開始
      503（受付停止）/ 429（制限）/ 5xx / 通信断 → pending を保持したまま legacy 発行へフォールバック
      403 → roomId のみ再生成して最大3回まで再試行、それでも駄目なら legacy フォールバック
```

**フォールバック時の扱い**: legacyキーを発行して通常どおり動かす。pending資格情報は残すが、activeでない限り通信経路は切り替わらない（Phase 1の既存仕様）。次回起動時に自動でV2へ昇格させることは**しない**（起動のたびに通信を増やさない。設定画面の「新方式で発行」から手動で再試行できる）。

## 回復手段のUX（この項目を落としたらPhase 2は不可）

1. **表示タイミング**: 起動直後ではなく、**初めて単語が保存され、同期が成功した直後**に引き継ぎコードを提示する（守る価値のあるデータができた瞬間）
2. **提示内容**: コード本体＋「これが唯一の引き継ぎ手段です。紛失するとこの端末以外からアクセスできません」＋ コピー / テキストで保存
3. **未確認バッジ**: コピーもダウンロードもしていない間、設定の該当セクションに注意を出し続ける。どちらかを実行したら消す（`wordsnap-v2-code-saved:v1`）
4. IndexedDBミラー（実装済み）はlocalStorage消去を救うが端末紛失は救わない。この導線は必須

## 既存UIとの整合（実装時の最大の危険）

現行UIの多くが `syncState.id`（legacyキー）を前提にしている。V2ネイティブユーザーでは legacyキーが存在しないため、以下を必ず洗い出して分岐すること:

- 「個人リンクをコピー」「共有リンク」まわり
- `updateSyncKeySecurityWarning(syncState.id)`（旧形式キーの警告）
- 別キー検出バナー（`foreignSyncId` / 切替確認）
- 設定の同期キー入力欄（表示・伏せ字トグル）
- 同期バッジの状態表示

**方針**: legacyキーが無いユーザーには「個人リンク」系UIを出さず、代わりに引き継ぎコード系UIを出す。`syncState.id` を空のまま参照して例外や誤表示が出ないことを、全経路で確認する。

## 後方互換とロールバック

- **旧クライアント**: 影響なし（新規発行の分岐はクライアント側の変更で、サーバー契約は不変）
- **ロールバック**: この分岐を戻せば新規ユーザーはlegacyに戻る。既に作成されたV2ネイティブroomは**そのまま使える**（`SYNC_V2_ENABLED` はcreate/upgradeのみを閉じ、既存roomの認可・GET/PUTには影響しない＝Phase 0で確認済み）
- **データ移行なし**。既存データの変換・コピーは一切行わない

## 受入条件

1. 保存済みlegacyキーがある端末の送信URL・localStorageキー集合・UI表示が**変更前と完全一致**（回帰テストで固定）
2. 新規ユーザー（全ストレージ空・`?w=`無し）でV2 roomが作成され、`?w=` がURLに付かない
3. V2発行が503/429/通信断のとき、legacyで正常に同期できる
4. 初回保存後に引き継ぎコードが提示され、コピー/保存するまで注意表示が残る
5. legacyキーを持たないユーザーで、`syncState.id` 依存のUIが例外・空表示・誤解を招く表示を出さない
6. `npm test` 全通過（現行95件＋追加分）

## 検証計画

- 隔離テスト（デプロイ別URL＝別オリジン）で「まっさらな新規ユーザー」を再現し、V2発行→単語保存→コード提示→別オリジンで合流までを通す
- 既存legacyユーザーを再現し、変更前後で送信URL・UIが不変であることを確認
- `SYNC_V2_ENABLED=0` 相当（503）を想定したフォールバック確認

---

# rev1 レビュー結果（2026-07-25 / Codex Advisor 敵対的レビュー）

**VERDICT: NO-GO。** 「資格情報が無いときだけV2発行し、失敗したらlegacyへフォールバックすれば既存影響ゼロ」という rev1 の仮説は成立しない。分岐の追加では済まず、**同期identityの再設計**が要る。

## 本番への影響: なし（確認済み）

現行の全ユーザーは初回起動時に必ずlegacyキーを発行済みで `syncState.id` が入っている。upgrade経由のPhase 1ユーザーも同様。**壊れるのは「legacyキーを一度も持たないユーザー」だけで、それは今日時点で存在しない。**

## BLOCKING（実装前に必ず解消）

1. **V2ネイティブでは通常同期が停止する（最重要）** — `activateV2Credential()` は `syncState.rev` / `connected` を設定するが `syncState.id` を設定しない。一方 `scheduleSyncPush()` は `!syncState.id` で即return。よってV2 create成功後も**単語保存が同期されない**。pull・履歴・強制同期・オンライン復帰も同様に停止。`syncState.id` の参照は45箇所。
   → 対処: `syncState.id` 直参照をやめ、「active V2資格情報 or legacyキー」を表す**同期identity/routeスナップショット**を導入し、push/pull/retry/履歴/強制操作/online復帰/起動接続の全ガードとstale判定を置換する。
2. **4秒起動フォールバックがIDB復元を妨害する** — 自動createがpendingをlocalStorageへ書くと、進行中の `recoverV2CredentialFromIdb()` が既存active資格情報を復元できなくなる（localStorage優先ガードが逆に働く）。さらにcreate成功でIDBの旧資格情報を上書きする。
   → 対処: IDB復元の確定後にだけ新規判定を許可する recovery barrier を設ける。復元未確定なら legacy に限定して開始。
3. **次回起動でlegacyキーが発行される** — 現行の起動経路はV2資格情報を見ず、`syncState.id` が空ならlegacyキーを生成し `?w=` をURLに載せる。Phase 2の目的（URLに秘密を載せない）が1リロードで崩れる。
   → 対処: Phase 2ネイティブであることを示すprovenanceを保存し、そのユーザーだけlegacy自動生成を抑止する。既存Phase 1 V2ユーザーには適用しない（「1ビット不変」を守るため `getActiveV2Credential()` 判定だけでは不十分）。
4. **V2ネイティブで `?w=` を開くと表示キーと実通信先が乖離する** — `foreignSyncId` 判定はlegacy IDとしか比較しない。他人のリンクを開くと切替バナーなしでそれを自分のlegacy IDとして保存・表示するが、実通信はV2 roomのまま。コピーされる「個人リンク」は偽の回復リンクになる。
5. **create応答喪失後のfallbackでデータ系列が分岐する** — V2 createは独立した新stateKeyを作る。応答喪失→legacyへfallback→そのlegacyで学習継続→後日同じpendingを再create、で**別系列**になる。
   → 対処: legacy fallback確定時点で origin=create の pending を破棄（再activation禁止）。後でV2へ移るなら、そのlegacyを対象に **upgrade** する。
6. **fallbackの失敗集合が網羅されていない** — 400/405/413/422、および200だが `validSyncPutResponse` 不成立が未定義。
   → 対処: active化は「200 かつ valid」のみ。403の限定再試行を除き、未知4xx・parse失敗を含む**全ケースでlegacy fallback**するcatch-all契約にする。
7. **回復UXが保全条件を満たさない** — `wordsnap-v2-code-saved:v1` が単一フラグだとroom切替後も旧フラグが残り新roomの警告が出ない。clipboardコピーだけでは端末外保存を保証しない。既に単語がある状態でcreateすると「初めて保存した後」イベントが発生しない。
   → 対処: 保存状態をroomIdに紐付ける。提示条件は「recovery-required かつ words>0 の最初の同期成功」。ダウンロード/JSON書き出しのみを保存完了とみなす。
8. **ロールバック境界が不足** — 全面revertするとネイティブユーザーにlegacyキーと `?w=` が生える。
   → 対処: ロールバック対象を「新規ユーザーの自動create判定」だけに限定する独立kill switchにし、identity対応と回復UIは残す。

## NON-BLOCKING

- 共有リンク経由の新規V2発行自体は意図どおり。ただしNAT環境（学校・社内・キャリア）でcreate 10回/時/IPに当たると11人目が429。完全fallbackされるので同期不能にはならないが、E2Eと監視は要る。
- 403衝突再試行はcreate枠に加えauth-fail枠も消費する。
- 「資格情報なし」判定は `readV2Credential() === null` ではなく**rawキーの不在**で行う（壊れたレコードも「保存あり」として自動createを止めないとIDB救済を妨害する）。
- V2ネイティブでは「URLに個人キーが含まれる」「個人リンクで引き継ぐ」等の文言が誤りになる。

## 判断メモ（Orchestrator）

BLOCKING#1 を自分でも検証し、事実であることを確認した（`activateV2Credential` に `syncState.id` 代入なし／`scheduleSyncPush` の `!syncState.id` 早期return／参照45箇所）。
rev1 は「小さな分岐追加」のつもりだったが、実際には**同期サブシステムのidentity再設計**であり、規模とリスクの見積もりが1桁違っていた。着手可否はコスト対効果として再判断が要る。
