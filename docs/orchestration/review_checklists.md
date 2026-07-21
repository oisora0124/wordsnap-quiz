# WordBank レビュー観点チェックリスト

差分レビューを委任するときの `ONLY_REVIEW_FOR`。全文再読をやめ、対象に応じた観点だけを見る。
判定は `pass` / `revise` / `escalate` ＋ 3点根拠 で返す。

## 差分レビュー共通（pull-request / batch-job）

- [ ] 既存の localStorage キー・JSON形式・`?w=`リンク・D1プレーン行を壊していないか
- [ ] 空/古い/不正な状態で正常な最新状態を上書きする経路が増えていないか
- [ ] 破壊的操作に2段階確認とチェックポイントがあるか
- [ ] root/publish 一致が壊れていないか（`npm run sync:html` / `check-release`）
- [ ] 秘密がHTML・ログ・fixture・URLクエリに混入していないか

## 例文（空所補充）

- [ ] 空所に入るのは正解だけか（複数正解になっていないか）
- [ ] 誤答が「入らない」根拠を言えるか（品詞違い/派生形/AI自己検証済み）
- [ ] 文脈が薄すぎないか（8語以上を優先。定義断片でないか）
- [ ] 対象語が例文中に実在の形で含まれるか

## 誤答候補（distractor）

- [ ] 正解と意味が重複していないか（訳の包含も含む）
- [ ] 紛らわしい綴りの誤答が2つ以上ないか（`MAX_CONFUSABLE=1`）
- [ ] 通常クイズは同品詞優先、空所補充は別品詞優先になっているか（形式で逆）
- [ ] 4択を維持できているか（無理なら注記付きで択数を減らして継続）

## 和訳・語義

- [ ] 品詞衝突・語義不一致がないか
- [ ] 同じ日本語訳が複数語に付いて出題が壊れないか
- [ ] 出典（provenance）と承認状態が付いているか

## SRS・学習ロジック

- [ ] 習得済みは降格しないか
- [ ] 遅い正解は連続1で頭打ちか / 速い正解2連続で習得か
- [ ] 誤答で連続正解リセット・段階を2下げるか
- [ ] 同期マージ（`mergeLearningState`）でLWWが未来時刻に負けないか

## 統計・実験

- [ ] sense単位で測っているか（word単位で薄めていないか）
- [ ] 評価期間が30日以上か / 混入チェックがあるか
- [ ] ランダム化の単位（user/sense）が主張と一致しているか

## 差分レビュー入力の型

```text
REVIEW_TARGET: pull-request / batch-job / lexical-pack
WHY_IT_CHANGED:
RISKS_TO_CHECK:
CHANGED_ARTIFACTS:
FAILED_OR_SENSITIVE_TESTS:
ONLY_REVIEW_FOR:            # 上のどのチェックリストを見るか
RETURN_FORMAT: pass / revise / escalate + 3-point rationale
```
