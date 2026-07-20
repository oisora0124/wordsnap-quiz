# WordBank

英単語を取り込んでクイズで覚える学習ツール（PWA）。
単語と成績は利用者ごとの個人キーに紐づけてサーバー保存され、端末をまたいで引き継げます。

公開URL: https://wordbank.pages.dev
配布時の説明は [DISTRIBUTION.md](../DISTRIBUTION.md) を参照。

## 構成

- 静的サイト: `publish/`（アプリ本体は `publish/index.html` の単一ファイル）
- 保存API（**稼働中**）: `functions/api/wordsnap-state.js`
  — Cloudflare Pages Functions + D1。`rev` による原子的CAS、gzip+base64圧縮、差分同期に対応。

契約は `GET`/`PUT /api/wordsnap-state?sync=KEY`、`baseRev`/`stateRev` による楽観的排他、
競合時 409。（Netlify Blobs 版は非原子的CAS・圧縮非対応のまま停止していたため削除した。
必要になれば git 履歴から復元できる。）

## 編集時の注意

アプリ本体は `publish/index.html` を編集し、リポジトリ直下の `index.html` へコピーして
同期させる（2ファイルは同一内容を保つ）。

```
cp github-upload/publish/index.html index.html
```
