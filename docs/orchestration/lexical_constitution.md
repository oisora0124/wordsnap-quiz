# WordBank 語彙・スキーマ憲法

語義データ・出題・品詞・出典の扱いを一本化する。教材生成や語義変換を委任するときの `SOURCE_OF_TRUTH`。

## 現行の正本（本番で実際に動いている形）

現行stateの語は `word` オブジェクト。lemma/sense分離はまだ**影運用**（本番未接続）。

```
word = {
  id, term, meaning, deckId, addedAt,
  pos: { tag: "n"|"v"|"adj"|"adv"|null, tags: [ ... ] },  // tags=取り得る品詞すべて
  learning: { status, srsStage, nextReviewAt, correctStreak, ... },
  history: [ { at, correct } ],   // 直近50件
  cefr, enrich, ...
}
```

- `pos.tags` は空所補充の根拠判定に使う（`posTagsFor` が同梱表と解決済みの**和集合**を返す）。
  代表の `pos.tag` は表示用。多品詞語（impact/decline/attempt 等）を単一品詞で判定しない。
- 内蔵サンプル「大学受験標準レベル単語300」の品詞は `BUILTIN_POS` に同梱（通信ゼロ）。
  名詞兼動詞は `BUILTIN_POS_NOUN_AND_VERB` に列挙。追加時は両方を更新する。

## 影モデル（Phase 2 以降。本番stateへ接続する前の検証用）

- lemma / sense / provenance: `github-upload/schemas/lexical-shadow.schema.json`
- 既存 `word -> meaning` を当面そのまま正本とし、変換結果を影データで**比較**する。
- 破壊的移行はしない。コピー → 変換 → 件数・語義差分検証 → 切替 の順。

## 難易度・帯（取り込む前提条件つき）

- CEFR: 現行は推定値を補助表示。authoritative属性へ昇格するのはPhase 2以降。
- JACET8000 / WordNet synset: **ライセンス・版・ID安定性を確認してから**取り込む。
  確認前のデータは provenance 未確定として本番に出さない。

## 出典（provenance）要件

教材（例文・和訳・誤答）には出典と承認状態を持たせる（`lexical-shadow.schema.json`）。

- `source_type` / `source_id` / `provenance` / `approval_status` / `confidence` を必須にする。
- **生成モデル名ではなく、根拠と検査結果を保存する**（モデルは変わるが根拠は残る）。
- ライセンス未確認（`license: "unverified"`）のまま本番へ出さない。

## 出題品質のルール（生成より先に機械検査する）

1. **複数正解を作らない**: 空所補充の誤答は「空所に入らない」と根拠を言える語だけ。
   根拠 = (a) 出題語の派生形で品詞が違う (b) 品詞が判明した登録語で品詞が違う
   (c) AIが同一応答内で「入るのは正解だけ」を自己検証済み。どれも無ければ通常出題へ落とす。
2. **訳の包含を弾く**: 「変える」と「部分的に変える」のような包含関係は同義扱いで誤答から除外。
3. **紛らわしい誤答は1つまで**（`MAX_CONFUSABLE=1`）。3つとも似せると引っかけ問題になる。
4. **根拠が薄い例文を避ける**: 空所補充の文脈は8語以上を優先（辞書の定義断片を出さない）。
5. **品詞衝突・語義不一致・未定義語**を生成物のルール検査で先に落とす。

## 教材QAの流れ（大量生成時）

生成 → **全件ルール検査（モードE）** → 疑義のみモデル審査 → 難例のみ上位審査。
全件を人手/上位モデルに通さない。例: 5万例文なら 全件ルール + 5〜10%抽出審査 + 1〜2%難例。
