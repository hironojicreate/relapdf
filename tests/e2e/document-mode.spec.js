// 画面テスト：M5（書類モード：背景を白く・文字をくっきり）
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';

const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url).pathname;
const cards = (page) => page.locator('.page-card');
const loadedThumbs = (page) => page.locator('.page-card .thumb img[src^="blob:"]');
const pageState = (page, i = 0) => page.evaluate((index) => window.__relapdf.getDoc().pages[index], i);

/** サムネイルの紙の部分（左上の余白）の明るさ */
const paperBrightness = (page, i = 0) =>
  cards(page)
    .nth(i)
    .locator('.thumb img[src^="blob:"]')
    .evaluate(async (img) => {
      // 描き直しの途中などで読めないときは NaN を返し、expect.poll でやり直す
      try {
        await img.decode();
      } catch {
        return NaN;
      }
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(Math.round(c.width * 0.04), Math.round(c.height * 0.03), 4, 4).data;
      let sum = 0;
      for (let k = 0; k < d.length; k += 4) sum += d[k] + d[k + 1] + d[k + 2];
      return sum / (d.length / 4) / 3;
    });

async function addDocumentPhoto(page, mode = 'easy') {
  await page.goto('./');
  await page.click(`[data-mode="${mode}"]`);
  await page.setInputFiles(mode === 'easy' ? '#input-photos' : '#input-files', [fixture('document-photo.jpg')]);
  await expect(loadedThumbs(page)).toHaveCount(1);
}

test('かんたんモードで書類の写真を取り込むと、書類モードになり紙が白くなる。補正画面で外せる', async ({ page }) => {
  await addDocumentPhoto(page);
  expect((await pageState(page)).filter).toBe('document');
  // サムネイルは描き直されることがあるので、読み取りは失敗したらやり直す
  let white = 0;
  await expect.poll(async () => (white = await paperBrightness(page))).toBeGreaterThan(248);

  await cards(page).nth(0).locator('[data-op="perspective"].icon-btn').click();
  await expect(page.locator('#editor')).not.toHaveClass(/loading/);
  await expect(page.locator('#editor-document')).toBeChecked();
  await page.locator('#editor-document').uncheck();
  await page.click('[data-editor="apply"]');
  await expect.poll(async () => (await pageState(page)).filter).toBe('none');
  await expect.poll(() => paperBrightness(page)).toBeLessThan(white - 5);

  // 書き出したPDFにも、書類モードの有無が反映される（ここでは外したまま書き出せることを確かめる）
  await page.click('[data-action="go-save"]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]:visible')]);
  const pdf = await PDFDocument.load(await readFile(await download.path()));
  expect(pdf.getPageCount()).toBe(1);
});

test('詳細モード：選んだ写真のページの書類モードを、まとめて切り替える', async ({ page }) => {
  await addDocumentPhoto(page, 'detail');
  expect((await pageState(page)).filter).toBe('none'); // 詳細モードでは自動で付けない
  await cards(page).nth(0).locator('.thumb').click();
  await page.click('[data-action="document-selected"]');
  await expect(page.locator('#toast')).toContainText('1ページを書類モードにしました');
  expect((await pageState(page)).filter).toBe('document');
  await page.click('[data-action="document-selected"]');
  await expect(page.locator('#toast')).toContainText('書類モードを外しました');
  expect((await pageState(page)).filter).toBe('none');
});

test('カメラの「書類モード」ボタンで切り替えられ、撮った写真に付き、次回も覚えている', async ({ page }) => {
  await page.goto('./');
  await page.click('[data-mode="easy"]');
  await page.click('#empty [data-action="camera"]');
  const chip = page.locator('#camera-document');
  await expect(chip).toHaveAttribute('aria-pressed', 'true'); // 最初はオン
  await expect(page.locator('#camera-shutter')).toBeEnabled();
  await page.click('#camera-shutter');
  await expect(page.locator('#camera-count')).toHaveText('1枚');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await page.click('#camera-shutter');
  await expect(page.locator('#camera-count')).toHaveText('2枚');
  await page.click('[data-camera="done"]');
  await expect(cards(page)).toHaveCount(2);
  expect((await pageState(page, 0)).filter).toBe('document');
  expect((await pageState(page, 1)).filter).toBe('none');

  await page.reload();
  await page.click('#workspace [data-action="camera"]');
  await expect(page.locator('#camera-document')).toHaveAttribute('aria-pressed', 'false');
});
