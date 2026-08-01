# WordBank

英単語を取り込んでクイズで覚える学習ツール（PWA）。
単語と成績は利用者ごとの個人キーに紐づけてサーバー保存され、端末をまたいで引き継げます。

公開URL: https://wordbank.pages.dev
配布時の説明は [DISTRIBUTION.md](../DISTRIBUTION.md) を参照。

## 構成

- 静的サイト: `publish/`（アプリ本体は `publish/index.html` の単一ファイル）
- 保存API（**稼働中**）: `functions/api/wordsnap-state.js`
  — Cloudflare Pages Functions + D1。`rev` による原子的CAS、gzip+base64圧縮、差分同期に対応。
- D1初期スキーマ: `schema.sql`

契約は `GET`/`PUT /api/wordsnap-state?sync=KEY`、`baseRev`/`stateRev` による楽観的排他、
競合時 409。（Netlify Blobs 版は非原子的CAS・圧縮非対応のまま停止していたため削除した。
必要になれば git 履歴から復元できる。）

## 編集時の注意

アプリ本体は `publish/index.html` を編集し、次のコマンドでリポジトリ直下の
`index.html` へ同期させる（2ファイルは同一内容を保つ）。

```
cd github-upload
npm run sync:html
```

コマンドはコピー後に内容一致も確認する。公開前の `npm test` でも不一致を拒否する。

## バージョンを進める

`publish/` か `functions/`（＝利用者に届く配信物）を変えたら、**同じコミットで
バージョンを1つ進める**。進め方と現在地は [docs/VERSIONS.md](docs/VERSIONS.md) にある。
設計書やテストだけの変更では進めない。

更新する3か所（値はすべて同じ）:

1. `package.json` の `version`
2. `publish/index.html` のフッター表示 `app-footer-version`
3. `publish/index.html` の `APP_REV`（テレメトリの `app_rev` として送られる）

そのうえで `docs/VERSIONS.md` の表の先頭に1行足す。ズレは `npm test` が、
進め忘れは CI の `scripts/check-version-bump.mjs` が落とす。

## 公開前チェック

Node.js 18以降で、外部パッケージを追加せずに公開物の整合性を確認できます。

```bash
cd github-upload
npm test
```

この検査は、ルート版と公開版の一致、manifestとアイコン、Service Workerの参照、
単一HTML保存処理、`_headers`の個人キー漏えい防止、D1スキーマとAPIの基本契約、
秘密情報の誤混入を確認します。

## D1の初期構築

Cloudflare PagesプロジェクトでD1データベースを作成し、`schema.sql` を一度適用した後、
Pages FunctionsのD1バインディング名を `DB` に設定します。既存環境へ再適用しても
`CREATE TABLE IF NOT EXISTS` のため既存データは削除されません。

GitHubの `main` をCloudflare Pagesへ接続している現在の運用では、変更をpushすると
`publish/` と `functions/` がデプロイ対象になります。push前に必ず `npm test` を実行します。

pushされた内容は GitHub Actions（`.github/workflows/release-checks.yml`）でも
`npm run sync:html` の差分確認と `npm test` を回します。ただし**それだけでは
デプロイは止まりません**。止めるには GitHub の Settings → Branches → `main` の
必須チェックに `release-checks / test` を指定してください（リポジトリ設定なので
コードには含められません）。
