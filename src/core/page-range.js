// ページ範囲の文字列（例："1-3, 5, 8-"）を扱う（Core層）
//
// 画面では1始まりのページ番号で入力してもらい、内部では0始まりの番号に変換する。
// 分割・抽出・削除などの範囲指定で使う。

/**
 * ページ範囲の文字列を、0始まりのページ番号の配列にする。
 * - "1-3" は1〜3ページ、"5" は5ページ、"8-" は8ページから最後まで、"-3" は最初から3ページまで
 * - 区切りは半角・全角のカンマ、読点、空白のどれでもよい
 * - 重なりは1つにまとめ、昇順で返す
 * @param {string} text
 * @param {number} pageCount 全体のページ数
 * @returns {number[]}
 */
export function parsePageRange(text, pageCount) {
  if (!Number.isInteger(pageCount) || pageCount < 0) throw new Error(`ページ数が不正です: ${pageCount}`);
  // "1 - 3" のようにハイフンの前後に空白があっても1つの範囲として読む
  const normalized = toHalfWidth(String(text)).trim().replace(/\s*-\s*/g, '-');
  if (normalized === '') throw new Error('ページ範囲が空です');

  const result = new Set();
  for (const part of normalized.split(/[,、\s]+/).filter(Boolean)) {
    const match = part.match(/^(\d*)-(\d*)$/);
    let start;
    let end;
    if (match) {
      if (match[1] === '' && match[2] === '') throw new Error(`ページ範囲が読み取れません: ${part}`);
      start = match[1] === '' ? 1 : Number(match[1]);
      end = match[2] === '' ? pageCount : Number(match[2]);
    } else if (/^\d+$/.test(part)) {
      start = end = Number(part);
    } else {
      throw new Error(`ページ範囲が読み取れません: ${part}`);
    }
    if (start < 1 || end > pageCount || start > end) {
      throw new Error(`ページ範囲が1〜${pageCount}の外です: ${part}`);
    }
    for (let n = start; n <= end; n++) result.add(n - 1);
  }
  return [...result].sort((a, b) => a - b);
}

/**
 * 分割用：カンマで区切ったまとまりごとに、0始まりのページ番号の配列を返す（まとめない）。
 * 例："1-3, 4-6, 8" → [[0,1,2], [3,4,5], [7]]
 */
export function parsePageRangeGroups(text, pageCount) {
  const normalized = toHalfWidth(String(text)).trim().replace(/\s*-\s*/g, '-');
  if (normalized === '') throw new Error('ページ範囲が空です');
  return normalized
    .split(/[,、\s]+/)
    .filter(Boolean)
    .map((part) => parsePageRange(part, pageCount));
}

/** 分割用：size ページずつのまとまりにする。例：(5, 2) → [[0,1], [2,3], [4]] */
export function chunkPages(pageCount, size) {
  if (!Number.isInteger(size) || size < 1) throw new Error('何ページずつに分けるかを、1以上の数で指定してください');
  const groups = [];
  for (let start = 0; start < pageCount; start += size) {
    groups.push(Array.from({ length: Math.min(size, pageCount - start) }, (_, i) => start + i));
  }
  return groups;
}

/** 0始まりのページ番号の配列を、短い範囲の文字列（1始まり）にする。例：[0,1,2,4] → "1-3, 5" */
export function formatPageRange(indexes) {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const parts = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${sorted[i] + 1}` : `${sorted[i] + 1}-${sorted[j] + 1}`);
    i = j + 1;
  }
  return parts.join(', ');
}

function toHalfWidth(text) {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－ー―〜～~]/g, '-')
    .replace(/，/g, ',')
    .replace(/　/g, ' ');
}
