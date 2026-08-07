# D1 マイグレーション

WordBank の Cloudflare D1 スキーマ。`wrangler.jsonc` の `migrations_dir` がここを指す。

| ファイル | 内容 | 無いとどうなるか |
|---|---|---|
| 0001_initial.sql | `states`（既存本番にも安全に再適用可能） | 同期がまったく動かない |
| 0002_state_revisions.sql | `state_revisions`（過去版復元用・追加型） | 過去状態からの復元ができない |
| 0003_feedback.sql | `feedback`（要望フォームの保存先） | 要望が保存されない |
| 0004_auth_v2.sql | `rooms`（同期V2。秘密をURLに載せない方式） | 新方式の同期が動かない |
| 0005_rate_limits.sql | `rate_limits`（同期・フィードバック・テレメトリで共有） | 上限判定が例外になり、経路ごと落ちる |
| 0006_telemetry.sql | `telemetry`（匿名の利用統計とエラー） | 障害の記録が残らない |
| 0007_telemetry_created_at.sql | `telemetry.created_at` の索引 | 保持期限の掃除が全表走査になる（行が増えるほど遅くなる） |

**`schema.sql` を1枚適用するだけでは足りない。** あれは 0001 と同じ内容で、
`states` しか作られない。新しいD1を作るときは、ここを番号順に全部適用する。

`npm test` の `scripts/schema-drift.test.mjs` が、Functions の使うテーブル・列が
この `migrations/` に揃っていることを検査する
（[../docs/schema-drift.md](../docs/schema-drift.md)）。

## 適用手順

```bash
# ローカル/ステージングで先に確認してから本番へ
npx wrangler d1 migrations apply wordbank            # ローカル
npx wrangler d1 migrations apply wordbank --remote   # 本番
```

## デプロイ順序（重要）

同期APIは履歴書き込みを **best-effort** で実装している（`state_revisions` が無くても
通常の GET/PUT は従来どおり成功する）。したがって次のどちらの順でも同期は壊れない:

1. 先にAPI（Pages Function）をデプロイ → まだ履歴は記録されない（テーブル不在を黙って許容）
2. 0002 を適用 → 以降のPUTから履歴が記録され始める

過去のリビジョンへは、クライアントが「`GET ?revision=N` で過去stateを取得 → 既存の
強制pushで新revとして書く」ことで戻す。サーバーは rev を巻き戻さない。

## 保持と無料枠

各PUTで `state_revisions` へ1行INSERTし、保持制約（上位5件＋直近7日の日次）を
DELETEで適用する。1回のPUTがD1書き込み 約3回（state更新＋履歴INSERT＋prune DELETE）に
増える。少人数運用では問題ないが、利用者が増えたら prune 頻度や保持数の見直しを検討する。
