// ページの大きなプレビュー（UI層）
//
// 詳細モードでページをダブルクリックすると開く。左右のボタンや矢印キーで前後のページへ。

const PREVIEW_SIZE = 1800; // プレビューの画像の長辺

/**
 * @param {object} deps
 * @param {() => object} deps.getDoc
 * @param {(page: object) => Promise<Blob>} deps.renderPreview ページを画像にする（回転や補正を反映したもの）
 */
export function createPreview({ getDoc, renderPreview }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $('#preview-dialog');
  const img = $('#preview-img');
  const label = $('#preview-label');
  let index = 0;
  let url = null;
  let token = 0;

  async function show(i) {
    const { pages } = getDoc();
    if (pages.length === 0) return;
    index = Math.min(pages.length - 1, Math.max(0, i));
    label.textContent = `${index + 1} / ${pages.length}`;
    $('#preview-prev').disabled = index === 0;
    $('#preview-next').disabled = index === pages.length - 1;
    dialog.classList.add('loading');
    const mine = ++token;
    try {
      const blob = await renderPreview(pages[index], PREVIEW_SIZE);
      if (mine !== token) return; // 次のページに移った
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob);
      img.src = url;
      img.alt = `${index + 1}ページ目`;
    } catch (error) {
      console.error(error);
    } finally {
      if (mine === token) dialog.classList.remove('loading');
    }
  }

  function open(pageId) {
    const i = getDoc().pages.findIndex((p) => p.id === pageId);
    if (i < 0) return;
    if (!dialog.open) dialog.showModal();
    show(i);
  }

  dialog.addEventListener('close', () => {
    token += 1;
    if (url) URL.revokeObjectURL(url);
    url = null;
    img.removeAttribute('src');
  });
  dialog.addEventListener('click', (event) => {
    const action = event.target.closest('[data-preview]')?.dataset.preview;
    if (action === 'prev') show(index - 1);
    else if (action === 'next') show(index + 1);
    else if (action === 'close' || event.target === dialog) dialog.close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') show(index - 1);
    else if (event.key === 'ArrowRight') show(index + 1);
  });

  return { open, isOpen: () => dialog.open, close: () => dialog.close() };
}
