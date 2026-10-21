// 画面テスト：M6（フォーム入力：PDFの入力欄に文字を入れる）
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url).pathname;

/** できたPDFの各ページの文字 */
async function readTexts(page, bytes) {
  return page.evaluate(async (b64) => {
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    const pdf = await pdfjs.getDocument({ data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i);
      pages.push((await p.getTextContent()).items.map((item) => item.str).join(' '));
    }
    return pages;
  }, Buffer.from(bytes).toString('base64'));
}

test('入力欄のあるPDFだけ「フォーム入力」が出て、日本語で入力して書き出せる', async ({ page }) => {
  await page.goto('./');
  await page.click('[data-mode="detail"]');
  await page.setInputFiles('#input-files', [fixture('sample-3pages.pdf')]);
  await expect(page.locator('.page-card .thumb img[src^="blob:"]')).toHaveCount(3);
  await expect(page.locator('#open-forms')).toBeHidden();

  await page.setInputFiles('#input-files', [fixture('form.pdf')]);
  await expect(page.locator('.page-card .thumb img[src^="blob:"]')).toHaveCount(5);
  await page.click('#open-forms');
  const dialog = page.locator('#forms-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#forms-file-row')).toBeHidden(); // 入力欄のあるPDFは1つだけ
  const field = (name) => dialog.locator(`.form-field[data-name="${name}"]`);
  await expect(field('name')).toContainText('Your name（1ページ）');
  await expect(field('note')).toContainText('（2ページ）');
  await field('name').locator('input').fill('山田 花子');
  await field('agree').locator('input').check();
  await field('contact').locator('select').selectOption('phone');
  await field('pref').locator('select').selectOption('Osaka');
  await field('note').locator('textarea').fill('午前中にお願いします');
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#forms-status')).toContainText('フォーム入力：5か所');

  // 開き直すと、入力した内容が入っている
  await page.click('#open-forms');
  await expect(field('name').locator('input')).toHaveValue('山田 花子');
  await expect(field('agree').locator('input')).toBeChecked();
  await dialog.locator('[data-action="forms-cancel"]').click();

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]:visible')]);
  const texts = await readTexts(page, await readFile(await download.path()));
  expect(texts).toHaveLength(5);
  expect(texts[3]).toContain('山田 花子');
  expect(texts[3]).toContain('Osaka');
  expect(texts[4]).toContain('午前中にお願いします');
});
