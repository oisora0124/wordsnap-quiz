# V2 Phase 2 段階実行計画（rev1 NO-GO を受けて）

- 制定: 2026-07-25
- 方針: **正確さ最優先。段階数は問わない。** 各段階は単独でデプロイ・検証・ロールバック可能にする
- 前提: `sync-v2-phase2-design.md` の rev1 レビュー結果（BLOCKING 8件）

## 全体像

```
段階1  同期identityの抽象化           ← 挙動完全不変。ユーザーに変化なし
段階2  V2ネイティブ状態の「表現」対応   ← まだ生成しない。ユーザーに変化なし
段階3  起動時レースの解消（IDB復元バリア）← ユーザーに変化なし
段階4  回復UX（引き継ぎコード保存導線） ← ネイティブ限定。既存V2には適用しない
段階5  新規ユーザーの自動V2発行         ← ここで初めて挙動が変わる。独立kill switch
```

段階5だけが挙動を変える。1〜4が全て安定してから着手する。

## 段階1: 同期identityの抽象化（BLOCKING#1）

**目的**: `syncState.id` の直参照（45箇所）をやめ、「active V2資格情報 or legacyキー」を表す単一の真実へ集約する。

**なぜ今の状態が危険か**: `syncState.id` が事実上の同期identityになっているが、V2 activeでも設定されない。今は全ユーザーがlegacyキーを持つため露見しないだけで、identityとキーが同一視されている設計上の弱点。

**やること**:
- `syncIdentity()` を導入し、`{kind, legacyId, roomId, secret, expectedSyncId, endpoint}` を返す
- push/pull/retry/履歴/強制操作/online復帰/起動接続の全ガードとstale判定を、この1つのスナップショットから決める

**挙動不変の根拠**: 現在到達可能な状態は「legacyのみ」「legacy+V2 pending」「legacy+V2 active」の3つだけ。いずれも `legacyId` が存在するため、identity経由に置き換えても出力は同一になる。差が出るのは「legacyなしV2」＝**今は生成不可能な状態**のみ。

**ゲート（着手前に用意する）**:
1. 到達可能な3状態それぞれについて `syncEndpoint()` / `syncHeaders()` / `expectedSyncId` を固定する契約テスト
2. リファクタ後の静的検査: `syncState.id` の読み取りが identity モジュールの外に存在しないこと
3. ブラウザ実機: legacyユーザーとupgrade済みV2ユーザーで、変更前後の送信リクエストが一致

**ロールバック**: この段階単独でrevert可能（挙動不変なので戻しても誰も影響を受けない）

## 段階2: V2ネイティブ状態の「表現」対応（BLOCKING#3, #4 の一部）

**目的**: `legacyId` を持たないidentityを、UI・URL生成・比較・警告文まで含めて正しく扱えるようにする。**この段階ではその状態を生成する経路は作らない。**

- 起動時のlegacy自動生成を、provenance（Phase 2ネイティブ印）がある場合だけ抑止
- `foreignSyncId` 判定をidentity基準にし、V2ネイティブが `?w=` を開いたら明示確認を出す
- 「個人リンク」「URLに個人キーが含まれます」等の文言をネイティブでは引き継ぎコード系へ差し替え
- **既存Phase 1 V2ユーザー（legacy+V2）には一切適用しない**

**検証**: テストとブラウザで資格情報を手動注入してネイティブ状態を作り、UI・通信を確認する（生成経路なしで検証できる）

## 段階3: 起動時レースの解消（BLOCKING#2）

- IDB復元が確定するまで「新規ユーザー」判定を行わせない recovery barrier
- 4秒フォールバック側ではV2資格情報を一切発行しない
- 遅延IDBの障害注入テストを追加

## 段階4: 回復UX（BLOCKING#7）

- 保存済みフラグを **roomIdに紐付ける**（単一booleanをやめる）
- 提示条件: 「recovery-required かつ words>0 の最初の同期成功」。create時点で既に単語がある場合も即提示
- **ダウンロード/JSON書き出しのみを「保存完了」とみなす**（clipboardコピーだけでは消さない）
- ネイティブ限定。既存V2ユーザーへretroactiveに適用しない

## 段階5: 新規ユーザーの自動V2発行（BLOCKING#5, #6, #8）

- 「資格情報なし」判定は **rawキーの不在**で行う（壊れたレコードも「保存あり」扱い）
- active化は **200 かつ validSyncPutResponse** のみ。403の限定再試行を除き、未知4xx・413・422・parse失敗を含む**全ケースでlegacy fallback**（catch-all）
- legacy fallback確定時点で origin=create の pending を **破棄**（後日の再createで別系列に分岐するのを防ぐ）。以後V2へ移るならそのlegacyを **upgrade** する
- **独立kill switch**（`wordsnap-v2-native-default` 相当）で、ロールバックは分岐の無効化のみ。段階1〜4は残す
- NAT環境（create 10回/時/IP）で429になるE2Eを実施

## 共通ルール

- 各段階で `npm test` を通し、既存ユーザー不変の回帰テストを恒久ゲートに積み増す
- 各段階のデプロイ後、本番で legacy / upgrade済みV2 の両方が正常であることを確認してから次へ
- 高リスク判断が出たら Advisor へエスカレート。3回失敗したら Fable 5（F-2）
