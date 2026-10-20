# 実ブラウザでの通し検証（2026-08-07）

## なぜ要るか

これまでの検査は `node:vm` とスタブが中心で、次を一度も通していなかった。

- 実DOM・実 localStorage・実 Service Worker の組み合わせ
- ページを読み込み直したときに進捗が残るか
- 通信できないときにアプリが起動するか
- CSP が実ブラウザでスクリプトをブロックしないか

`docs/csp-hashes.md` が書いているとおり、CSPは**壊れてもローカルでは何も起きず、
本番だけが壊れる**。実ブラウザで一度は通しておく必要があった。

## 本番サイトでやってはいけない

`https://wordbank.pages.dev` を開くと、**利用者の実データ（個人キー・進捗）に触れる**。
検証のつもりが実データを書き換えかねない。

`localhost` なら localStorage も Service Worker も別スコープになり、
実データに一切影響しない。`localhost` は Service Worker の登録が許される
数少ない非HTTPS環境なので、SWまで含めて確認できる。

## 手順

```bash
cd github-upload
node scripts/serve-local.mjs 8788      # publish/ を配信（本番と同じヘッダ）
# ブラウザで http://localhost:8788/ を開く
```

`scripts/serve-local.mjs` は `publish/_headers` の `/*` ブロックを読み、
**CSPを含む本番と同じヘッダをそのまま返す**。CSPを外して確認すると、
まさに見つけたい種類の不具合を見逃す。

`/api/*` は Pages Functions なのでローカルには無く、501 を返す。
同期まで通したいなら `wrangler pages dev` を使う。

## 2026-08-07 の結果（1.0.74）

| 確認したこと | 結果 |
| --- | --- |
| 起動（CSP下でスクリプトが実行される） | **エラー0・CSP違反0・コンソール出力なし** |
| Service Worker の登録と制御 | 登録され、ページを制御下に置く |
| 取り込み → 候補 → 保存 | 6語が保存され、localStorage にも反映 |
| クイズの出題と採点 | 4択が生成され、正解で `stats.correct` が加算 |
| 学習状態の更新 | `srsStage` / `nextReviewAt` / `correctStreak` が更新される |
| **読み込み直し後の保持** | 6語すべて**食い違い0**（履歴・成績・SRS状態とも） |
| **サーバ停止中の起動** | 起動でき、進捗も無傷 |
| **オフライン中のクイズ** | 出題・採点・保存すべて動作 |
| 個人キーがキャッシュに残らないか | Cache Storage に `?w=` も `ws_` も**0件** |

### 単体テストで固定した不変条件が、実環境でも成立していた

`docs/service-worker.md` の v5 回帰防止（個人キー付きURLをキャッシュしない）を、
実ブラウザで確認できた。URLに `?w=...` が付いた状態で開いても、
Cache Storage に入っていたのは次の5件だけで、キーは1つも含まれていない。

```
http://localhost:8788/                     ← "./" に正規化されている
http://localhost:8788/wordsnap.webmanifest
http://localhost:8788/assets/icon-192.png
http://localhost:8788/assets/icon-512.png
http://localhost:8788/assets/wordsnap-icon-light.png
```

## 後始末

検証で作った localhost のデータは毎回消すこと。

```js
// ブラウザのコンソールで
for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
for (const k of await caches.keys()) await caches.delete(k);
localStorage.clear(); sessionStorage.clear();
```

2026-08-07 の検証後、SW1件・キャッシュ全件・localStorage 8件を削除済み。

## 自動化していない理由

実ブラウザが要るので `npm test` には入れられない。CIでも動かない。
**手順を残して、必要なときに人が回すもの**として扱う。

回すべきタイミング:

- CSPや `_headers` を変えたとき
- Service Worker を変えたとき
- 保存・読み込み・同期の経路を変えたとき
- **`stats` や学習データの構造を変えるとき**（移行の検証手段がこれしかない）

## 端末内OCR（1.0.137〜）

`scripts/ocr-e2e.mjs` が、画像の生成からアプリでの読み取り・採点までを通す（Playwright と
日本語フォントが要る）。先に `node scripts/serve-local.mjs` を起動しておく。

```sh
node scripts/ocr-e2e.mjs            # 通常
HIACC=1 node scripts/ocr-e2e.mjs    # 高精度
```

単語帳風の画像9種（1列・2列・番号付き・傾き・ぼかし・影・JPEG劣化・90°/180°/270° 回転）で、
「英単語と訳が同じ行に正しく並んだ組」を数える。1.0.137 の時点で 280/280、1枚4〜9秒
（cross-origin isolated で4スレッド。1スレッドでは約2.5倍かかる）。
モデル・前処理の値・行の組み立てを変えたら必ず回す。手書き・実際のカメラ写真は含まないので、
実機での確認も別に行うこと。

あわせて手で確かめたこと（1.0.137）: ダウンロード中・認識中の「読み取りを中止」で入力欄が
変わらないこと、中止後にもう一度読めること、OCRのアセットが `wordsnap-ocr-…` の専用キャッシュに
入ること、COEP を外した（1スレッドの）状態でも読めること、モデルが404のときに原因と対処が出ること。

## まだ通していないこと

- 複数タブを同時に開いたときの整合
- 同期（`/api/*` が要る。`wrangler pages dev` が必要）
- 引き継ぎコードでの合流、履歴からの復元、Undo
- 支援技術（スクリーンリーダー）での通し操作
