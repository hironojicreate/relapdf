// 色の調整（Core層）
//
// 画像は { data: Uint8ClampedArray(RGBA), width, height }（ブラウザの ImageData と同じ形）で受け取る。
// 書類モード（背景を白く・文字をくっきり）もここにある。

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

// ---- 書類モード ----

const DOC_GRID = 32; // 明るさのムラを調べるときに、長辺を何マスに分けるか
const DOC_PERCENTILE = 0.9; // マスの中で、この割合より明るい画素を「紙の白」とみなす
const DOC_MIN_BACKGROUND = 48; // これより暗い所は紙とみなさない（暗い所を無理に白くしない）
const DOC_BLACK = 40; // 白くそろえたあと、これより暗い所は黒にする
const DOC_WHITE = 215; // 白くそろえたあと、これより明るい所は白にする

/**
 * 書類モード：影や照明のムラを消して紙を白くし、文字をくっきりさせる（元の配列を書き換える）。
 * 1. 画像を小さなマスに分け、マスごとに「紙の白」の明るさを調べる（文字の黒は無視する）
 * 2. 大きな文字のマスでも紙の明るさを取れるよう、まわりのマスで補い、なめらかにする
 * 3. 各画素をその場所の紙の明るさで割って、紙を白にそろえる（色の付いた印鑑などの色は残る）
 * 4. 白と黒の幅を少し広げて、くっきりさせる
 */
export function applyDocumentFilter(image) {
  const { data, width, height } = image;
  if (!width || !height) return image;
  const block = Math.max(2, Math.ceil(Math.max(width, height) / DOC_GRID));
  const gw = Math.ceil(width / block);
  const gh = Math.ceil(height / block);

  // 1. マスごとの紙の明るさ
  let grid = new Float32Array(gw * gh);
  const histogram = new Uint32Array(256);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      histogram.fill(0);
      const x0 = gx * block;
      const y0 = gy * block;
      const x1 = Math.min(width, x0 + block);
      const y1 = Math.min(height, y0 + block);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          histogram[luminance(data[i], data[i + 1], data[i + 2])] += 1;
        }
      }
      const target = (x1 - x0) * (y1 - y0) * DOC_PERCENTILE;
      let count = 0;
      let level = 0;
      while (level < 255 && count + histogram[level] < target) count += histogram[level++];
      grid[gy * gw + gx] = level;
    }
  }

  // 2. まわりのマスの明るい方を取り（大きな文字の対策）、そのあと平均してなめらかにする
  grid = gridFilter(grid, gw, gh, Math.max);
  grid = gridFilter(grid, gw, gh, Math.max);
  grid = gridFilter(grid, gw, gh, (...v) => v.reduce((a, b) => a + b, 0) / v.length);
  grid = gridFilter(grid, gw, gh, (...v) => v.reduce((a, b) => a + b, 0) / v.length);

  // 3〜4. 画素ごとに、その場所の紙の明るさで割って白にそろえ、白と黒の幅を広げる
  const levels = new Float32Array(256 * 4); // 値 × 倍率 を、最終的な明るさにする表（倍率は 1/4 刻み）
  for (let v = 0; v < levels.length; v++) {
    const t = (v / 4 - DOC_BLACK) / (DOC_WHITE - DOC_BLACK);
    levels[v] = Math.round(Math.min(1, Math.max(0, t)) * 255);
  }
  const lastIndex = levels.length - 1;
  for (let y = 0; y < height; y++) {
    // マスの中心の間で、紙の明るさを補間する
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const gy0 = Math.floor(fy);
    const gy1 = Math.min(gh - 1, gy0 + 1);
    const ty = fy - gy0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / block - 0.5));
      const gx0 = Math.floor(fx);
      const gx1 = Math.min(gw - 1, gx0 + 1);
      const tx = fx - gx0;
      const top = grid[gy0 * gw + gx0] * (1 - tx) + grid[gy0 * gw + gx1] * tx;
      const bottom = grid[gy1 * gw + gx0] * (1 - tx) + grid[gy1 * gw + gx1] * tx;
      const background = Math.max(DOC_MIN_BACKGROUND, top * (1 - ty) + bottom * ty);
      const gain = (255 / background) * 4;
      const i = (y * width + x) * 4;
      data[i] = levels[Math.min(lastIndex, Math.round(data[i] * gain))];
      data[i + 1] = levels[Math.min(lastIndex, Math.round(data[i + 1] * gain))];
      data[i + 2] = levels[Math.min(lastIndex, Math.round(data[i + 2] * gain))];
    }
  }
  return image;
}

function luminance(r, g, b) {
  return (r * 77 + g * 150 + b * 29) >> 8;
}

/** マス目の各マスを、自分と上下左右・斜めのマス（3×3）の値でまとめ直す */
function gridFilter(grid, gw, gh, combine) {
  const out = new Float32Array(grid.length);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const values = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && xx < gw && yy >= 0 && yy < gh) values.push(grid[yy * gw + xx]);
        }
      }
      out[y * gw + x] = combine(...values);
    }
  }
  return out;
}
