# 同梱ライブラリ

CDNは使わず、ここに置いたファイルだけを読み込みます（オフラインで動かすため）。
入れ替えるときは、バージョンをこの表に書き、`node scripts/precache.js` でキャッシュ一覧を作り直してください。

| フォルダ | ライブラリ | バージョン | ライセンス | 元のファイル |
|---|---|---|---|---|
| `pdf-lib/` | [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT（`pdf-lib/LICENSE.md`） | `dist/pdf-lib.esm.min.js` |
| `fflate/` | [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT（`fflate/LICENSE`） | `esm/browser.js` → `fflate.mjs` |
| `fontkit/` | [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) | 1.1.1 | MIT（`fontkit/LICENSE`） | `dist/fontkit.umd.min.js` → `fontkit.mjs`（下記の変更あり） |
| `fonts/` | [BIZ UDゴシック](https://github.com/googlefonts/morisawa-biz-ud-gothic)（Regular） | Google Fonts 版 | SIL OFL 1.1（`fonts/OFL.txt`） | `ofl/bizudgothic/BIZUDGothic-Regular.ttf`（下記の変更あり） |
| `qpdf/` | [qpdf](https://github.com/qpdf/qpdf) 12.2.0（[@neslinesli93/qpdf-wasm](https://github.com/neslinesli93/qpdf-wasm) 0.3.0 の WebAssembly 版） | 12.2.0 | Apache 2.0（`qpdf/LICENSE`）、包む部分は ISC（`qpdf/LICENSE-wrapper`） | `dist/qpdf.js` → `qpdf.mjs`、`dist/qpdf.wasm` |
| `tesseract/` | [Tesseract.js](https://github.com/naptha/tesseract.js) 7.0.0、[tesseract.js-core](https://github.com/naptha/tesseract.js-core) 7.0.0、日本語の学習データ（[@tesseract.js-data/jpn](https://github.com/naptha/tessdata) 1.0.0 の 4.0.0_best_int） | 7.0.0 | Apache 2.0（`tesseract/LICENSE`、`tesseract/core/LICENSE`）、学習データは MIT（元は tessdata_best・Apache 2.0） | `dist/tesseract.esm.min.js`、`dist/worker.min.js`、`tesseract-core-lstm.wasm.js`、`tesseract-core-simd-lstm.wasm.js`、`4.0.0_best_int/jpn.traineddata.gz` |
| `pdfjs/` | [PDF.js](https://github.com/mozilla/pdf.js)（pdfjs-dist） | 6.4.299 | Apache 2.0（`pdfjs/LICENSE`） | `legacy/build/pdf.min.mjs`、`legacy/build/pdf.worker.min.mjs`、`cmaps/`、`standard_fonts/`、`iccs/`、`wasm/` |

## PDF.js について

- 少し古いSafari（iOS 17など）でも動くよう、**legacy 版**を使っています。
- `cmaps/`：フォントが埋め込まれていない日本語のPDFを表示するのに必要です。
- `standard_fonts/`：Foxit（BSD系、`LICENSE_FOXIT`）と Liberation（OFL、`LICENSE_LIBERATION`）のフォントです。
- `wasm/`：JPEG2000・JBIG2 の画像と色の変換に使います。JBIG2 は PDFium（BSD系）、OpenJPEG は BSD 2条項、qcms は MIT です（各 `LICENSE_*`）。PDF内のJavaScriptを動かす部品（quickjs）と、WebAssemblyが使えない環境向けの代わりの部品は入れていません。
- ソースマップの参照（`//# sourceMappingURL=`）は、ファイルがないため削除しています。

## fontkit について（PDFに日本語の文字を書き込むため）

- pdf-lib に日本語フォントを埋め込むための部品です。UMD版を ES Modules として読めるよう、前後に数行を足しています（`module`・`exports` を用意して `export default`）。
- **不具合の修正を1か所入れています**：使う文字だけを埋め込む（subset）とき、文字の形のデータの長さが奇数だと、位置の表（loca）がずれて文字が欠けていました（BIZ UDゴシックで発生）。形のデータを偶数の長さにそろえるよう、`TTFSubset._addGlyph` の `this.glyf.push(o)` の前に `o.length%2&&(o=b.concat([o,b.alloc(1)]))` を足しています。

## フォントについて

- **BIZ UDゴシック**（モリサワ、SIL Open Font License 1.1。予約フォント名の指定なし）。読みやすさに配慮したユニバーサルデザインのフォントで、書類向き。
- ファイルを小さくするため、fontTools で次のように加工しています（4.6MB → 3.4MB）。文字の種類は減らしていません。
  ```sh
  pyftsubset BIZUDGothic-Regular.ttf --unicodes='*' --no-hinting \
    --drop-tables+=GSUB,GPOS,vhea,vmtx,DSIG,meta,gasp --layout-features='' \
    --output-file=BIZUDGothic-Regular.ttf
  ```
  - ヒンティング（画面の小さな文字をくっきり見せるための情報）、縦書き・文字の置き換えの情報を除いています。PDFに書き込む横書きの文字には使わないためです。
- WOFF2 にするともっと小さくなりますが、fontkit で使う文字だけを取り出せなかったため、TTF のままにしています。

## qpdf について（PDFのパスワードをかける・外すため）

- pdf-lib は暗号化に対応していないので、qpdf を WebAssembly にしたものを使います。`qpdf.js` の最後に `export default Module;` を1行足して、ES Modules として読めるようにしています（中身は変えていません）。
- WebAssembly を動かすため、`index.html` の CSP に `'wasm-unsafe-eval'` を足しています（JavaScript の文字列を実行する `eval` は許していません）。
- この版の qpdf は、エラーの文を受け取れません（ブラウザの console に出るだけ）。成功・失敗だけで判断しています（`src/web/qpdf.js`）。
- WebAssembly の中には、qpdf が使う zlib（zlib License）と libjpeg-turbo（IJG License・BSD 3条項）も入っています。

## Tesseract.js について（文字認識・OCR）

- 約8MBあるので、**オフライン用の最初のキャッシュには入れていません**（アプリを更新するたびに全員が取り直さなくてすむように）。初めて文字認識を使ったときに、Service Worker が別のキャッシュ（`relapdf-ocr-1`）に入れ、以後はオフラインでも使えます。部品を入れ替えたら、`sw.js` の `OCR_CACHE` の数字を上げてください。
- WebAssembly の部品は、速い命令（SIMD）が使える端末用（`simd-lstm`）と使えない端末用（`lstm`）の2つを入れ、画面側で選んでいます（`src/web/ocr.js`）。文字の並びを読む新しい方式（LSTM）だけの版です。
- ソースマップの参照（`//# sourceMappingURL=`）は、ファイルがないため削除しています。
- 中に含まれる部品のライセンス（buffer・ieee754・regenerator-runtime・zlib.js）は `tesseract/LICENSE-bundled` にあります（MIT・BSD）。
