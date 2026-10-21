// ページを1枚の画像にする（PDF→画像の書き出し・大きなプレビュー用。ブラウザ側）
//
// - PDFのページ：PDF.js で、指定の解像度（dpi）で描く
// - 写真のページ：4点補正・書類モードと回転をかけて、元の大きさのまま
// - 白紙のページ：白い画像

import { renderPdfPage } from './pdf-view.js';
import { renderImagePage } from './image.js';

/** 書き出す画像の形式 */
export const IMAGE_FORMATS = Object.freeze({
  jpeg: Object.freeze({ type: 'image/jpeg', extension: '.jpg', quality: 0.92 }),
  png: Object.freeze({ type: 'image/png', extension: '.png' }),
});

/**
 * @param {object} page ページリストのページ
 * @param {object} store 元データの置き場所（source-store）
 * @param {{ dpi?: number, format?: 'jpeg'|'png', maxSide?: number }} options maxSide を指定すると、長辺をその大きさにする（プレビュー用）
 * @returns {Promise<Blob>}
 */
export async function renderPageImage(page, store, { dpi = 150, format = 'jpeg', maxSide } = {}) {
  const { type, quality } = IMAGE_FORMATS[format] ?? IMAGE_FORMATS.jpeg;
  const { content } = page;
  if (content.type === 'pdf') {
    return renderPdfPage(content.sourceId, () => store.bytes(content.sourceId), content.pageIndex, {
      scale: dpi / 72,
      maxSide,
      extraRotation: page.rotation,
      type,
      quality,
    });
  }
  if (content.type === 'image') {
    return renderImagePage(await store.get(content.sourceId), {
      perspective: page.perspective,
      filter: page.filter,
      rotation: page.rotation,
      type,
      quality,
      maxSide,
    });
  }
  // 白紙
  const sideways = page.rotation === 90 || page.rotation === 270;
  const scale = maxSide ? maxSide / Math.max(content.width, content.height) : dpi / 72;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((sideways ? content.height : content.width) * scale));
  canvas.height = Math.max(1, Math.round((sideways ? content.width : content.height) * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
