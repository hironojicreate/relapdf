// ファイルの保存・共有（ブラウザ側）
//
// 共有シート（navigator.share）は、ボタンを押した直後でないと開けない（特にiPhone）。
// そのため、PDFを作り終えてから「保存」「送る」ボタンを出し、押されたときにすぐ呼ぶ。

/** この端末で、ファイルを共有シートから送れるか */
export function canShareFiles() {
  try {
    const probe = new File([new Uint8Array(1)], 'probe.pdf', { type: 'application/pdf' });
    return typeof navigator.share === 'function' && navigator.canShare?.({ files: [probe] }) === true;
  } catch {
    return false;
  }
}

/** ファイルをダウンロードとして保存する */
export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // すぐに消すとダウンロードが始まらないブラウザがあるので、少し待ってから消す
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * 共有シートでファイルを送る。
 * @returns {Promise<'shared'|'cancelled'>}
 */
export async function shareBlob(blob, fileName) {
  const file = new File([blob], fileName, { type: blob.type });
  try {
    await navigator.share({ files: [file] });
    return 'shared';
  } catch (error) {
    if (error?.name === 'AbortError') return 'cancelled';
    throw error;
  }
}
