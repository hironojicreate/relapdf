# ページリストの仕様

RelaPDFの中心となるデータ構造です。実装は `src/core/page-list.js`、テストは `tests/core/page-list.test.js` にあります。

## 全体の形

```js
{
  version: 1,              // 形式のバージョン。自動保存したデータの読み込みで確認する
  sources: {               // 元データ（読み込んだPDF・画像）の情報。キーは sourceId
    "src_...": Source,
  },
  pages: [Page, ...],      // ページの並び。この順番がそのまま出力の順番になる
  marks: Marks | null,     // 書き込み（ページ番号など）。なくてもよい（M6で追加。古いデータにはない）
  forms: { [sourceId]: { 入力欄の名前: 文字 | true/false } }  // フォーム入力。なくてもよい（M6）
}
```

ページリストはJSONに変換できる情報だけを持ちます。PDFや写真の中身（バイナリ）は持たず、`sourceId` をキーにして別の場所に保存します（M1：メモリ、M2：IndexedDB）。

## Source（元データ）

| 項目 | 型 | 内容 |
|---|---|---|
| `id` | string | sourceId |
| `kind` | `'pdf'` \| `'image'` | 種類 |
| `name` | string | ファイル名 |
| `mimeType` | string | 例：`application/pdf`、`image/jpeg` |
| `byteLength` | number | ファイルの大きさ（バイト） |
| `pageCount` | number | PDFのページ数。画像は常に1 |
| `width`, `height` | number | 画像のみ。写真の回転情報（EXIF）を反映したあとのピクセル数 |

1つのPDFから何ページ使っても、元データは1つです。どのページからも使われなくなった元データは `pruneSources` で取り除き、返ってきた `removedSourceIds` を使ってバイナリも削除します。

## Page（ページ）

| 項目 | 型 | 内容 |
|---|---|---|
| `id` | string | pageId。並べ替えや選択に使う |
| `content` | 下の表 | このページの中身がどこから来たか |
| `rotation` | 0 \| 90 \| 180 \| 270 | ユーザーが付けた回転（右回り）。PDFにもともと付いている回転とは別に持ち、出力するときに足し合わせる |
| `perspective` | `null` \| Perspective | 4点補正。画像のページだけに使える |
| `filter` | `'none'` \| `'document'` | 色補正。`'document'` は書類モード（背景を白く・文字をくっきり） |
| `annotations` | Annotation[]（なくてもよい） | 注釈（文字・図形・署名や印鑑の画像）。下の「Annotation」 |

### content の種類

| type | 項目 | 内容 |
|---|---|---|
| `'pdf'` | `sourceId`, `pageIndex` | PDFの何ページ目か（0始まり）。出力するときは画像にせず、そのままコピーする |
| `'image'` | `sourceId`, `pageIndex`（常に0） | 写真・画像 |
| `'blank'` | `width`, `height` | 白紙ページ。サイズはポイント（1pt = 1/72インチ） |

### Perspective（4点補正）

```js
{
  corners: [               // [左上, 右上, 右下, 左下] の順
    { x: 0.08, y: 0.11 },  // 元画像に対する割合（0〜1。写真の外は -0.25〜1.25 まで）
    ...
  ],
  aspect: 'free' | 'a4'    // 'a4' のときはA4比率に合わせる
}
```

座標の基準は「写真の回転情報を反映したあと、ユーザーの回転をかける前」の元画像です。書類の端が写真からはみ出していても補正できるよう、写真の外にも幅・高さの25%まで置けます（`PERSPECTIVE_MARGIN`）。はみ出した部分は白で書き出します。座標を割合で持つのは、縮小した画像でも元の画像でも同じ値を使えるようにするためです。

## Annotation（注釈）

ページの上に置く文字・図形・画像です（`src/core/annotations.js`）。位置は「ユーザーの回転をかける前」のページに対する0〜1の割合（左上が原点）で持つので、あとからページを回転しても、注釈はページの中身と一緒に回ります。

| type | 項目 |
|---|---|
| `text` | `x, y`（文字の左上）, `text`（改行あり）, `size`（ページの幅に対する割合）, `color`, `rotation` |
| `image` | `x, y`（画像の左上）, `w, h`（どちらもページの幅に対する割合）, `sourceId`, `rotation` |
| `rect` / `ellipse` / `highlight` | `x, y, w, h`, `color`（`highlight` はマーカー。半透明で塗る） |
| `line` / `arrow` | `x1, y1, x2, y2`, `color` |

- どれも `id` を持つ。`color` は `red` `blue` `black` `green` `yellow`
- `rotation`：文字や画像を、回転前のページに対して右に回す角度。回転したページに置くとき、画面で見て正しい向き（横書き）になるよう、ページの回転と逆の角度にする
- 画像の注釈が使う元データ（署名・印鑑）は、`kind: 'image'` で `asset: true` の Source として登録する。ページにはならない。`pruneSources` は、注釈で使っている画像を残す

## フォーム入力（forms）

読み込んだPDFに入力欄があるとき、入力した値を `forms[sourceId][入力欄の名前]` に持ちます（`src/core/forms.js`）。書き出すときに元のPDFの入力欄へ値を入れ、入力欄を平坦化（ページの中身にする）してからページをコピーします。PDFの Source には、入力欄の数 `formFieldCount` を持ちます。

## Marks（書き込み）

PDFを書き出すときに、すべてのページへ書き込む文字の設定です（`src/core/marks.js`）。元のファイルは変えません。どの項目も `enabled` が `true` で、文字が空でないときだけ書き込みます。

```js
{
  pageNumber: { enabled, position: 'bottom-center' など6か所, format: 'plain'|'total'|'dash'|'ja', start: 1, skipFirst: false },
  header:     { enabled, text: '社内資料 {date}', align: 'left'|'center'|'right' },
  footer:     { enabled, text, align },
  watermark:  { enabled, text: '社外秘', color: 'gray'|'red'|'blue', opacity: 0.1〜0.3 },
  stamp:      { enabled, text: '社外秘', color: 'red'|'blue'|'black', position: 'top-right' など4か所, firstPageOnly: true }
}
```

- ヘッダー・フッターの文字の `{n}` はページ番号、`{total}` は全体のページ数、`{date}` は書き出した日（2026/10/21）
- `skipFirst`：1ページ目（表紙）には番号を付けず、2ページ目を `start` の番号にする
- 位置は「画面で見たときの向き」で決める。回転したページでも、見たときに下の中央・横書きになるよう、回転前の座標に戻して書き込む（`toPageSpace`）
- 取り出す・分割のときも、できたファイルごとに書き込む（ページ番号はファイルごとに1から）

## 出力するときの処理の順番（画像のページ）

1. 元画像を読み込み、写真の回転情報（EXIF）を反映する
2. 4点補正（`perspective`）で切り出して、まっすぐにする
3. 色補正（`filter`）をかける
4. ユーザーの回転（`rotation`）をかける
5. 用紙（初期値A4）に配置し、圧縮の設定に合わせて縮小・JPEG化する

## 操作の一覧

すべての操作は元の状態を変更せず、新しい状態を返します。存在しないIDや範囲外の位置を渡すとエラーになります。

| 関数 | 内容 |
|---|---|
| `createDocument()` | 空のページリストを作る |
| `addSource(doc, source)` | 元データを登録する |
| `appendSourcePages(doc, sourceId, { at })` | 元データの全ページを並びに追加する |
| `createSourcePage` / `createBlankPage` | ページを1つ作る（並びには入れない） |
| `insertPages(doc, pages, at)` | ページを指定位置に挿入する |
| `movePages(doc, pageIds, toIndex)` | 選んだページをまとめて移動する（選んだページ同士の順番は保つ） |
| `removePages(doc, pageIds)` | ページを削除する |
| `rotatePages(doc, pageIds, delta)` | 90度単位で回転する |
| `setPerspective(doc, pageId, perspective \| null)` | 4点補正を設定する・外す |
| `setFilter(doc, pageIds, filter)` | 色補正を設定する |
| `setMarks(doc, marks \| null)` | 書き込みを設定する・外す |
| `setAnnotations(doc, pageId, annotations)` | ページの注釈を置き換える（空の配列で外す） |
| `setFormValues(doc, sourceId, values \| null)` | フォーム入力の値を設定する・外す |
| `pruneSources(doc)` | 使われていない元データを取り除く |
| `extractPages(doc, pageIds)` | 選んだページを新しいページリストとして取り出す |
| `splitDocument(doc, splitBefore)` | 指定したページの手前で区切って複数に分ける |
| `serializeDocument` / `deserializeDocument` | 自動保存用の文字列にする・戻す（戻すときに形を確認する） |
| `validateDocument(doc)` | 形が正しいか調べる |

ページ範囲の入力（例：`1-3, 5, 8-`）は `src/core/page-range.js` の `parsePageRange` / `formatPageRange` で扱います。全角数字や読点にも対応しています。

## 形式を変えるときは

`SCHEMA_VERSION` を上げて、古いバージョンのデータを新しい形に変換する処理を `deserializeDocument` に追加します。変換できない場合は自動保存を捨てて、新しく始めます。
