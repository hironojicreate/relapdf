// 書き込みの画面（ページ番号・ヘッダー/フッター・透かし・スタンプ）（UI層）
//
// 設定を変えるたびに、1ページ分だけ実際にPDFを作って見本を表示する（書き出したときと同じ見た目になる）。
// 「決定」でページリストの marks に保存し、PDFを作成するときにすべてのページへ書き込む。

import { STAMP_PRESETS, defaultMarks, hasMarks, normalizeMarks } from '../core/marks.js';

const PREVIEW_DELAY = 350; // 入力が止まってから見本を作り直すまでの時間（ミリ秒）
const OPACITIES = [0.1, 0.18, 0.3]; // 透かしの濃さの選択肢

/**
 * @param {object} deps
 * @param {() => object} deps.getDoc 今のページリスト
 * @param {(marks: object|null) => void} deps.onApply 「決定」「すべて外す」を押したとき（null は外す）
 * @param {(marks: object) => Promise<{url: string, pageNumber: number}>} deps.renderPreview 見本の画像を作る
 */
export function createMarksDialog({ getDoc, onApply, renderPreview }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $('#marks-dialog');
  const form = $('#marks-form');
  const fields = [...form.querySelectorAll('[data-mark]')];
  const sections = [...form.querySelectorAll('.mark-section')];
  const image = $('#marks-preview-img');
  const spinner = $('#marks-preview-spinner');
  const caption = $('#marks-preview-caption');
  const errorBox = $('#marks-error');
  $('#mark-presets').innerHTML = STAMP_PRESETS.map((text) => `<option value="${text}"></option>`).join('');

  let timer = 0;
  let token = 0;
  let previewUrl = null;

  /** 画面の入力から設定を作る */
  function read() {
    const marks = defaultMarks();
    for (const field of fields) {
      const [group, key] = field.dataset.mark.split('.');
      let value = field.value;
      if (field.type === 'checkbox') value = field.checked;
      else if (field.type === 'number' || key === 'opacity') value = Number(field.value);
      marks[group][key] = value;
    }
    return marks;
  }

  /** 設定を画面の入力に入れる */
  function write(marks) {
    for (const field of fields) {
      const [group, key] = field.dataset.mark.split('.');
      let value = marks[group][key];
      if (key === 'opacity') {
        // 選択肢のうち、いちばん近い濃さにする
        value = OPACITIES.reduce((a, b) => (Math.abs(b - value) < Math.abs(a - value) ? b : a));
      }
      if (field.type === 'checkbox') field.checked = Boolean(value);
      else field.value = String(value);
    }
  }

  /** チェックが入っている項目だけ、細かい設定を見せる */
  function syncSections() {
    for (const section of sections) {
      section.classList.toggle('on', section.querySelector('.mark-toggle input').checked);
    }
  }

  function open() {
    if (getDoc().pages.length === 0) return;
    write(normalizeMarks(getDoc().marks));
    syncSections();
    errorBox.textContent = '';
    image.removeAttribute('src');
    dialog.showModal();
    schedulePreview(0);
  }

  function close() {
    clearTimeout(timer);
    token += 1;
    if (dialog.open) dialog.close();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    image.removeAttribute('src');
  }

  function schedulePreview(delay = PREVIEW_DELAY) {
    clearTimeout(timer);
    timer = setTimeout(updatePreview, delay);
  }

  async function updatePreview() {
    let marks;
    try {
      marks = normalizeMarks(read());
      errorBox.textContent = '';
    } catch (error) {
      errorBox.textContent = error.message;
      return;
    }
    const current = ++token;
    spinner.hidden = false;
    try {
      const { url, pageNumber } = await renderPreview(marks);
      if (current !== token) {
        URL.revokeObjectURL(url);
        return;
      }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = url;
      image.src = url;
      caption.textContent = `見本（${pageNumber}ページ目）`;
    } catch (error) {
      console.error(error);
      if (current === token) errorBox.textContent = `見本を作れませんでした：${error.message}`;
    } finally {
      if (current === token) spinner.hidden = true;
    }
  }

  form.addEventListener('input', () => {
    syncSections();
    schedulePreview();
  });
  form.addEventListener('change', () => {
    syncSections();
    schedulePreview();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    let marks;
    try {
      marks = normalizeMarks(read());
    } catch (error) {
      errorBox.textContent = error.message;
      return;
    }
    close();
    onApply(hasMarks(marks) ? marks : null);
  });
  form.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'marks-cancel') close();
    else if (action === 'marks-clear') {
      close();
      onApply(null);
    }
  });
  dialog.addEventListener('close', () => {
    clearTimeout(timer);
    token += 1;
  });

  return { open, close, isOpen: () => dialog.open };
}
