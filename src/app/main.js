// RelaPDF の画面（UI層）
//
// ページリスト（Core）の状態を持ち、操作のたびに新しい状態に置き換えて画面を描き直す。
// かんたんモードは「1 撮る・選ぶ → 2 確認 → 3 保存」の3ステップで進む。
// 作業中の状態は端末内に自動保存し、ページを読み込み直しても続きから再開する。

import {
  addSource,
  appendSourcePages,
  createDocument,
  deserializeDocument,
  movePages,
  pruneSources,
  removePages,
  rotatePages,
  serializeDocument,
  setPerspective,
} from '../core/page-list.js';
import { exportPdf, inspectPdf } from '../core/pdf-export.js';
import { defaultFileName, sanitizeFileName, stripExtension } from '../core/filename.js';
import { PAPER_MODES, QUALITY_PRESETS } from '../core/layout.js';
import { createSourceStore } from '../web/source-store.js';
import { imageThumbnailUrl, loadImageFile, prepareImageForExport } from '../web/image.js';
import { closePdf, pdfThumbnailUrl } from '../web/pdf-view.js';
import { canShareFiles, downloadBlob, shareBlob } from '../web/save.js';
import { currentMode, saveMode } from '../web/mode.js';
import { createCameraView } from './camera-view.js';
import { enableDragReorder } from './drag.js';
import { createPerspectiveEditor } from './perspective-editor.js';
import { APP_VERSION } from './version.js';

const THUMB_SIZE = 360;
const SAVE_DELAY = 300;

const $ = (selector) => document.querySelector(selector);
const els = {
  steps: $('#steps'),
  empty: $('#empty'),
  workspace: $('#workspace'),
  grid: $('#page-grid'),
  count: $('#page-count'),
  nextBar: $('#next-bar'),
  nextCount: $('#next-count'),
  exportBar: $('#export-bar'),
  saveSummary: $('#save-summary'),
  fileName: $('#file-name'),
  paper: $('#paper'),
  quality: $('#quality'),
  inputPhotos: $('#input-photos'),
  inputCamera: $('#input-camera'),
  inputFiles: $('#input-files'),
  resultDialog: $('#result-dialog'),
  resultReady: $('#result-ready'),
  resultDone: $('#result-done'),
  resultMeta: $('#result-meta'),
  doneTitle: $('#done-title'),
  doneMeta: $('#done-meta'),
  shareButton: $('#share-button'),
  downloadButton: $('#download-button'),
  busy: $('#busy'),
  busyText: $('#busy-text'),
  toast: $('#toast'),
  dropOverlay: $('#drop-overlay'),
  version: $('#app-version'),
};

const store = await createSourceStore();
const thumbnails = new Map(); // `${sourceId}:${pageIndex}` → Promise<string>（表示用URL）
let doc = createDocument();
let mode = currentMode();
let easyStep = 'confirm'; // ページがあるときの、かんたんモードの段階（'confirm' | 'save'）
let lastExport = null; // { blob, fileName }

// ---- 状態の更新 ----

function update(next) {
  const { doc: pruned, removedSourceIds } = pruneSources(next);
  for (const sourceId of removedSourceIds) forgetSource(sourceId);
  doc = pruned;
  if (doc.pages.length === 0) easyStep = 'confirm';
  render();
  saveStateSoon();
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

// ファイルの追加やカメラの写真など、時間のかかる変更は1つずつ順番に行う（追い越しで消えないように）
let work = Promise.resolve();
function serial(task) {
  const result = work.then(task);
  work = result.catch(() => {});
  return result;
}

// ---- 自動保存 ----

let saveTimer = 0;
function saveStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStateNow, SAVE_DELAY);
}

function saveStateNow() {
  clearTimeout(saveTimer);
  const state = {
    doc: serializeDocument(doc),
    fileName: els.fileName.value,
    paper: els.paper.value,
    quality: els.quality.value,
    step: easyStep,
    savedAt: Date.now(),
  };
  return store.saveState(state).catch((error) => {
    console.warn(error);
    toast('端末の空き容量が足りないため、作業途中の保存ができませんでした', 'error');
  });
}

/** 前回の作業が残っていれば、続きから再開する */
async function restoreState() {
  const state = await store.loadState().catch(() => null);
  if (!state?.doc) return;
  let restored;
  try {
    restored = deserializeDocument(state.doc);
  } catch (error) {
    console.warn('前回の作業を読み込めませんでした', error);
    await store.clear();
    return;
  }
  // 中身が見つからない元データのページは外す（保存の途中で閉じた場合など）
  const keys = new Set(await store.keys());
  const missing = restored.pages
    .filter((p) => p.content.type !== 'blank' && !keys.has(p.content.sourceId))
    .map((p) => p.id);
  restored = pruneSources(removePages(restored, missing)).doc;
  for (const key of keys) {
    if (!restored.sources[key]) store.delete(key);
  }

  doc = restored;
  els.fileName.value = state.fileName ?? '';
  if (PAPER_MODES.includes(state.paper)) els.paper.value = state.paper;
  if (QUALITY_PRESETS[state.quality]) els.quality.value = state.quality;
  easyStep = state.step === 'save' ? 'save' : 'confirm';
  if (doc.pages.length > 0) toast('前回の続きから再開しました');
}

let persistRequested = false;
function requestPersistentStorage() {
  // ブラウザが容量不足のときに、保存したデータを勝手に消さないようお願いする
  if (persistRequested) return;
  persistRequested = true;
  navigator.storage?.persist?.().catch(() => {});
}

// ---- ファイルの読み込み ----

const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
const isImage = (file) => file.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(file.name);

function addFiles(fileList) {
  const files = [...fileList];
  if (files.length === 0) return Promise.resolve();
  return serial(async () => {
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
      easyStep = 'confirm';
      update(next);
    }
    if (errors.length > 0) toast(errors.join('\n'), 'error');
  });
}

async function addFile(current, file) {
  if (isPdf(file)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { pageCount } = await inspectPdf(bytes);
    const source = { kind: 'pdf', name: file.name, mimeType: 'application/pdf', byteLength: file.size, pageCount };
    return addSourceWithBlob(current, source, file);
  }
  if (isImage(file)) {
    return addImage(current, await loadImageFile(file), file.name);
  }
  throw new Error('対応していないファイルです（PDFか画像を選んでください）');
}

function addImage(current, image, name) {
  const source = {
    kind: 'image',
    name,
    mimeType: image.blob.type,
    byteLength: image.blob.size,
    width: image.width,
    height: image.height,
  };
  return addSourceWithBlob(current, source, image.blob);
}

async function addSourceWithBlob(current, source, blob) {
  const withSource = addSource(current, source);
  const sourceId = Object.keys(withSource.sources).find((id) => !current.sources[id]);
  // 中身を先に保存してから、ページリストに入れる（途中で閉じても壊れないように）
  await store.put(sourceId, blob).catch(() => {});
  requestPersistentStorage();
  return appendSourcePages(withSource, sourceId);
}

// ---- カメラ ----

const camera = createCameraView({
  onCapture: (frame, number) =>
    serial(async () => {
      const name = `撮影_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}_${String(number).padStart(2, '0')}.jpg`;
      easyStep = 'confirm';
      update(await addImage(doc, frame, name));
    }),
  onDone: () => {
    render();
    saveStateNow();
  },
  onUseOsCamera: () => els.inputCamera.click(),
  onBusy: (text) => (text ? showBusy(text) : hideBusy()),
});

// ---- 4点補正 ----

const editor = createPerspectiveEditor({
  getBlob: (page) => store.get(page.content.sourceId),
  onApply: (pageId, perspective) => {
    if (!doc.pages.some((p) => p.id === pageId)) return;
    update(setPerspective(doc, pageId, perspective));
    toast(perspective ? '補正しました' : '補正を外しました');
  },
});

function openEditor(pageId) {
  const page = doc.pages.find((p) => p.id === pageId);
  if (page?.content.type === 'image') editor.open(page);
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
        return prepareImageForExport(await store.get(page.content.sourceId), {
          quality,
          paper,
          perspective: page.perspective,
        });
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
  els.resultReady.hidden = false;
  els.resultDone.hidden = true;
  if (!els.resultDialog.open) els.resultDialog.showModal();
}

/** 送る・保存が終わったことを、ダイアログの中で知らせる */
function showDone(title, message) {
  els.doneTitle.textContent = title;
  els.doneMeta.textContent = message;
  els.resultReady.hidden = true;
  els.resultDone.hidden = false;
  els.doneTitle.focus();
}

async function shareResult() {
  let result;
  try {
    result = await shareBlob(lastExport.blob, lastExport.fileName);
  } catch (error) {
    console.error(error);
    toast('共有できませんでした。「ダウンロード」を試してください', 'error');
    return;
  }
  // 共有シートを閉じただけ（キャンセル）のときは、そのまま選び直せるようにする
  if (result === 'shared') showDone('完了しました', `「${lastExport.fileName}」を送りました`);
}

function downloadResult() {
  downloadBlob(lastExport.blob, lastExport.fileName);
  showDone('保存しました', `「${lastExport.fileName}」をダウンロードしました`);
}

async function startOver() {
  els.resultDialog.close();
  els.fileName.value = '';
  easyStep = 'confirm';
  update(createDocument());
  await store.clear();
}

// ---- 描画 ----

/** 今のかんたんモードの段階 */
function currentStep() {
  if (doc.pages.length === 0) return 'capture';
  return easyStep;
}

function render() {
  const count = doc.pages.length;
  const easy = mode === 'easy';
  const step = currentStep();
  document.body.dataset.step = step;

  els.empty.hidden = count > 0;
  els.workspace.hidden = count === 0 || (easy && step === 'save');
  els.nextBar.hidden = !(easy && step === 'confirm');
  els.exportBar.hidden = count === 0 || (easy && step !== 'save');
  els.count.textContent = `${count}ページ`;
  els.nextCount.textContent = `（${count}ページ）`;
  els.saveSummary.textContent = `${count}ページをPDFにします`;
  if (!els.fileName.value) els.fileName.placeholder = suggestedFileName();

  for (const item of els.steps.querySelectorAll('[data-step]')) {
    if (item.dataset.step === step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  }

  const cards = doc.pages.map((page, index) => renderCard(page, index, count));
  els.grid.replaceChildren(...cards);
  placeVersion();
}

/** バージョン表示が下のバー（保存へ進む・書き出し）に隠れないよう、バーの高さだけ上げる */
function placeVersion() {
  const bar = [els.nextBar, els.exportBar].find((el) => !el.hidden && el.offsetHeight > 0 && getComputedStyle(el).position !== 'static');
  document.body.classList.toggle('has-bottom-bar', Boolean(bar));
  document.documentElement.style.setProperty('--bottom-bar', `${bar ? bar.offsetHeight : 0}px`);
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
    img.draggable = false;
    img.style.transform = `rotate(${page.rotation}deg)`;
    img.hidden = true;
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    thumb.append(spinner, img);
    if (content.type === 'image') {
      thumb.classList.add('clickable');
      thumb.dataset.op = 'perspective';
      thumb.title = 'タップして4点補正';
    }
    if (page.perspective) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = '補正済み';
      thumb.append(badge);
    }
    thumbnailFor(page)
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
  const grip = iconButton('drag', 'ドラッグして並べ替え', ICONS.grip, false, 'grip easy-only');
  grip.dataset.dragHandle = '';
  actions.append(
    grip,
    iconButton('move-left', '前へ移動', ICONS.left, index === 0, 'detail-only'),
    content.type === 'image' ? iconButton('perspective', '4点補正', ICONS.perspective) : '',
    iconButton('rotate', '右に回転', ICONS.rotate),
    iconButton('move-right', '後ろへ移動', ICONS.right, index === count - 1, 'detail-only'),
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
function thumbnailFor(page) {
  const { content, perspective } = page;
  // 4点補正の内容が変われば、別のサムネイルとして作り直す
  const key = `${content.sourceId}:${content.pageIndex}:${perspective ? JSON.stringify(perspective) : ''}`;
  if (!thumbnails.has(key)) {
    const task = thumbnailQueue.then(async () => {
      if (!doc.sources[content.sourceId]) throw new Error('削除済みのページです');
      return content.type === 'pdf'
        ? pdfThumbnailUrl(content.sourceId, () => store.bytes(content.sourceId), content.pageIndex, THUMB_SIZE)
        : imageThumbnailUrl(await store.get(content.sourceId), THUMB_SIZE, perspective);
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
  perspective: svg('<path d="M6 5l13 2-1 12-13-2z"/><circle cx="6" cy="5" r="1.6" fill="currentColor"/><circle cx="19" cy="7" r="1.6" fill="currentColor"/><circle cx="18" cy="19" r="1.6" fill="currentColor"/><circle cx="5" cy="17" r="1.6" fill="currentColor"/>'),
  grip: svg('<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>'),
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

function applyMode(next) {
  mode = next;
  document.body.classList.toggle('mode-easy', mode === 'easy');
  document.body.classList.toggle('mode-detail', mode === 'detail');
  for (const button of document.querySelectorAll('[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
  render();
}

function goToStep(step) {
  easyStep = step;
  render();
  saveStateSoon();
  scrollTo({ top: 0 });
}

// ---- 操作の受け付け ----

function onAction(action) {
  switch (action) {
    case 'camera':
      camera.open();
      break;
    case 'os-camera':
      els.inputCamera.click();
      break;
    case 'pick-photos':
      els.inputPhotos.click();
      break;
    case 'pick-files':
      els.inputFiles.click();
      break;
    case 'clear':
      if (confirm('すべてのページを削除しますか？')) startOver();
      break;
    case 'go-save':
      goToStep('save');
      break;
    case 'back-to-confirm':
      goToStep('confirm');
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
    case 'back-to-result':
      showResult();
      break;
    case 'new-document':
      startOver();
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
    case 'perspective':
      openEditor(pageId);
      return;
    default:
      return;
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

enableDragReorder(els.grid, (pageId, toIndex) => update(movePages(doc, [pageId], toIndex)));

for (const input of [els.inputPhotos, els.inputCamera, els.inputFiles]) {
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = ''; // 同じファイルをもう一度選べるようにする
    addFiles(files);
  });
}

for (const input of [els.fileName, els.paper, els.quality]) {
  input.addEventListener('change', saveStateSoon);
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

// ほかのアプリに切り替えるときは、待たずにすぐ保存する
document.addEventListener('visibilitychange', () => {
  if (document.hidden) saveStateNow();
});
window.addEventListener('pagehide', () => saveStateNow());

// ---- 起動 ----

els.version.textContent = `RelaPDF v${APP_VERSION}`;
window.addEventListener('resize', placeVersion);

await restoreState();
applyMode(mode);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service Worker を登録できませんでした', error));
}

// 画面テストから状態を確かめるための入り口（アプリの動作には使わない）
window.__relapdf = { getDoc: () => doc, flushSave: () => saveStateNow() };
