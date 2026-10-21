// PDFの圧縮：PDFの中の画像を縮小し直す（Core層）
//
// 読み込んだPDFのページに入っている画像を、長辺が決まった大きさに収まるよう縮小する。
// - JPEG（DCTDecode）の画像：縮小・JPEGへの変換は、呼び出し側（ブラウザの canvas）に任せる
// - 圧縮だけの画像（FlateDecode）：ここで展開して縮小し、もう一度 Flate で圧縮する（文字や図がにじまないよう、JPEGにはしない）
// どちらも、元より小さくなったときだけ置き換える。
// 次のような画像は、見た目が変わるおそれがあるので触らない：
// 色の数が限られた画像（Indexed）、CMYK、1色あたり8ビット以外、マスク画像、色の範囲を変える指定（Decode）があるもの

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';
import { unzlibSync, zlibSync } from '../../vendor/fflate/fflate.mjs';

/** 圧縮の強さ。maxSide は画像の長辺の上限（ピクセル）、quality はJPEGの画質 */
export const COMPRESS_LEVELS = Object.freeze({
  standard: Object.freeze({ maxSide: 2000, quality: 0.8, reencode: false }),
  strong: Object.freeze({ maxSide: 1400, quality: 0.65, reencode: true }),
});

const N = (name) => PDFName.of(name);

/**
 * PDFの中の画像を圧縮する（pdf を書き換える）。
 * @param {import('pdf-lib').PDFDocument} pdf
 * @param {'standard'|'strong'} level
 * @param {object} options
 * @param {(input: {bytes: Uint8Array, width: number, height: number, targetWidth: number, targetHeight: number, quality: number})
 *   => Promise<{bytes: Uint8Array, width: number, height: number} | null>} options.recompressJpeg
 *   JPEG を縮小・画質を下げて作り直す（できなければ null）
 * @returns {Promise<{count: number, before: number, after: number}>} 置き換えた枚数と、置き換えた画像の大きさの合計（バイト）
 */
export async function compressImages(pdf, level, { recompressJpeg }) {
  const settings = COMPRESS_LEVELS[level];
  if (!settings) throw new Error(`圧縮の強さが不正です: ${level}`);
  const { context } = pdf;
  const result = { count: 0, before: 0, after: 0 };

  for (const [ref, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const info = imageInfo(context, object.dict);
    if (!info) continue;
    const before = object.contents.length;
    const scale = Math.min(1, settings.maxSide / Math.max(info.width, info.height));
    const targetWidth = Math.max(1, Math.round(info.width * scale));
    const targetHeight = Math.max(1, Math.round(info.height * scale));

    let replacement = null;
    try {
      if (info.filter === 'DCTDecode') {
        if (scale === 1 && !settings.reencode) continue;
        const jpeg = await recompressJpeg({
          bytes: object.contents,
          width: info.width,
          height: info.height,
          targetWidth,
          targetHeight,
          quality: settings.quality,
        });
        if (jpeg) replacement = imageStream(context, object.dict, { ...jpeg, filter: 'DCTDecode', colorSpace: 'DeviceRGB' });
      } else {
        if (scale === 1) continue;
        const pixels = decodeFlate(object.contents, info);
        const small = downscale(pixels, info.width, info.height, info.components, targetWidth, targetHeight);
        // PNG と同じく「上の行との差」にしてから圧縮すると、写真やグラデーションがよく縮む
        replacement = imageStream(context, object.dict, {
          bytes: zlibSync(predictUp(small, targetWidth * info.components, targetHeight), { level: 9 }),
          width: targetWidth,
          height: targetHeight,
          filter: 'FlateDecode',
          colorSpace: info.colorSpace,
          decodeParms: { Predictor: 12, Colors: info.components, BitsPerComponent: 8, Columns: targetWidth },
        });
      }
    } catch (error) {
      // 読めない画像は、そのままにしておく
      console.warn('画像を圧縮できませんでした', error);
      continue;
    }
    if (!replacement || replacement.contents.length >= before) continue;
    context.assign(ref, replacement);
    result.count += 1;
    result.before += before;
    result.after += replacement.contents.length;
  }
  return result;
}

/**
 * 圧縮できる画像なら、その情報を返す（できなければ null）。
 * @returns {{width: number, height: number, components: 1|3, filter: 'DCTDecode'|'FlateDecode', colorSpace: object, predictor: number} | null}
 */
export function imageInfo(context, dict) {
  if (dict.get(N('Subtype')) !== N('Image')) return null;
  if (dict.get(N('ImageMask'))?.toString() === 'true') return null;
  if (dict.has(N('Mask')) && context.lookup(dict.get(N('Mask'))) instanceof PDFArray) return null; // 色で抜く指定
  if (dict.has(N('Decode'))) return null;
  const width = numberOf(context, dict.get(N('Width')));
  const height = numberOf(context, dict.get(N('Height')));
  const bits = numberOf(context, dict.get(N('BitsPerComponent')));
  if (!(width > 0 && height > 0) || bits !== 8) return null;

  let filters = context.lookup(dict.get(N('Filter')));
  if (filters instanceof PDFArray) filters = filters.size() === 1 ? context.lookup(filters.get(0)) : null;
  const filter = filters === N('DCTDecode') ? 'DCTDecode' : filters === N('FlateDecode') ? 'FlateDecode' : null;
  if (!filter) return null;

  const colorSpace = dict.get(N('ColorSpace'));
  const components = componentsOf(context, colorSpace);
  if (!components) return null;

  let predictor = 1;
  const params = context.lookup(dict.get(N('DecodeParms')));
  const param = params instanceof PDFArray ? context.lookup(params.get(0)) : params;
  if (param instanceof PDFDict) {
    predictor = numberOf(context, param.get(N('Predictor'))) || 1;
    const colors = numberOf(context, param.get(N('Colors'))) || 1;
    const bpc = numberOf(context, param.get(N('BitsPerComponent'))) || 8;
    const columns = numberOf(context, param.get(N('Columns'))) || 1;
    if (predictor !== 1 && (predictor < 10 || colors !== components || bpc !== 8 || columns !== width)) return null;
  }
  return { width, height, components, filter, colorSpace, predictor };
}

/** 色の種類から、1画素あたりの色の数を求める（対応していなければ 0） */
function componentsOf(context, colorSpace) {
  const cs = context.lookup(colorSpace);
  if (cs === N('DeviceRGB')) return 3;
  if (cs === N('DeviceGray')) return 1;
  if (cs instanceof PDFArray) {
    const kind = context.lookup(cs.get(0));
    if (kind === N('CalRGB')) return 3;
    if (kind === N('CalGray')) return 1;
    if (kind === N('ICCBased')) {
      const profile = context.lookup(cs.get(1));
      const n = numberOf(context, profile?.dict?.get(N('N')));
      return n === 1 || n === 3 ? n : 0;
    }
  }
  return 0;
}

function numberOf(context, value) {
  const v = context.lookup(value);
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

/** Flate の画像を展開し、画素の並び（1行ずつ、色の数 × 幅）にする */
export function decodeFlate(bytes, { width, height, components, predictor }) {
  const raw = unzlibSync(bytes);
  const rowBytes = width * components;
  if (predictor < 10) {
    if (raw.length < rowBytes * height) throw new Error('画像のデータが足りません');
    return raw.subarray(0, rowBytes * height);
  }
  return unpredictPng(raw, rowBytes, height, components);
}

/** PNG の予測（行ごとの差分）を元に戻す */
export function unpredictPng(raw, rowBytes, height, bpp) {
  const out = new Uint8Array(rowBytes * height);
  const stride = rowBytes + 1;
  if (raw.length < stride * height) throw new Error('画像のデータが足りません');
  for (let y = 0; y < height; y++) {
    const type = raw[y * stride];
    const src = raw.subarray(y * stride + 1, y * stride + 1 + rowBytes);
    const row = y * rowBytes;
    const prev = row - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= bpp && y > 0 ? out[prev + x - bpp] : 0;
      let v;
      switch (type) {
        case 0:
          v = src[x];
          break;
        case 1:
          v = src[x] + a;
          break;
        case 2:
          v = src[x] + b;
          break;
        case 3:
          v = src[x] + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = src[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`対応していない予測の種類です: ${type}`);
      }
      out[row + x] = v & 0xff;
    }
  }
  return out;
}

/** PNG の予測（Up：上の行との差）をかける。各行の頭に予測の種類（2）を付ける */
export function predictUp(data, rowBytes, height) {
  const out = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (rowBytes + 1);
    out[o] = 2;
    const row = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      out[o + 1 + x] = (data[row + x] - (y > 0 ? data[row - rowBytes + x] : 0)) & 0xff;
    }
  }
  return out;
}

/** 画素の並びを、面積の平均で縮小する */
export function downscale(pixels, width, height, components, targetWidth, targetHeight) {
  const out = new Uint8Array(targetWidth * targetHeight * components);
  const sx = width / targetWidth;
  const sy = height / targetHeight;
  const sums = new Float64Array(components);
  for (let ty = 0; ty < targetHeight; ty++) {
    const y0 = Math.floor(ty * sy);
    const y1 = Math.max(y0 + 1, Math.min(height, Math.floor((ty + 1) * sy)));
    for (let tx = 0; tx < targetWidth; tx++) {
      const x0 = Math.floor(tx * sx);
      const x1 = Math.max(x0 + 1, Math.min(width, Math.floor((tx + 1) * sx)));
      sums.fill(0);
      for (let y = y0; y < y1; y++) {
        let i = (y * width + x0) * components;
        for (let x = x0; x < x1; x++) {
          for (let c = 0; c < components; c++) sums[c] += pixels[i++];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (ty * targetWidth + tx) * components;
      for (let c = 0; c < components; c++) out[o + c] = Math.round(sums[c] / n);
    }
  }
  return out;
}

/** 元の画像の設定（マスクなど）を引き継いで、新しい画像のデータを作る */
function imageStream(context, oldDict, { bytes, width, height, filter, colorSpace, decodeParms }) {
  const dict = context.obj({});
  for (const [key, value] of oldDict.entries()) {
    if (['Filter', 'DecodeParms', 'Width', 'Height', 'Length', 'ColorSpace', 'BitsPerComponent'].includes(key.decodeText())) continue;
    dict.set(key, value);
  }
  dict.set(N('Filter'), N(filter));
  dict.set(N('Width'), PDFNumber.of(width));
  dict.set(N('Height'), PDFNumber.of(height));
  dict.set(N('BitsPerComponent'), PDFNumber.of(8));
  if (decodeParms) dict.set(N('DecodeParms'), context.obj(decodeParms));
  dict.set(N('ColorSpace'), colorSpace instanceof PDFRef || colorSpace instanceof PDFArray || colorSpace instanceof PDFName ? colorSpace : N(colorSpace));
  return PDFRawStream.of(dict, bytes);
}
