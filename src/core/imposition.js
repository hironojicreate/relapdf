// ページの配置：用紙サイズの変換・割付（2in1・4in1）・トリミング（Core層）
//
// - 用紙サイズの変換：どのページも、指定の用紙に収まるよう縮小・拡大して、真ん中に置く
// - 割付：2ページ・4ページを、1枚の用紙にまとめる
// - トリミング：ページの見せる範囲（CropBox）を狭める。ページごとに設定する（page.crop）
// 設定はページリストの layout（文書全体）と page.crop（ページごと）に持ち、PDFを書き出すときにかける。

/** 用紙の大きさ（ポイント、縦向き）。B判は日本のJIS規格 */
export const PAPERS = Object.freeze({
  A3: Object.freeze({ width: 841.89, height: 1190.55, label: 'A3' }),
  A4: Object.freeze({ width: 595.28, height: 841.89, label: 'A4' }),
  A5: Object.freeze({ width: 419.53, height: 595.28, label: 'A5' }),
  B4: Object.freeze({ width: 728.5, height: 1031.81, label: 'B4' }),
  B5: Object.freeze({ width: 515.91, height: 728.5, label: 'B5' }),
  Letter: Object.freeze({ width: 612, height: 792, label: 'レター' }),
});

export const ORIENTATIONS = Object.freeze(['auto', 'portrait', 'landscape']);
export const NUP = Object.freeze([1, 2, 4]);
export const MARGINS = Object.freeze({ none: 0, small: 18 }); // 用紙の端とページの間のすき間（ポイント。18pt ≒ 6mm）

/** 配置を変えない設定 */
export function defaultLayout() {
  return { paper: 'none', orientation: 'auto', nup: 1, margin: 'none', border: false };
}

/** 設定を確かめ、足りない項目は初期値で埋める */
export function normalizeLayout(layout) {
  const out = { ...defaultLayout(), ...(layout ?? {}) };
  if (out.paper !== 'none' && !PAPERS[out.paper]) throw new Error(`用紙サイズが不正です: ${out.paper}`);
  if (!ORIENTATIONS.includes(out.orientation)) throw new Error(`用紙の向きが不正です: ${out.orientation}`);
  if (!NUP.includes(out.nup)) throw new Error(`割付の数が不正です: ${out.nup}`);
  if (MARGINS[out.margin] === undefined) throw new Error(`余白の指定が不正です: ${out.margin}`);
  out.border = Boolean(out.border);
  return { paper: out.paper, orientation: out.orientation, nup: out.nup, margin: out.margin, border: out.border };
}

/** 配置を変える設定か（用紙そのまま・1ページずつなら何もしない） */
export function hasLayout(layout) {
  return Boolean(layout) && (layout.paper !== 'none' || layout.nup > 1);
}

/** 設定を短く説明する（画面の表示用） */
export function describeLayout(layout) {
  if (!hasLayout(layout)) return '';
  const paper = layout.paper === 'none' ? 'A4' : PAPERS[layout.paper].label;
  return layout.nup > 1 ? `${paper}に${layout.nup}ページずつ` : `${paper}に合わせる`;
}

/**
 * ページを用紙に並べる計画を立てる。
 * @param {Array<{width: number, height: number}>} pages 画面で見たときのページの大きさ（ポイント）
 * @param {object} layout normalizeLayout 済みの設定
 * @returns {Array<{width: number, height: number, cells: Array<{index: number, x: number, y: number, width: number, height: number, scale: number}>}>}
 *   用紙ごとに、置くページ（index）と、その左下の位置・大きさ・倍率（ポイント、左下が原点）
 */
export function planSheets(pages, layout) {
  if (pages.length === 0) return [];
  const paper = PAPERS[layout.paper === 'none' ? 'A4' : layout.paper];
  const first = pages[0];
  const landscapePages = first.width > first.height;
  // 用紙の向き：2in1 は、縦長のページなら横向きの用紙に横に並べる（横長のページなら縦向きの用紙に縦に並べる）
  let landscape;
  if (layout.orientation !== 'auto') landscape = layout.orientation === 'landscape';
  else if (layout.nup === 2) landscape = !landscapePages;
  else landscape = landscapePages;
  const sheet = landscape ? { width: paper.height, height: paper.width } : { width: paper.width, height: paper.height };
  // 枠の数（列 × 行）
  let cols = 1;
  let rows = 1;
  if (layout.nup === 2) {
    if (sheet.width >= sheet.height) cols = 2;
    else rows = 2;
  } else if (layout.nup === 4) {
    cols = 2;
    rows = 2;
  }
  const margin = MARGINS[layout.margin];
  const gap = layout.nup > 1 ? Math.max(margin, 6) : 0;
  const cellWidth = (sheet.width - margin * 2 - gap * (cols - 1)) / cols;
  const cellHeight = (sheet.height - margin * 2 - gap * (rows - 1)) / rows;

  const sheets = [];
  for (let start = 0; start < pages.length; start += layout.nup) {
    const cells = [];
    for (let k = 0; k < layout.nup && start + k < pages.length; k++) {
      const index = start + k;
      const page = pages[index];
      // 左上から右へ、次の行へ（日本語の横書きの書類と同じ順番）
      const col = k % cols;
      const row = Math.floor(k / cols);
      const scale = Math.min(cellWidth / page.width, cellHeight / page.height);
      const width = page.width * scale;
      const height = page.height * scale;
      const cellX = margin + col * (cellWidth + gap);
      const cellTop = sheet.height - margin - row * (cellHeight + gap);
      cells.push({ index, x: cellX + (cellWidth - width) / 2, y: cellTop - cellHeight + (cellHeight - height) / 2, width, height, scale });
    }
    sheets.push({ ...sheet, cells });
  }
  return sheets;
}

/** トリミングの範囲を確かめる（回転前のページに対する0〜1の割合、左上が原点） */
export function normalizeCrop(crop) {
  if (!crop || typeof crop !== 'object') throw new Error('トリミングの範囲が不正です');
  const { x, y, w, h } = crop;
  for (const v of [x, y, w, h]) if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('トリミングの範囲が不正です');
  if (x < 0 || y < 0 || w < 0.02 || h < 0.02 || x + w > 1.0001 || y + h > 1.0001) throw new Error('トリミングの範囲が不正です');
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
}

/**
 * 回転前のページの範囲（左上が原点の割合）を、PDFのページの座標（左下が原点のポイント）の範囲にする。
 * @param {{x: number, y: number, w: number, h: number}} crop
 * @param {{x: number, y: number, width: number, height: number}} box 今のページの範囲（CropBox）
 * @param {number} baseRotation PDFにもともと付いている回転（ユーザーの回転は含めない）
 */
export function cropToPageBox(crop, box, baseRotation) {
  // 回転前のページ（もともとの回転はかけた向き）での左上・右下の角を、PDFの座標に戻す
  const sideways = baseRotation === 90 || baseRotation === 270;
  const view = { width: sideways ? box.height : box.width, height: sideways ? box.width : box.height };
  const toPage = (nx, ny) => {
    const x = nx * view.width;
    const y = (1 - ny) * view.height;
    switch (baseRotation) {
      case 90:
        return { x: box.width - y, y: x };
      case 180:
        return { x: box.width - x, y: box.height - y };
      case 270:
        return { x: y, y: box.height - x };
      default:
        return { x, y };
    }
  };
  const a = toPage(crop.x, crop.y);
  const b = toPage(crop.x + crop.w, crop.y + crop.h);
  return {
    x: box.x + Math.min(a.x, b.x),
    y: box.y + Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** 0〜1の点を、右に rotation 度回した向きにする（左上が原点） */
function rotateUnitPoint({ x, y }, rotation) {
  switch (rotation) {
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

/** 0〜1の範囲を、右に rotation 度回した向きの範囲にする */
function rotateUnitRect(rect, rotation) {
  const a = rotateUnitPoint({ x: rect.x, y: rect.y }, rotation);
  const b = rotateUnitPoint({ x: rect.x + rect.w, y: rect.y + rect.h }, rotation);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** トリミングの範囲（回転前）を、画面で見たときの向き（ユーザーの回転をかけた向き）にする */
export function cropToDisplay(crop, rotation) {
  return rotateUnitRect(crop, rotation);
}

/** 画面で見たときの向きの範囲を、トリミングの範囲（回転前）に戻す */
export function cropFromDisplay(rect, rotation) {
  return rotateUnitRect(rect, (360 - rotation) % 360);
}
