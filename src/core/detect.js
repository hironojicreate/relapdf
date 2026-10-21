// 書類の四隅の自動検出（Core層）
//
// 机の上の書類の写真から、紙の四隅を見つける。紙と机を分ける方法を2通り試し、いちばん四角形らしいものを選ぶ。
// - 明るさで分ける：白い紙と暗い机のように、明るさが違うとき
// - 机の色との違いで分ける：写真の外周（ほとんどが机）の色を「机の色」とし、それと違う色の所を紙とする。
//   色の多い表紙や、絵と机の明るさが近いときでも、紙をひとかたまりで取り出せる
// 分けたあとは、どちらも同じ手順：
// 1. 紙の中の穴（文字や絵で抜けた所）を埋める
// 2. つながった大きなかたまりを探し、外形（凸包）にいちばん大きく重なる四角形を当てはめる
// 3. 四角形がかたまりとよく重なり、大きさも妥当なら、その四隅を返す（だめなら null）
//
// 画像は縮小してから渡す（長辺400px程度）。{ data: RGBA, width, height } の形。
// OpenCV.js（約8〜10MB）を使わず、数KBで動くようにしている。

import { isConvexQuad } from './perspective.js';

/** 検出に使う画像の長辺の目安 */
export const DETECT_SIZE = 400;

const MIN_AREA = 0.2; // 画像に対する紙の面積の下限（小さな四角い模様を紙と間違えないため）
const MAX_AREA = 0.98; // これより大きいときは「写真全体が紙」とみなして補正しない
const MIN_FILL = 0.85; // かたまりと四角形の重なり具合の下限
const MIN_CONTRAST = 40; // 紙と背景の明るさの差の下限（ムラのある机を紙と間違えないため）
const MIN_COLOR_CONTRAST = 45; // 机の色との違いで分けるときの、紙と机の差の下限
const RING = 0.03; // 「机の色」を調べる外周の幅（短辺に対する割合）
const MIN_DESK_THRESHOLD = 28; // 机の色との違いがこれより小さい所は、机とみなす
const BORDER = 2; // 画像の端からこの距離（px）以内は「端に接している」とみなす
const INSET = 1.5; // 机が細く写り込まないよう、四隅を内側に寄せる量（px）

/**
 * 書類の四隅を探す。
 * @param {{data: Uint8ClampedArray, width: number, height: number}} image
 * @returns {{ corners: {x: number, y: number}[], score: number } | null}
 *   corners は [左上, 右上, 右下, 左下] の順で、画像に対する0〜1の割合
 */
export function detectDocument(image) {
  const { width, height } = image;
  if (width < 16 || height < 16) return null;
  const masks = [];

  // 明るさで分ける：明るい紙（よくある場合）と、暗い紙（白い机の上など）の両方
  const gray = blur(toGray(image), width, height);
  const threshold = otsuThreshold(gray);
  if (classContrast(gray, threshold) >= MIN_CONTRAST) {
    for (const bright of [true, false]) {
      const mask = new Uint8Array(width * height);
      for (let i = 0; i < mask.length; i++) mask[i] = (gray[i] > threshold) === bright ? 1 : 0;
      masks.push(mask);
    }
  }

  // 机の色との違いで分ける。境目は、大津の方法と「外周（机）の色のばらつき」の小さい方にする
  // （灰色っぽい紙や影の部分が、机の側に入ってしまわないように）
  const { distance, deskSpread } = backgroundDistance(image);
  const t = Math.min(otsuThreshold(distance), Math.max(MIN_DESK_THRESHOLD, deskSpread * 1.5 + 8));
  if (classContrast(distance, t) >= MIN_COLOR_CONTRAST) {
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) mask[i] = distance[i] > t ? 1 : 0;
    masks.push(mask);
  }

  let best = null;
  for (const mask of masks) {
    fillHoles(mask, width, height);
    for (const component of components(mask, width, height)) {
      const candidate = fitQuad(component, width, height);
      if (candidate && (!best || candidate.score > best.score)) best = candidate;
    }
  }
  return best;
}

/**
 * 各画素が「机の色」からどれだけ違うか（0〜255）。
 * 机の色は、写真の外周の帯の色の中央値（紙が少し外周にかかっていても、ほとんどは机なので影響しない）。
 * deskSpread は、外周の帯の中での違いの大きさ（90%の画素がこれ以下）。木目などのばらつきの目安
 */
function backgroundDistance(image) {
  const { width, height } = image;
  const channels = [0, 1, 2].map((c) => {
    const plane = new Uint8ClampedArray(width * height);
    for (let i = 0, j = c; i < plane.length; i++, j += 4) plane[i] = image.data[j];
    return blur(plane, width, height);
  });
  const ring = Math.max(2, Math.round(Math.min(width, height) * RING));
  const samples = [[], [], []];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= ring && x < width - ring && y >= ring && y < height - ring) continue;
      const i = y * width + x;
      for (let c = 0; c < 3; c++) samples[c].push(channels[c][i]);
    }
  }
  const desk = samples.map((values) => [...values].sort((a, b) => a - b)[values.length >> 1]);
  const distance = new Uint8ClampedArray(width * height);
  for (let i = 0; i < distance.length; i++) {
    distance[i] = Math.hypot(channels[0][i] - desk[0], channels[1][i] - desk[1], channels[2][i] - desk[2]);
  }
  const ringDistances = samples[0]
    .map((_, k) => Math.hypot(samples[0][k] - desk[0], samples[1][k] - desk[1], samples[2][k] - desk[2]))
    .sort((a, b) => a - b);
  return { distance, deskSpread: ringDistances[Math.floor(ringDistances.length * 0.9)] };
}

/** 紙の中の穴（外周につながっていない、紙でない所）を埋める（配列を書き換える） */
function fillHoles(mask, width, height) {
  const outside = new Uint8Array(mask.length);
  const stack = [];
  const push = (i) => {
    if (!mask[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < width; x++) push(x), push((height - 1) * width + x);
  for (let y = 0; y < height; y++) push(y * width), push(y * width + width - 1);
  while (stack.length) {
    const i = stack.pop();
    const x = i % width;
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (i >= width) push(i - width);
    if (i < mask.length - width) push(i + width);
  }
  for (let i = 0; i < mask.length; i++) if (!outside[i]) mask[i] = 1;
}

/** 明るさ（0〜255）だけにする */
export function toGray({ data, width, height }) {
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    gray[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  }
  return gray;
}

/** 大津の方法：明るさのヒストグラムを、いちばんよく分ける境目 */
export function otsuThreshold(gray) {
  const histogram = new Float64Array(256);
  for (const v of gray) histogram[v] += 1;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let sumBack = 0;
  let weightBack = 0;
  let bestVariance = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    weightBack += histogram[t];
    if (weightBack === 0) continue;
    const weightFore = total - weightBack;
    if (weightFore === 0) break;
    sumBack += t * histogram[t];
    const meanBack = sumBack / weightBack;
    const meanFore = (sum - sumBack) / weightFore;
    const variance = weightBack * weightFore * (meanBack - meanFore) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = t;
    }
  }
  return threshold;
}

/** 境目で分けた明るい側と暗い側の、平均の明るさの差 */
function classContrast(gray, threshold) {
  let sumLow = 0;
  let nLow = 0;
  let sumHigh = 0;
  let nHigh = 0;
  for (const v of gray) {
    if (v > threshold) (sumHigh += v), nHigh++;
    else (sumLow += v), nLow++;
  }
  if (!nLow || !nHigh) return 0;
  return sumHigh / nHigh - sumLow / nLow;
}

/** 四角形のどれかの辺が、画像の端に沿っているか */
function alongBorder(quad, width, height) {
  const edges = [
    (p) => p.x <= BORDER,
    (p) => p.y <= BORDER,
    (p) => p.x >= width - BORDER,
    (p) => p.y >= height - BORDER,
  ];
  return quad.some((a, i) => {
    const b = quad[(i + 1) % 4];
    return edges.some((on) => on(a) && on(b));
  });
}

/** 5×5 のぼかし（横と縦に分けて平均する） */
function blur(gray, width, height) {
  const r = 2;
  const tmp = new Uint8ClampedArray(gray.length);
  const out = new Uint8ClampedArray(gray.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < width) {
          s += gray[y * width + xx];
          n++;
        }
      }
      tmp[y * width + x] = s / n;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < height) {
          s += tmp[yy * width + x];
          n++;
        }
      }
      out[y * width + x] = s / n;
    }
  }
  return out;
}

/**
 * つながったかたまり（上下左右でつながる部分）のうち、大きいものを返す。
 * かたまりごとに、外形の候補になる点（各行の左端と右端）と面積を持つ。
 */
function components(mask, width, height) {
  const labels = new Int32Array(mask.length);
  const result = [];
  const minArea = width * height * MIN_AREA;
  const stack = [];
  let label = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    label += 1;
    labels[start] = label;
    stack.push(start);
    let area = 0;
    const rowMin = new Int32Array(height).fill(width);
    const rowMax = new Int32Array(height).fill(-1);
    while (stack.length) {
      const i = stack.pop();
      area += 1;
      const x = i % width;
      const y = (i - x) / width;
      if (x < rowMin[y]) rowMin[y] = x;
      if (x > rowMax[y]) rowMax[y] = x;
      if (x > 0 && mask[i - 1] && !labels[i - 1]) (labels[i - 1] = label), stack.push(i - 1);
      if (x < width - 1 && mask[i + 1] && !labels[i + 1]) (labels[i + 1] = label), stack.push(i + 1);
      if (y > 0 && mask[i - width] && !labels[i - width]) (labels[i - width] = label), stack.push(i - width);
      if (y < height - 1 && mask[i + width] && !labels[i + width]) (labels[i + width] = label), stack.push(i + width);
    }
    if (area < minArea) continue;
    const points = [];
    for (let y = 0; y < height; y++) {
      if (rowMax[y] < 0) continue;
      points.push({ x: rowMin[y], y }, { x: rowMax[y] + 1, y });
    }
    result.push({ area, points });
  }
  return result;
}

/** かたまりに四角形を当てはめ、点数をつける。合わなければ null */
function fitQuad({ area, points }, width, height) {
  const hull = convexHull(points);
  if (hull.length < 4) return null;
  // 最初の四隅：左上（x+y 最小）、右上（x−y 最大）、右下（x+y 最大）、左下（y−x 最大）
  const pick = (score) => hull.reduce((best, p, i) => (score(p) > score(hull[best]) ? i : best), 0);
  let idx = [pick((p) => -(p.x + p.y)), pick((p) => p.x - p.y), pick((p) => p.x + p.y), pick((p) => p.y - p.x)];
  if (new Set(idx).size < 4) return null;
  idx = refineQuad(hull, idx);
  const quad = idx.map((i) => hull[i]);
  if (!isConvexQuad(quad)) return null;
  // 辺が画像の端にぴったり沿っているのは、紙ではなく背景を切り取ったもの（または紙がはみ出している）
  if (alongBorder(quad, width, height)) return null;
  const quadArea = polygonArea(quad);
  const imageArea = width * height;
  if (quadArea < imageArea * MIN_AREA || quadArea > imageArea * MAX_AREA) return null;
  // かたまりの面積と四角形の面積が近いほど「四角い紙」らしい
  const fill = Math.min(area, quadArea) / Math.max(area, quadArea);
  if (fill < MIN_FILL) return null;
  // 中心に向かって少しだけ寄せる（縮小した画像での1画素ぶんのずれで、机が線のように残らないように）
  const cx = quad.reduce((sum, p) => sum + p.x, 0) / 4;
  const cy = quad.reduce((sum, p) => sum + p.y, 0) / 4;
  const inset = quad.map((p) => {
    const d = Math.hypot(cx - p.x, cy - p.y) || 1;
    return { x: p.x + ((cx - p.x) / d) * INSET, y: p.y + ((cy - p.y) / d) * INSET };
  });
  return {
    corners: inset.map((p) => ({ x: p.x / width, y: p.y / height })),
    score: fill * Math.sqrt(quadArea / imageArea),
  };
}

/** 四隅を凸包の上で少しずつ動かして、いちばん大きな四角形にする（順番は保つ） */
function refineQuad(hull, idx) {
  const n = hull.length;
  const order = (a) => {
    // 凸包の上で左上から順に並んでいるか（ぐるっと1周の中で順番が保たれているか）
    const shifted = a.map((i) => (i - a[0] + n) % n);
    return shifted[0] < shifted[1] && shifted[1] < shifted[2] && shifted[2] < shifted[3];
  };
  let current = [...idx];
  let area = polygonArea(current.map((i) => hull[i]));
  for (let round = 0; round < 8; round++) {
    let improved = false;
    for (let k = 0; k < 4; k++) {
      for (let j = 0; j < n; j++) {
        if (current.includes(j)) continue;
        const next = [...current];
        next[k] = j;
        if (!order(next)) continue;
        const a = polygonArea(next.map((i) => hull[i]));
        if (a > area + 1e-6) {
          area = a;
          current = next;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return current;
}

/** 凸包（時計回り。画面の座標では y が下向きなので、見た目は時計回り） */
export function convexHull(points) {
  const pts = [...new Map(points.map((p) => [`${p.x},${p.y}`, p])).values()].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  // 左上から時計回り（画面の向き）になるよう、逆順にする
  return lower.concat(upper).reverse();
}

function polygonArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}
