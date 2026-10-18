// RelaPDF の画面（UI層）
//
// ページリスト（Core）の状態を持ち、操作のたびに新しい状態に置き換えて画面を描き直す。

import {
  addSource,
  appendSourcePages,
  createDocument,
  movePages,
  pruneSources,
  removePages,
  rotatePages,
} from '../core/page-list.js';
import { exportPdf, inspectPdf } from '../core/pdf-export.js';
import { defaultFileName, sanitizeFileName, stripExtension } from '../core/filename.js';
import { createSourceStore } from '../web/source-store.js';
import { imageThumbnailUrl, loadImageFile, prepareImageForExport } from '../web/image.js';
import { closePdf, pdfThumbnailUrl } from '../web/pdf-view.js';
import { canShareFiles, downloadBlob, shareBlob } from '../web/save.js';
import { currentMode, saveMode } from '../web/mode.js';

const THUMB_SIZE = 360;

const $ = (selector) => document.querySelector(selector);
const els = {
  empty: $('#empty'),
  workspace: $('#workspace'),
  grid: $('#page-grid'),
  count: $('#page-count'),
  exportBar: $('#export-bar'),
  fileName: $('#file-name'),
  paper: $('#paper'),
  quality: $('#quality'),
  inputPhotos: $('#input-photos'),
  inputCamera: $('#input-camera'),
  inputFiles: $('#input-files'),
  resultDialog: $('#result-dialog'),
  resultMeta: $('#result-meta'),
  shareButton: $('#share-button'),
  downloadButton: $('#download-button'),
  busy: $('#busy'),
  busyText: $('#busy-text'),
  toast: $('#toast'),
  dropOverlay: $('#drop-overlay'),
};

const store = createSourceStore();
const thumbnails = new Map(); // `${sourceId}:${pageIndex}` → Promise<string>（表示用URL）
let doc = createDocument();
let lastExport = null; // { blob, fileName }

// ---- 状態の更新 ----

function update(next) {
  const { doc: pruned, removedSourceIds } = pruneSources(next);
  for (const sourceId of removedSourceIds) forgetSource(sourceId);
  doc = pruned;
  render();
}

function forgetSource(sourceId) {
  store.delete(sourceId);
  closePdf(sourceId);
  for (const [key, promise] of thumbnails) {
    if (key.startsWith(`${sourceId}:`)) {
      promise.then((url) => URL.revokeObjectURL(url)).catch(() => {});
      thumbnails.delete(key);
    }
  }
}

// ---- ファイルの読み込み ----

const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
const isImage = (file) => file.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(file.name);

async function addFiles(fileList) {
  const files = [...fileList];
  if (files.length === 0) return;
  let next = doc;
  const errors = [];
  try {
    for (const [i, file] of files.entries()) {
      showBusy(files.length > 1 ? `読み込み中… ${i + 1} / ${files.length}` : '読み込み中…');
      try {
        next = await addFile(next, file);
      } catch (error) {
        console.error(error);
        errors.push(`${file.name}：${error.message}`);
      }
    }
  } finally {
    hideBusy();
    update(next);
  }
  if (errors.length > 0) toast(errors.join('\n'), 'error');
}

async function addFile(current, file) {
  if (isPdf(file)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { pageCount } = await inspectPdf(bytes);
    const withSource = addSource(current, {
      kind: 'pdf',
      name: file.name,
      mimeType: 'application/pdf',
      byteLength: file.size,
      pageCount,
    });
    const sourceId = newestSourceId(current, withSource);
    store.put(sourceId, file);
    return appendSourcePages(withSource, sourceId);
  }
  if (isImage(file)) {
    const image = await loadImageFile(file);
    const withSource = addSource(current, {
      kind: 'image',
      name: file.name,
      mimeType: image.blob.type,
      byteLength: image.blob.size,
      width: image.width,
      height: image.height,
    });
    const sourceId = newestSourceId(current, withSource);
    store.put(sourceId, image.blob);
    return appendSourcePages(withSource, sourceId);
  }
  throw new Error('対応していないファイルです（PDFか画像を選んでください）');
}

function newestSourceId(before, after) {
  return Object.keys(after.sources).find((id) => !before.sources[id]);
}

// ---- 書き出し ----

async function createPdf() {
  if (doc.pages.length === 0) return;
  const fileName = sanitizeFileName(els.fileName.value || els.fileName.placeholder);
  const paper = els.paper.value;
  const quality = els.quality.value;
  const imageTotal = doc.pages.filter((p) => p.content.type === 'image').length;
  let imageDone = 0;

  showBusy('PDFを作成中…');
  try {
    const bytes = await exportPdf(doc, {
      paper,
      title: stripExtension(fileName),
      getSourceBytes: (sourceId) => store.bytes(sourceId),
      getImage: async (page) => {
        imageDone += 1;
        showBusy(`PDFを作成中… ${imageDone} / ${imageTotal}`);
        return prepareImageForExport(store.get(page.content.sourceId), { quality, paper });
      },
    });
    lastExport = { blob: new Blob([bytes], { type: 'application/pdf' }), fileName };
  } catch (error) {
    console.error(error);
    toast(`PDFを作成できませんでした：${error.message}`, 'error');
    return;
  } finally {
    hideBusy();
  }
  showResult();
}

function showResult() {
  const { blob, fileName } = lastExport;
  els.resultMeta.textContent = `${fileName}（${doc.pages.length}ページ・${formatBytes(blob.size)}）`;
  const shareable = canShareFiles();
  els.shareButton.hidden = !shareable;
  els.downloadButton.classList.toggle('primary', !shareable);
  els.resultDialog.showModal();
}

async function shareResult() {
  try {
    await shareBlob(lastExport.blob, lastExport.fileName);
  } catch (error) {
    console.error(error);
    toast('共有できませんでした。「ダウンロード」を試してください', 'error');
  }
}

function downloadResult() {
  downloadBlob(lastExport.blob, lastExport.fileName);
  els.resultDialog.close();
  toast('ダウンロードしました');
}

// ---- 描画 ----

function render() {
  const count = doc.pages.length;
  els.empty.hidden = count > 0;
  els.workspace.hidden = count === 0;
  els.exportBar.hidden = count === 0;
  els.count.textContent = `${count}ページ`;
  if (!els.fileName.value) els.fileName.placeholder = suggestedFileName();

  const cards = doc.pages.map((page, index) => renderCard(page, index, count));
  els.grid.replaceChildren(...cards);
}

function suggestedFileName() {
  const sources = Object.values(doc.sources);
  if (sources.length === 1 && sources[0].kind === 'pdf') return stripExtension(sources[0].name);
  return stripExtension(defaultFileName());
}

function renderCard(page, index, count) {
  const li = document.createElement('li');
  li.className = 'page-card';
  li.dataset.id = page.id;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const number = document.createElement('span');
  number.className = 'page-no';
  number.textContent = String(index + 1);
  thumb.append(number);

  const { content } = page;
  if (content.type === 'blank') {
    const blank = document.createElement('div');
    blank.className = 'blank';
    blank.style.transform = `rotate(${page.rotation}deg)`;
    thumb.append(blank);
  } else {
    const img = document.createElement('img');
    img.alt = `${index + 1}ページ目`;
    img.style.transform = `rotate(${page.rotation}deg)`;
    img.hidden = true;
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    thumb.append(spinner, img);
    thumbnailFor(content)
      .then((url) => {
        img.src = url;
        img.hidden = false;
        spinner.remove();
      })
      .catch((error) => {
        console.error(error);
        spinner.remove();
      });
  }

  const source = content.type === 'blank' ? null : doc.sources[content.sourceId];
  const label = document.createElement('div');
  label.className = 'page-src';
  label.textContent = !source ? '白紙' : source.kind === 'pdf' ? `${source.name}・${content.pageIndex + 1}` : source.name;
  label.title = label.textContent;

  const actions = document.createElement('div');
  actions.className = 'page-actions';
  actions.append(
    iconButton('move-left', '前へ移動', ICONS.left, index === 0),
    iconButton('rotate', '右に回転', ICONS.rotate),
    iconButton('move-right', '後ろへ移動', ICONS.right, index === count - 1),
    iconButton('delete', '削除', ICONS.trash, false, 'danger'),
  );

  li.append(thumb, label, actions);
  return li;
}

function iconButton(op, label, icon, disabled = false, extraClass = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `icon-btn ${extraClass}`.trim();
  button.dataset.op = op;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.disabled = disabled;
  button.innerHTML = icon;
  return button;
}

// サムネイルは同時に作りすぎないよう、順番に作る（iPhoneのメモリ対策）
let thumbnailQueue = Promise.resolve();
function thumbnailFor(content) {
  const key = `${content.sourceId}:${content.pageIndex}`;
  if (!thumbnails.has(key)) {
    const task = thumbnailQueue.then(() => {
      if (!doc.sources[content.sourceId]) throw new Error('削除済みのページです');
      return content.type === 'pdf'
        ? pdfThumbnailUrl(content.sourceId, () => store.bytes(content.sourceId), content.pageIndex, THUMB_SIZE)
        : imageThumbnailUrl(store.get(content.sourceId), THUMB_SIZE);
    });
    thumbnailQueue = task.catch(() => {});
    task.catch(() => thumbnails.delete(key));
    thumbnails.set(key, task);
  }
  return thumbnails.get(key);
}

const svg = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  left: svg('<path d="M15 18l-6-6 6-6"/>'),
  right: svg('<path d="M9 18l6-6-6-6"/>'),
  rotate: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
  trash: svg('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>'),
};

// ---- お知らせ・処理中の表示 ----

let toastTimer = 0;
function toast(message, kind = 'info') {
  els.toast.textContent = message;
  els.toast.classList.toggle('error', kind === 'error');
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), kind === 'error' ? 6000 : 2500);
}

function showBusy(text) {
  els.busyText.textContent = text;
  els.busy.hidden = false;
}

function hideBusy() {
  els.busy.hidden = true;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ---- モード ----

function applyMode(mode) {
  document.body.classList.toggle('mode-easy', mode === 'easy');
  document.body.classList.toggle('mode-detail', mode === 'detail');
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
}

// ---- 操作の受け付け ----

function onAction(action) {
  switch (action) {
    case 'camera':
      els.inputCamera.click();
      break;
    case 'pick-photos':
      els.inputPhotos.click();
      break;
    case 'pick-files':
      els.inputFiles.click();
      break;
    case 'clear':
      if (confirm('すべてのページを削除しますか？')) update(createDocument());
      break;
    case 'export':
      createPdf();
      break;
    case 'share':
      shareResult();
      break;
    case 'download':
      downloadResult();
      break;
    case 'close-result':
      els.resultDialog.close();
      break;
  }
}

function onPageOp(op, pageId) {
  const index = doc.pages.findIndex((p) => p.id === pageId);
  if (index < 0) return;
  switch (op) {
    case 'rotate':
      update(rotatePages(doc, [pageId], 90));
      break;
    case 'move-left':
      update(movePages(doc, [pageId], index - 1));
      break;
    case 'move-right':
      update(movePages(doc, [pageId], index + 1));
      break;
    case 'delete':
      update(removePages(doc, [pageId]));
      break;
  }
  // 描き直したあとも、同じページの同じボタンに操作の位置を残す
  const button = els.grid.querySelector(`[data-id="${CSS.escape(pageId)}"] [data-op="${op}"]`);
  if (button && !button.disabled) button.focus();
}

document.addEventListener('click', (event) => {
  const actionTarget = event.target.closest('[data-action]');
  if (actionTarget) {
    onAction(actionTarget.dataset.action);
    return;
  }
  const modeTarget = event.target.closest('[data-mode]');
  if (modeTarget) {
    saveMode(modeTarget.dataset.mode);
    applyMode(modeTarget.dataset.mode);
    return;
  }
  const opTarget = event.target.closest('[data-op]');
  if (opTarget) onPageOp(opTarget.dataset.op, opTarget.closest('[data-id]').dataset.id);
});

for (const input of [els.inputPhotos, els.inputCamera, els.inputFiles]) {
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = ''; // 同じファイルをもう一度選べるようにする
    addFiles(files);
  });
}

// ドラッグ＆ドロップでの追加
let dragDepth = 0;
const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  dragDepth += 1;
  els.dropOverlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.dropOverlay.hidden = true;
});
window.addEventListener('dragover', (event) => {
  if (hasFiles(event)) event.preventDefault();
});
window.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  addFiles(event.dataTransfer.files);
});

// M2で自動保存を入れるまでは、作業中にページを閉じようとしたら確認する
window.addEventListener('beforeunload', (event) => {
  if (doc.pages.length > 0) event.preventDefault();
});

// ---- 起動 ----

applyMode(currentMode());
render();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service Worker を登録できませんでした', error));
}

// 画面テストから状態を確かめるための入り口（アプリの動作には使わない）
window.__relapdf = { getDoc: () => doc };
