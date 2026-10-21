// 画面テスト：M6（PDFの圧縮：PDFの中の大きな画像を縮小し直す）
import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFRawStream } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';

/** 大きな写真（3000×2000のJPEG）が入ったPDFを作る */
async function makeBigImagePdf(page, path) {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 3000;
    c.height = 2000;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 3000, 2000);
    grad.addColorStop(0, '#3a6ea5');
    grad.addColorStop(1, '#f0c27b');
    g.fillStyle = grad;
    g.fillRect(0, 0, 3000, 2000);
    // 細かい模様（JPEGが小さくなりすぎないように）
    for (let i = 0; i < 4000; i++) {
      g.fillStyle = `hsl(${(i * 37) % 360} 60% 50%)`;
      g.fillRect((i * 97) % 3000, (i * 61) % 2000, 18, 18);
    }
    return c.toDataURL('image/jpeg', 0.92);
  });
  const pdf = await PDFDocument.create();
  const image = await pdf.embedJpg(Buffer.from(dataUrl.split(',')[1], 'base64'));
  const p = pdf.addPage([842, 595]);
  p.drawImage(image, { x: 0, y: 0, width: 842, height: 595 });
  await writeFile(path, await pdf.save());
}

/** PDFの中の画像の大きさ（幅） */
async function imageWidths(bytes) {
  const pdf = await PDFDocument.load(bytes);
  const widths = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
      widths.push(object.dict.get(PDFName.of('Width')).asNumber());
    }
  }
  return widths;
}

test('詳細モード：「PDFの圧縮」で、PDFの中の大きな画像を縮小して小さくする', async ({ page }, testInfo) => {
  const source = testInfo.outputPath('big-image.pdf');
  await page.goto('./');
  await makeBigImagePdf(page, source);
  const original = await readFile(source);

  await page.click('[data-mode="detail"]');
  await page.setInputFiles('#input-files', [source]);
  await expect(page.locator('.page-card .thumb img[src^="blob:"]')).toHaveCount(1);

  // しない（初期値）：そのまま
  await expect(page.locator('#compress')).toHaveValue('none');
  const [plain] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]:visible')]);
  expect(await imageWidths(await readFile(await plain.path()))).toEqual([3000]);

  // する：長辺2000pxまで縮小
  await page.selectOption('#compress', 'standard');
  const [small] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]:visible')]);
  const bytes = await readFile(await small.path());
  expect(await imageWidths(bytes)).toEqual([2000]);
  expect(bytes.length).toBeLessThan(original.length * 0.8);
  await expect(page.locator('#toast')).toContainText('画像1枚を圧縮');

  // 強め：長辺1400px
  await page.selectOption('#compress', 'strong');
  const [strong] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]:visible')]);
  expect(await imageWidths(await readFile(await strong.path()))).toEqual([1400]);

  // 設定は次回も残る
  await page.evaluate(() => window.__relapdf.flushSave());
  await page.reload();
  await expect(page.locator('#compress')).toHaveValue('strong');
});
