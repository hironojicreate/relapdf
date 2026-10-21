// ページリスト → PDF の書き出し、PDFの読み込み確認（Core層）
//
// pdf-lib を使う。ブラウザでもNode.jsでも同じファイルを読み込めるよう、vendor/ の同梱版を相対パスで読む。
// 画像の加工（縮小・4点補正・色補正）はブラウザ側で行い、出来上がった画像だけを受け取る。

import { PDFDocument, degrees, rgb } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';
import { imagePageLayout } from './layout.js';
import { hasMarks, marksForPage, normalizeMarks, toPageSpace } from './marks.js';
import { compressImages } from './compress.js';
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
  return { pageCount: pdf.getPageCount() };
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
 * @param {{ offset: number, total: number }} [options.markNumbering]
 *   書き込みのページ番号の数え方を変える（見本として一部のページだけ書き出すとき。offset は最初のページが元の何ページ目か）
 * @returns {Promise<Uint8Array>}
 */
export async function exportPdf(doc, options) {
  const { getSourceBytes, getImage, getFont, markNumbering, compress, paper = 'a4', title, date = new Date() } = options;
  if (doc.pages.length === 0) throw new Error('ページがありません');

  // updateMetadata: false にしないと、保存時に作成者などが pdf-lib の名前で上書きされる
  const out = await PDFDocument.create({ updateMetadata: false });
  out.setProducer(APP_NAME);
  out.setCreator(APP_NAME);
  out.setCreationDate(date);
  out.setModificationDate(date);
  if (title) out.setTitle(title);

  // PDFのページは元データごとにまとめてコピーする（フォントなどの共有データを重複させないため）
  const copied = await copyPdfPages(doc, out, getSourceBytes);
  // この時点で out に入っているのは、読み込んだPDFのページの中身だけ（写真はまだ入れていない）
  if (compress) {
    const result = await compressImages(out, compress.level, { recompressJpeg: compress.recompressJpeg });
    compress.onResult?.(result);
  }

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
  }

  if (hasMarks(doc.marks)) await drawMarks(out, normalizeMarks(doc.marks), { getFont, date, numbering: markNumbering });

  return out.save();
}

/** すべてのページに、書き込み（ページ番号など）をする */
async function drawMarks(out, marks, { getFont, date, numbering }) {
  if (!getFont) throw new Error('書き込みに使うフォントがありません');
  const { bytes, fontkit } = await getFont();
  out.registerFontkit(fontkit);
  // 使う文字だけを埋め込む（日本語フォントは全部入れると数MBになるため）
  const font = await out.embedFont(bytes, { subset: true });
  const measure = (text, size) => font.widthOfTextAtSize(text, size);
  const pages = out.getPages();
  const offset = numbering?.offset ?? 0;
  const total = numbering?.total ?? pages.length;
  pages.forEach((pdfPage, i) => {
    const index = offset + i;
    const rotation = normalizeRotation(pdfPage.getRotation().angle);
    const box = pdfPage.getCropBox();
    const sideways = rotation === 90 || rotation === 270;
    const view = { width: sideways ? box.height : box.width, height: sideways ? box.width : box.height };
    for (const item of marksForPage(marks, { ...view, index, total, date, measure })) {
      const p = toPageSpace(rotation, box, item.x, item.y);
      const rotate = degrees(normalizeRotation(p.angle + item.angle));
      const color = rgb(...item.color);
      if (item.type === 'text') {
        pdfPage.drawText(item.text, { x: p.x, y: p.y, size: item.size, font, color, opacity: item.opacity, rotate });
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
  });
}

async function copyPdfPages(doc, out, getSourceBytes) {
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
