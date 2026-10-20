# OCRの実行環境（onnxruntime-web）の自前配信

`<版>/` の下のファイルは第三者パッケージを**そのまま**置いたもの。手で編集しない。
端末内OCRのモデル（PP-OCRv6）は `../ppocr/VENDOR.md` を参照。

## 何に使うか

端末内OCRは、PP-OCRv6 のモデル（ONNX形式）をブラウザの中で動かして読み取る。
その推論エンジンが onnxruntime-web の WebAssembly 版。アプリは Worker の中で
`ort.wasm.min.js` を `importScripts` し、それが同じディレクトリの
`ort-wasm-simd-threaded.mjs`（読み込み役）と `.wasm`（本体）を取りに行く。

## なぜ自前で配るのか

Tesseract.js のときと同じ理由（2026-07-30 の判断を引き継ぐ）。SRIは `<script>` の
読み込みにしか効かず、実行時に取りに行く `.mjs` と `.wasm` には整合性検査を掛けられない。
CDNが汚染されればOCR中の画像を持ち出せるので、実行されるコードを全部自オリジンに置く。
CSPの `script-src` / `connect-src` にもCDNを入れずに済む。

## 置いてあるファイルを3つに絞った理由

npm パッケージの `dist/` には WebGPU/WebGL/JSEP/JSPI 向けなど多数の版があるが、
アプリは `executionProviders: ["wasm"]` だけを使い、`ort.wasm.min.js` は
`ort-wasm-simd-threaded.{mjs,wasm}` の組だけを読む（SIMD 必須。Chrome 91 / Firefox 89 /
Safari 16.4 以降）。スレッドは SharedArrayBuffer がある（ページが cross-origin isolated の）
ときだけ使われ、無ければ同じ `.wasm` が1スレッドで動く。

`ort.wasm.min.js` 末尾の `sourceMappingURL` が指す `.map` は置いていない
（開発者ツールを開いたときに404が出るだけで、動作には関係しない）。

## 由来

| パッケージ | 版 | npm integrity |
|---|---|---|
| `onnxruntime-web` | 1.30.0（2026-09-14 公開） | `sha512-q0y+JrrtukXSzsBWEMccVfqX25LRmosXHF+CaRJmg8pZClzcV7svNc4rKY3jL02Vb7QmRMDs1SigqR4CXAfKYQ==` |

取得時（2026-10-20）に、npmレジストリの tarball が公開 integrity と一致することを確認し、
tarball の `package/dist/` から下の3ファイルをそのまま置いた。

ライセンスは MIT（Copyright (c) Microsoft Corporation）。npm パッケージには LICENSE が
含まれていないため、同じ版のタグの `LICENSE`
（`https://raw.githubusercontent.com/microsoft/onnxruntime/v1.30.0/LICENSE`）を
`<版>/LICENSE` として一緒に置いている。

## 置いてあるファイルのSHA-384

更新時は下の表を作り直し、`scripts/check-release.mjs` のゲートも同じ値にする。

| ファイル | バイト | SHA-384 |
|---|---|---|
| `LICENSE` | 1073 | `sha384-rrhzEgV70STq4ce7Ln6JaTR6E99dAwlIkc3tM/ZZU/M7syLSA4KUnIsIpGXgl3mc` |
| `ort-wasm-simd-threaded.mjs` | 24381 | `sha384-XcXA/MtAf0WpB8e023xQH9CM7RIjiugakT7x99DIwpFf7k56BIFFcAPerIF7FDad` |
| `ort-wasm-simd-threaded.wasm` | 14239897 | `sha384-vjBJ1z7qrhkTyYsNqKeF6c7N+nOJSU94czEo+tvZcu8G75JparGq9kB+kTnEUNVM` |
| `ort.wasm.min.js` | 50196 | `sha384-Bw6URI+Gvoadw0do7/QrSHUC9D1vCYYK5OSqChFyhyV5mzPL4oe2rOAFljAnS8Sq` |

## 更新手順

1. npm から該当版の tarball を取り、公開 integrity と照合する
2. **新しい版番号のディレクトリを作って**、`dist/` の3ファイルと同じ版の LICENSE を置く
   （既存のディレクトリを上書きしない。Service Workerに古いものが残る）
3. アプリの `ORT_VERSION` と `wordsnap-sw.js` の `OCR_ASSET_DIRS` を新しい版へ変える
4. 上の表と `scripts/check-release.mjs` の期待ハッシュを更新する
5. **実ブラウザで写真からのOCRを実際に通す**（ゲートはファイルの存在と一致しか見ない）
6. 古い版のディレクトリを消す（新しい版が本番で動くのを確かめてから）
