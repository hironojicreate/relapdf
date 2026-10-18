// 色の調整（Core層）
//
// 画像は { data: Uint8ClampedArray(RGBA), width, height }（ブラウザの ImageData と同じ形）で受け取る。
// M5の書類モード（背景を白く・文字をくっきり）もここに追加する。

/** 明るさの調整の範囲。-1 で半分の明るさ、+1 で2倍の明るさ */
export const BRIGHTNESS_MIN = -1;
export const BRIGHTNESS_MAX = 1;

/**
 * 明るさの値（-1〜+1）を、色にかける倍率にする。
 * 画面のプレビュー（CSS の brightness()）と、撮った写真の両方で同じ倍率を使う。
 */
export function brightnessFactor(amount) {
  const a = Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, Number(amount) || 0));
  return Math.round(2 ** a * 1000) / 1000;
}

/** 画像の明るさを変える（元の配列を書き換える）。白くなりすぎた部分は白のまま */
export function applyBrightness(image, factor) {
  if (factor === 1) return image;
  const { data } = image;
  // 0〜255 の結果を先に計算しておいて、表から引く（速くするため）
  const table = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) table[i] = Math.round(i * factor);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = table[data[i]];
    data[i + 1] = table[data[i + 1]];
    data[i + 2] = table[data[i + 2]];
  }
  return image;
}
