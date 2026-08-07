# WordBank

英単語を取り込んでクイズで覚える学習ツール（PWA）。
単語と成績は利用者ごとの個人キーに紐づけてサーバー保存され、端末をまたいで引き継げます。

公開URL: https://wordbank.pages.dev
配布時の説明は [DISTRIBUTION.md](../DISTRIBUTION.md) を参照。

## 構成

- 静的サイト: `publish/`（アプリ本体は `publish/index.html` の単一ファイル）
- 保存API（**稼働中**）: `functions/api/wordsnap-state.js`
  — Cloudflare Pages Functions + D1。`rev` による原子的CAS、gzip+base64圧縮、差分同期に対応。
- D1スキーマ: `migrations/0001_initial.sql` 〜 `0007_telemetry_created_at.sql`
  （`schema.sql` は最初の1枚と同じもの。**これだけでは足りない** — 下記「D1の初期構築」参照）

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

一部だけ回すなら:

| コマンド | 対象 |
| --- | --- |
| `npm run test:api` | 同期・フィードバック・テレメトリのAPI契約、D1スキーマの齟齬 |
| `npm run test:quiz` | クイズ・学習アルゴリズムの不変条件 |
| `npm run test:a11y` | アクセシビリティ（静的検査＋モーダルのフォーカス） |
| `npm run test:sw` | Service Worker の契約 |
| `npm run test:scale` | 語数が増えたときの計算量 |
| `npm run check` | 公開物の整合性のみ（`check-release.mjs`） |
| `node scripts/serve-local.mjs` | 実ブラウザ検証用に `publish/` を配信（本番と同じヘッダ） |

### なぜそう検査しているかの記録

壊れ方が分かりにくい箇所は、経緯を残してあります。

| 文書 | 内容 |
| --- | --- |
| [docs/csp-hashes.md](docs/csp-hashes.md) | ハッシュ型CSP。**壊れてもローカルでは何も起きず、本番だけが壊れる** |
| [docs/service-worker.md](docs/service-worker.md) | キャッシュの契約。過去に個人キーが端末に残る不具合を踏んでいる |
| [docs/schema-drift.md](docs/schema-drift.md) | Functions と D1 スキーマの齟齬。実行時エラーとしてしか現れない |
| [docs/accessibility.md](docs/accessibility.md) | 自動で見ている範囲と、人が見るしかない範囲 |
| [docs/scale-guard.md](docs/scale-guard.md) | 語数が増えたときの計算量。二次に落ちても機能は正しく動く |
| [docs/data-retention.md](docs/data-retention.md) | サーバー側データの保持方針。**進捗は休眠を理由に消さない** |
| [docs/d1-integration.md](docs/d1-integration.md) | 実SQLiteでの結合テスト。FakeD1が素通りさせる5種を捕まえる |
| [docs/browser-e2e.md](docs/browser-e2e.md) | 実ブラウザでの通し検証。**本番サイトではやらない**（実データに触れるため） |

## D1の初期構築

Cloudflare PagesプロジェクトでD1データベースを作成し、**`migrations/` を番号順にすべて**
適用してから、Pages FunctionsのD1バインディング名を `DB` に設定します。

```bash
for f in migrations/*.sql; do
  npx wrangler d1 execute <DB名> --remote --file "$f"
done
```

| migration | テーブル | 無いとどうなるか |
| --- | --- | --- |
| `0001_initial.sql` | `states` | 同期がまったく動かない |
| `0002_state_revisions.sql` | `state_revisions` | 過去状態からの復元ができない |
| `0003_feedback.sql` | `feedback` | 要望が保存されない |
| `0004_auth_v2.sql` | `rooms` | 新方式（V2）の同期が動かない |
| `0005_rate_limits.sql` | `rate_limits` | 上限判定が例外になり、API が落ちる |
| `0006_telemetry.sql` | `telemetry` | 障害の記録が残らない |
| `0007_telemetry_created_at.sql` | `telemetry.created_at` の索引 | 保持期限の掃除が全表走査になる |

**`schema.sql` だけを適用しても足りません。** これは `0001` と同じ内容で、
`states` しか作られません。以前この記述だけがあったため、手順どおりに
作り直すと同期以外がすべて壊れる状態でした。

すべて `CREATE TABLE IF NOT EXISTS` なので、既存環境へ再適用してもデータは消えません。
`npm test` の `scripts/schema-drift.test.mjs` が、Functions の使うテーブル・列が
`migrations/` に揃っていることを検査します（[docs/schema-drift.md](docs/schema-drift.md)）。

GitHubの `main` をCloudflare Pagesへ接続している現在の運用では、変更をpushすると
`publish/` と `functions/` がデプロイ対象になります。push前に必ず `npm test` を実行します。

pushされた内容は GitHub Actions（`.github/workflows/release-checks.yml`）でも
`npm run sync:html` の差分確認と `npm test` を回します。ただし**それだけでは
デプロイは止まりません**。止めるには GitHub の Settings → Branches → `main` の
必須チェックに `release-checks / test` を指定してください（リポジトリ設定なので
コードには含められません）。
