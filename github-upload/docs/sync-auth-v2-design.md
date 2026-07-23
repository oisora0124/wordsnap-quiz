# 同期認可 V2 設計書（キーとIDの分離＋HMAC化）

Status: rev4（実装可・修正後GOの残2点を反映）/ Codex第2回レビュー(2026-07-24)の残指摘を反映。
rev2からの主変更: timing-safe比較の明文化、資格情報のpending/active分離、V2受付フラグ既定OFF、V2のforce契約、upgrade送信契約の固定、V2資格情報の復旧経路。
rev1からの主変更: shadow room対策、V2作成契約、upgrade冪等化、Phase 2の旧クライアント保護、Phase 3凍結、ロールバック方針の現実化。

## 背景と課題（セキュリティ監査 High①・Low⑨）

現行の同期は `ws_` + 60hex（240bit乱数）の**単一キーが「領域ID」と「認可秘密」を兼ねる**。

- キーはURL（`?w=`）・クエリ（`?sync=`）・localStorage・D1（平文PK）に存在する
- キーを知る者は読取・履歴取得・強制上書き（baseRev省略）まで全操作が可能
- クライアントは `x-room-key` ヘッダを送っているが、サーバーは検証していない

## 設計原則（絶対条件）

1. **legacy経路（`?sync=`）は仕様・入力集合・応答を無期限で不変**。prefix判定でのlegacy識別はしない（`cleanSyncId` は任意英数IDを受理しており、`ws_` 以外の既存IDが存在しうるため）
2. 旧クライアント（SW更新前・休眠端末）は**何年後に起動しても**従来どおり動く。legacy経路への428/403の後付け施行は**永久に行わない**
3. V2は**追加**であり置換ではない。ロールバック＝「V2の新規受付停止（環境変数フラグ）」。V2利用開始後のコードrevertは既存V2ユーザーを壊すため行わない（forward-fix原則）
4. 秘密はURL・クエリに載せない。D1に平文で保存しない
5. upgradeは「利便性のための資格情報追加」であり**漏洩修復ではない**。漏洩時の修復は既存の「新しいキーへ引っ越し（issueNewSyncId＝別領域コピー）」を使う。UI文言もそう区別する

## 用語とフォーマット

- **roomId**: 領域の公開識別子。`wr_` + 32hex（**128bit**）。V2経路では `/^wr_[0-9a-f]{32}$/` で厳格検証
- **secret**: 認可秘密。`wk_` + 60hex（240bit）。**常にクライアントが生成**。`x-room-key` ヘッダでのみ送信
- **stateKey**: D1内部の行キー。`v2:` + 32hex（クライアントへ一切公開しない代理キー）。`state_revisions` は従来どおりこのstateKeyを参照する＝**履歴の孤立は構造的に起きない**
- **authHash**: `HMAC-SHA256(K[kid], "wordsnap-sync-auth-v2\0" + roomId + "\0" + secret)` のhex。用途分離・room結合・鍵バージョン付き
- **鍵リング**: 環境変数 `SYNC_AUTH_SECRETS` = JSON `[{"kid":"k1","secret":"<32byte+>"}]`。先頭が現行鍵。検証は全kidで試行し、旧kidで一致したら現行kidで**lazy re-hash**。ローテーション＝先頭に新鍵を追加（旧鍵は当面残す）

## D1スキーマ（0004_auth_v2.sql）

```sql
-- V2領域テーブル。legacyのstatesには一切触れない（ALTERもしない）
CREATE TABLE IF NOT EXISTS rooms (
  room_id   TEXT PRIMARY KEY NOT NULL,   -- wr_...（公開ID）
  state_key TEXT NOT NULL UNIQUE,        -- states.key への内部参照（v2:...）
  auth_hash TEXT NOT NULL,
  auth_kid  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  upgraded_from_legacy INTEGER NOT NULL DEFAULT 0
);
```

- states/state_revisions は**無変更**。V2は `rooms.room_id → state_key` を解決した後、既存の読み書き・履歴・CAS関数をそのまま使う
- legacy行のupgrade時も states.key は不変（平文legacyKeyのまま）。dual-acceptに必要であり、Phase 3（平文縮退）は**本設計から除外・凍結**（実施するなら `last_legacy_at` 追加とimmutable ID化を含む別設計で再レビュー）

## サーバーAPI（V2経路の追加。legacy経路は1行も変更しない）

共通: `?room=wr_...` + ヘッダ `x-room-key: wk_...`（**raw secretをヘッダで送る。クライアント側でハッシュ化しない。HMAC計算はサーバーのみ**）。認可失敗・room未存在は**同一の403**（未存在時もダミーHMAC計算を行い時間差を抑える）。

**認可判定の実装要件**: 提示secretから計算したHMACと保存 `auth_hash` の比較は、両者を固定長byte列にデコードした上で `crypto.subtle.timingSafeEqual()` で行う。**文字列の `===` / インデックス比較は禁止**（HMAC化してもtiming leakは比較方法で生じるため）。デコード失敗・長さ不一致は比較前に403。

**受付フラグ**: 環境変数 `SYNC_V2_ENABLED`。未設定/OFF時は create と upgrade のみ503（**既存V2 roomの認可・GET/PUT/履歴は影響を受けない**）。`SYNC_AUTH_SECRETS` 未設定時はV2経路全体が503（legacyは無関係に動作）。

1. **作成**: `PUT ?room=...&create=1` + `x-room-key` + body `{state: <初期state>, learningSchemaVersion}`（現行PUTと同形。baseRev不要）。応答は現行PUT応答と同形＋`syncId: roomId`。**クライアントの新規発行フローはGET-firstではなく、資格情報生成→create→成功後にactive化**（下記ライフサイクル）
   - **原子性の契約**: 先に `SELECT` で room_id を照合。存在すれば authHash とtiming-safe照合し、一致=200（冪等リトライ。既存stateは返さず `{ok, syncId, stateRev}` のみ）／不一致=403、**書き込みは一切しない**。未存在なら `db.batch([states行INSERT, rooms行INSERT])` の**単一バッチ（=単一トランザクション）**で両行を書く。rooms側は `ON CONFLICT` を付けない素のINSERTにし、並行createとの競合時は制約違反で**バッチ全体が失敗**（states孤児行を作らない）→ 再SELECTして冪等判定へフォールバック。stateKey衝突も同様にバッチ失敗→stateKey再生成でリトライ
2. **GET/PUT/履歴/復元**: 認可後、stateKeyで既存経路を呼ぶ。**応答の `syncId` フィールドには roomId を入れる**（現クライアントの `validSyncGetResponse/validSyncPutResponse` が syncId 一致を必須とするため。契約テストで固定）
3. **強制上書き**: V2では初日から `?force=1` 必須（baseRev省略+forceなし＝422）。クライアントのV2エンドポイント生成は、`forcePushOverwrite` / `restoreFromRevision` 経路で `force=1` を付与する（該当2関数の改修をPhase 1のクライアント作業に含める）。**legacy経路のbaseRev省略の受理は無期限で不変**（rev1のPhase 2「90日後に428」は撤回。旧クライアントの消滅は判定不能）
4. **upgrade**: `PUT ?sync=<legacyKey>&op=upgrade` + ヘッダ `x-room-key: <新secret>` + body `{roomId}`（secretの導出値をbodyに入れない）。
   - **クライアントが** roomId/secret を生成し、**localStorageへ永続化してから**呼ぶ（応答喪失・保存失敗でも同じ値で何度でも再試行できる冪等設計。サーバーがsecretを発行・返却することはない）
   - サーバー: `INSERT INTO rooms(room_id, state_key=<legacyKey>, auth_hash, ...)`（素のINSERT。`UNIQUE(state_key)` と room_id PK の制約違反はエラーコードで区別して下表へ変換）
   - **判定表（全ケースを網羅。「一致」は常にtiming-safe比較）**:
     | 状況 | 判定 | 応答 | クライアント動作 |
     |---|---|---|---|
     | legacyKey未upgrade・roomId未使用 | INSERT成功 | 200 | pending→active |
     | 同一legacyKey・同一roomId・secret一致 | 冪等リトライ | 200 | pending→active |
     | 同一legacyKey・同一roomId・secret不一致 | 認可不正 | 403 | pending破棄・legacy継続 |
     | 同一legacyKeyが別roomIdでupgrade済み | 他端末が先行 | 409 `already-upgraded` | pending破棄・legacy継続・「引き継ぎコードで合流」案内 |
     | 別のlegacyKeyが同一roomIdを使用中（衝突） | roomId衝突 | 409 `room-taken` | **roomIdのみ再生成**して再試行（secretは維持。破棄しない） |
   - **active化の条件**: 応答200かつ `syncId === roomId` のときのみ。それ以外でpendingを自動的にactiveにしない
   - 注: legacyKeyを知る攻撃者はupgradeを先取りできるが、それは「攻撃者が既に全権限を持つ」現状と等価であり、upgradeで悪化しない（漏洩修復は引っ越しフロー）

## クライアント設計

- **資格情報の保存（shadow room対策の核心）**: V2資格情報は新規キー `wordsnap-sync-credential:v2` に `{v:2, status, roomId, secret}` を1レコードで保存。既存の `SYNC_ID_KEY`（wordsnap-sync-id:v1）と `SYNC_ACCESS_KEY` は**legacy専用のまま一切流用しない**。旧コード（SW更新前）はv2キーを読まないため、roomIdを `?sync=` に流し込む事故（shadow room／V2領域のlegacy公開）が構造的に起きない
- **資格情報ライフサイクル（pending/active）**:
  - `status: "pending"` で保存してから create / upgrade を呼ぶ。**サーバー200を受けて初めて `"active"` に更新**
  - 通信の優先順位は「**activeなv2資格情報があればV2、なければlegacy**」。pendingは通信経路を切り替えない（起動時にpendingが残っていてもlegacyで正常動作し、次の明示操作時に同じ値で再試行）
  - upgrade/createが**確定403/409**（別roomId競合＝他端末が先に移行済み、または認可不一致）を返したら、pending資格情報を破棄してlegacy継続＋「他の端末で移行済みです。引き継ぎコードで合流してください」を表示。ネットワークエラー・5xxでは破棄しない（再試行可能なまま）
- V2資格情報の復旧経路: localStorage消去時は引き継ぎコード（`wr_xxx.wk_xxx`）が唯一の復旧手段。移行/発行完了画面とその後の設定画面で「このコードを必ず控えてください（紛失するとデータに二度とアクセスできません）」を明示し、コピーとダウンロード（テキストファイル）の両方を提供する
- **新規発行**: 今後も既定はlegacyのまま（安全に倒す）。設定に「新方式（V2）で発行」を追加し、十分な運用実績後に既定をV2へ切替（別リリース判断）
- **移行UI**: 設定「データの保存・引き継ぎ」内に「新方式へ移行」。移行後の引き継ぎコードは `wr_xxx.wk_xxx` 形式の1文字列（設定画面からいつでも再表示可＝R1解決）。他端末はコード貼り付けで合流
- `?key=`・`?w=` にV2 secretを載せる経路は作らない。URL経由の引き継ぎはlegacy専用のまま
- V2でも `x-room-key` 送信は既存の `syncHeaders()` を流用

## フェーズ構成（各フェーズ独立デプロイ・独立判断）

- **Phase 0**: 0004適用＋サーバーにV2経路追加（クライアント無変更）。**`SYNC_V2_ENABLED` は未設定＝create/upgrade閉鎖のままデプロイ**するため、レート制限未設定でも無制限createは公開されない。リリースゲート: legacy経路の全契約テストがPhase 0前後でバイト同一
- **Phase 1**: レート制限設定を確認後に `SYNC_V2_ENABLED=1`。クライアントにv2資格情報・移行UI・V2通信を追加（既定発行はlegacyのまま）
- **Phase 2**: 運用実績を見て新規発行の既定をV2へ。**legacyの縮退はしない**
- （旧Phase 2の強制上書き猶予→428、旧Phase 3の平文縮退は撤回・凍結）

## リリース前提条件（コード外）

- Cloudflareダッシュボードでのレート制限（V2作成・認証失敗・upgrade）。**これが未設定の間は `SYNC_V2_ENABLED` を有効化しない**（フラグ既定OFFにより、設定漏れでも受付は開かない）
- `SYNC_AUTH_SECRETS` の設定と、鍵ローテーション手順書（漏洩時: 新kid追加→lazy rehash進行→旧kid削除は十分期間後）

## テスト計画

1. legacy経路スナップショット（Phase 0前後でバイト同一。以後の全リリースの恒久ゲートに昇格）
2. V2: create冪等（同資格情報リトライ200/別資格情報403）→GET→PUT(CAS)→409→force→履歴→復元、応答 `syncId===roomId`
3. upgrade: 冪等再試行、並行upgrade（同一legacyKeyへ別roomId=409。SQLite UNIQUE制約例外を409へ変換）、dual-accept下でlegacyとV2が同一rev系列を共有、応答喪失シミュレーション（保存済みpending資格情報で再試行成功）、確定409でのpending破棄とlegacy復帰、5xxでのpending保持
4. 認可: 誤secret/未存在room/形式不正が同一403、SECRET未設定時V2のみ503でlegacy無影響、鍵リングのkid移行とlazy rehash
5. クライアント: 旧コード相当（v2キーを知らない読み手）がv2資格情報保存後もlegacyで正常動作すること（shadow room回帰テスト）、`?sync=` 入力集合の不変
6. 障害注入: upgrade中のfetch中断・localStorage書込失敗・D1一時エラーで资格情報不整合が起きないこと
7. ロールバック演習: V2受付停止フラグON時に、既存V2ユーザーの読み書きが継続すること（新規作成のみ503）

## 運用手順（ユーザー作業）

1. Phase 0前: `npx wrangler pages secret put SYNC_AUTH_SECRETS`（JSON鍵リング）
2. `npx wrangler d1 migrations apply wordbank --remote`（0004: roomsテーブル作成のみ。既存テーブル無変更）
3. ダッシュボードでV2系エンドポイントのレート制限を設定（Phase 1前に必須）
4. 各Phase後のsmoke: 既存キーGET/PUT 200、V2 create→PUT→GET 200

## 解決済みの旧・未決事項

- R1: secretは設定画面からいつでも再表示可（サーバー再発行は無し）
- R2: legacyへの428施行は撤回（旧クライアント消滅は判定不能）
- R3: state_revisionsはstateKey参照を維持（V2は代理キー、legacyは従来キー）。移行不要
- R4: roomId公開は条件付き採用（128bit・厳格検証・secretは絶対にURL不可・legacy名前空間と完全分離）
