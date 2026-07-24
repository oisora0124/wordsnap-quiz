# WordBank 匿名利用統計・エラー監視

## 収集する項目

`telemetry` テーブルには次の項目だけを保存します。

- `kind`: `usage`（利用回数）または `error`（ブラウザ上の未処理エラー）
- `name`: 固定の機能ID、または120文字以内のエラーメッセージ
- `detail`: エラーのstackなど（最大600文字）。利用回数では空文字
- `count`: 同じ機能IDを端末内でまとめた回数
- `app_rev`: クライアントの版を示す40文字以内の文字列
- `created_at`: 受信日時（Unix時刻、ミリ秒）

利用回数の機能IDは、クイズ回答、フラッシュカード回答、OCR実行、AI抽出、JSON入出力、同期V2への移行・発行、ツール共有、学習記録パネル、チュートリアル完了の固定値です。単語、訳、成績、単語帳名などからイベント名を作ることはありません。

## 匿名性の設計

- `telemetry` 行にはIPアドレスとUser-Agentを保存しません。
- 1日60リクエストの制限に使うIPアドレスは、既存の `rate_limits` テーブルの `telemetry:<IP>` キーにだけ含まれます。`telemetry` テーブルとは結合せず、閲覧用SQLにも使用しません。
- 同期の個人キーに一致する `ws_`、`wk_`、`wr_`（および仕様上の `w_`）＋16桁以上の16進文字列は、クライアントとサーバーの両方で `[redacted]` に置き換えます。
- エラー内のURLクエリと `?w=` の値も送信前・保存前に除去します。
- 読み出しAPIはありません。閲覧できるのは、Cloudflareアカウントの権限を持つ開発者がD1へ直接SQLを実行した場合だけです。
- 利用回数は端末内で集計し、原則1日1回にまとめて送ります。通信失敗は画面に出さず、学習機能を止めません。

## オプトアウト

設定の「データの保存場所と削除について」で「匿名の利用統計とエラー情報の送信をOFFにする」を有効にすると、以後は利用回数もエラー情報も送信しません。設定は `localStorage` の `wordsnap-telemetry-optout:v1` に保存されます。

OFFにした時点で未送信の利用回数とエラー監視の日次状態も端末から削除します。再びONにした場合は、ONに戻した後の操作だけを新しく集計します。

## 開発者向け閲覧SQL

以下は直近30日を対象にする例です。`created_at` はミリ秒なので、SQLiteの秒単位時刻に `1000` を掛けます。

利用回数の多い機能:

```sh
npx wrangler d1 execute wordbank --remote --command "SELECT kind, name, SUM(count) AS total FROM telemetry WHERE created_at > (unixepoch('now', '-30 days') * 1000) GROUP BY 1, 2 ORDER BY 3 DESC"
```

直近のエラー一覧:

```sh
npx wrangler d1 execute wordbank --remote --command "SELECT datetime(created_at / 1000, 'unixepoch') AS occurred_at, name, detail, app_rev FROM telemetry WHERE kind = 'error' ORDER BY created_at DESC LIMIT 100"
```

エラー種別ごとの件数:

```sh
npx wrangler d1 execute wordbank --remote --command "SELECT name, SUM(count) AS total, MAX(datetime(created_at / 1000, 'unixepoch')) AS last_seen FROM telemetry WHERE kind = 'error' AND created_at > (unixepoch('now', '-30 days') * 1000) GROUP BY name ORDER BY total DESC"
```

利用回数の日別推移:

```sh
npx wrangler d1 execute wordbank --remote --command "SELECT date(created_at / 1000, 'unixepoch') AS day, name, SUM(count) AS total FROM telemetry WHERE kind = 'usage' AND created_at > (unixepoch('now', '-30 days') * 1000) GROUP BY day, name ORDER BY day DESC, total DESC"
```

エラーの日別推移:

```sh
npx wrangler d1 execute wordbank --remote --command "SELECT date(created_at / 1000, 'unixepoch') AS day, SUM(count) AS errors FROM telemetry WHERE kind = 'error' AND created_at > (unixepoch('now', '-30 days') * 1000) GROUP BY day ORDER BY day DESC"
```
