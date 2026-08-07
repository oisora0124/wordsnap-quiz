# 実DBでの結合テスト（2026-08-07）

## なぜ要ったか

契約テスト（`api-contract` / `telemetry-contract` / `feedback-contract`）は
`FakeD1` を使っている。これは**期待するSQLの意味を JavaScript で書き直したもの**で、
与えられたSQLを解釈していない。つまり次を全部通してしまう。

- 存在しない列・テーブルへのアクセス
- migrations の適用漏れ
- `ON CONFLICT` の対象列の間違い
- 制約違反（NOT NULL / UNIQUE / CHECK）

セキュリティレビューの **M7「結合テストが無い（FakeD1は実D1ではない）」** がこれで、
「サーバー側のスキーマを変更するときに再検討」と書かれていた。

## どう埋めたか

**`node:sqlite`**（Node 22以降の標準機能）で、npm依存を増やさずに本物のSQLiteを使う。

| ファイル | 役割 |
| --- | --- |
| `scripts/sqlite-d1.mjs` | 実SQLiteに D1 のAPI（`prepare`/`bind`/`first`/`run`/`all`/`batch`）をかぶせる薄い層 |
| `scripts/d1-integration.test.mjs` | migrations を実際に適用し、**本番の Functions をそのまま**動かす（10件） |

`migrations/*.sql` を番号順に本物のSQLiteへ適用してから、
`functions/api/*.js` の `onRequest` を実リクエストで呼ぶ。SQLは一切書き直していない。

## 効果（変異テストによる実測）

同じ壊し方を、契約テスト（FakeD1）と結合テスト（実SQLite）の両方に通した。

| 変異 | 契約(FakeD1) | 結合(実SQLite) |
| --- | --- | --- |
| 存在しない列へ INSERT する | 素通り | **検出** |
| SQLの構文を壊す | 検出 | 検出 |
| NOT NULL 制約に違反する値を入れる | 検出 | 検出 |
| migration からテーブルを消す（適用漏れの再現） | 素通り | **検出** |
| migration から列を消す | 素通り | **検出** |
| `ON CONFLICT` の対象列を間違える | 素通り | **検出** |
| 履歴テーブルの定義を狂わせる | 素通り | **検出** |

**FakeD1 が素通りさせる5件を、結合テストが全部捕まえる。**

## 何を検査しているか

- migrations が順に適用でき、テーブル6つ・索引4つになる
- migrations を**二重に適用しても壊れない**（`IF NOT EXISTS`。本番への再適用の根拠）
- 途中までしか適用していないと、そのテーブルを使うAPIが**実際に失敗する**（503）
- telemetry: 実DBへの書き込みと、保持期限の掃除が実SQLで効く
- telemetry: レート制限の `ON CONFLICT` が実SQLで正しく数える
- feedback: 実DBへ保存でき、列の制約を満たす
- 同期: PUT→GET で同じ状態が返る
- 同期: 楽観的排他（`baseRev` 不一致で409）が実DBで効く
- 同期: 履歴が積まれ、保持制約が効く
- 同期V2: room 作成が**単一トランザクション**で、`states` と `rooms` が揃う
  （片方だけできて孤児になる事故を防ぐ）

## SQLite と D1 の違い（ここでは埋まらないもの）

- ネットワーク越しの遅延・タイムアウト・**1クエリ30秒の上限**
- **DB単位の逐次処理**とキューの詰まり
- Cloudflare 側のエラー形（`D1_ERROR` など）
- 同時実行の競合

ここが守るのは **SQLとスキーマの正しさ**まで。上記は実D1でしか出ない。

## 実装上の注意

- `node:sqlite` は行を **null プロトタイプ**で返すが、D1 は通常のオブジェクトを返す。
  そのまま渡すと `assert.deepEqual` がプロトタイプ違いで落ち、
  「実装は正しいのにテストが落ちる」状態になる。ラッパー側で実物へ寄せてある。
- `batch()` は D1 と同じく**単一トランザクション**として実装した
  （1つでも失敗したら全部巻き戻る）。同期V2の作成がこれに依存している。
- `bind()` の `undefined` は `null` へ寄せる（D1 は `undefined` を受け付けない）。

## 実行

`npm test` / `npm run test:api` に同梱（10件）。`node:sqlite` は標準機能なので
追加インストールは不要で、実験的機能の警告も出ない。
