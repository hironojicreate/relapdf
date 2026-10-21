// 写真から書類の四隅を探す（ブラウザ側）
//
// 写真を小さく描き直して画素を取り出し、Core の detectDocument に渡す。

import { DETECT_SIZE, detectDocument } from '../core/detect.js';
import { fitLongSide } from '../core/layout.js';

/**
 * 描画できる画像（canvas・ImageBitmap・img など）から、書類の四隅を探す。
 * @returns {{x: number, y: number}[] | null} 画像に対する0〜1の割合。見つからなければ null
 */
export function detectCorners(source, width, height) {
  if (!width || !height) return null;
  const size = fitLongSide(width, height, DETECT_SIZE);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(source, 0, 0, size.width, size.height);
    return detectDocument(ctx.getImageData(0, 0, size.width, size.height))?.corners ?? null;
  } catch (error) {
    // 探せなかったときは、補正しないだけにする
    console.warn(error);
    return null;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
