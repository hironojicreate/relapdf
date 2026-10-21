// 用紙サイズの変換・割付の画面（UI層）
//
// 設定を変えるたびに、最初の1枚分だけ実際にPDFを作って見本を表示する。
// 「決定」でページリストの layout に保存し、PDFを作成するときにかける（imposition.js）。

import { defaultLayout, hasLayout, normalizeLayout } from '../core/imposition.js';

const PREVIEW_DELAY = 300;

/**
 * @param {object} deps
 * @param {() => object} deps.getDoc 今のページリスト
 * @param {(layout: object|null) => void} deps.onApply 「決定」を押したとき（null は外す）
 * @param {(layout: object) => Promise<string>} deps.renderPreview 最初の1枚の見本（画像のURL）
 */
export function createLayoutDialog({ getDoc, onApply, renderPreview }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $('#layout-dialog');
  const form = $('#layout-form');
  const image = $('#layout-preview-img');
  const spinner = $('#layout-preview-spinner');
  const errorBox = $('#layout-error');
  const field = (name) => form.querySelector(`[data-layout="${name}"]`);
  let timer = 0;
  let token = 0;
  let url = null;

  function read() {
    return normalizeLayout({
      paper: field('paper').value,
      orientation: field('orientation').value,
      nup: Number(field('nup').value),
      margin: field('margin').value,
      border: field('border').checked,
    });
  }

  function write(layout) {
    field('paper').value = layout.paper;
    field('orientation').value = layout.orientation;
    field('nup').value = String(layout.nup);
    field('margin').value = layout.margin;
    field('border').checked = layout.border;
  }

  function open() {
    if (getDoc().pages.length === 0) return;
    write(normalizeLayout(getDoc().layout ?? defaultLayout()));
    errorBox.textContent = '';
    image.removeAttribute('src');
    dialog.showModal();
    schedule(0);
  }

  function schedule(delay = PREVIEW_DELAY) {
    clearTimeout(timer);
    timer = setTimeout(update, delay);
  }

  async function update() {
    const current = ++token;
    spinner.hidden = false;
    try {
      const next = await renderPreview(read());
      if (current !== token) return URL.revokeObjectURL(next);
      if (url) URL.revokeObjectURL(url);
      url = next;
      image.src = url;
      errorBox.textContent = '';
    } catch (error) {
      console.error(error);
      if (current === token) errorBox.textContent = `見本を作れませんでした：${error.message}`;
    } finally {
      if (current === token) spinner.hidden = true;
    }
  }

  function close() {
    clearTimeout(timer);
    token += 1;
    if (dialog.open) dialog.close();
  }

  form.addEventListener('change', () => schedule());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const layout = read();
    close();
    onApply(hasLayout(layout) ? layout : null);
  });
  form.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'layout-cancel') close();
    else if (action === 'layout-clear') {
      close();
      onApply(null);
    }
  });
  dialog.addEventListener('close', () => {
    clearTimeout(timer);
    token += 1;
  });

  return { open };
}
