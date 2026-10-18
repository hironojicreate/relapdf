// 詳細モードの道具：取り出す（抽出）・分割・画像にする（UI層）
//
// 1つのダイアログで、道具ごとに入力欄を切り替える。
// ページ範囲は「1-3, 5」のように入力する（選んだページがあれば、それが最初から入っている）。
// できたファイルが1つならそのまま、複数ならZIPにまとめて渡す。

import { extractPages } from '../core/page-list.js';
import { chunkPages, formatPageRange, parsePageRange, parsePageRangeGroups } from '../core/page-range.js';
import { numberedName } from '../core/filename.js';
import { zipSync } from '../../vendor/fflate/fflate.mjs';
import { IMAGE_FORMATS } from '../web/page-image.js';

const TOOLS = {
  extract: { title: 'ページを取り出す', description: '指定したページだけで、新しいPDFを作ります。', submit: 'PDFを作成' },
  split: { title: 'PDFを分割する', description: 'いくつかのPDFに分けます。複数できたときはZIPにまとめます。', submit: '分割する' },
  images: { title: '画像にする', description: 'ページを1枚ずつ画像にします。複数あるときはZIPにまとめます。', submit: '画像を作成' },
};

/** ページ範囲を、ファイル名に使える短い文字にする。例：[0,1,2,4] → "1-3_5" */
const rangeLabel = (indexes) => formatPageRange(indexes).replaceAll(', ', '_');

/**
 * @param {object} deps
 * @param {() => object} deps.getDoc 今のページリスト
 * @param {() => number[]} deps.getSelectedIndexes 選んでいるページ（0始まり）
 * @param {() => string} deps.getBaseName 書き出すファイル名の元（拡張子なし）
 * @param {(doc: object, title: string, progress: (text: string) => void) => Promise<Uint8Array>} deps.buildPdf
 * @param {(page: object, options: object) => Promise<Blob>} deps.renderImage
 * @param {(blob: Blob, fileName: string, info: { title: string, summary: string }) => void} deps.deliver
 * @param {(text: string|null) => void} deps.busy
 * @param {(message: string) => void} deps.onError
 */
export function createToolsDialog({ getDoc, getSelectedIndexes, getBaseName, buildPdf, renderImage, deliver, busy, onError }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $('#tool-dialog');
  const form = $('#tool-form');
  const error = $('#tool-error');
  let tool = null;

  function open(name) {
    tool = name;
    const info = TOOLS[name];
    $('#tool-title').textContent = info.title;
    $('#tool-desc').textContent = info.description;
    $('#tool-submit').textContent = info.submit;
    for (const section of dialog.querySelectorAll('[data-tool]')) section.hidden = section.dataset.tool !== name;
    error.textContent = '';

    // 選んだページがあれば、それを範囲の入力欄に入れておく
    const count = getDoc().pages.length;
    const selected = getSelectedIndexes();
    const range = selected.length > 0 ? formatPageRange(selected) : count > 1 ? `1-${count}` : '1';
    $('#extract-range').value = range;
    $('#images-range').value = range;
    $('#split-ranges').value = count > 1 ? `1-${Math.ceil(count / 2)}, ${Math.ceil(count / 2) + 1}-${count}` : '1';
    $('#split-ranges').placeholder = '例：1-3, 4-6';
    dialog.showModal();
  }

  async function run() {
    const doc = getDoc();
    const count = doc.pages.length;
    const base = getBaseName();
    if (tool === 'extract') {
      const indexes = parsePageRange($('#extract-range').value, count);
      const part = extractPages(doc, indexes.map((i) => doc.pages[i].id));
      const name = `${base}_${rangeLabel(indexes)}`;
      const bytes = await buildPdf(part, name, (text) => busy(text));
      return deliver(new Blob([bytes], { type: 'application/pdf' }), `${name}.pdf`, {
        title: 'PDFができました',
        summary: `${indexes.length}ページ`,
      });
    }

    if (tool === 'split') {
      const mode = form.elements['split-mode'].value;
      const groups =
        mode === 'every'
          ? chunkPages(count, Number($('#split-every').value))
          : parsePageRangeGroups($('#split-ranges').value, count);
      const files = {};
      for (const [i, group] of groups.entries()) {
        const part = extractPages(doc, group.map((index) => doc.pages[index].id));
        const name = `${base}_${rangeLabel(group)}`;
        const bytes = await buildPdf(part, name, () => busy(`分割中… ${i + 1} / ${groups.length}`));
        files[`${name}.pdf`] = bytes;
      }
      const names = Object.keys(files);
      if (names.length === 1) {
        return deliver(new Blob([files[names[0]]], { type: 'application/pdf' }), names[0], {
          title: 'PDFができました',
          summary: `${groups[0].length}ページ`,
        });
      }
      // PDFはすでに圧縮されているので、ZIPでは圧縮しない（速くするため）
      const zip = zipSync(files, { level: 0 });
      return deliver(new Blob([zip], { type: 'application/zip' }), `${base}_分割.zip`, {
        title: 'PDFを分割しました',
        summary: `${names.length}個のPDF`,
      });
    }

    if (tool === 'images') {
      const indexes = parsePageRange($('#images-range').value, count);
      const format = $('#images-format').value;
      const dpi = Number($('#images-dpi').value);
      const { extension, type } = IMAGE_FORMATS[format];
      const files = {};
      for (const [i, index] of indexes.entries()) {
        busy(`画像を作成中… ${i + 1} / ${indexes.length}`);
        const blob = await renderImage(doc.pages[index], { dpi, format });
        files[numberedName(base, index + 1, count, extension)] = new Uint8Array(await blob.arrayBuffer());
      }
      const names = Object.keys(files);
      if (names.length === 1) {
        return deliver(new Blob([files[names[0]]], { type }), names[0], { title: '画像ができました', summary: '1枚' });
      }
      const zip = zipSync(files, { level: 0 });
      return deliver(new Blob([zip], { type: 'application/zip' }), `${base}_画像.zip`, {
        title: '画像ができました',
        summary: `${names.length}枚`,
      });
    }
    return undefined;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    try {
      // 入力のまちがいは、ダイアログを閉じずにその場で知らせる
      if (tool === 'extract') parsePageRange($('#extract-range').value, getDoc().pages.length);
      if (tool === 'images') parsePageRange($('#images-range').value, getDoc().pages.length);
      if (tool === 'split' && form.elements['split-mode'].value === 'ranges') {
        parsePageRangeGroups($('#split-ranges').value, getDoc().pages.length);
      }
      if (tool === 'split' && form.elements['split-mode'].value === 'every') chunkPages(1, Number($('#split-every').value));
    } catch (e) {
      error.textContent = e.message;
      return;
    }
    dialog.close();
    busy('作成中…');
    try {
      await run();
    } catch (e) {
      console.error(e);
      busy(null);
      onError(`作成できませんでした：${e.message}`);
      return;
    }
    busy(null);
  });

  dialog.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="close-tool"]')) dialog.close();
  });
  // 範囲の入力欄を触ったら、「ページ範囲ごと」を選んだことにする
  $('#split-ranges').addEventListener('focus', () => (form.elements['split-mode'].value = 'ranges'));
  $('#split-every').addEventListener('focus', () => (form.elements['split-mode'].value = 'every'));

  return { open, isOpen: () => dialog.open, close: () => dialog.close() };
}
