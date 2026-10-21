// 画像の読み込み・縮小・書き出し（ブラウザ側）
//
// iPhoneのメモリ対策として、大きな写真は読み込んだ時点で縮小し、1枚ずつ処理する。
// 写真の回転情報（EXIF）は、ブラウザが画像を読み込むときに反映される。

import { MAX_SOURCE_LONG_SIDE, fitLongSide, targetImageSize } from '../core/layout.js';
import { outputSize, toPixels, warpPerspective } from '../core/perspective.js';
import { detectCorners } from './detect-image.js';

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
 * 書類の四隅が見つかったときは corners も返す（見つからなければ null）。
 */
export async function loadImageFile(file) {
  const decoded = await decodeImage(file, file.name);
  try {
    const size = fitLongSide(decoded.width, decoded.height, MAX_SOURCE_LONG_SIDE);
    const blob = await encodeImage(decoded.source, size.width, size.height, { quality: 0.92 });
    const corners = detectCorners(decoded.source, decoded.width, decoded.height);
    return { blob, width: size.width, height: size.height, corners };
  } finally {
    decoded.close();
  }
}

/**
 * 4点補正をかけた画像を作る（ImageData を使って、Core の warpPerspective で引き伸ばす）。
 * 縮小しすぎてギザギザにならないよう、先に元画像を出力に近い大きさまで縮めてから引き伸ばす。
 * @returns {Promise<Blob>}
 */
async function encodeCorrected(decoded, perspective, width, height, quality) {
  const cornersPx = toPixels(perspective.corners, decoded.width, decoded.height);
  const natural = outputSize(cornersPx, perspective.aspect);
  const k = Math.min(1, Math.max(width / natural.width, height / natural.height) * 1.25);
  const sw = Math.max(1, Math.round(decoded.width * k));
  const sh = Math.max(1, Math.round(decoded.height * k));

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sw, sh);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(decoded.source, 0, 0, sw, sh);
  const src = ctx.getImageData(0, 0, sw, sh);
  const warped = warpPerspective(
    src,
    cornersPx.map((p) => ({ x: p.x * (sw / decoded.width), y: p.y * (sh / decoded.height) })),
    width,
    height,
  );
  canvas.width = width;
  canvas.height = height;
  ctx.putImageData(new ImageData(warped.data, width, height), 0, 0);
  try {
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('画像を作れませんでした'))), 'image/jpeg', quality);
    });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** 4点補正をかけたあとの画像の大きさ（補正がなければ元のまま） */
function correctedSize(decoded, perspective) {
  if (!perspective) return { width: decoded.width, height: decoded.height };
  return outputSize(toPixels(perspective.corners, decoded.width, decoded.height), perspective.aspect);
}

/**
 * 書き出し用の画像を作る。4点補正があればかけてから、画質の設定に合わせて縮小する。
 * @returns {Promise<{bytes: Uint8Array, format: 'jpeg', width: number, height: number}>}
 *   width/height は補正後の画像の大きさ（用紙への配置の計算に使う）
 */
export async function prepareImageForExport(blob, { quality = 'standard', paper = 'a4', perspective = null } = {}) {
  const decoded = await decodeImage(blob);
  try {
    // M5：色補正（書類モード）は、ここで縮小の前後に行う
    const size = correctedSize(decoded, perspective);
    const target = targetImageSize(size.width, size.height, quality, paper);
    const jpeg = perspective
      ? await encodeCorrected(decoded, perspective, target.width, target.height, target.jpegQuality)
      : await encodeImage(decoded.source, target.width, target.height, { quality: target.jpegQuality });
    return {
      bytes: new Uint8Array(await jpeg.arrayBuffer()),
      format: 'jpeg',
      width: target.width,
      height: target.height,
    };
  } finally {
    decoded.close();
  }
}

/** サムネイル用の小さな画像を作り、表示用のURLを返す（4点補正があれば反映する） */
export async function imageThumbnailUrl(blob, maxSide, perspective = null) {
  const decoded = await decodeImage(blob);
  try {
    const corrected = correctedSize(decoded, perspective);
    const size = fitLongSide(corrected.width, corrected.height, maxSide);
    const thumb = perspective
      ? await encodeCorrected(decoded, perspective, size.width, size.height, 0.8)
      : await encodeImage(decoded.source, size.width, size.height, { quality: 0.8 });
    return URL.createObjectURL(thumb);
  } finally {
    decoded.close();
  }
}

/**
 * 画像のページを、1枚の画像ファイルにする（PDF→画像の書き出し用）。
 * 4点補正とユーザーの回転をかける。大きさは元データのまま（長辺は元データの上限まで）。
 * @param {{ perspective?: object|null, rotation?: number, type?: string, quality?: number, maxSide?: number }} options
 */
export async function renderImagePage(blob, { perspective = null, rotation = 0, type = 'image/jpeg', quality = 0.92, maxSide } = {}) {
  let source = blob;
  if (perspective) {
    const decoded = await decodeImage(blob);
    try {
      const size = correctedSize(decoded, perspective);
      source = await encodeCorrected(decoded, perspective, size.width, size.height, 0.95);
    } finally {
      decoded.close();
    }
  }
  const decoded = await decodeImage(source);
  try {
    const size = maxSide ? fitLongSide(decoded.width, decoded.height, maxSide) : { width: decoded.width, height: decoded.height };
    const sideways = rotation === 90 || rotation === 270;
    const canvas = document.createElement('canvas');
    canvas.width = sideways ? size.height : size.width;
    canvas.height = sideways ? size.width : size.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(decoded.source, -size.width / 2, -size.height / 2, size.width, size.height);
    try {
      return await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を作れませんでした'))), type, quality),
      );
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    decoded.close();
  }
}
