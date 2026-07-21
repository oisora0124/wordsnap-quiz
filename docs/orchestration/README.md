# WordBank 開発オーケストレーション

WordBank を**開発・監査・バッチ処理**するときに、タスクをモード A〜E で回すための実行基盤。
利用者のブラウザで動くものではない（ロードマップ Phase 5 の実体化）。

## 構成

| ファイル | 役割 |
|---|---|
| [product_constitution.md](product_constitution.md) | 製品憲法。対象・KPI・学習原則・不変条件。委任時の `SOURCE_OF_TRUTH` |
| [lexical_constitution.md](lexical_constitution.md) | 語彙・スキーマ・出題品質・出典の規則 |
| [review_checklists.md](review_checklists.md) | 差分レビューの観点。委任時の `ONLY_REVIEW_FOR` |
| [../ORCHESTRATION_POLICY.md](../ORCHESTRATION_POLICY.md) | ルーティング方針とモード定義 |
| [../../tools/route.mjs](../../tools/route.mjs) | 決定論的ルーター兼実績ログCLI |
| routing-log.jsonl | 実績（decision と outcome）を追記するJSONL |

## 使い方

```bash
# 1. タスクの経路を決める（decision をログに残し task_id を得る）
node tools/route.mjs decide '{"task_type":"impl","goal":"...","risk":"medium","testable":true,"spec_known":true}'

# 2. 委任・実装する（憲法ファイル＋差分だけを渡す。リポジトリ全体を渡さない）

# 3. 実績を記録する（後で経路を見直すため）
node tools/route.mjs record <task_id> '{"chosen_model":"gpt-5.6-terra","pass_fail":"pass","retries":0}'

# 4. たまったら集計して経路を寄せる
node tools/route.mjs stats
```

## 原則

- 通常は **E → B/A** の順に必要性を判定する。低リスク変更が自動検査に合格したら、
  追加モデルによる儀式的レビューはしない。
- 高位モデル（Sol）は**作業者ではなくルーター兼審査者**として使う。毎タスクの実装には流さない。
- ユーザーが特定モデルの不使用を指定したら（`avoid_models`）必ず優先する。
- 実績が同じ `task_type` で 30 件以上たまったら、一発合格率が高くトークンの小さい経路へ寄せる。

## モード早見

| モード | 使いどころ | 既定ルート（Codex主軸・Claude最小） |
|---|---|---|
| A | 前例のない設計・未確定仕様を直接処理 | Sol 直処理 ＋ 別モデルレビュー |
| B | 低〜中リスクの委任・量産 | Terra/Luna（量産は Luna） |
| C | 独立案の比較価値が高い | Sol＋主力を並列、別モデルでレビュー |
| D | 高リスクだが仕様は明確 | 作成者 Terra → レビュアー Sol |
| E | 型・ルール・テスト・SQLで機械処理 | モデル不使用 |
