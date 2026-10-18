// ファイル名の扱い（Core層）

/** 初期のファイル名。例：RelaPDF_20261018_0930.pdf */
export function defaultFileName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `RelaPDF_${stamp}.pdf`;
}

/**
 * 入力されたファイル名を、保存に使える形にする。
 * - OSで使えない文字（\ / : * ? " < > | と制御文字）は「_」に置き換える
 * - 前後の空白と末尾のドットを取り除く
 * - 拡張子 .pdf がなければ付ける（大文字の .PDF はそのまま）
 * - 空になったら初期のファイル名にする
 */
export function sanitizeFileName(name, extension = '.pdf', fallback = defaultFileName) {
  let base = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim();
  if (base.toLowerCase().endsWith(extension)) base = base.slice(0, -extension.length);
  base = base.replace(/[.\s]+$/, '');
  if (base === '') return typeof fallback === 'function' ? fallback() : fallback;
  return `${base}${extension}`;
}

/** ファイル名から拡張子を除いた部分を返す。例："見積書.pdf" → "見積書" */
export function stripExtension(name) {
  const text = String(name ?? '');
  const dot = text.lastIndexOf('.');
  return dot > 0 ? text.slice(0, dot) : text;
}
