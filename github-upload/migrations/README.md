# D1 マイグレーション

WordBank の Cloudflare D1 スキーマ。`wrangler.jsonc` の `migrations_dir` がここを指す。

| ファイル | 内容 |
|---|---|
| 0001_initial.sql | 現行の `states` テーブル（既存本番にも安全に再適用可能） |
| 0002_state_revisions.sql | 過去版復元用の履歴テーブル（追加型・影運用） |

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
