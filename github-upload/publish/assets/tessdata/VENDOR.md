# OCR言語データ（traineddata）の自前配信

`<版>/` の下のファイルは第三者パッケージの中身を**そのまま**置いたもの。手で編集しない。
実行コード（worker/core）の自前配信は `../tesseract/VENDOR.md` を参照。

## なぜ言語データも自前で配るのか

実行コードを自前配信へ移した時点（2026-07-30）では、言語データは「実行されない
データなのでCDNのままでよい」と判断していた。今回移した理由は2つ。

1. **connect-src から CDN を消せる。** 言語データのためだけに
   `cdn.jsdelivr.net` が connect-src に残っており、万一別の穴（XSS等）が
   開いたときの持ち出し先として機能してしまう。多層防御として閉じる価値がある
2. **サイズの再実測。** 当時「合計26MB」とした数字は高精度版込みだった。
   既定モードが実際に取るのは eng 2.8MB + jpn 1.9MB = **4.7MB** で、
   抱えるコストがほぼ無い

**高精度モード（設定の「高精度」ON時）だけは従来どおり
`tessdata.projectnaptha.com` から取得する**（eng/jpn 各12MB。リポジトリで
恒久的に抱えるには大きく、利用実績も無いため）。高精度OCRのみオンライン必須。

## 版をディレクトリ名に入れている理由

`../tesseract/VENDOR.md` と同じ。Service Worker が同一オリジンの静的アセットを
cache-first で保持するため、更新＝別URL＝再取得になるようにする。
アプリ側の `TESSDATA_VERSION` とディレクトリ名の一致はリリースゲートが照合する。

## 由来

| パッケージ | 版 | npm integrity |
|---|---|---|
| `@tesseract.js-data/eng` | 1.0.0 | `sha512-mbTumm6KQPUHyzTPQaF3ObXYnx0SqqfV2nabqFVQBwD6Kl7PhGSLSzOlfFTWy0P3BjghaSKA2W9GB19Jk+ZcTg==` |
| `@tesseract.js-data/jpn` | 1.0.0 | `sha512-nUq2xHUjiWE6FRqkvLIIbByLZ39B8qNaBSOnVP4XIKGPKtZ1e0hiRnK7WhPfl8A+Fe7aNE1u/QoXXUym3TbSCA==` |

取得時（2026-08-12）に次を確認した。

1. npmレジストリの tarball が公開 integrity と一致すること
2. jsdelivr が配るファイルと tarball 内のファイルが**1バイト一致**すること
   （vendored worker.min.js の既定取得先 `@tesseract.js-data/<lang>/4.0.0_best_int/` と同一パス）

## 置いてあるファイルのSHA-384

更新時は下の表を作り直し、`scripts/check-release.mjs` のゲートも同じ値にする。

| ファイル | バイト | SHA-384 |
|---|---|---|
| `4.0.0_best_int/eng.traineddata.gz` | 2952873 | `sha384-JI+fraGAoc5GBGIliuqzHRnP1nJyrukg5ggNSBv/TO+YOVj+6Te6XXQOx7ia10xq` |
| `4.0.0_best_int/jpn.traineddata.gz` | 2030256 | `sha384-OlgrInD77KoJd+WsE8cHWtmI3mKzvi69lIv6JSH3t3bFDa4/vH8MaxvO1mdX3UQ3` |

## 更新手順

1. npm から `@tesseract.js-data/<lang>` の tarball を取り、公開 integrity と照合する
2. **新しい版番号のディレクトリを作って**そこへ置く（既存を上書きしない）
3. アプリの `TESSDATA_VERSION` を新しい版へ変える
4. 上の表と `check-release.mjs` の期待ハッシュを更新する
5. **実ブラウザで写真からのOCRを実際に通す**（ゲートは存在と一致しか見ない）
6. 古い版のディレクトリを消す（新しい版が本番で動くのを確かめてから）
