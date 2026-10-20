# 端末内OCRのモデル（PP-OCRv6 small）の自前配信

`<版>/` の下のファイルは第三者パッケージの中身を**そのまま**置いたもの（文字表だけは
モデルの中から取り出したもの。下記）。手で編集しない。
推論エンジン（onnxruntime-web）は `../onnxruntime/VENDOR.md` を参照。

## 何に使うか

| ファイル | 役割 |
|---|---|
| `PP-OCRv6_det_small.onnx` | 文字の**検出**（写真のどこに文字列があるか） |
| `PP-OCRv6_rec_small.onnx` | 文字の**認識**（切り出した1行を文字にする。日本語・英語を含む多言語） |
| `ppocrv6_dict.txt` | 認識モデルの出力番号と文字の対応表 |
| `LICENSE` | Apache License 2.0 の全文（RapidOCR 同梱のもの） |
| `MODEL_LICENSES.md` | RapidOCR によるモデルの権利・由来・再配布条件の告知 |

## 権利

モデルの重みは PaddleOCR（Baidu ほか）のもので、**Apache License 2.0**。
商用を含めて利用・改変・再配布できる。再配布の条件は、ライセンス全文と
著作権・帰属の表示を一緒に配ること（`MODEL_LICENSES.md` の §7）。
このディレクトリに `LICENSE` と `MODEL_LICENSES.md` を同梱して満たしている。
上流に NOTICE ファイルは無い（同 §7）。

ONNX への変換は RapidOCR が行ったもので、変換・同梱の告知は `MODEL_LICENSES.md` の §5 にある。
アプリは重みを変更していない（量子化も試したが、英単語の読み取りが落ちたので使っていない）。

PaddleOCR / RapidOCR の名前は由来の説明にだけ使い、提携や推奨を示す表示はしない（同 §8）。

## 由来

PyPI の `rapidocr` の wheel に同梱されているモデルをそのまま取り出した。

| パッケージ | 版 | wheel の SHA-256（PyPI 公開値と一致を確認） |
|---|---|---|
| `rapidocr` | 3.10.0（2026-10-08 公開） | `2fc34e26cd0f48514804a94f8832283039c7334076bff60768b1fed9ad068050` |

取得時（2026-10-20）に次を確認した。

1. wheel の SHA-256 が PyPI の公開値と一致すること
2. 2つの `.onnx` の SHA-256 が、同じ wheel の `rapidocr/default_models.yaml`（モデルの
   公式な登録簿）と `MODEL_LICENSES.md` §6 の値と一致すること
   - `PP-OCRv6_det_small.onnx`: `090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f`
   - `PP-OCRv6_rec_small.onnx`: `6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884`
3. 3か月前の `rapidocr` 3.9.2（2026-07-21 公開）の wheel にも、1バイト違わず同じ
   2ファイルが入っていること（公開直後の版だけに紛れ込んだものではない）

### 文字表（`ppocrv6_dict.txt`）について

RapidOCR 用の ONNX は、文字表を別ファイルではなく**認識モデルのメタデータ**
（`metadata_props` の `character`）に持っている。onnxruntime-web からはメタデータを
読めないため、取り出してテキストにした。中身は1行1文字・18708文字で、
メタデータの値そのもの（加工なし）。取り出し方:

```python
import onnx
m = onnx.load("PP-OCRv6_rec_small.onnx")
open("ppocrv6_dict.txt", "w").write(next(p.value for p in m.metadata_props if p.key == "character"))
```

認識モデルの出力は 18710 クラスで、0番が CTC の空白（blank）、1〜18708番が
この表の各行、18709番が半角スペース。

## 選定の経緯（2026-10-20）

- **PP-OCRv5 mobile** ではなく **v6 small** にしたのは、出どころの確かさのため。v5 の
  ブラウザ向け ONNX は第三者の再配布（npm）しか取得できず、変換元を確かめられなかった。
  v6 small は PyPI の RapidOCR に、権利の告知とハッシュの登録簿つきで同梱されている
- Datalab の Indra OCR は日本語のかなに対応しておらず、重みのライセンスにも用途制限があるので見送った
- 合成した単語帳の写真6種（1列・2列・番号付き・傾き・ぼかし・影・JPEG劣化）で、
  「英単語と訳が同じ行に正しく並んだ組」の数を比べた結果:
  - PP-OCRv6 small（レイアウト自動）: 192/192
  - Tesseract（eng+jpn、レイアウト自動）: 59/192
  - Tesseract（列の数を正しく指定）: 167/192

## 置いてあるファイルのSHA-384

更新時は下の表を作り直し、`scripts/check-release.mjs` のゲートも同じ値にする。

| ファイル | バイト | SHA-384 |
|---|---|---|
| `LICENSE` | 11422 | `sha384-XlS1SIfL4yEEdEbhgLNGWTGgW/RFNPSzT3ikqxHOpOXnjZCJz0fgcGdpqBdYrkA8` |
| `MODEL_LICENSES.md` | 8398 | `sha384-rN9mV/1gMmnPg0pYG2AXif3avOVQFB7pTfxYphXq6sqcY2reEe0oHKJ8NsMQd50z` |
| `PP-OCRv6_det_small.onnx` | 9929594 | `sha384-u0gahSmZRIi8+Juzo96q0vjpD6JFXJSsRpynx2iJSFmM9nZZ8kYMnwvBEol6acnY` |
| `PP-OCRv6_rec_small.onnx` | 21234383 | `sha384-0M9izWSg47cRpZteiyFaOQTP5ZcZ8fJbEGeGmLVkjNZTNCpEe3Vnt1d5jbxh/cIu` |
| `ppocrv6_dict.txt` | 74946 | `sha384-U7irdqg42HIfh+GWCZJ+DyiiohzWeR2aVni3VySUEWHeOzkWflRkaB1gBUy8TMhG` |

## 更新手順

1. PyPI から `rapidocr` の wheel を取り、公開 SHA-256 と照合する
2. wheel 内の `.onnx` が `default_models.yaml` の SHA-256 と一致することを確かめる
3. **新しい版名のディレクトリを作って**そこへ置き、文字表を上の方法で取り出す（既存を上書きしない）
4. アプリの `PPOCR_MODEL_VERSION` と `wordsnap-sw.js` の `OCR_ASSET_DIRS` を新しい版名へ変える
5. 上の表と `check-release.mjs` の期待ハッシュを更新する
6. 前処理の値（平均・標準偏差・閾値）がモデルの版で変わっていないか、RapidOCR の
   `config.yaml` と見比べる（v6 の検出は平均・標準偏差とも 0.5。ImageNet の値ではない）
7. **実ブラウザで写真からのOCRを実際に通す**（ゲートは存在と一致しか見ない）
8. 古い版のディレクトリを消す（新しい版が本番で動くのを確かめてから）
