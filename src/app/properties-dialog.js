// 文書のプロパティの画面（タイトル・作成者・件名・キーワード）（UI層）
//
// PDFの「文書のプロパティ」に入る情報。設定はページリストの properties に保存し、PDFを作成するときに書き込む。

import { PROPERTY_KEYS } from '../core/page-list.js';

/**
 * @param {object} deps
 * @param {() => object} deps.getDoc 今のページリスト
 * @param {() => string} deps.getDefaultTitle タイトルを空にしたときに使う名前（ファイル名）
 * @param {(properties: object) => void} deps.onApply 「決定」を押したとき
 */
export function createPropertiesDialog({ getDoc, getDefaultTitle, onApply }) {
  const dialog = document.querySelector('#properties-dialog');
  const form = document.querySelector('#properties-form');
  const input = (key) => form.querySelector(`[data-prop="${key}"]`);

  function open() {
    const props = getDoc().properties ?? {};
    for (const key of PROPERTY_KEYS) input(key).value = props[key] ?? '';
    input('title').placeholder = `空のときはファイル名（${getDefaultTitle()}）`;
    dialog.showModal();
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = Object.fromEntries(PROPERTY_KEYS.map((key) => [key, input(key).value]));
    dialog.close();
    onApply(values);
  });
  form.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="properties-cancel"]')) dialog.close();
  });

  return { open };
}
