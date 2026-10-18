# 同梱ライブラリ

CDNは使わず、ここに置いたファイルだけを読み込みます（オフラインで動かすため）。
入れ替えるときは、バージョンをこの表に書き、`node scripts/precache.js` でキャッシュ一覧を作り直してください。

| フォルダ | ライブラリ | バージョン | ライセンス | 元のファイル |
|---|---|---|---|---|
| `pdf-lib/` | [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT（`pdf-lib/LICENSE.md`） | `dist/pdf-lib.esm.min.js` |
| `pdfjs/` | [PDF.js](https://github.com/mozilla/pdf.js)（pdfjs-dist） | 6.4.299 | Apache 2.0（`pdfjs/LICENSE`） | `legacy/build/pdf.min.mjs`、`legacy/build/pdf.worker.min.mjs`、`cmaps/`、`standard_fonts/`、`iccs/`、`wasm/` |

## PDF.js について

- 少し古いSafari（iOS 17など）でも動くよう、**legacy 版**を使っています。
- `cmaps/`：フォントが埋め込まれていない日本語のPDFを表示するのに必要です。
- `standard_fonts/`：Foxit（BSD系、`LICENSE_FOXIT`）と Liberation（OFL、`LICENSE_LIBERATION`）のフォントです。
- `wasm/`：JPEG2000・JBIG2 の画像と色の変換に使います。JBIG2 は PDFium（BSD系）、OpenJPEG は BSD 2条項、qcms は MIT です（各 `LICENSE_*`）。PDF内のJavaScriptを動かす部品（quickjs）と、WebAssemblyが使えない環境向けの代わりの部品は入れていません。
- ソースマップの参照（`//# sourceMappingURL=`）は、ファイルがないため削除しています。
