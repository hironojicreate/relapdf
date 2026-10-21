// 書き込み（ページ番号・ヘッダー/フッター・透かし・スタンプ）（Core層）
//
// ページリストの marks に設定を持ち、PDFを書き出すときに各ページへ文字を書き込む。
// 位置は「画面で見たときの向き」（ページの回転をかけたあと）で計算し、書き込むときに回転前の座標に戻す。
// 座標の単位はポイント（1/72インチ）、原点は左下（PDFと同じ）。

/** ページ番号の位置 */
export const NUMBER_POSITIONS = Object.freeze(['bottom-center', 'bottom-right', 'bottom-left', 'top-center', 'top-right', 'top-left']);

/** ページ番号の書き方。{n} はページ番号、{total} は全体のページ数 */
export const NUMBER_FORMATS = Object.freeze({
  plain: '{n}',
  total: '{n} / {total}',
  dash: '- {n} -',
  ja: '{n}ページ',
});

export const ALIGNS = Object.freeze(['left', 'center', 'right']);

/** 文字の色 */
export const MARK_COLORS = Object.freeze({
  black: [0.1, 0.1, 0.1],
  gray: [0.45, 0.45, 0.45],
  red: [0.82, 0.1, 0.12],
  blue: [0.12, 0.3, 0.75],
});

export const STAMP_POSITIONS = Object.freeze(['top-right', 'top-left', 'bottom-right', 'bottom-left']);

/** スタンプのよく使う文字 */
export const STAMP_PRESETS = Object.freeze(['社外秘', '複製禁止', '重要', '確認済み', '下書き', '控え']);

/** 何も書き込まない設定 */
export function defaultMarks() {
  return {
    pageNumber: { enabled: false, position: 'bottom-center', format: 'plain', start: 1, skipFirst: false },
    header: { enabled: false, text: '', align: 'center' },
    footer: { enabled: false, text: '', align: 'center' },
    watermark: { enabled: false, text: '社外秘', color: 'gray', opacity: 0.18 },
    stamp: { enabled: false, text: '社外秘', color: 'red', position: 'top-right', firstPageOnly: true },
  };
}

/**
 * 設定を確かめ、足りない項目は初期値で埋めた新しい設定を返す。おかしな値はエラーにする。
 * @param {object|null|undefined} marks
 */
export function normalizeMarks(marks) {
  const base = defaultMarks();
  if (marks == null) return base;
  if (typeof marks !== 'object') throw new Error('書き込みの設定が不正です');
  const out = {};
  for (const key of Object.keys(base)) {
    const value = { ...base[key], ...(marks[key] ?? {}) };
    value.enabled = Boolean(value.enabled);
    out[key] = value;
  }
  const { pageNumber, header, footer, watermark, stamp } = out;
  if (!NUMBER_POSITIONS.includes(pageNumber.position)) throw new Error(`ページ番号の位置が不正です: ${pageNumber.position}`);
  if (!NUMBER_FORMATS[pageNumber.format]) throw new Error(`ページ番号の書き方が不正です: ${pageNumber.format}`);
  if (!Number.isInteger(pageNumber.start) || pageNumber.start < 0 || pageNumber.start > 99999) {
    throw new Error(`ページ番号の始まりが不正です: ${pageNumber.start}`);
  }
  pageNumber.skipFirst = Boolean(pageNumber.skipFirst);
  for (const line of [header, footer]) {
    if (!ALIGNS.includes(line.align)) throw new Error(`文字のそろえ方が不正です: ${line.align}`);
    line.text = String(line.text ?? '');
  }
  for (const item of [watermark, stamp]) {
    if (!MARK_COLORS[item.color]) throw new Error(`文字の色が不正です: ${item.color}`);
    item.text = String(item.text ?? '');
  }
  if (!(watermark.opacity > 0 && watermark.opacity <= 1)) throw new Error(`透かしの濃さが不正です: ${watermark.opacity}`);
  if (!STAMP_POSITIONS.includes(stamp.position)) throw new Error(`スタンプの位置が不正です: ${stamp.position}`);
  stamp.firstPageOnly = Boolean(stamp.firstPageOnly);
  return out;
}

/** 書き込むものがあるか */
export function hasMarks(marks) {
  if (!marks) return false;
  const { pageNumber, header, footer, watermark, stamp } = marks;
  return Boolean(
    pageNumber?.enabled ||
      (header?.enabled && header.text.trim()) ||
      (footer?.enabled && footer.text.trim()) ||
      (watermark?.enabled && watermark.text.trim()) ||
      (stamp?.enabled && stamp.text.trim()),
  );
}

/** 書き込みの内容を短く説明する（画面の表示用）。何もなければ空の配列 */
export function describeMarks(marks) {
  if (!marks) return [];
  const list = [];
  if (marks.pageNumber?.enabled) list.push('ページ番号');
  if (marks.header?.enabled && marks.header.text.trim()) list.push('ヘッダー');
  if (marks.footer?.enabled && marks.footer.text.trim()) list.push('フッター');
  if (marks.watermark?.enabled && marks.watermark.text.trim()) list.push('透かし');
  if (marks.stamp?.enabled && marks.stamp.text.trim()) list.push('スタンプ');
  return list;
}

/** 日付を「2026/10/21」の形にする */
export function formatDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

/** ヘッダー・フッターの文字の {n} {total} {date} を置き換える */
export function fillPlaceholders(text, { n, total, date }) {
  return text
    .replaceAll('{n}', String(n))
    .replaceAll('{total}', String(total))
    .replaceAll('{date}', formatDate(date));
}

/**
 * 1ページに書き込むものを、画面で見たときの向きで並べる。
 * @param {object} marks normalizeMarks 済みの設定
 * @param {object} page
 * @param {number} page.width 画面で見たときの幅（ポイント）
 * @param {number} page.height 画面で見たときの高さ
 * @param {number} page.index 何ページ目か（0始まり）
 * @param {number} page.total 全体のページ数
 * @param {Date} page.date 書き出した日
 * @param {(text: string, size: number) => number} page.measure 文字の幅を測る
 * @returns {Array<{type: 'text', text: string, x: number, y: number, size: number, angle: number, color: number[], opacity: number}
 *   | {type: 'rect', x: number, y: number, width: number, height: number, angle: number, color: number[], borderWidth: number, opacity: number}>}
 *   x, y は文字の左下（文字の並びの始まり）・四角形の左下。angle は左回りの角度
 */
export function marksForPage(marks, { width, height, index, total, date, measure }) {
  const items = [];
  // 用紙の大きさに合わせて、文字の大きさと余白を変える（A4の短辺 595pt を基準にする）
  const scale = Math.min(width, height) / 595;
  const margin = 28 * scale;
  const small = 9 * scale;

  const line = (text, size, align, y, color = MARK_COLORS.black) => {
    const w = measure(text, size);
    const x = align === 'left' ? margin : align === 'right' ? width - margin - w : (width - w) / 2;
    items.push({ type: 'text', text, x, y, size, angle: 0, color, opacity: 1 });
  };
  const top = height - margin + small * 0.2 - small;
  const bottom = margin - small * 0.2;

  const { pageNumber, header, footer, watermark, stamp } = marks;
  const numbered = pageNumber.skipFirst ? index - 1 : index;
  const numberTotal = pageNumber.skipFirst ? total - 1 : total;
  const n = pageNumber.start + numbered;

  if (header.enabled && header.text.trim()) {
    line(fillPlaceholders(header.text, { n, total: numberTotal, date }), small, header.align, top, MARK_COLORS.gray);
  }
  if (footer.enabled && footer.text.trim()) {
    line(fillPlaceholders(footer.text, { n, total: numberTotal, date }), small, footer.align, bottom, MARK_COLORS.gray);
  }
  if (pageNumber.enabled && numbered >= 0) {
    const text = NUMBER_FORMATS[pageNumber.format].replaceAll('{n}', String(n)).replaceAll('{total}', String(pageNumber.start + numberTotal - 1));
    const [vertical, horizontal] = pageNumber.position.split('-');
    const size = 10 * scale;
    // ヘッダー・フッターと同じ側にあるときは、ぶつからないよう1行ずらす
    const shared = vertical === 'top' ? header.enabled && header.text.trim() : footer.enabled && footer.text.trim();
    const shift = shared ? small * 1.6 : 0;
    const y = vertical === 'top' ? top - shift : bottom + shift;
    line(text, size, horizontal === 'center' ? 'center' : horizontal, y);
  }

  if (watermark.enabled && watermark.text.trim()) {
    // ページの対角線に沿って、ページの幅いっぱいくらいの大きさで書く
    const angle = (Math.atan2(height, width) * 180) / Math.PI;
    const diagonal = Math.hypot(width, height);
    const unit = measure(watermark.text, 100) / 100 || 1;
    const size = Math.min((diagonal * 0.7) / unit, Math.min(width, height) * 0.3);
    const w = unit * size;
    const rad = (angle * Math.PI) / 180;
    // 文字の中心がページの中心に来るように、左下の位置を戻す
    const cx = width / 2;
    const cy = height / 2;
    const x = cx - (Math.cos(rad) * w) / 2 + (Math.sin(rad) * size * 0.35);
    const y = cy - (Math.sin(rad) * w) / 2 - (Math.cos(rad) * size * 0.35);
    items.push({ type: 'text', text: watermark.text, x, y, size, angle, color: MARK_COLORS[watermark.color], opacity: watermark.opacity });
  }

  if (stamp.enabled && stamp.text.trim() && (!stamp.firstPageOnly || index === 0)) {
    // 文字を四角で囲んだ、ハンコのような印
    const size = 16 * scale;
    const padX = size * 0.5;
    const padY = size * 0.35;
    const w = measure(stamp.text, size) + padX * 2;
    const h = size + padY * 2;
    const [vertical, horizontal] = stamp.position.split('-');
    const x = horizontal === 'right' ? width - margin - w : margin;
    const y = vertical === 'top' ? height - margin - h - small * 1.6 : margin + small * 1.6;
    const color = MARK_COLORS[stamp.color];
    items.push({ type: 'rect', x, y, width: w, height: h, angle: 0, color, borderWidth: Math.max(1, 1.6 * scale), opacity: 0.9 });
    items.push({ type: 'text', text: stamp.text, x: x + padX, y: y + padY + size * 0.12, size, angle: 0, color, opacity: 0.9 });
  }
  return items;
}

/**
 * 画面で見たときの向きの座標を、回転前のページの座標に戻す。
 * PDFのページは /Rotate（右回り）で表示が回るので、その逆をかける。
 * @param {number} rotation ページの回転（0/90/180/270、右回り）
 * @param {{x: number, y: number, width: number, height: number}} box 回転前のページの範囲（CropBox）
 * @param {number} x 画面で見たときの座標
 * @param {number} y
 * @returns {{x: number, y: number, angle: number}} angle は、画面で横書きに見えるよう文字にかける左回りの角度
 */
export function toPageSpace(rotation, box, x, y) {
  const { width: w, height: h } = box;
  let p;
  switch (rotation) {
    case 90:
      p = { x: w - y, y: x };
      break;
    case 180:
      p = { x: w - x, y: h - y };
      break;
    case 270:
      p = { x: y, y: h - x };
      break;
    default:
      p = { x, y };
  }
  return { x: box.x + p.x, y: box.y + p.y, angle: rotation };
}
