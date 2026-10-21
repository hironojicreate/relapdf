// フォーム入力：PDFの入力欄（フォーム）に文字を入れる（Core層）
//
// 入力した内容はページリストの forms に「元データ（PDF）ごと・入力欄の名前ごと」に持つ。
// PDFを書き出すときに、元のPDFの入力欄へ値を入れ、入力欄を普通の文字（ページの中身）に変えてから（平坦化）ページをコピーする。
// 平坦化するのは、ほかのPDFと結合しても入力欄がぶつからず、どのアプリで開いても同じに見えるようにするため。
// そのかわり、できたPDFでは入力欄として書き直せない。

import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from '../../vendor/pdf-lib/pdf-lib.esm.min.js';

/** 入力欄の種類 */
export const FIELD_TYPES = Object.freeze(['text', 'checkbox', 'radio', 'dropdown', 'list']);

/**
 * PDFの入力欄を読み取る。入力できない欄（ボタン・電子署名）は含めない。
 * @param {PDFDocument} pdf
 * @returns {Array<{name: string, label: string, type: string, value: string|boolean, options?: string[], multiline?: boolean, pages: number[]}>}
 *   pages は、その欄があるページ（0始まり）
 */
export function readFormFields(pdf) {
  const pageIndex = new Map(pdf.getPages().map((page, i) => [page.ref.toString(), i]));
  const fields = [];
  for (const field of pdf.getForm().getFields()) {
    const type = typeOf(field);
    if (!type || field.isReadOnly()) continue;
    const name = field.getName();
    // 入力欄の説明（ツールチップ）があれば、名前の代わりに見せる
    const tooltip = field.acroField.dict.lookup(PDFName.of('TU'))?.decodeText?.();
    const pages = [
      ...new Set(
        field.acroField
          .getWidgets()
          .map((widget) => pageIndex.get(widget.P()?.toString()))
          .filter((i) => i !== undefined),
      ),
    ].sort((a, b) => a - b);
    const entry = { name, label: tooltip || name, type, value: valueOf(field, type), pages };
    if (type === 'text') entry.multiline = field.isMultiline();
    if (type === 'radio' || type === 'dropdown' || type === 'list') entry.options = field.getOptions();
    fields.push(entry);
  }
  return fields;
}

const MULTILINE_SIZE = 11; // 複数行の欄の文字の大きさ（PDFで「自動」になっているとき）
const MAX_MULTILINE_SIZE = 24; // 複数行の欄で、これより大きな文字の指定は使わない

/** 入力欄に決められている文字の大きさ（「自動」なら 0） */
function defaultFontSize(field) {
  const da = field.acroField.getWidgets()[0]?.getDefaultAppearance() ?? field.acroField.getDefaultAppearance() ?? '';
  const match = /([\d.]+)\s+Tf/.exec(da);
  return match ? Number(match[1]) : 0;
}

/**
 * 文字を、幅に収まるよう1文字ずつ折り返す（日本語は単語の区切りがないため）。改行はそのまま残す。
 * @param {(text: string) => number} measure 文字の幅
 */
export function wrapText(text, measure, maxWidth) {
  const lines = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    let line = '';
    for (const char of paragraph) {
      if (line && measure(line + char) > maxWidth) {
        lines.push(line);
        line = '';
      }
      line += char;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** PDFの中身（バイト列）から入力欄を読み取る */
export async function readFormFieldsFromBytes(bytes) {
  return readFormFields(await PDFDocument.load(bytes, { updateMetadata: false }));
}

function typeOf(field) {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'list';
  return null;
}

function valueOf(field, type) {
  switch (type) {
    case 'text':
      return field.getText() ?? '';
    case 'checkbox':
      return field.isChecked();
    case 'radio':
      return field.getSelected() ?? '';
    default:
      return field.getSelected()[0] ?? '';
  }
}

/**
 * 入力した値の形を確かめる。{ 欄の名前: 文字 または true/false }
 * @returns {Record<string, string|boolean>}
 */
export function normalizeFormValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('フォームの入力内容が不正です');
  const out = {};
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== 'string' && typeof value !== 'boolean') throw new Error(`フォームの値が不正です: ${name}`);
    out[name] = value;
  }
  return out;
}

/**
 * 読み込んだPDFの入力欄に値を入れ、平坦化する（pdf を書き換える）。
 * @param {PDFDocument} pdf
 * @param {Record<string, string|boolean>} values
 * @param {import('pdf-lib').PDFFont} font 入力した文字の表示に使うフォント（日本語フォント）
 */
export function fillAndFlatten(pdf, values, font) {
  const form = pdf.getForm();
  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field) continue; // 元のPDFにない欄（入れ替えたなど）は無視する
    const type = typeOf(field);
    if (type === 'text') {
      let text = String(value);
      const max = field.getMaxLength();
      if (max !== undefined) text = text.slice(0, max);
      if (field.isMultiline()) {
        // 複数行の欄：文字の大きさが「自動」だと、日本語（区切りの空白がない）がとても大きくなってはみ出すので、
        // 大きさを決めて、欄の幅で折り返す
        // 決められた大きさが「自動」（0）や、とても大きいときは、読みやすい大きさにする
        const given = defaultFontSize(field);
        const size = given > 0 && given <= MAX_MULTILINE_SIZE ? given : MULTILINE_SIZE;
        field.setFontSize(size);
        // 欄の表示部分（ウィジェット）に別の大きさが書かれていると、そちらが使われるので、そろえる
        for (const widget of field.acroField.getWidgets()) {
          const da = widget.getDefaultAppearance();
          if (da) widget.setDefaultAppearance(da.replace(/[\d.]+(\s+Tf)/, `${size}$1`));
        }
        const width = field.acroField.getWidgets()[0]?.getRectangle().width ?? 0;
        if (width > 8) text = wrapText(text, (w) => font.widthOfTextAtSize(w, size), width - 8);
      }
      field.setText(text);
    } else if (type === 'checkbox') {
      if (value === true) field.check();
      else field.uncheck();
    } else if (type === 'radio') {
      if (value && field.getOptions().includes(value)) field.select(value);
      else if (!value) field.clear();
    } else if (type === 'dropdown' || type === 'list') {
      if (value && field.getOptions().includes(value)) field.select(value);
      else if (!value) field.clear();
    }
  }
  // 入力した文字の見た目を日本語フォントで作り直してから、ページの中身に変える
  form.updateFieldAppearances(font);
  form.flatten({ updateFieldAppearances: false });
}
