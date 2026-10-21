// 文字認識（OCR）の画面（UI層）
//
// 選んだページ（またはすべてのページ）の文字を読み取る。読み取った文字は、PDFを作成するときに
// 見えない文字としてページに重ねる（検索・コピーできるPDFになる）。読み取った文字はこの画面からもコピーできる。

/**
 * @param {object} deps
 * @param {() => object} deps.getDoc 今のページリスト
 * @param {() => string[]} deps.getSelectedIds 選んでいるページ
 * @param {(pageIds: string[]) => Promise<void>} deps.recognize 読み取る（終わったらページリストに保存されている）
 */
export function createOcrDialog({ getDoc, getSelectedIds, recognize }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $('#ocr-dialog');
  const form = $('#ocr-form');
  const setup = $('#ocr-setup');
  const result = $('#ocr-result');
  const output = $('#ocr-text');
  const selectedOption = form.querySelector('input[name="ocr-target"][value="selected"]');

  function open() {
    const selected = getSelectedIds().length;
    selectedOption.disabled = selected === 0;
    selectedOption.closest('label').querySelector('span').textContent = selected ? `選んだページ（${selected}ページ）` : '選んだページ（選んでいません）';
    form.querySelector(`input[name="ocr-target"][value="${selected ? 'selected' : 'all'}"]`).checked = true;
    setup.hidden = false;
    result.hidden = true;
    dialog.showModal();
  }

  /** 読み取った文字を、ページごとに並べて見せる */
  function showResult(pageIds) {
    const doc = getDoc();
    const parts = [];
    for (const id of pageIds) {
      const index = doc.pages.findIndex((p) => p.id === id);
      const page = doc.pages[index];
      if (!page) continue;
      parts.push(`【${index + 1}ページ】\n${(page.ocr?.lines ?? []).map((line) => line.text).join('\n') || '（文字が見つかりませんでした）'}`);
    }
    output.value = parts.join('\n\n');
    setup.hidden = true;
    result.hidden = false;
    if (!dialog.open) dialog.showModal();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const target = form.querySelector('input[name="ocr-target"]:checked').value;
    const ids = target === 'selected' ? getSelectedIds() : getDoc().pages.map((p) => p.id);
    if (ids.length === 0) return;
    dialog.close();
    const ok = await recognize(ids).then(
      () => true,
      () => false,
    );
    if (ok) showResult(ids);
  });
  form.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'ocr-cancel' || action === 'ocr-close') dialog.close();
    else if (action === 'ocr-copy') {
      try {
        await navigator.clipboard.writeText(output.value);
        event.target.closest('button').textContent = 'コピーしました';
      } catch {
        output.select(); // コピーできないときは選んでおく
      }
    }
  });

  return { open };
}
