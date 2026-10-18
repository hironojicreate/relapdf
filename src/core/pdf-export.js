// ページリスト → PDF の書き出し、PDFの読み込み確認（Core層）
//
// pdf-lib を使う。ブラウザでもNode.jsでも同じファイルを読み込めるよう、vendor/ の同梱版を相対パスで読む。
// 画像の加工（縮小・4点補正・色補正）はブラウザ側で行い、出来上がった画像だけを受け取る。

import { PDFDocument, degrees } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';
import { imagePageLayout } from './layout.js';
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
 * @returns {Promise<Uint8Array>}
 */
export async function exportPdf(doc, options) {
  const { getSourceBytes, getImage, paper = 'a4', title, date = new Date() } = options;
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

  return out.save();
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
