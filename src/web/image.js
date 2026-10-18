// 画像の読み込み・縮小・書き出し（ブラウザ側）
//
// iPhoneのメモリ対策として、大きな写真は読み込んだ時点で縮小し、1枚ずつ処理する。
// 写真の回転情報（EXIF）は、ブラウザが画像を読み込むときに反映される。

import { MAX_SOURCE_LONG_SIDE, fitLongSide, targetImageSize } from '../core/layout.js';

/** 読み込めない画像形式のときのエラー */
export class UnsupportedImageError extends Error {
  constructor(name) {
    super(`この画像は読み込めませんでした：${name}`);
    this.name = 'UnsupportedImageError';
  }
}

/**
 * 画像（Blob）を読み込んで描画できる形にする。
 * 使い終わったら必ず close() を呼ぶ（メモリを早く解放するため）。
 * @returns {Promise<{source: CanvasImageSource, width: number, height: number, close: () => void}>}
 */
export async function decodeImage(blob, name = '') {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Safariの一部の形式などは <img> で読めることがあるので、下で試す
    }
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new UnsupportedImageError(name);
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
}

/**
 * 描画できる画像を、指定の大きさに縮小してJPEGなどにする。
 * 透明な部分は白にする（JPEGは透明を持てないため。黒くなるのを防ぐ）。
 */
export async function encodeImage(source, width, height, { type = 'image/jpeg', quality = 0.92 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  try {
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('画像を作れませんでした'))), type, quality);
    });
  } finally {
    // iPhoneではcanvasのメモリがすぐに解放されないことがあるので、大きさを0にしておく
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * 写真ファイルを読み込み、長辺を上限までに縮小したJPEGにする。
 * これを元データとして保存し、書き出しのときに画質の設定に合わせてもう一度縮小する。
 */
export async function loadImageFile(file) {
  const decoded = await decodeImage(file, file.name);
  try {
    const size = fitLongSide(decoded.width, decoded.height, MAX_SOURCE_LONG_SIDE);
    const blob = await encodeImage(decoded.source, size.width, size.height, { quality: 0.92 });
    return { blob, width: size.width, height: size.height };
  } finally {
    decoded.close();
  }
}

/**
 * 書き出し用の画像を作る。
 * @returns {Promise<{bytes: Uint8Array, format: 'jpeg', width: number, height: number}>}
 *   width/height は元画像の大きさ（用紙への配置の計算に使う）
 */
export async function prepareImageForExport(blob, { quality = 'standard', paper = 'a4' } = {}) {
  const decoded = await decodeImage(blob);
  try {
    // M3：4点補正、M5：色補正は、ここで縮小の前に行う
    const target = targetImageSize(decoded.width, decoded.height, quality, paper);
    const jpeg = await encodeImage(decoded.source, target.width, target.height, { quality: target.jpegQuality });
    return {
      bytes: new Uint8Array(await jpeg.arrayBuffer()),
      format: 'jpeg',
      width: decoded.width,
      height: decoded.height,
    };
  } finally {
    decoded.close();
  }
}

/** サムネイル用の小さな画像を作り、表示用のURLを返す */
export async function imageThumbnailUrl(blob, maxSide) {
  const decoded = await decodeImage(blob);
  try {
    const size = fitLongSide(decoded.width, decoded.height, maxSide);
    const thumb = await encodeImage(decoded.source, size.width, size.height, { quality: 0.8 });
    return URL.createObjectURL(thumb);
  } finally {
    decoded.close();
  }
}
