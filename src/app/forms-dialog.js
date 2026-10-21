// フォーム入力の画面（UI層）
//
// 読み込んだPDFに入力欄（フォーム）があるとき、その欄を一覧にして入力してもらう。
// 入力した内容はページリストの forms に保存し、PDFを作成するときに書き込む（入力欄は固定される）。

import { readFormFieldsFromBytes } from '../core/forms.js';

/**
 * @param {object} deps
 * @param {() => object} deps.getDoc 今のページリスト
 * @param {(sourceId: string) => Promise<Uint8Array>} deps.getBytes PDFの中身
 * @param {(sourceId: string, values: Record<string, string|boolean>) => void} deps.onApply 「決定」を押したとき
 * @param {(error: Error) => void} deps.onError
 */
export function createFormsDialog({ getDoc, getBytes, onApply, onError }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $('#forms-dialog');
  const form = $('#forms-form');
  const fileSelect = $('#forms-file');
  const fileRow = $('#forms-file-row');
  const list = $('#forms-fields');
  let current = null; // { sourceId, fields }
  let loading = 0;

  /** 入力欄のあるPDF */
  function formSources() {
    return Object.values(getDoc().sources).filter((s) => s.kind === 'pdf' && s.formFieldCount > 0);
  }

  async function open(sourceId) {
    const sources = formSources();
    if (sources.length === 0) return;
    fileSelect.innerHTML = sources.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    fileRow.hidden = sources.length < 2;
    fileSelect.value = sourceId ?? sources[0].id;
    if (!dialog.open) dialog.showModal();
    await load(fileSelect.value);
  }

  async function load(sourceId) {
    const token = ++loading;
    current = null;
    list.innerHTML = '<div class="spinner"></div>';
    try {
      const fields = await readFormFieldsFromBytes(await getBytes(sourceId));
      if (token !== loading) return;
      current = { sourceId, fields };
      render();
    } catch (error) {
      if (token !== loading) return;
      list.innerHTML = '';
      dialog.close();
      onError(error);
    }
  }

  /** 入力欄を、種類ごとの入力部品にする。入力済みの値があればそれを、なければPDFに入っている値を入れる */
  function render() {
    const saved = getDoc().forms?.[current.sourceId] ?? {};
    list.innerHTML = '';
    current.fields.forEach((field, i) => {
      const value = field.name in saved ? saved[field.name] : field.value;
      const id = `form-field-${i}`;
      const where = field.pages.length ? `（${field.pages.map((p) => p + 1).join('・')}ページ）` : '';
      const row = document.createElement('div');
      row.className = 'form-field';
      row.dataset.name = field.name;
      if (field.type === 'checkbox') {
        row.innerHTML = `<label class="choice"><input type="checkbox" id="${id}"><span></span></label>`;
        row.querySelector('input').checked = value === true;
        row.querySelector('span').textContent = `${field.label}${where}`;
      } else {
        row.innerHTML = `<label class="field" for="${id}"><span></span></label>`;
        row.querySelector('span').textContent = `${field.label}${where}`;
        let input;
        if (field.type === 'text') {
          input = document.createElement(field.multiline ? 'textarea' : 'input');
          if (!field.multiline) input.type = 'text';
          else input.rows = 3;
          input.autocomplete = 'off';
        } else {
          input = document.createElement('select');
          const options = ['', ...field.options];
          input.innerHTML = options.map((o) => `<option>${escapeHtml(o)}</option>`).join('');
          input.options[0].textContent = '（選ばない）';
        }
        input.id = id;
        input.value = String(value ?? '');
        row.querySelector('label').append(input);
      }
      list.append(row);
    });
    if (current.fields.length === 0) list.textContent = 'このPDFには、入力できる欄がありません。';
  }

  /** 画面の入力のうち、PDFにもともと入っていた値と違うものだけを集める */
  function readChanges() {
    const values = {};
    for (const field of current.fields) {
      const row = [...list.children].find((el) => el.dataset.name === field.name);
      const input = row?.querySelector('input, textarea, select');
      if (!input) continue;
      const value = input.type === 'checkbox' ? input.checked : input.value;
      if (value !== field.value) values[field.name] = value;
    }
    return values;
  }

  fileSelect.addEventListener('change', () => load(fileSelect.value));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!current) return;
    const { sourceId } = current;
    const values = readChanges();
    dialog.close();
    onApply(sourceId, values);
  });
  form.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="forms-cancel"]')) dialog.close();
  });

  return { open, hasForms: () => formSources().length > 0, isOpen: () => dialog.open };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
