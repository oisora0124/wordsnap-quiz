# WordBank 製品憲法

タスク委任時に毎回この背景を再説明しない。委任フォーマットの `SOURCE_OF_TRUTH` にこのファイルを指す。
現行コード（`github-upload/publish/index.html`）と矛盾したら、コードを正とし、本書を直す。

## 対象と目的

- 対象利用者: 開発者本人、家族、友人、少人数の知人。大学受験〜一般英語の語彙学習。
- 配布形態: `https://wordbank.pages.dev` のPWA。インストール・登録不要。
- 目的: 英単語を「見せる」のではなく「30日後も残る記憶」へ変える。
- 対象外: 課金、広告、ストア公開、教師/生徒管理、大規模会員基盤。

## 成功指標（KPI）

| 指標 | 定義 | 現状 |
|---|---|---|
| D30 定着率 | 30日後に正答できる語義の割合 | 未計測（Phase 1で観測基盤、Phase 3で実験） |
| 1語1回のAI呼び出し | 新規1語あたりAI呼び出し回数 | 実装済み・維持必須 |
| キーなし空所補充率 | AIキー無しで例文出題できる語の割合 | 実測 約88%（内蔵300語） |
| データ喪失事故 | 誤操作・同期事故での不可逆な喪失 | 0を維持（Undo・チェックポイント） |

## 学習原則

- 中核スケジューラは**決定論的**（現行は段階式SRS: `SRS_INTERVAL_DAYS=[0,1,3,7,14,30,60,120]`）。
  乱数依存の出題順や、LLMによる期日決定はしない。
- 検索練習（thinkして答える）と間隔反復を主軸にする。
- 速い正解と遅い正解を区別する（`SLOW_ANSWER_MS=5000`。遅い正解は習得に進めない）。
- 誤答は段階を0でなく2つ下げる。育てた語を一度の取りこぼしでやり直させない。
- 「正解が2つある問題」を出さない。空所補充は品詞の重なりで根拠を担保し、
  担保できない語は通常出題へ落として理由を表示する。

## 絶対に壊さないもの（不変条件）

- 既存の localStorage キー、JSONバックアップ形式、`?w=` 個人リンク、D1のプレーン行。
- 空・古い・不正な状態で、正常な最新状態を暗黙に上書きしない。
- 破壊的操作（全削除・強制取得/送信・復元・キー再発行）は2段階確認＋チェックポイント。
- root `index.html` と `github-upload/publish/index.html` は常に一致（`npm run sync:html`）。
- 秘密（APIキー・個人キー・トークン）をHTML・JSONバックアップ・ログ・テストfixtureに入れない。

## LLMの使いどころ

- LLMは**難所の判断・例外処理・教材生成・監査**に限定する。中核ロジックはコードで持つ。
- 利用者のブラウザ内に多モデルルーターを常設しない。オーケストレーションは開発・バッチ・監査で使う。
- 外部モデルへ学習履歴を送るのは、目的・同意・匿名化・保持条件を先に定義してからだけ。

## 参照

- ルーティング方針: [ORCHESTRATION_POLICY.md](../ORCHESTRATION_POLICY.md)
- 語彙・スキーマ規則: [lexical_constitution.md](lexical_constitution.md)
- レビュー観点: [review_checklists.md](review_checklists.md)
- 再構成の順序: [WORDBANK-RECONSTRUCTION-ROADMAP.md](../WORDBANK-RECONSTRUCTION-ROADMAP.md)
- 基盤改修仕様: [FREE-OPERATIONS-HARDENING-SPEC.md](../FREE-OPERATIONS-HARDENING-SPEC.md)
