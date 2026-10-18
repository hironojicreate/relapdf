// 4点補正（射影変換）の計算（Core層）
//
// 斜めに撮った書類の四隅を指定すると、まっすぐな長方形に引き伸ばす。
// 画像は { data: Uint8ClampedArray(RGBA), width, height }（ブラウザの ImageData と同じ形）で受け取り、
// DOMには触らないので Node.js でもテストできる。
//
// 四隅の順番はいつも [左上, 右上, 右下, 左下]。

import { PAPER_SIZES, normalizeRotation } from './page-list.js';

/** A4の縦横比（長辺 ÷ 短辺） */
export const A4_RATIO = PAPER_SIZES.A4.height / PAPER_SIZES.A4.width;

/** 補正を始めるときの四隅の位置（画像の端から少し内側。端だとつまみにくいため） */
export function defaultCorners(inset = 0.08) {
  return [
    { x: inset, y: inset },
    { x: 1 - inset, y: inset },
    { x: 1 - inset, y: 1 - inset },
    { x: inset, y: 1 - inset },
  ];
}

/**
 * 4組の点の対応から、射影変換の行列（3×3、9要素の配列）を求める。
 * from[i] が to[i] に移る。
 */
export function homography(from, to) {
  // h0..h7 を未知数とする8元連立方程式（h8 = 1）
  const a = [];
  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = from[i];
    const { x, y } = to[i];
    a.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    a.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  const h = solve(a);
  return [...h, 1];
}

/** 射影変換で点を移す */
export function applyHomography(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

/**
 * 四隅（ピクセル座標）から、補正後の画像の大きさを求める。
 * 上下の辺の長い方を幅、左右の辺の長い方を高さにする。
 * aspect が 'a4' のときは、長い方の辺に合わせてA4の比率にする。
 */
export function outputSize(cornersPx, aspect = 'free') {
  const [tl, tr, br, bl] = cornersPx;
  let width = Math.max(distance(tl, tr), distance(bl, br));
  let height = Math.max(distance(tl, bl), distance(tr, br));
  if (aspect === 'a4') {
    if (height >= width) width = height / A4_RATIO;
    else height = width / A4_RATIO;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/** 0〜1の割合の四隅を、画像のピクセル座標にする */
export function toPixels(corners, width, height) {
  return corners.map((c) => ({ x: c.x * width, y: c.y * height }));
}

/**
 * 四隅が正しい四角形（ねじれていない、へこんでいない）か調べる。
 * 指で動かしているときに、おかしな形にならないようにするため。
 */
export function isConvexQuad(corners) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const c = corners[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * 画像の座標（0〜1）を、ページの回転をかけた「画面に見えている向き」の座標にする。
 * 補正画面は回転後の向きで表示し、保存するときは回転前の座標に戻す。
 */
export function toDisplayPoint(point, rotation) {
  const { x, y } = point;
  switch (normalizeRotation(rotation)) {
    case 90:
      return { x: 1 - y, y: x };
    case 180:
      return { x: 1 - x, y: 1 - y };
    case 270:
      return { x: y, y: 1 - x };
    default:
      return { x, y };
  }
}

/** toDisplayPoint の逆 */
export function fromDisplayPoint(point, rotation) {
  return toDisplayPoint(point, 360 - normalizeRotation(rotation));
}

/**
 * 四隅で囲まれた部分を、outWidth × outHeight の長方形に引き伸ばした画像を作る。
 * 色は周りの4ピクセルから滑らかに補う（バイリニア補間）。
 * @param {{data: Uint8ClampedArray, width: number, height: number}} src
 * @param {{x: number, y: number}[]} cornersPx 元画像のピクセル座標の四隅
 */
export function warpPerspective(src, cornersPx, outWidth, outHeight) {
  const { data: s, width: sw, height: sh } = src;
  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  // 出力の長方形 → 元画像の四角形 への変換
  const h = homography(
    [
      { x: 0, y: 0 },
      { x: outWidth, y: 0 },
      { x: outWidth, y: outHeight },
      { x: 0, y: outHeight },
    ],
    cornersPx,
  );
  const maxX = sw - 1;
  const maxY = sh - 1;
  let o = 0;
  for (let v = 0; v < outHeight; v++) {
    const cy = v + 0.5;
    // 行の中では、分子・分母が u について一次式なので足し算で進める
    let nx = h[0] * 0.5 + h[1] * cy + h[2];
    let ny = h[3] * 0.5 + h[4] * cy + h[5];
    let dw = h[6] * 0.5 + h[7] * cy + h[8];
    for (let u = 0; u < outWidth; u++) {
      const x = nx / dw - 0.5;
      const y = ny / dw - 0.5;
      const xc = x < 0 ? 0 : x > maxX ? maxX : x;
      const yc = y < 0 ? 0 : y > maxY ? maxY : y;
      const x0 = Math.floor(xc);
      const y0 = Math.floor(yc);
      const x1 = x0 < maxX ? x0 + 1 : x0;
      const y1 = y0 < maxY ? y0 + 1 : y0;
      const fx = xc - x0;
      const fy = yc - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 4; c++) {
        const top = s[i00 + c] + (s[i10 + c] - s[i00 + c]) * fx;
        const bottom = s[i01 + c] + (s[i11 + c] - s[i01 + c]) * fx;
        out[o + c] = top + (bottom - top) * fy;
      }
      o += 4;
      nx += h[0];
      ny += h[3];
      dw += h[6];
    }
  }
  return { data: out, width: outWidth, height: outHeight };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** ガウスの消去法で連立方程式を解く（拡大係数行列 n×(n+1)） */
function solve(matrix) {
  const a = matrix.map((row) => row.slice());
  const n = a.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error('四隅の位置から変換を計算できません');
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row, i) => row[n] / row[i]);
}
