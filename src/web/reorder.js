// ドラッグでの並べ替えの計算（ブラウザ側の部品。画面には触らない純粋な関数）

/**
 * 指の位置から「どのページの前に入れるか」を求める。
 * 一番近いページを探し、その中心より左（同じ行の場合）なら前、右なら後ろに入れる。
 * @param {{left: number, top: number, width: number, height: number}[]} rects 並び順の各ページの位置
 * @param {number} x
 * @param {number} y
 * @returns {number} 挿入位置（0〜rects.length）。i は「i番目のページの前」
 */
export function insertionIndexAt(rects, x, y) {
  return dropTargetAt(rects, x, y).insertBefore;
}

/**
 * 指の位置から、落ちる場所とその目印の位置を求める。
 * 目印（線）は、一番近いページの左（before）か右（after）に出す。
 * 行の右端のページの右に落とすときも、線は次の行の左ではなく、そのページの右に出す。
 * @returns {{ insertBefore: number, anchor: number, side: 'before'|'after' }}
 */
export function dropTargetAt(rects, x, y) {
  if (rects.length === 0) return { insertBefore: 0, anchor: -1, side: 'before' };
  let best = 0;
  let bestDistance = Infinity;
  rects.forEach((r, i) => {
    // 長方形の外側からの距離（中に入っていれば0）。行の判定を優先するため縦方向を重くする
    const dx = Math.max(r.left - x, 0, x - (r.left + r.width));
    const dy = Math.max(r.top - y, 0, y - (r.top + r.height));
    const distance = dx + dy * 4;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  });
  const r = rects[best];
  return x < r.left + r.width / 2
    ? { insertBefore: best, anchor: best, side: 'before' }
    : { insertBefore: best + 1, anchor: best, side: 'after' };
}

/**
 * 移動したあとに、動かしたページ（の先頭）が何番目（0始まり）になるか。
 * movingIndexes は動かすページの今の位置。
 */
export function positionAfterMove(insertBefore, movingIndexes) {
  return insertBefore - movingIndexes.filter((i) => i < insertBefore).length;
}

/**
 * 挿入位置を、movePages に渡す移動先（動かすページを取り除いた並びでの位置）に変える。
 * 位置が変わらないときは null を返す。
 */
export function moveTargetIndex(insertBefore, fromIndex) {
  const to = insertBefore > fromIndex ? insertBefore - 1 : insertBefore;
  return to === fromIndex ? null : to;
}
