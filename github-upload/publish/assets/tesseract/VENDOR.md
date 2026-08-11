# OCR（Tesseract.js）の自前配信

`<版>/` の下のファイルは第三者パッケージを**そのまま**置いたもの。手で編集しない。

## 版をディレクトリ名に入れている理由

Service Worker が同一オリジンの静的アセットを cache-first で保持するため、URLが
変わらないと版を上げても古いものが配られ続ける（CDNから読んでいた頃は版付きURLだった
ので更新が自然に届いていた）。版をパスに含めておけば、更新＝別URL＝再取得になる。

アプリ側の `TESSERACT_VERSION` とこのディレクトリ名は一致していなければならない。
食い違うと404でOCRが死ぬので、リリースゲートが両方を照合している。

## なぜ自前で配るのか

SRIは `<script>` タグの読み込みにしか効かない。Tesseract.js は動作中に
worker と core（OCR本体のwasm）を**自分で取りに行く**ため、そこには整合性検査を
掛けられない。CDNが汚染されればOCR中の画像を持ち出せる（CSPの `connect-src` に
そのCDNが入っていれば送信先も確保できる）。実行されるコードを自オリジンへ移すと、
この経路そのものが無くなる。

言語データ（`.traineddata.gz`）は**実行されないデータ**なので当初は対象外としたが、
2026-08-12 に既定モードぶん（eng+jpn 計4.7MB。「26MB」は高精度版込みの誤認だった）を
`../tessdata/` へ移した。経緯とハッシュは `../tessdata/VENDOR.md` を参照。
高精度モード（12MB×2）だけは projectnaptha のCDNのまま。

## 由来

| パッケージ | 版 | npm integrity |
|---|---|---|
| `tesseract.js` | 7.0.0 | `sha512-exPBkd+z+wM1BuMkx/Bjv43OeLBxhL5kKWsz/9JY+DXcXdiBjiAch0V49QR3oAJqCaL5qURE0vx9Eo+G5YE7mA==` |
| `tesseract.js-core` | 7.0.0 | `sha512-WnNH518NzmbSq9zgTPeoF8c+xmilS8rFIl1YKbk/ptuuc7p6cLNELNuPAzcmsYw450ca6bLa8j3t0VAtq435Vw==` |

取得時（2026-07-30）に次を確認した。

1. npmレジストリの tarball が公開 integrity と一致すること
2. jsdelivr が配るファイルと tarball 内のファイルが**1バイト一致**すること
3. `tesseract.min.js` が、それまでコードに書かれていたSRI（`sha384-2BQ3U3Od…`）と一致すること

## 置いてあるファイルのSHA-384

更新時は下の表を作り直し、`scripts/check-release.mjs` のゲートも同じ値になる。

| ファイル | バイト | SHA-384 |
|---|---|---|
| `tesseract-core-lstm.wasm.js` | 3896484 | `sha384-ljppwjVnA7rpAU/v9enQiR6pXDStaEAYw9I+7ddiEynJcmDNnjHCmcvizBeO3cSA` |
| `tesseract-core-relaxedsimd-lstm.wasm.js` | 3905767 | `sha384-/8lT8Rpy0sk4iWEyUA0rKewXOiWu/nV0JjVCd2vMw2nlpqBsk1/6GttRwex7g/S8` |
| `tesseract-core-simd-lstm.wasm.js` | 3899472 | `sha384-1PHRxr8cs/w6IDh6HZYHEHS+Li9cfjahWYKnioD1xvjs7wZD20qpwhD2+ZvhDmHU` |
| `tesseract.min.js` | 62961 | `sha384-2BQ3U3OdKOb0Uczxqr41I9UvZkzr4V9Hv8uSzMMZAlmhsFClvdZX5wi5fDCzG+tM` |
| `worker.min.js` | 111307 | `sha384-iUyp1FxLBc4DYaSwxT1/G6elMdSh3vvQffNSmMiySoXDpk2XfS9ZcM4RjPSiqiw3` |

## core を3種置いてある理由

worker は実行時の機能検査で `relaxedsimd` → `simd` → 素の順に選ぶ。どれが選ばれるかは
ブラウザ次第なので、1つでも欠けるとその端末でOCRが動かない。

`-lstm` の付いた版だけを置いてある。アプリが `Tesseract.OEM.LSTM_ONLY` を渡しており、
worker が `-lstm` 側を選ぶため。**エンジンモードを変える場合は、`-lstm` 無しの3種も
併せて置く必要がある**（リリースゲートがこの対応を検査している）。

## 更新手順

1. npm から該当版の tarball を取り、公開 integrity と照合する
2. **新しい版番号のディレクトリを作って**、tarball 内のファイルをそこへ置く
   （既存のディレクトリを上書きしない。Service Workerに古いものが残る）
3. アプリの `TESSERACT_VERSION` を新しい版へ変える
4. 上の表を作り直す
5. `scripts/check-release.mjs` の期待ハッシュを更新する
6. 古い版のディレクトリを消す（新しい版が本番で動くのを確かめてから）
7. **実ブラウザで写真からのOCRを実際に通す**（ゲートはファイルの存在と一致しか見ない）
