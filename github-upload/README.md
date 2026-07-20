# WordBank

英単語を取り込んでクイズで覚える学習ツール（PWA）。
単語と成績は利用者ごとの個人キーに紐づけてサーバー保存され、端末をまたいで引き継げます。

公開URL: https://wordbank.pages.dev
配布時の説明は [DISTRIBUTION.md](../DISTRIBUTION.md) を参照。

## 構成

- 静的サイト: `publish/`（アプリ本体は `publish/index.html` の単一ファイル）
- 保存API（**稼働中**）: `functions/api/wordsnap-state.js`
  — Cloudflare Pages Functions + D1。`rev` による原子的CAS、gzip+base64圧縮、差分同期に対応。
- 保存API（**未使用・旧**）: `netlify/functions/wordsnap-state.mjs`
  — Netlify Functions + Netlify Blobs。Netlify側のデプロイは停止済み。
  非原子的CASで圧縮にも未対応のため、使う場合はD1版に揃える必要がある。

どちらも同じ契約（`GET`/`PUT /api/wordsnap-state?sync=KEY`、`baseRev`/`stateRev` による
楽観的排他、競合時 409）を実装している。

## 編集時の注意

アプリ本体は `publish/index.html` を編集し、リポジトリ直下の `index.html` へコピーして
同期させる（2ファイルは同一内容を保つ）。

```
cp github-upload/publish/index.html index.html
```
