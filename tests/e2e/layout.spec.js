// 画面テスト：M7（用紙サイズの変換・割付・トリミング）
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';

const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url).pathname;
const cards = (page) => page.locator('.page-card');

async function openPdf(page) {
  await page.goto('./');
  await page.click('[data-mode="detail"]');
  await page.setInputFiles('#input-files', [fixture('sample-3pages.pdf')]);
  await expect(page.locator('.page-card .thumb img[src^="blob:"]')).toHaveCount(3);
  await page.evaluate(() => document.querySelector('#page-grid').scrollIntoView());
}

async function exportPdf(page) {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]:visible')]);
  return PDFDocument.load(await readFile(await download.path()));
}

test('用紙・割付：2in1にして、見本を見てから書き出す', async ({ page }) => {
  await openPdf(page);
  await page.click('[data-action="open-layout"]');
  const dialog = page.locator('#layout-dialog');
  await dialog.locator('[data-layout="nup"]').selectOption('2');
  await dialog.locator('[data-layout="margin"]').selectOption('small');
  await expect(page.locator('#layout-preview-img')).toHaveAttribute('src', /^blob:/, { timeout: 20_000 });
  await dialog.locator('button[type="submit"]').click();
  await expect(page.locator('#layout-status')).toContainText('A4に2ページずつ');

  const pdf = await exportPdf(page);
  expect(pdf.getPageCount()).toBe(2);
  const { width, height } = pdf.getPage(0).getSize();
  expect(Math.round(width)).toBe(842);
  expect(Math.round(height)).toBe(595);

  // 元に戻す
  await page.click('[data-action="open-layout"]');
  await dialog.locator('[data-action="layout-clear"]').click();
  await expect(page.locator('#layout-status')).toBeHidden();
  expect((await exportPdf(page)).getPageCount()).toBe(3);
});

test('トリミング：残す範囲を囲み、選んだページすべてに使う', async ({ page }) => {
  await openPdf(page);
  await cards(page).nth(0).locator('.thumb').click();
  await cards(page).nth(2).locator('.thumb').click();
  await page.click('[data-action="open-cropper"]');
  await expect(page.locator('#cropper')).toBeVisible();
  await expect(page.locator('#cropper')).not.toHaveClass(/loading/);
  await expect(page.locator('#cropper-all')).toBeChecked();
  // 下の辺の丸を、ページの真ん中まで上げる（上半分を残す）
  const img = await page.locator('#cropper-page').boundingBox();
  const dot = await page.locator('#cropper-svg [data-handle="s"] .dot').boundingBox();
  await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
  await page.mouse.down();
  await page.mouse.move(dot.x + dot.width / 2, img.y + img.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.click('[data-crop="apply"]');
  await expect(page.locator('#toast')).toContainText('2ページをトリミングしました');
  await expect(cards(page).nth(0).locator('.badge')).toHaveText('トリミング');
  await expect(cards(page).nth(1).locator('.badge')).toHaveCount(0);

  const crops = await page.evaluate(() => window.__relapdf.getDoc().pages.map((p) => p.crop?.h ?? null));
  expect(crops[0]).toBeCloseTo(0.5, 1);
  expect(crops[1]).toBeNull();
  // 3ページ目（PDFにもともと90度の回転が付いている）も、画面で見て上半分
  expect(crops[2]).toBeCloseTo(0.5, 1);

  const pdf = await exportPdf(page);
  const box = pdf.getPage(0).getCropBox();
  expect(box.height).toBeCloseTo(842 / 2, 0);
});
