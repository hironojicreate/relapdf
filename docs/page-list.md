# ページリストの仕様

RelaPDFの中心となるデータ構造です。実装は `src/core/page-list.js`、テストは `tests/core/page-list.test.js` にあります。

## 全体の形

```js
{
  version: 1,              // 形式のバージョン。自動保存したデータの読み込みで確認する
  sources: {               // 元データ（読み込んだPDF・画像）の情報。キーは sourceId
    "src_...": Source,
  },
  pages: [Page, ...]       // ページの並び。この順番がそのまま出力の順番になる
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
| `pruneSources(doc)` | 使われていない元データを取り除く |
| `extractPages(doc, pageIds)` | 選んだページを新しいページリストとして取り出す |
| `splitDocument(doc, splitBefore)` | 指定したページの手前で区切って複数に分ける |
| `serializeDocument` / `deserializeDocument` | 自動保存用の文字列にする・戻す（戻すときに形を確認する） |
| `validateDocument(doc)` | 形が正しいか調べる |

ページ範囲の入力（例：`1-3, 5, 8-`）は `src/core/page-range.js` の `parsePageRange` / `formatPageRange` で扱います。全角数字や読点にも対応しています。

## 形式を変えるときは

`SCHEMA_VERSION` を上げて、古いバージョンのデータを新しい形に変換する処理を `deserializeDocument` に追加します。変換できない場合は自動保存を捨てて、新しく始めます。
