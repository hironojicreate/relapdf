// 画面テスト：M6（書き込み：ページ番号・ヘッダー/フッター・透かし・スタンプ）
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url).pathname;
const cards = (page) => page.locator('.page-card');

/** できたPDFの各ページの文字と、画面で見たときの位置（左上が原点、0〜1の割合） */
async function readTexts(page, bytes) {
  return page.evaluate(async (b64) => {
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const pdf = await pdfjs.getDocument({ data }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i);
      const viewport = p.getViewport({ scale: 1 });
      const items = (await p.getTextContent()).items
        .filter((item) => item.str.trim())
        .map((item) => {
          const [, , , , x, y] = pdfjs.Util.transform(viewport.transform, item.transform);
          return { text: item.str, x: x / viewport.width, y: y / viewport.height };
        });
      pages.push(items);
    }
    return pages;
  }, Buffer.from(bytes).toString('base64'));
}

test('ページ番号・ヘッダー・スタンプを書き込み、回転したページも画面の向きで書く', async ({ page }) => {
  await page.goto('./');
  await page.click('[data-mode="detail"]');
  await page.setInputFiles('#input-files', [fixture('sample-3pages.pdf')]);
  await expect(page.locator('.page-card .thumb img[src^="blob:"]')).toHaveCount(3);
  // 1ページ目（縦向き）を右に回して横向きにする
  await cards(page).nth(0).locator('[data-op="rotate"]').click();

  await page.click('[data-action="open-marks"]');
  const dialog = page.locator('#marks-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-mark="pageNumber.enabled"]').check();
  await dialog.locator('[data-mark="pageNumber.format"]').selectOption('total');
  await dialog.locator('[data-mark="header.enabled"]').check();
  await dialog.locator('[data-mark="header.text"]').fill('社内資料 {n}/{total}');
  await dialog.locator('[data-mark="stamp.enabled"]').check();
  await dialog.locator('[data-mark="stamp.text"]').fill('社外秘');
  // 見本が出る
  await expect(page.locator('#marks-preview-img')).toHaveAttribute('src', /^blob:/, { timeout: 20_000 });
  await expect(page.locator('#marks-preview-caption')).toHaveText('見本（1ページ目）');
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#marks-status')).toContainText('ページ番号・ヘッダー・スタンプ');

  // 読み込み直しても設定が残る
  await page.evaluate(() => window.__relapdf.flushSave());
  await page.reload();
  await expect(page.locator('#marks-status')).toContainText('ページ番号・ヘッダー・スタンプ');

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]:visible')]);
  const texts = await readTexts(page, await readFile(await download.path()));
  expect(texts).toHaveLength(3);
  texts.forEach((items, i) => {
    const number = items.find((item) => item.text === `${i + 1} / 3`);
    expect(number, `${i + 1}ページ目の番号`).toBeTruthy();
    // 下の中央（回転したページでも、画面で見た向きで）
    expect(number.y).toBeGreaterThan(0.9);
    expect(number.x).toBeGreaterThan(0.4);
    expect(number.x).toBeLessThan(0.55);
    const header = items.find((item) => item.text === `社内資料 ${i + 1}/3`);
    expect(header.y, '上の余白').toBeLessThan(0.1);
  });
  expect(texts[0].some((item) => item.text === '社外秘')).toBe(true);
  expect(texts[1].some((item) => item.text === '社外秘')).toBe(false); // 最初のページだけ
});

test('表紙に番号を付けない・透かし・すべて外す', async ({ page }) => {
  await page.goto('./');
  await page.click('[data-mode="detail"]');
  await page.setInputFiles('#input-files', [fixture('sample-3pages.pdf')]);
  await expect(page.locator('.page-card .thumb img[src^="blob:"]')).toHaveCount(3);

  await page.click('[data-action="open-marks"]');
  const dialog = page.locator('#marks-dialog');
  await dialog.locator('[data-mark="pageNumber.enabled"]').check();
  await dialog.locator('[data-mark="pageNumber.skipFirst"]').check();
  await dialog.locator('[data-mark="watermark.enabled"]').check();
  await dialog.locator('[data-mark="watermark.text"]').fill('複製禁止');
  await expect(page.locator('#marks-preview-caption')).toHaveText('見本（2ページ目）', { timeout: 20_000 });
  await dialog.locator('button[type="submit"]').click();

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]:visible')]);
  const texts = await readTexts(page, await readFile(await download.path()));
  expect(texts[0].some((item) => /^\d$/.test(item.text))).toBe(false);
  expect(texts[1].some((item) => item.text === '1')).toBe(true);
  expect(texts[2].some((item) => item.text === '2')).toBe(true);
  for (const items of texts) expect(items.some((item) => item.text === '複製禁止')).toBe(true);

  await page.click('[data-action="open-marks"]');
  await expect(dialog.locator('[data-mark="watermark.text"]')).toHaveValue('複製禁止'); // 前の設定が入っている
  await dialog.locator('[data-action="marks-clear"]').click();
  await expect(page.locator('#toast')).toContainText('書き込みを外しました');
  await expect(page.locator('#marks-status')).toBeHidden();
});
