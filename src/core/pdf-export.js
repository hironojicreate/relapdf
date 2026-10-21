// ページリスト → PDF の書き出し、PDFの読み込み確認（Core層）
//
// pdf-lib を使う。ブラウザでもNode.jsでも同じファイルを読み込めるよう、vendor/ の同梱版を相対パスで読む。
// 画像の加工（縮小・4点補正・色補正）はブラウザ側で行い、出来上がった画像だけを受け取る。

import { PDFDocument, degrees, rgb } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';
import { imagePageLayout } from './layout.js';
import { hasMarks, marksForPage, normalizeMarks, toPageSpace } from './marks.js';
import { compressImages } from './compress.js';
import { fillAndFlatten, readFormFields } from './forms.js';
import { annotationItems } from './annotations.js';
import { cropToPageBox, hasLayout, normalizeLayout, planSheets } from './imposition.js';
import { normalizeRotation } from './page-list.js';

export const APP_NAME = 'RelaPDF';

/** パスワード付き（暗号化された）PDFを読み込もうとしたときのエラー */
export class EncryptedPdfError extends Error {
  constructor() {
    super('パスワード付きのPDFは、今はまだ使えません');
    this.name = 'EncryptedPdfError';
  }
}

/** PDFとして読めなかったときのエラー */
export class InvalidPdfError extends Error {
  constructor(cause) {
    super('PDFを読み込めませんでした。ファイルが壊れているか、PDFではない可能性があります');
    this.name = 'InvalidPdfError';
    this.cause = cause;
  }
}

/**
 * PDFを読み込めるか確かめ、ページ数を返す。
 * 書き出しに使う pdf-lib で読めるかどうかを、読み込んだ時点で確かめておくため。
 */
export async function inspectPdf(bytes) {
  const pdf = await loadPdf(bytes);
  let formFieldCount = 0;
  try {
    formFieldCount = readFormFields(pdf).length;
  } catch (error) {
    // 入力欄が壊れていても、ページを使うことはできる
    console.warn('PDFの入力欄を読み取れませんでした', error);
  }
  return { pageCount: pdf.getPageCount(), formFieldCount };
}

/**
 * ページリストをPDFにする。
 * @param {object} doc ページリスト
 * @param {object} options
 * @param {(sourceId: string) => Promise<Uint8Array>} options.getSourceBytes PDFの元データの中身を返す
 * @param {(page: object) => Promise<{bytes: Uint8Array, format: 'jpeg'|'png', width: number, height: number}>} options.getImage
 *   画像ページの、加工済みの画像を返す。width/height は加工前の元画像の大きさ（配置の計算に使う）
 * @param {'a4'|'image'} [options.paper] 写真を置く用紙
 * @param {string} [options.title] PDFのタイトル
 * @param {Date} [options.date] 作成日時
 * @param {() => Promise<{bytes: Uint8Array, fontkit: object}>} [options.getFont]
 *   書き込み（doc.marks）に使う日本語フォントと fontkit を返す。書き込みがあるときだけ呼ぶ
 * @param {{ level: 'standard'|'strong', recompressJpeg: Function, onResult?: (result: object) => void }} [options.compress]
 *   読み込んだPDFの中の画像を縮小し直す（compress.js）。写真のページは画質の設定で縮小済みなので対象外
 * @param {(sourceId: string) => Promise<{bytes: Uint8Array, format: 'png'|'jpeg'}>} [options.getAnnotationImage]
 *   注釈の画像（署名・印鑑）の中身を返す。画像の注釈があるときだけ呼ぶ
 * @param {{ offset: number, total: number }} [options.markNumbering]
 *   書き込みのページ番号の数え方を変える（見本として一部のページだけ書き出すとき。offset は最初のページが元の何ページ目か）
 * @returns {Promise<Uint8Array>}
 */
export async function exportPdf(doc, options) {
  const { getSourceBytes, getImage, getFont, getAnnotationImage, markNumbering, compress, paper = 'a4', title, date = new Date() } = options;
  if (doc.pages.length === 0) throw new Error('ページがありません');

  // 書き出しの順番：ページを作る → 注釈 → トリミング → 用紙サイズの変換・割付 → 書き込み（ページ番号など）
  const out = await createOutput(doc, { title, date });

  // PDFのページは元データごとにまとめてコピーする（フォントなどの共有データを重複させないため）
  const copied = await copyPdfPages(doc, out, getSourceBytes, getFont);
  // この時点で out に入っているのは、読み込んだPDFのページの中身だけ（写真はまだ入れていない）
  if (compress) {
    const result = await compressImages(out, compress.level, { recompressJpeg: compress.recompressJpeg });
    compress.onResult?.(result);
  }

  const built = []; // { pdfPage, page, baseRotation }
  for (const page of doc.pages) {
    const { content } = page;
    let pdfPage;
    let baseRotation = 0;

    if (content.type === 'pdf') {
      pdfPage = copied.get(page.id);
      baseRotation = pdfPage.getRotation().angle;
      out.addPage(pdfPage);
    } else if (content.type === 'image') {
      const image = await getImage(page);
      const embedded = image.format === 'png' ? await out.embedPng(image.bytes) : await out.embedJpg(image.bytes);
      const layout = imagePageLayout(image.width, image.height, paper);
      pdfPage = out.addPage([layout.pageWidth, layout.pageHeight]);
      pdfPage.drawImage(embedded, { x: layout.x, y: layout.y, width: layout.width, height: layout.height });
    } else if (content.type === 'blank') {
      pdfPage = out.addPage([content.width, content.height]);
    } else {
      throw new Error(`ページの種類が不正です: ${content.type}`);
    }

    // PDFにもともと付いている回転に、ユーザーの回転を足す
    pdfPage.setRotation(degrees(normalizeRotation(baseRotation + page.rotation)));
    built.push({ pdfPage, page, baseRotation: normalizeRotation(baseRotation) });
  }

  // 日本語フォントは、PDFごとに、使うときに1回だけ埋め込む（使う文字だけ。全部入れると数MBになるため）
  const fonts = new Map();
  const fontFor = (pdf) => {
    if (!fonts.has(pdf)) {
      fonts.set(
        pdf,
        (async () => {
          if (!getFont) throw new Error('文字の書き込みに使うフォントがありません');
          const { bytes, fontkit } = await getFont();
          pdf.registerFontkit(fontkit);
          return pdf.embedFont(bytes, { subset: true });
        })(),
      );
    }
    return fonts.get(pdf);
  };

  const annotated = built.filter(({ page }) => page.annotations?.length);
  if (annotated.length > 0) await drawAnnotations(out, annotated, { loadFont: () => fontFor(out), getAnnotationImage });

  // トリミング：ページの見せる範囲（CropBox）を狭める
  for (const { pdfPage, page, baseRotation } of built) {
    if (!page.crop) continue;
    const box = cropToPageBox(page.crop, pdfPage.getCropBox(), baseRotation);
    pdfPage.setCropBox(box.x, box.y, box.width, box.height);
  }

  // 用紙サイズの変換・割付：ページを新しい用紙に並べ直す
  const result = hasLayout(doc.layout) ? await impose(out, normalizeLayout(doc.layout), doc, { title, date }) : out;

  if (hasMarks(doc.marks)) {
    await drawMarks(result, normalizeMarks(doc.marks), { loadFont: () => fontFor(result), date, numbering: markNumbering });
  }
  return result.save();
}

/** 書き出すPDFを作り、作成日やプロパティを入れる */
async function createOutput(doc, { title, date }) {
  // updateMetadata: false にしないと、保存時に作成者などが pdf-lib の名前で上書きされる
  const out = await PDFDocument.create({ updateMetadata: false });
  out.setProducer(APP_NAME);
  out.setCreator(APP_NAME);
  out.setCreationDate(date);
  out.setModificationDate(date);
  // プロパティ（設定されていれば、ファイル名から付けたタイトルより優先する）
  const props = doc.properties ?? {};
  if (props.title || title) out.setTitle(props.title || title);
  if (props.author) out.setAuthor(props.author);
  if (props.subject) out.setSubject(props.subject);
  if (props.keywords) out.setKeywords(props.keywords.split(/[,、，]\s*/).filter(Boolean));
  return out;
}

/**
 * ページを、新しい用紙に並べ直したPDFを作る（用紙サイズの変換・割付。imposition.js）。
 * 元のページは、画面で見たときの向き（回転をかけた向き）で置く。
 */
async function impose(out, layout, doc, meta) {
  // 画像やフォントは、保存するときに初めて書き込まれる。ページを写す前に書き込んでおかないと、写したページから抜け落ちる
  await out.flush();
  const sheetsPdf = await createOutput(doc, meta);
  const pages = out.getPages();
  const views = pages.map((p) => {
    const rotation = normalizeRotation(p.getRotation().angle);
    const box = p.getCropBox();
    const sideways = rotation === 90 || rotation === 270;
    return { width: sideways ? box.height : box.width, height: sideways ? box.width : box.height, rotation, box };
  });
  const embedded = await sheetsPdf.embedPages(
    pages,
    views.map(({ box }) => ({ left: box.x, bottom: box.y, right: box.x + box.width, top: box.y + box.height })),
  );
  for (const sheet of planSheets(views, layout)) {
    const page = sheetsPdf.addPage([sheet.width, sheet.height]);
    for (const cell of sheet.cells) {
      const { box, rotation } = views[cell.index];
      const w = box.width * cell.scale; // 回転前の大きさ
      const h = box.height * cell.scale;
      // 右に回して置くと、左下の角がずれるので、その分だけ動かす
      let { x, y } = cell;
      if (rotation === 90) y += w;
      else if (rotation === 180) (x += w), (y += h);
      else if (rotation === 270) x += h;
      page.drawPage(embedded[cell.index], { x, y, xScale: cell.scale, yScale: cell.scale, rotate: degrees(-rotation) });
      if (layout.border) {
        page.drawRectangle({ x: cell.x, y: cell.y, width: cell.width, height: cell.height, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
      }
    }
  }
  return sheetsPdf;
}

/** 注釈（文字・図形・署名や印鑑の画像）を描く */
async function drawAnnotations(out, annotated, { loadFont, getAnnotationImage }) {
  const needsFont = annotated.some(({ page }) => page.annotations.some((a) => a.type === 'text' && a.text.trim()));
  const font = needsFont ? await loadFont() : null;
  const images = new Map(); // sourceId → 埋め込んだ画像（同じ画像は1回だけ埋め込む）
  for (const { pdfPage, page, baseRotation } of annotated) {
    for (const a of page.annotations) {
      if (a.type !== 'image' || images.has(a.sourceId)) continue;
      if (!getAnnotationImage) throw new Error('注釈の画像がありません');
      const image = await getAnnotationImage(a.sourceId);
      images.set(a.sourceId, image.format === 'png' ? await out.embedPng(image.bytes) : await out.embedJpg(image.bytes));
    }
    // 注釈の座標の基準：PDFにもともと付いている回転をかけたページ（ユーザーの回転をかける前）
    const box = pdfPage.getCropBox();
    const sideways = baseRotation === 90 || baseRotation === 270;
    const frame = { width: sideways ? box.height : box.width, height: sideways ? box.width : box.height, rotation: page.rotation };
    drawItems(pdfPage, annotationItems(page.annotations, frame), { font, images });
  }
}

/** すべてのページに、書き込み（ページ番号など）をする */
async function drawMarks(out, marks, { loadFont, date, numbering }) {
  const font = await loadFont();
  const measure = (text, size) => font.widthOfTextAtSize(text, size);
  const pages = out.getPages();
  const offset = numbering?.offset ?? 0;
  const total = numbering?.total ?? pages.length;
  pages.forEach((pdfPage, i) => {
    const rotation = normalizeRotation(pdfPage.getRotation().angle);
    const box = pdfPage.getCropBox();
    const sideways = rotation === 90 || rotation === 270;
    const view = { width: sideways ? box.height : box.width, height: sideways ? box.width : box.height };
    drawItems(pdfPage, marksForPage(marks, { ...view, index: offset + i, total, date, measure }), { font });
  });
}

/**
 * 画面で見たときの向きの座標（ポイント・左下が原点）で表した内容を、ページに描く。
 * 回転したページでは、回転前の座標に戻して、文字や図形も一緒に回す（marks.js の toPageSpace）。
 */
function drawItems(pdfPage, items, { font, images }) {
  const rotation = normalizeRotation(pdfPage.getRotation().angle);
  const box = pdfPage.getCropBox();
  const place = (x, y) => toPageSpace(rotation, box, x, y);
  for (const item of items) {
    const color = item.color ? rgb(...item.color) : undefined;
    if (item.type === 'line') {
      const a = place(item.x1, item.y1);
      const b = place(item.x2, item.y2);
      pdfPage.drawLine({ start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y }, thickness: item.width, color, opacity: item.opacity, lineCap: 1 });
      continue;
    }
    if (item.type === 'ellipse') {
      const c = place(item.cx, item.cy);
      pdfPage.drawEllipse({
        x: c.x,
        y: c.y,
        xScale: item.rx,
        yScale: item.ry,
        rotate: degrees(normalizeRotation(c.angle + item.angle)),
        borderColor: color,
        borderWidth: item.borderWidth,
        borderOpacity: item.opacity,
      });
      continue;
    }
    const p = place(item.x, item.y);
    const rotate = degrees(normalizeRotation(p.angle + item.angle));
    if (item.type === 'text') {
      pdfPage.drawText(item.text, { x: p.x, y: p.y, size: item.size, font, color, opacity: item.opacity, rotate });
    } else if (item.type === 'image') {
      pdfPage.drawImage(images.get(item.sourceId), { x: p.x, y: p.y, width: item.width, height: item.height, rotate });
    } else if (item.fill) {
      pdfPage.drawRectangle({ x: p.x, y: p.y, width: item.width, height: item.height, color, opacity: item.opacity, rotate });
    } else {
      pdfPage.drawRectangle({
        x: p.x,
        y: p.y,
        width: item.width,
        height: item.height,
        borderColor: color,
        borderWidth: item.borderWidth,
        borderOpacity: item.opacity,
        rotate,
      });
    }
  }
}

async function copyPdfPages(doc, out, getSourceBytes, getFont) {
  const bySource = new Map();
  for (const page of doc.pages) {
    if (page.content.type !== 'pdf') continue;
    const list = bySource.get(page.content.sourceId) ?? [];
    list.push(page);
    bySource.set(page.content.sourceId, list);
  }

  const copied = new Map();
  for (const [sourceId, pages] of bySource) {
    const src = await loadPdf(await getSourceBytes(sourceId));
    // フォーム入力があれば、入力欄に値を入れて平坦化してからコピーする（forms.js）
    const values = doc.forms?.[sourceId];
    if (values && Object.keys(values).length > 0) {
      if (!getFont) throw new Error('フォーム入力に使うフォントがありません');
      const { bytes, fontkit } = await getFont();
      src.registerFontkit(fontkit);
      fillAndFlatten(src, values, await src.embedFont(bytes, { subset: true }));
    }
    const result = await out.copyPages(
      src,
      pages.map((p) => p.content.pageIndex),
    );
    pages.forEach((p, i) => copied.set(p.id, result[i]));
  }
  return copied;
}

async function loadPdf(bytes) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    if (error?.constructor?.name === 'EncryptedPDFError' || /encrypted/i.test(error?.message ?? '')) {
      throw new EncryptedPdfError();
    }
    throw new InvalidPdfError(error);
  }
}
