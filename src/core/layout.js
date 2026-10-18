// 用紙への配置と画質の計算（Core層）
//
// 写真を用紙のどこに、どの大きさで置くか、何ピクセルまで縮小するかを決める。
// 数字の計算だけで、画像そのものには触らない。

import { PAPER_SIZES } from './page-list.js';

/** 写真をPDFにするときの用紙。'a4' はA4に収める、'image' は写真の縦横比のまま */
export const PAPER_MODES = Object.freeze(['a4', 'image']);

/** 圧縮の設定。dpi は用紙に置いたときの解像度の上限 */
export const QUALITY_PRESETS = Object.freeze({
  standard: Object.freeze({ dpi: 150, jpegQuality: 0.8 }),
  high: Object.freeze({ dpi: 300, jpegQuality: 0.9 }),
});

/** 読み込んだ写真を保持するときの長辺の上限（A4を300dpiで印刷できる大きさ） */
export const MAX_SOURCE_LONG_SIDE = 3508;

/**
 * 写真を置く用紙の大きさと、用紙の中での位置（ポイント）を求める。
 * - 'a4'：写真が横長なら横向き、縦長なら縦向きのA4にし、余白が最小になるよう中央に収める
 * - 'image'：用紙を写真と同じ縦横比にし、長辺をA4の長辺にそろえる
 * ユーザーの回転は含めない（回転はPDFのページ回転で付ける）。
 */
export function imagePageLayout(imageWidth, imageHeight, paper = 'a4') {
  if (!(imageWidth > 0 && imageHeight > 0)) throw new Error('画像の大きさが不正です');
  if (!PAPER_MODES.includes(paper)) throw new Error(`用紙の指定が不正です: ${paper}`);

  const { width: a4Short, height: a4Long } = PAPER_SIZES.A4;
  const landscape = imageWidth > imageHeight;

  if (paper === 'image') {
    const scale = a4Long / Math.max(imageWidth, imageHeight);
    const width = round2(imageWidth * scale);
    const height = round2(imageHeight * scale);
    return { pageWidth: width, pageHeight: height, x: 0, y: 0, width, height };
  }

  const pageWidth = landscape ? a4Long : a4Short;
  const pageHeight = landscape ? a4Short : a4Long;
  const scale = Math.min(pageWidth / imageWidth, pageHeight / imageHeight);
  const width = round2(imageWidth * scale);
  const height = round2(imageHeight * scale);
  return {
    pageWidth,
    pageHeight,
    x: round2((pageWidth - width) / 2),
    y: round2((pageHeight - height) / 2),
    width,
    height,
  };
}

/**
 * 書き出すときの画像のピクセル数を求める。
 * 用紙に置いた大きさで、画質の設定の dpi を超えないように縮小する（拡大はしない）。
 */
export function targetImageSize(imageWidth, imageHeight, quality = 'standard', paper = 'a4') {
  const preset = QUALITY_PRESETS[quality];
  if (!preset) throw new Error(`画質の指定が不正です: ${quality}`);
  const layout = imagePageLayout(imageWidth, imageHeight, paper);
  const maxWidth = (layout.width / 72) * preset.dpi;
  const scale = Math.min(1, maxWidth / imageWidth);
  return {
    width: Math.max(1, Math.round(imageWidth * scale)),
    height: Math.max(1, Math.round(imageHeight * scale)),
    jpegQuality: preset.jpegQuality,
  };
}

/** 長辺が maxLongSide を超えないように縮小した大きさを求める（拡大はしない） */
export function fitLongSide(width, height, maxLongSide = MAX_SOURCE_LONG_SIDE) {
  if (!(width > 0 && height > 0)) throw new Error('画像の大きさが不正です');
  const scale = Math.min(1, maxLongSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
