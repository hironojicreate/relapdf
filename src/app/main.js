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
  movePagesBefore,
  pruneSources,
  removePages,
  rotatePages,
  serializeDocument,
  extractPages,
  setFilter,
  newId,
  setAnnotations,
  setFormValues,
  setMarks,
  setPerspective,
} from '../core/page-list.js';
import { describeMarks, hasMarks } from '../core/marks.js';
import { COMPRESS_LEVELS } from '../core/compress.js';
import { exportPdf, inspectPdf } from '../core/pdf-export.js';
import { defaultFileName, sanitizeFileName, stripExtension } from '../core/filename.js';
import { PAPER_MODES, QUALITY_PRESETS } from '../core/layout.js';
import { createSourceStore, isQuotaError } from '../web/source-store.js';
import { imageThumbnailUrl, loadImageFile, prepareImageForExport, recompressJpeg } from '../web/image.js';
import { closePdf, pdfThumbnailUrl, renderPdfPage } from '../web/pdf-view.js';
import { loadMarkFont } from '../web/fonts.js';
import { downloadBlob } from '../web/save.js';
import { currentMode, saveMode } from '../web/mode.js';
import { loadDocumentMode } from '../web/document-mode.js';
import { setupUpdater } from '../web/updater.js';
import { setupInstall } from '../web/install.js';
import { createCameraView } from './camera-view.js';
import { enableDragReorder } from './drag.js';
import { enableMarqueeSelect } from './marquee.js';
import { createPerspectiveEditor } from './perspective-editor.js';
import { createStepHistory } from './navigation.js';
import { createToolsDialog } from './tools-dialog.js';
import { createMarksDialog } from './marks-dialog.js';
import { createFormsDialog } from './forms-dialog.js';
import { createAnnotator } from './annotate-editor.js';
import { createSignatureDialog } from './signature-dialog.js';
import { createPreview } from './preview.js';
import { renderPageImage } from '../web/page-image.js';
import { APP_VERSION } from './version.js';

const THUMB_SIZE = 360;
const UNDO_DURATION = 6000; // 「元に戻す」を押せる時間
const SAVE_DELAY = 300;

const $ = (selector) => document.querySelector(selector);
const els = {
  steps: $('#steps'),
  empty: $('#empty'),
  workspace: $('#workspace'),
  grid: $('#page-grid'),
  count: $('#page-count'),
  nextBar: $('#next-bar'),
  nextButton: $('#next-bar .btn'),
  nextLabel: $('#next-label'),
  nextCount: $('#next-count'),
  emptyTitleEasy: $('#empty-title-easy'),
  emptyLeadEasy: $('#empty-lead-easy'),
  captureMore: $('#capture-more'),
  captureCount: $('#capture-count'),
  captureRestart: $('#capture-restart'),
  toastText: $('#toast-text'),
  toastAction: $('#toast-action'),
  exportBar: $('#export-bar'),
  saveSummary: $('#save-summary'),
  fileName: $('#file-name'),
  paper: $('#paper'),
  quality: $('#quality'),
  compress: $('#compress'),
  inputPhotos: $('#input-photos'),
  inputCamera: $('#input-camera'),
  inputFiles: $('#input-files'),
  resultDialog: $('#result-dialog'),
  resultDone: $('#result-done'),
  selectionCount: $('#selection-count'),
  selectAllButton: $('#select-all'),
  mergeHint: $('#merge-hint'),
  marksStatus: $('#marks-status'),
  formsStatus: $('#forms-status'),
  openForms: $('#open-forms'),
  doneTitle: $('#done-title'),
  doneMeta: $('#done-meta'),
  busy: $('#busy'),
  busyText: $('#busy-text'),
  toast: $('#toast'),
  dropOverlay: $('#drop-overlay'),
  version: $('#app-version'),
  updateBanner: $('#update-banner'),
  installButtons: document.querySelectorAll('[data-action="install"]'),
  installDialog: $('#install-dialog'),
};

const store = await createSourceStore();
const thumbnails = new Map(); // `${sourceId}:${pageIndex}` → Promise<string>（表示用URL）
let doc = createDocument();
let mode = currentMode();
let easyStep = 'confirm'; // ページがあるときの、かんたんモードの段階（'capture' | 'confirm' | 'save'）
let lastExport = null; // { blob, fileName }（もう一度ダウンロードするため）
let selected = new Set(); // 詳細モードで選んでいるページのID
let selectionAnchor = null; // Shift+クリックで範囲を選ぶときの起点

// ---- 状態の更新 ----

function update(next) {
  // 削除や「最初からやり直す」のあとに別の作業を始めたら、もう元に戻せないので片付ける
  finalizeUndo();
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

let lastSaveErrorAt = 0;
function saveStateNow() {
  clearTimeout(saveTimer);
  const state = {
    doc: serializeDocument(doc),
    fileName: els.fileName.value,
    paper: els.paper.value,
    quality: els.quality.value,
    compress: els.compress.value,
    step: easyStep,
    savedAt: Date.now(),
  };
  return store.saveState(state).catch((error) => {
    console.warn(error);
    // 何度も続けて出さない（保存は操作のたびに行うため）
    if (Date.now() - lastSaveErrorAt < 60_000) return;
    lastSaveErrorAt = Date.now();
    toast(
      isQuotaError(error)
        ? '端末の空き容量が足りないため、作業途中の保存ができませんでした。端末の写真やアプリを整理すると直ります'
        : `作業途中の保存ができませんでした（${error?.name ?? 'エラー'}）。アプリを開き直すと直ることがあります`,
      'error',
    );
  });
}

/** 前回の作業が残っていれば、続きから再開する */
async function restoreState() {
  let state;
  try {
    state = await store.loadState();
  } catch (error) {
    console.warn('前回の作業を読み込めませんでした', error);
    return;
  }
  if (!state?.doc) {
    // 作業の記録がないのに中身だけ残っていたら（保存の途中で閉じた場合など）、消しておく
    for (const key of await store.keys().catch(() => [])) await store.delete(key);
    return;
  }
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
  if (['none', ...Object.keys(COMPRESS_LEVELS)].includes(state.compress)) els.compress.value = state.compress;
  easyStep = ['capture', 'confirm', 'save'].includes(state.step) ? state.step : 'confirm';
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
    const before = doc;
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
      setStep('confirm');
    }
    if (errors.length > 0) toast(errors.join('\n'), 'error');
    else notifyAutoCorrected(autoCorrectedIds(before, next));
  });
}

async function addFile(current, file) {
  if (isPdf(file)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { pageCount, formFieldCount } = await inspectPdf(bytes);
    const source = { kind: 'pdf', name: file.name, mimeType: 'application/pdf', byteLength: file.size, pageCount, formFieldCount };
    return addSourceWithBlob(current, source, file);
  }
  if (isImage(file)) {
    const image = await loadImageFile(file);
    // かんたんモードで書類の写真を取り込んだときは、書類モードも付ける（設定がオンのとき）
    if (image.corners && mode === 'easy' && loadDocumentMode()) image.filter = 'document';
    return addImage(current, image, file.name);
  }
  throw new Error('対応していないファイルです（PDFか画像を選んでください）');
}

/**
 * 写真をページに加える。書類の四隅が見つかっていれば、4点補正を自動でかける。
 * image.filter があれば、その色補正（書類モード）も付ける。
 */
async function addImage(current, image, name) {
  const source = {
    kind: 'image',
    name,
    mimeType: image.blob.type,
    byteLength: image.blob.size,
    width: image.width,
    height: image.height,
  };
  let next = await addSourceWithBlob(current, source, image.blob);
  const pageId = next.pages[next.pages.length - 1].id;
  if (image.corners) next = setPerspective(next, pageId, { corners: image.corners, aspect: 'free' });
  if (image.filter && image.filter !== 'none') next = setFilter(next, [pageId], image.filter);
  return next;
}

/** 新しく加わったページのうち、自動で補正したもののID */
function autoCorrectedIds(before, after) {
  const old = new Set(before.pages.map((p) => p.id));
  return after.pages.filter((p) => !old.has(p.id) && p.perspective).map((p) => p.id);
}

/** 自動で補正したことを知らせ、「補正を外す」で元の写真に戻せるようにする */
function notifyAutoCorrected(ids) {
  if (ids.length === 0) return;
  toast(ids.length > 1 ? `${ids.length}枚を自動で補正しました` : '自動で補正しました', 'info', {
    duration: 6000,
    action: {
      label: '補正を外す',
      run: () => {
        let next = doc;
        for (const id of ids) {
          if (next.pages.some((p) => p.id === id)) next = setPerspective(next, id, null);
        }
        update(next);
      },
    },
  });
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

let cameraAutoIds = []; // カメラで撮って、自動で補正したページ（カメラを閉じたときに知らせる）

const camera = createCameraView({
  // 撮った写真をページに加え、そのページのIDを返す（「最後の1枚を取り消す」で使う）
  onCapture: (frame, number) =>
    serial(async () => {
      const name = `撮影_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}_${String(number).padStart(2, '0')}.jpg`;
      const next = await addImage(doc, frame, name);
      easyStep = 'confirm';
      update(next);
      const pageId = next.pages[next.pages.length - 1].id;
      if (frame.corners) cameraAutoIds.push(pageId);
      return pageId;
    }),
  onUndo: (pageId) =>
    serial(async () => {
      if (doc.pages.some((p) => p.id === pageId)) update(removePages(doc, [pageId]));
      cameraAutoIds = cameraAutoIds.filter((id) => id !== pageId);
    }),
  onDone: () => {
    setStep(doc.pages.length > 0 ? 'confirm' : 'capture');
    saveStateNow();
    notifyAutoCorrected(cameraAutoIds.filter((id) => doc.pages.some((p) => p.id === id)));
    cameraAutoIds = [];
  },
  onUseOsCamera: () => els.inputCamera.click(),
  onBusy: (text) => (text ? showBusy(text) : hideBusy()),
});

// ---- 4点補正 ----

const editor = createPerspectiveEditor({
  getBlob: (page) => store.get(page.content.sourceId),
  onApply: (pageId, perspective, filter) => {
    if (!doc.pages.some((p) => p.id === pageId)) return;
    update(setFilter(setPerspective(doc, pageId, perspective), [pageId], filter));
    toast(perspective ? '補正しました' : '補正を外しました');
  },
});

function openEditor(pageId) {
  const page = doc.pages.find((p) => p.id === pageId);
  if (page?.content.type === 'image') editor.open(page);
}

/**
 * 選んだ写真のページの書類モードを切り替える。
 * すべて書類モードならすべて外し、そうでなければすべて書類モードにする。
 */
function toggleDocumentMode(ids) {
  const targets = doc.pages.filter((p) => ids.includes(p.id) && p.content.type === 'image');
  if (targets.length === 0) {
    toast('書類モードは、写真のページだけに使えます');
    return;
  }
  const on = !targets.every((p) => p.filter === 'document');
  update(setFilter(doc, targets.map((p) => p.id), on ? 'document' : 'none'));
  toast(on ? `${targets.length}ページを書類モードにしました` : `${targets.length}ページの書類モードを外しました`);
}

// ---- 書き出し ----

/** 書き出すファイル名の元（拡張子なし） */
function baseFileName() {
  return stripExtension(sanitizeFileName(els.fileName.value || els.fileName.placeholder));
}

/**
 * ページリスト（またはその一部）をPDFにする。写真のページは用紙・画質の設定に合わせる。
 * @param {(text: string) => void} [progress] 進み具合の表示
 */
async function buildPdf(target, title, progress = showBusy) {
  const imageTotal = target.pages.filter((p) => p.content.type === 'image').length;
  let imageDone = 0;
  progress('PDFを作成中…');
  // PDFの圧縮（詳細モードだけ）。読み込んだPDFの中の大きな画像を縮小し直す
  const level = mode === 'detail' ? els.compress.value : 'none';
  const hasPdf = target.pages.some((p) => p.content.type === 'pdf');
  const compress =
    level !== 'none' && hasPdf
      ? {
          level,
          recompressJpeg: (input) => {
            progress('PDFの中の画像を圧縮中…');
            return recompressJpeg(input);
          },
          onResult: (result) => (lastCompression = result),
        }
      : undefined;
  lastCompression = null;
  return exportPdf(target, {
    ...exportOptions(() => {
      imageDone += 1;
      progress(`PDFを作成中… ${imageDone} / ${imageTotal}`);
    }),
    title,
    compress,
  });
}

/** 最後に作ったPDFで、圧縮した画像の数と大きさ（お知らせに使う） */
let lastCompression = null;

/** 圧縮した結果の説明（圧縮しなかったときは空） */
function compressionSummary() {
  if (!lastCompression) return '';
  if (lastCompression.count === 0) return '・圧縮できる画像はありませんでした';
  return `・画像${lastCompression.count}枚を圧縮（${formatBytes(lastCompression.before)}→${formatBytes(lastCompression.after)}）`;
}

/** 書き出しの設定（用紙・画質）と、中身の取り出し方 */
function exportOptions(onImage = () => {}) {
  const paper = els.paper.value;
  const quality = els.quality.value;
  return {
    paper,
    getSourceBytes: (sourceId) => store.bytes(sourceId),
    getImage: async (page) => {
      onImage();
      return prepareImageForExport(await store.get(page.content.sourceId), {
        quality,
        paper,
        perspective: page.perspective,
        filter: page.filter,
      });
    },
    getFont: loadMarkFont,
    getAnnotationImage: async (sourceId) => ({
      bytes: await store.bytes(sourceId),
      format: doc.sources[sourceId]?.mimeType === 'image/jpeg' ? 'jpeg' : 'png',
    }),
  };
}

// ---- 注釈・署名 ----

// 署名・印鑑の画像は、注釈を「完了」したときにページリストに登録する（それまでは端末に保存だけしておく）
const pendingAssets = new Map(); // sourceId → { width, height, byteLength }
const assetUrls = new Map(); // sourceId → 表示用URL

async function assetUrl(sourceId) {
  if (!assetUrls.has(sourceId)) assetUrls.set(sourceId, URL.createObjectURL(await store.get(sourceId)));
  return assetUrls.get(sourceId);
}

const signatureDialog = createSignatureDialog({
  getRecent: () => {
    const assets = Object.values(doc.sources)
      .filter((s) => s.asset)
      .map((s) => ({ sourceId: s.id, width: s.width, height: s.height }));
    for (const [sourceId, info] of pendingAssets) assets.push({ sourceId, width: info.width, height: info.height });
    return assets.map((a) => ({ ...a, url: assetUrls.get(a.sourceId) ?? '' })).filter((a) => a.url);
  },
  createAsset: async (blob, width, height) => {
    const sourceId = newId('src');
    await store.put(sourceId, blob);
    pendingAssets.set(sourceId, { width, height, byteLength: blob.size });
    assetUrls.set(sourceId, URL.createObjectURL(blob));
    return sourceId;
  },
});

const annotator = createAnnotator({
  renderPage: (page) => renderPageImage(page, store, { maxSide: 1600, format: 'jpeg' }),
  getImageUrl: assetUrl,
  pickImage: () => signatureDialog.open(),
  onApply: (pageId, annotations) => {
    if (!doc.pages.some((p) => p.id === pageId)) return;
    let next = doc;
    for (const a of annotations) {
      if (a.type !== 'image' || next.sources[a.sourceId]) continue;
      const info = pendingAssets.get(a.sourceId);
      if (!info) continue;
      next = addSource(next, { id: a.sourceId, kind: 'image', asset: true, name: '署名・印鑑', mimeType: 'image/png', ...info });
      pendingAssets.delete(a.sourceId);
    }
    update(setAnnotations(next, pageId, annotations));
    toast(annotations.length ? `注釈を保存しました（${annotations.length}個）` : '注釈を外しました');
  },
});

/** 選んでいるページ（なければ1ページ目）の注釈を開く */
function openAnnotator() {
  const id = selectedIds()[0] ?? doc.pages[0]?.id;
  const page = doc.pages.find((p) => p.id === id);
  if (page) annotator.open(page);
}

// ---- 書き込み（ページ番号・ヘッダー/フッター・透かし・スタンプ） ----

let markPreviewCount = 0;
const marksDialog = createMarksDialog({
  getDoc: () => doc,
  onApply: (marks) => {
    update(setMarks(doc, marks));
    toast(marks ? `書き込みを設定しました（${describeMarks(marks).join('・')}）` : '書き込みを外しました');
  },
  // 見本：1ページだけPDFにして、画像にする（表紙を数えないときは2ページ目）
  renderPreview: async (marks) => {
    const index = marks.pageNumber.enabled && marks.pageNumber.skipFirst && doc.pages.length > 1 ? 1 : 0;
    const blob = await renderAsExported(doc.pages[index], 900, marks);
    return { url: URL.createObjectURL(blob), pageNumber: index + 1 };
  },
});

/**
 * 1ページだけ実際にPDFにして、画像にする（書き出したときと同じ見た目の見本）。
 * 書き込み・注釈・フォーム入力も入る。
 */
async function renderAsExported(page, maxSide, marks = doc.marks) {
  const index = doc.pages.indexOf(page);
  const one = { ...extractPages(doc, [page.id]), marks };
  const bytes = await exportPdf(one, { ...exportOptions(), markNumbering: { offset: index, total: doc.pages.length } });
  const id = `exact-preview-${++markPreviewCount}`;
  try {
    return await renderPdfPage(id, async () => bytes, 0, { maxSide });
  } finally {
    closePdf(id);
  }
}

// ---- フォーム入力 ----

const formsDialog = createFormsDialog({
  getDoc: () => doc,
  getBytes: (sourceId) => store.bytes(sourceId),
  onApply: (sourceId, values) => {
    if (!doc.sources[sourceId]) return;
    update(setFormValues(doc, sourceId, values));
    const n = Object.keys(values).length;
    toast(n > 0 ? `フォームの入力を保存しました（${n}か所）。PDFを作成するときに書き込みます` : 'フォームの入力を外しました');
  },
  onError: (error) => {
    console.error(error);
    toast(`入力欄を読み取れませんでした：${error.message}`, 'error');
  },
});

async function createPdf() {
  if (doc.pages.length === 0) return;
  const fileName = sanitizeFileName(els.fileName.value || els.fileName.placeholder);
  try {
    const bytes = await buildPdf(doc, stripExtension(fileName));
    deliver(new Blob([bytes], { type: 'application/pdf' }), fileName, {
      title: 'PDFができました',
      summary: `${doc.pages.length}ページ${compressionSummary()}`,
    });
  } catch (error) {
    console.error(error);
    toast(`PDFを作成できませんでした：${error.message}`, 'error');
  } finally {
    hideBusy();
  }
}

/**
 * できたファイルを渡す。どちらのモードも、すぐにダウンロードする（送る機能は、必要になったら追加する）。
 * かんたんモード：終わったら「保存しました」の画面を出し、「新しく作る」などを選べるようにする
 * 詳細モード：お知らせだけ出して、そのまま作業を続けられるようにする
 */
function deliver(blob, fileName, { summary }) {
  lastExport = { blob, fileName };
  downloadBlob(blob, fileName);
  const message = `「${fileName}」をダウンロードしました（${summary}・${formatBytes(blob.size)}）`;
  if (mode === 'detail') toast(message, 'info', { duration: 4000 });
  else showDone('保存しました', message);
}

/** 保存が終わったことを、ダイアログで知らせる */
function showDone(title, message) {
  els.doneTitle.textContent = title;
  els.doneMeta.textContent = message;
  if (!els.resultDialog.open) els.resultDialog.showModal();
  els.doneTitle.focus();
}

function downloadAgain() {
  if (!lastExport) return;
  downloadBlob(lastExport.blob, lastExport.fileName);
  toast(`「${lastExport.fileName}」をもう一度ダウンロードしました`);
}

// ---- 最初からやり直す（数秒間は元に戻せる） ----

let undoState = null; // { doc, fileName, step, timer }

/**
 * ページリストを置き換え、数秒間「元に戻す」を出す（削除・最初からやり直す）。
 * 端末に保存した写真などの中身は、元に戻せる時間が過ぎてから消す。
 */
function replaceWithUndo(next, message, { step, fileName } = {}) {
  finalizeUndo();
  undoState = { doc, fileName: els.fileName.value, step: easyStep, timer: setTimeout(finalizeUndo, UNDO_DURATION) };
  doc = pruneSources(next).doc;
  if (fileName !== undefined) els.fileName.value = fileName;
  setStep(step ?? easyStep);
  saveStateNow();
  toast(message, 'info', { action: { label: '元に戻す', run: undoLast }, duration: UNDO_DURATION });
}

function restart(message = 'すべて削除しました') {
  if (els.resultDialog.open) els.resultDialog.close();
  if (doc.pages.length === 0) {
    finalizeUndo();
    setStep('capture');
    return;
  }
  selected.clear();
  replaceWithUndo(createDocument(), message, { step: 'capture', fileName: '' });
}

/** ページを削除する（数秒間は元に戻せる） */
function deletePages(pageIds) {
  if (pageIds.length === 0) return;
  for (const id of pageIds) selected.delete(id);
  replaceWithUndo(removePages(doc, pageIds), `${pageIds.length}ページを削除しました`);
}

function undoLast() {
  if (!undoState) return;
  clearTimeout(undoState.timer);
  const { doc: previous, fileName, step } = undoState;
  undoState = null;
  doc = previous;
  els.fileName.value = fileName;
  setStep(step);
  saveStateNow();
  toast('元に戻しました');
}

function finalizeUndo() {
  if (!undoState) return;
  clearTimeout(undoState.timer);
  const previous = undoState.doc;
  undoState = null;
  for (const sourceId of Object.keys(previous.sources)) {
    if (!doc.sources[sourceId]) forgetSource(sourceId);
  }
}

// ---- 描画 ----

/** 今のかんたんモードの段階（ページが0枚なら、いつも①） */
function currentStep() {
  if (doc.pages.length === 0) return 'capture';
  return easyStep;
}

/** 段階を移る（履歴の並びは render の中で整える） */
function setStep(step) {
  const before = currentStep();
  easyStep = step;
  render();
  if (currentStep() !== before) scrollTo({ top: 0 });
}

function render() {
  const count = doc.pages.length;
  const easy = mode === 'easy';
  const step = currentStep();
  document.body.dataset.step = step;

  els.empty.hidden = easy ? step !== 'capture' : count > 0;
  els.workspace.hidden = count === 0 || (easy && step !== 'confirm');
  els.nextBar.hidden = !(easy && count > 0);
  els.exportBar.hidden = count === 0 || (easy && step !== 'save');
  els.count.textContent = `${count}ページ`;
  // ③はボタンの文字が長いので、ページ数は出さない（保存の画面に出ている）
  els.nextCount.textContent = step === 'save' ? '' : `（${count}ページ）`;
  // 画面下のボタン（親指で押しやすい場所）：①「確認へ進む」、②「保存へ進む」、③「PDFを作成（ダウンロードします）」
  const next = { capture: ['確認へ進む', 'go-confirm'], confirm: ['保存へ進む', 'go-save'], save: ['PDFを作成（ダウンロードします）', 'export'] }[step];
  els.nextLabel.textContent = next[0];
  els.nextButton.dataset.action = easy ? next[1] : '';
  // ①に戻ってきたとき（ページがあるとき）は、追加で撮れることと、やり直せることを伝える
  els.emptyTitleEasy.textContent = count > 0 ? '写真を追加する' : '写真をPDFに';
  els.emptyLeadEasy.hidden = count > 0;
  els.captureMore.hidden = count === 0;
  els.captureRestart.hidden = count === 0;
  els.captureCount.textContent = String(count);
  els.saveSummary.textContent = `${count}ページをPDFにします`;
  if (!els.fileName.value) els.fileName.placeholder = suggestedFileName();

  for (const item of els.steps.querySelectorAll('[data-step]')) {
    if (item.dataset.step === step) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
    // ページがないときは、②③には進めない
    item.disabled = count === 0 && item.dataset.step !== 'capture';
  }

  // 選んでいるページ（詳細モード）：なくなったページは外す
  for (const id of selected) if (!doc.pages.some((p) => p.id === id)) selected.delete(id);
  renderSelectionBar(count);
  els.mergeHint.hidden = !Object.values(doc.sources).some((source) => source.kind === 'pdf');
  const marks = describeMarks(doc.marks);
  els.marksStatus.hidden = marks.length === 0;
  els.marksStatus.textContent = `書き込み：${marks.join('・')}（PDFを作成するときに、すべてのページに書き込みます）`;
  const filled = Object.values(doc.forms ?? {}).reduce((n, values) => n + Object.keys(values).length, 0);
  els.formsStatus.hidden = filled === 0;
  els.formsStatus.textContent = `フォーム入力：${filled}か所（PDFを作成するときに書き込み、入力欄は固定されます）`;
  // 隠さずに押せなくする（ボタンの位置を変えないため）
  els.openForms.disabled = !formsDialog.hasForms();
  els.openForms.title = els.openForms.disabled ? '入力欄（フォーム）のあるPDFを読み込むと使えます' : 'PDFの入力欄に文字を入れる';

  const cards = doc.pages.map((page, index) => renderCard(page, index, count));
  els.grid.replaceChildren(...cards);
  placeVersion();
  // スマホの「戻る」で、いつも ③→②→① の順に戻れるよう、履歴の並びを今の段階に合わせる
  if (historyReady && easy) stepHistory.sync(step);
}

let historyReady = false;

/** バージョン表示が下のバー（保存へ進む・書き出し）に隠れないよう、バーの高さだけ上げる */
function placeVersion() {
  const bar = [els.nextBar, els.exportBar].find((el) => !el.hidden && el.offsetHeight > 0 && getComputedStyle(el).position !== 'static');
  document.body.classList.toggle('has-bottom-bar', Boolean(bar));
  document.documentElement.style.setProperty('--bottom-bar', `${bar ? bar.offsetHeight : 0}px`);
}

function renderSelectionBar(count) {
  const n = selected.size;
  els.selectionCount.textContent =
    n === 0 ? 'クリックで選択・解除（囲んでまとめて選択）、ダブルクリックで拡大' : `${n} / ${count} ページを選択中`;
  els.selectAllButton.textContent = n === count && count > 0 ? '選択を解除' : 'すべて選択';
  for (const button of document.querySelectorAll('[data-needs-selection]')) button.disabled = n === 0;
}

/**
 * 選択の見た目だけを更新する（ページの一覧は描き直さない）。
 * 描き直すとダブルクリックが届かなくなるため、選ぶ操作ではこちらを使う。
 */
function refreshSelection() {
  for (const card of els.grid.querySelectorAll('.page-card')) {
    const on = mode === 'detail' && selected.has(card.dataset.id);
    card.classList.toggle('selected', on);
    card.setAttribute('aria-selected', String(on));
    card.querySelector('.select-box')?.setAttribute('aria-pressed', String(on));
  }
  renderSelectionBar(doc.pages.length);
}

/** 選んでいるページのID（並び順） */
function selectedIds() {
  return doc.pages.filter((p) => selected.has(p.id)).map((p) => p.id);
}

/**
 * クリックでページを選ぶ（詳細モード）。押すたびに選ぶ・外すが切り替わる。
 * Shift を押しながらだと、前に押したページからそのページまでをまとめて選ぶ。
 */
function selectByClick(pageId, { shift = false } = {}) {
  const ids = doc.pages.map((p) => p.id);
  if (shift && selectionAnchor && ids.includes(selectionAnchor)) {
    const [a, b] = [ids.indexOf(selectionAnchor), ids.indexOf(pageId)].sort((x, y) => x - y);
    for (const id of ids.slice(a, b + 1)) selected.add(id);
  } else {
    if (selected.has(pageId)) selected.delete(pageId);
    else selected.add(pageId);
    selectionAnchor = pageId;
  }
  refreshSelection();
}

function selectAllToggle() {
  selected = selected.size === doc.pages.length ? new Set() : new Set(doc.pages.map((p) => p.id));
  refreshSelection();
}

function suggestedFileName() {
  const sources = Object.values(doc.sources).filter((source) => !source.asset); // 署名・印鑑の画像は数えない
  if (sources.length === 1 && sources[0].kind === 'pdf') return stripExtension(sources[0].name);
  return stripExtension(defaultFileName());
}

function renderCard(page, index, count) {
  const li = document.createElement('li');
  li.className = 'page-card';
  li.dataset.id = page.id;
  const isSelected = mode === 'detail' && selected.has(page.id);
  li.classList.toggle('selected', isSelected);
  li.setAttribute('aria-selected', String(isSelected));

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
    // かんたんモードでは、写真をタップすると4点補正（詳細モードでは、クリックで選択・ダブルクリックで拡大）
    if (content.type === 'image' && mode === 'easy') {
      thumb.classList.add('clickable');
      thumb.dataset.op = 'perspective';
      thumb.title = 'タップして4点補正';
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

  // 印：4点補正をしたページ、注釈のあるページ
  const badges = [page.perspective ? '補正済み' : '', page.annotations?.length ? `注釈${page.annotations.length}` : ''].filter(Boolean);
  if (badges.length) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = badges.join('・');
    thumb.append(badge);
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

  // 詳細モード：タッチ操作でも選べるよう、選択の丸を置く
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'select-box detail-only';
  check.dataset.op = 'select';
  check.setAttribute('aria-label', `${index + 1}ページ目を選ぶ`);
  check.setAttribute('aria-pressed', String(isSelected));
  check.innerHTML = ICONS.check;
  thumb.append(check);

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
  const { content, perspective, filter } = page;
  // 4点補正や書類モードが変われば、別のサムネイルとして作り直す
  const key = `${content.sourceId}:${content.pageIndex}:${perspective ? JSON.stringify(perspective) : ''}:${content.type === 'image' ? filter : ''}`;
  if (!thumbnails.has(key)) {
    const task = thumbnailQueue.then(async () => {
      if (!doc.sources[content.sourceId]) throw new Error('削除済みのページです');
      return content.type === 'pdf'
        ? pdfThumbnailUrl(content.sourceId, () => store.bytes(content.sourceId), content.pageIndex, THUMB_SIZE)
        : imageThumbnailUrl(await store.get(content.sourceId), THUMB_SIZE, { perspective, filter });
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
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  grip: svg('<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>'),
};

// ---- お知らせ・処理中の表示 ----

let toastTimer = 0;
let toastActionRun = null;
/**
 * 画面の下にお知らせを出す。
 * @param {string} message
 * @param {'info'|'error'} [kind]
 * @param {{ action?: { label: string, run: () => void }, duration?: number }} [options] ボタン付きにするとき
 */
function toast(message, kind = 'info', { action, duration } = {}) {
  els.toastText.textContent = message;
  toastActionRun = action?.run ?? null;
  els.toastAction.hidden = !action;
  if (action) els.toastAction.textContent = action.label;
  els.toast.classList.toggle('error', kind === 'error');
  els.toast.classList.toggle('has-action', Boolean(action));
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration ?? (kind === 'error' ? 6000 : 2500));
}

function hideToast() {
  els.toast.classList.remove('show', 'has-action');
  toastActionRun = null;
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
  setStep(step);
  saveStateSoon();
}

// ---- 詳細モードの道具・プレビュー ----

const tools = createToolsDialog({
  getDoc: () => doc,
  getSelectedIndexes: () => doc.pages.map((p, i) => (selected.has(p.id) ? i : -1)).filter((i) => i >= 0),
  getBaseName: baseFileName,
  buildPdf,
  renderImage: (page, options) => renderPageImage(page, store, options),
  deliver,
  busy: (text) => (text ? showBusy(text) : hideBusy()),
  onError: (message) => toast(message, 'error'),
});

const preview = createPreview({
  getDoc: () => doc,
  // 書き込み・注釈・フォーム入力があるときは、書き出したときと同じ見た目にする
  renderPreview: (page, maxSide) =>
    page.annotations?.length || hasMarks(doc.marks) || (page.content.type === 'pdf' && doc.forms?.[page.content.sourceId])
      ? renderAsExported(page, maxSide)
      : renderPageImage(page, store, { maxSide, format: 'jpeg' }),
});

/** スマホの「戻る」で閉じられる画面（カメラ・補正画面・ダイアログ）が開いていれば閉じる */
function closeOverlay() {
  if (editor.isOpen()) {
    editor.close();
    return true;
  }
  if (signatureDialog.isOpen()) {
    document.querySelector('#signature-dialog').close();
    return true;
  }
  if (annotator.isOpen()) {
    annotator.close();
    return true;
  }
  if (camera.isOpen()) {
    camera.finish();
    return true;
  }
  for (const dialog of document.querySelectorAll('dialog[open]')) {
    if (dialog.open) {
      dialog.close();
      return true;
    }
  }
  return false;
}

const stepHistory = createStepHistory({
  onNavigate: (step) => {
    setStep(step);
    saveStateSoon();
  },
  closeOverlay,
});

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
    case 'restart':
      restart();
      break;
    case 'go-confirm':
      goToStep('confirm');
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
    case 'download-again':
      downloadAgain();
      break;
    case 'close-result':
      els.resultDialog.close();
      break;
    case 'new-document':
      restart('新しく作り始めます');
      break;
    case 'select-all':
      selectAllToggle();
      break;
    case 'rotate-selected':
      if (selected.size > 0) update(rotatePages(doc, selectedIds(), 90));
      break;
    case 'delete-selected':
      deletePages(selectedIds());
      break;
    case 'open-annotator':
      openAnnotator();
      break;
    case 'open-forms':
      formsDialog.open();
      break;
    case 'open-marks':
      marksDialog.open();
      break;
    case 'document-selected':
      toggleDocumentMode(selectedIds());
      break;
    case 'open-extract':
      tools.open('extract');
      break;
    case 'open-split':
      tools.open('split');
      break;
    case 'open-images':
      tools.open('images');
      break;
    case 'apply-update':
      applyUpdate();
      break;
    case 'install':
      startInstall();
      break;
    case 'close-install':
      els.installDialog.close();
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
      deletePages([pageId]);
      break;
    case 'select':
      selectByClick(pageId);
      return;
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
  // 手順（①②③）のボタン。body にも data-step があるので、#steps の中だけを見る
  const stepTarget = event.target.closest('#steps [data-step]');
  if (stepTarget) {
    if (!stepTarget.disabled) goToStep(stepTarget.dataset.step);
    return;
  }
  if (event.target.closest('#toast-action')) {
    const run = toastActionRun;
    hideToast();
    run?.();
    return;
  }
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

// 選んだページのうちの1枚をドラッグしたときは、選んだページをまとめて動かす
enableDragReorder(els.grid, (pageId, insertBefore) => {
  const ids = mode === 'detail' && selected.has(pageId) && selected.size > 1 ? selectedIds() : [pageId];
  update(movePagesBefore(doc, ids, insertBefore));
  // 動かしたことがはっきり分かるよう、移動したページを光らせて、何番目になったかを知らせる
  const position = doc.pages.findIndex((p) => ids.includes(p.id)) + 1;
  for (const id of ids) els.grid.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add('just-moved');
  toast(ids.length > 1 ? `${ids.length}ページを${position}番目に移動しました` : `${position}番目に移動しました`);
});

// 詳細モード：ページのクリックで選ぶ、ダブルクリックで大きく見る
els.grid.addEventListener('click', (event) => {
  if (mode !== 'detail' || event.target.closest('button')) return;
  const card = event.target.closest('.page-card');
  if (card) selectByClick(card.dataset.id, { shift: event.shiftKey });
});
// 詳細モード：ページのない所からマウスでドラッグすると、青い四角に入ったページをまとめて選ぶ
enableMarqueeSelect(document.body, {
  enabled: () => mode === 'detail' && doc.pages.length > 0 && !els.workspace.hidden && !editor.isOpen() && !camera.isOpen() && !annotator.isOpen(),
  cards: () => [...els.grid.querySelectorAll('.page-card')],
  onSelect: (ids, { add }) => {
    selected = new Set(add ? [...selected, ...ids] : ids);
    refreshSelection();
  },
});
els.grid.addEventListener('dblclick', (event) => {
  if (mode !== 'detail' || event.target.closest('button')) return;
  const card = event.target.closest('.page-card');
  if (card) preview.open(card.dataset.id);
});
// ページ以外の場所をクリックしたら、選択を外す
els.workspace.addEventListener('click', (event) => {
  if (mode === 'detail' && selected.size > 0 && !event.target.closest('.page-card, button, input, select, label')) {
    selected.clear();
    refreshSelection();
  }
});

// 詳細モードのキーボード操作：Ctrl/⌘+A すべて選択、Delete 削除、Esc 選択を外す、Ctrl/⌘+Z 元に戻す
document.addEventListener('keydown', (event) => {
  if (mode !== 'detail' || document.querySelector('dialog[open]') || camera.isOpen() || editor.isOpen() || annotator.isOpen()) return;
  if (event.target.closest?.('input, select, textarea')) return;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 'a' && doc.pages.length > 0) {
    event.preventDefault();
    selected = new Set(doc.pages.map((p) => p.id));
    refreshSelection();
  } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected.size > 0) {
    event.preventDefault();
    deletePages(selectedIds());
  } else if (event.key === 'Escape' && selected.size > 0) {
    selected.clear();
    refreshSelection();
  } else if (mod && event.key.toLowerCase() === 'z' && undoState) {
    event.preventDefault();
    hideToast();
    undoLast();
  }
});

for (const input of [els.inputPhotos, els.inputCamera, els.inputFiles]) {
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = ''; // 同じファイルをもう一度選べるようにする
    addFiles(files);
  });
}

for (const input of [els.fileName, els.paper, els.quality, els.compress]) {
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
  if (!document.hidden) return;
  saveStateNow();
  // ほかのアプリに切り替えている間に、待っている更新を当てておく（戻ったときには新しいバージョン）
  if (updater.ready && canReloadNow()) applyUpdate();
});
window.addEventListener('pagehide', () => saveStateNow());

// ---- 自動アップデート ----

const UPDATED_KEY = 'relapdf:updated';

/** 今すぐ読み込み直しても、作業のじゃまにならないか（カメラ・補正画面・ダイアログ・処理中でない） */
function canReloadNow() {
  return (
    !camera.isOpen() &&
    !editor.isOpen() &&
    !annotator.isOpen() &&
    !document.querySelector('dialog[open]') &&
    els.busy.hidden
  );
}

const updater = setupUpdater({
  onReady: () => {
    // 作業中でなければすぐに、作業中なら案内を出して、切り替えるタイミングを選んでもらう
    if (canReloadNow() && (doc.pages.length === 0 || document.hidden)) applyUpdate();
    else els.updateBanner.hidden = false;
  },
  beforeReload: async () => {
    await saveStateNow();
    try {
      sessionStorage.setItem(UPDATED_KEY, '1');
    } catch {
      // 保存できなくても更新はできる
    }
  },
});

function applyUpdate() {
  els.updateBanner.hidden = true;
  showBusy('新しいバージョンに更新中…');
  updater.apply();
}

/** 更新で読み込み直した直後か（一度だけ true） */
function justUpdated() {
  try {
    const flag = sessionStorage.getItem(UPDATED_KEY);
    sessionStorage.removeItem(UPDATED_KEY);
    return flag === '1';
  } catch {
    return false;
  }
}

// ---- ホーム画面への追加 ----

const install = setupInstall(showInstallButtons);

function showInstallButtons(method) {
  for (const button of els.installButtons) button.hidden = !(method === 'prompt' || method === 'ios');
}

async function startInstall() {
  if (install.method === 'prompt') {
    const outcome = await install.prompt();
    if (outcome === 'accepted') toast('ホーム画面に追加しました');
  } else {
    els.installDialog.showModal();
  }
}

// ---- 起動 ----

els.version.textContent = `RelaPDF v${APP_VERSION}`;
window.addEventListener('resize', placeVersion);

await restoreState();
stepHistory.seed(currentStep());
historyReady = true;
applyMode(mode);
showInstallButtons(install.method);

if (justUpdated()) toast(`最新版（v${APP_VERSION}）に更新しました`);
else if (doc.pages.length > 0) toast('前回の続きから再開しました');

// 画面テストから状態を確かめるための入り口（アプリの動作には使わない）
window.__relapdf = { getDoc: () => doc, flushSave: () => saveStateNow(), checkForUpdate: () => updater.check() };
