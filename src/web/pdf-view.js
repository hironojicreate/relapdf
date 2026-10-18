// PDFの表示（ブラウザ側）
//
// PDF.js は大きいので、PDFを初めて開いたときに読み込む。
// 同梱の vendor/pdfjs/ の legacy 版を使う（iOS 17 など少し古いSafariでも動くようにするため）。

import { fitLongSide } from '../core/layout.js';

const PDFJS_BASE = new URL('../../vendor/pdfjs/', import.meta.url);

let pdfjsPromise = null;
const documents = new Map(); // sourceId → Promise<PDFDocumentProxy>

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(new URL('pdf.min.mjs', PDFJS_BASE).href).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', PDFJS_BASE).href;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/** PDFを開く（同じ元データは一度だけ開く） */
export function openPdf(sourceId, getBytes) {
  if (!documents.has(sourceId)) {
    const task = (async () => {
      const pdfjs = await loadPdfjs();
      // PDF.js はデータを作業用スレッドに渡すと元の配列が使えなくなるので、コピーを渡す
      const data = (await getBytes()).slice();
      return pdfjs.getDocument({
        data,
        cMapUrl: new URL('cmaps/', PDFJS_BASE).href,
        cMapPacked: true,
        standardFontDataUrl: new URL('standard_fonts/', PDFJS_BASE).href,
        wasmUrl: new URL('wasm/', PDFJS_BASE).href,
        iccUrl: new URL('iccs/', PDFJS_BASE).href,
        enableXfa: false,
      }).promise;
    })();
    task.catch(() => documents.delete(sourceId));
    documents.set(sourceId, task);
  }
  return documents.get(sourceId);
}

/** 開いたPDFを閉じて、メモリを解放する */
export async function closePdf(sourceId) {
  const task = documents.get(sourceId);
  documents.delete(sourceId);
  if (task) {
    try {
      await (await task).destroy();
    } catch {
      // 開くのに失敗していた場合は何もしない
    }
  }
}

/**
 * PDFの1ページを画像（Blob）にする。
 * @param {object} options
 * @param {number} [options.scale] 拡大率（1 = 72dpi）。maxSide を指定したときは、長辺がその大きさになるように決める
 * @param {number} [options.maxSide]
 * @param {number} [options.extraRotation] PDFにもともと付いている回転に足す回転（ユーザーの回転）
 * @param {string} [options.type] 'image/jpeg' | 'image/png'
 * @param {number} [options.quality] JPEGの画質
 */
export async function renderPdfPage(sourceId, getBytes, pageIndex, options = {}) {
  const { maxSide, extraRotation = 0, type = 'image/jpeg', quality = 0.9 } = options;
  const pdf = await openPdf(sourceId, getBytes);
  const page = await pdf.getPage(pageIndex + 1);
  try {
    const rotation = (((page.rotate + extraRotation) % 360) + 360) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const scale = maxSide ? fitLongSide(base.width, base.height, maxSide).width / base.width : (options.scale ?? 1);
    const viewport = page.getViewport({ scale, rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像を作れませんでした'))), type, quality),
    );
    canvas.width = 0;
    canvas.height = 0;
    return blob;
  } finally {
    page.cleanup();
  }
}

/**
 * PDFの1ページをサムネイルにして、表示用のURLを返す。
 * PDFにもともと付いている回転は反映する（ユーザーの回転は画面側で付ける）。
 */
export async function pdfThumbnailUrl(sourceId, getBytes, pageIndex, maxSide) {
  const blob = await renderPdfPage(sourceId, getBytes, pageIndex, { maxSide, quality: 0.8 });
  return URL.createObjectURL(blob);
}
