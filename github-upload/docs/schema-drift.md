# Functions と D1 スキーマの齟齬を検出する（2026-08-07）

## なぜ要るか

D1 はデプロイ時にSQLを検証しない。存在しないテーブルや列を参照していても
push は通り、**その API が呼ばれた瞬間に初めて失敗する**。

| 壊れる場所 | 利用者に起きること |
| --- | --- |
| `states` / `state_revisions` / `rooms` | 同期が落ちる。データは端末に取り残される |
| `feedback` | 要望が黙って消える（送信側は成功に見える） |
| `telemetry` | 障害の記録が残らない＝気づく手段が減る |
| `rate_limits` | 上限判定が例外になり、経路ごと落ちる |

既存の契約テスト（`api-contract` など）は FakeD1 で**振る舞い**を見ているが、
FakeD1 は与えられたSQLをそのまま解釈するわけではないので、
「そのテーブルと列が本当に定義されているか」は誰も見ていなかった。

## 何を見ているか

`scripts/schema-drift.test.mjs`（`npm test` / `npm run test:api` に同梱、12件）。

1. `functions/api/*.js` の `.prepare(...)` に渡すSQLが参照するテーブルが、
   すべて `migrations/*.sql` に定義されている
2. `INSERT INTO t (...)` が並べる列が、すべてその定義に存在する
3. `WHERE` / `SET` で `列 = ?` の形に使う列が、定義に存在する
   （テーブルが1つに定まる文だけを対象にする）
4. `テーブル.列` / `別名.列` の参照が、すべて定義に存在する
   （`FROM state_revisions AS daily_row` のような別名を解決してから照合する）
5. `ON CONFLICT(...)` の対象列が、その表の定義に存在する
6. `SET` の代入先の列が、その表の定義に存在する
   （`DO UPDATE SET window_start = CASE …` は修飾も `= ?` も無いので、
   これまでどの検査も触れていなかった）
7. 単一表の `SELECT` が並べる列が、定義に存在する
   （関数呼び出しや `*` を含む選択リストは意味が広いので対象外）
8. `schema.sql` と `migrations/0001_initial.sql` のテーブルが一致する
9. `migrations/` のファイル名が飛びや重複のない連番である
10. `migrations/` に `DROP TABLE` / `DROP COLUMN` / `TRUNCATE` / `DELETE FROM` が無い
   （既存利用者のデータ保全が最優先。取り返しのつかない操作を混ぜない）

## SQLの取り出し方（ここで2回つまずいた）

**ファイル全体を正規表現で舐めてはいけない。** `functions/api/wordsnap-state.js`
には、JSの正規表現リテラルの中に `FROM state_revisions` や
`INSERT .* INTO states` といった文字列が実在する。これを拾うと、
SQLでない場所を検査してしまう。

**`.prepare(` の直後の文字列リテラルだけを見るのでも足りない。**
`wordsnap-state.js` には

```js
db.prepare(includeState ? "SELECT state, rev, updatedAt FROM states …" : "SELECT …")
```

のように三項演算子で切り替えている箇所があり、直後だけを見ると**丸ごと取りこぼす**。
検査したつもりで何も見ていない状態になるので、いまは `.prepare( … )` の
**引数全体**を括弧の対応で切り出し、その中の文字列リテラルを全部拾っている。
テンプレートリテラルの `${...}` は値の埋め込みなので落とす。

抽出漏れが再発しないよう、「`.prepare(` の出現回数に対して取り出せたSQLが
足りているか」と「三項演算子の中のSQLを実際に拾えているか」もテストにしてある。

## いまのスキーマ

`schema.sql` は「最初の1枚」で、以後の変更は `migrations/` にある。

| migration | テーブル |
| --- | --- |
| `0001_initial.sql` | `states` |
| `0002_state_revisions.sql` | `state_revisions` |
| `0003_feedback.sql` | `feedback` |
| `0004_auth_v2.sql` | `rooms`（同期V2） |
| `0005_rate_limits.sql` | `rate_limits` |
| `0006_telemetry.sql` | `telemetry` |

`rate_limits` は4つの経路（同期・フィードバック保存・フィードバックメール・
テレメトリ）が共有し、いずれも**期限切れの行を毎回掃除**している。
IPごとに1行増える作りなので、掃除が消えると行が滞留する。

## 検査が空振りしていないことの確認

15通りの壊し方を試し、すべて検出することを確認済み。
存在しないテーブルの参照（三項演算子の中も含む）、存在しない列への `INSERT`、
存在しない列での絞り込み（`= ?` と `LIKE ?`）、`ON CONFLICT` が存在しない列を指す、
`テーブル.列` と `別名.列` で存在しない列を参照する、`SET` の代入先の誤記、
単一表 `SELECT` の列の誤記、migration からのテーブル定義の削除、
`DROP TABLE` の混入、`schema.sql` と `0001` の食い違い、連番の飛び。

**偽陽性でゲートを止めないこと**も確認してある。CTE（`WITH recent AS (…)
SELECT … FROM recent`）を含む正当なSQLを一時的に足しても検査は通る。

### 検査の穴は、自分の変異テストでは見つからなかった

上の 4〜7（別名解決・`SET` 左辺・単一表 `SELECT`・`LIKE ?`）と、
CTE を弾いてしまう偽陽性、migrations のブロックコメント内の `DROP TABLE` で
落ちる偽陽性は、**自分の変異テストが全部OKになった後に
Codex の独立レビューが指摘した**もの。
変異テストは「自分が想像した壊し方」しか試せない。

## 見ていないこと（意図的な限界）

- **実D1との結合**。SQLの構文エラー、制約違反、マイグレーションの適用漏れは
  ここでは分からない。本番のD1に対する結合テストは持っていない。
- 列の型・NOT NULL・CHECK 制約の整合。名前の存在しか見ていない。
- `SELECT` が返す列名の、JS側での使われ方。
- 関数呼び出しや `*` を含む選択リスト、`ORDER BY` / `GROUP BY` / `JOIN … ON` の列。
- `INSERT INTO t VALUES (…)`（列名を省略する形）と `INSERT … SELECT`。
  現行のコードには無いが、書かれても検査されない。
- 動的に組み立てたSQL（`${table}` など）。構造が静的に決まらないため。
- migrations 側の前提: 1行1列・`);` の前に改行・行コメントのみ。
  quoted identifier やブロックコメント、`ADD COLUMN IF NOT EXISTS` は扱えない。
- `schema.sql` と `0001` の比較はテーブル名だけ。列・制約・INDEX の差は見ない。
