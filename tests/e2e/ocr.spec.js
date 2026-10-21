// 画面テスト：M7（文字認識：OCR）
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/** 日本語の書類のような画像（同梱のフォントで描く） */
async function documentImage(page) {
  const dataUrl = await page.evaluate(async () => {
    const font = new FontFace('OcrTest', 'url(/vendor/fonts/BIZUDGothic-Regular.ttf)');
    document.fonts.add(await font.load());
    const c = document.createElement('canvas');
    c.width = 1240;
    c.height = 1754;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#111';
    g.font = '96px OcrTest';
    g.fillText('請求書', 120, 260);
    g.font = '56px OcrTest';
    g.fillText('合計金額 12,000円', 120, 460);
    g.fillText('お支払い期限 10月31日', 120, 560);
    return c.toDataURL('image/png');
  });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

test('写真の文字を読み取り、検索・コピーできるPDFにする', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'pc', '読み取りは時間がかかるので、PCだけで確かめる');
  test.setTimeout(180_000);
  await page.goto('./');
  await page.click('[data-mode="detail"]');
  await page.setInputFiles('#input-files', [{ name: 'invoice.png', mimeType: 'image/png', buffer: await documentImage(page) }]);
  await expect(page.locator('.page-card .thumb img[src^="blob:"]')).toHaveCount(1);

  await page.click('[data-action="open-ocr"]');
  const dialog = page.locator('#ocr-dialog');
  await expect(dialog.locator('input[value="selected"]')).toBeDisabled(); // 選んでいない
  await expect(dialog.locator('input[value="all"]')).toBeChecked();
  await dialog.locator('button[type="submit"]').click();
  await expect(page.locator('#ocr-text')).toBeVisible({ timeout: 150_000 });
  const text = await page.locator('#ocr-text').inputValue();
  expect(text).toContain('請求書');
  expect(text).toContain('12,000円');
  await dialog.locator('[data-action="ocr-close"]').click();
  await expect(page.locator('.page-card .badge')).toContainText('OCR');

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]:visible')]);
  const bytes = await readFile(await download.path());
  const found = await page.evaluate(async (b64) => {
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    const pdf = await pdfjs.getDocument({ data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }).promise;
    const p = await pdf.getPage(1);
    return (await p.getTextContent()).items.map((item) => item.str).join(' ');
  }, Buffer.from(bytes).toString('base64'));
  expect(found).toContain('請求書');
});
