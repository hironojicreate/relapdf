// 文字認識（OCR）（ブラウザ側）
//
// Tesseract.js（Apache 2.0）で、ページの画像から日本語の文字を読み取る。読み取りは別のスレッド（Worker）で行う。
// 部品（約8MB）は初めて使うときに読み込み、Service Worker が別のキャッシュに入れる（以後はオフラインでも使える）。

const BASE = new URL('../../vendor/tesseract/', import.meta.url);

let workerPromise = null;
let onLog = null;

/** WebAssembly の速い命令（SIMD）が使えるか。使えれば速い方の部品を読み込む */
function supportsSimd() {
  try {
    // wasm-feature-detect（Apache 2.0）の SIMD の判定と同じ小さなモジュール
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
    );
  } catch {
    return false;
  }
}

function getWorker() {
  workerPromise ??= (async () => {
    const { default: Tesseract } = await import(new URL('tesseract.esm.min.js', BASE).href);
    return Tesseract.createWorker('jpn', 1, {
      workerPath: new URL('worker.min.js', BASE).href,
      corePath: new URL(`core/tesseract-core-${supportsSimd() ? 'simd-' : ''}lstm.wasm.js`, BASE).href,
      langPath: new URL('lang', BASE).href,
      gzip: true,
      cacheMethod: 'none', // Service Worker のキャッシュを使うので、Tesseract.js の保存はしない
      workerBlobURL: false,
      logger: (message) => onLog?.(message),
    });
  })().catch((error) => {
    workerPromise = null; // 次にもう一度試せるように
    throw error;
  });
  return workerPromise;
}

/**
 * 読み取った文字の、余計な空白を取る。Tesseract は日本語を1文字ずつ空白で区切ることがあるため。
 * - 日本語の文字どうしの間、日本語と数字の間の空白
 * - 「12, 000」のような、数字の区切りの後ろの空白
 * 英単語の間の空白は残す。
 */
export function tidyText(text) {
  const cjk = '\\u3000-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
  return text
    .replace(/\s+/g, ' ')
    .replace(new RegExp(`(?<=[${cjk}]) (?=[${cjk}0-9])`, 'g'), '')
    .replace(new RegExp(`(?<=[0-9]) (?=[${cjk}])`, 'g'), '')
    .replace(/(?<=[0-9][,.]) (?=[0-9])/g, '')
    .trim();
}

/**
 * 画像から、行ごとの文字と位置を読み取る。
 * @param {Blob} image ページの画像
 * @param {(progress: number) => void} [onProgress] 読み取りの進み具合（0〜1）
 * @returns {Promise<Array<{text: string, x: number, y: number, w: number, h: number}>>} 位置は画像に対する0〜1の割合（左上が原点）
 */
export async function recognizeLines(image, onProgress) {
  const bitmap = await createImageBitmap(image);
  const { width, height } = bitmap;
  bitmap.close();
  const worker = await getWorker();
  onLog = (message) => {
    if (message.status === 'recognizing text') onProgress?.(message.progress);
  };
  try {
    const { data } = await worker.recognize(image, {}, { blocks: true, text: false });
    const lines = [];
    for (const block of data.blocks ?? []) {
      for (const paragraph of block.paragraphs ?? []) {
        for (const line of paragraph.lines ?? []) {
          const text = tidyText(line.text ?? '');
          const { x0, y0, x1, y1 } = line.bbox;
          if (!text || x1 <= x0 || y1 <= y0) continue;
          lines.push({ text, x: x0 / width, y: y0 / height, w: (x1 - x0) / width, h: (y1 - y0) / height });
        }
      }
    }
    return lines;
  } finally {
    onLog = null;
  }
}
