// 画面テスト：M4（詳細モード 第1段階）
// 複数ページの選択と一括操作、取り出す（抽出）・分割・画像にする、大きなプレビュー
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';
import { unzipSync } from '../../vendor/fflate/fflate.mjs';

const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url).pathname;
const cards = (page) => page.locator('.page-card');
const selectedCount = (page) => page.locator('.page-card.selected').count();
const names = (page) =>
  page.evaluate(() => {
    const doc = window.__relapdf.getDoc();
    return doc.pages.map((p) => `${doc.sources[p.content.sourceId].name}:${p.content.pageIndex + 1}`);
  });

// PDF（3ページ）と写真2枚 → 5ページ
async function openFiles(page) {
  await page.goto('./');
  await page.click('[data-mode="detail"]');
  await page.setInputFiles('#input-files', [
    fixture('sample-3pages.pdf'),
    fixture('photo-landscape.jpg'),
    fixture('photo-landscape.png'),
  ]);
  await expect(page.locator('.page-card .thumb img[src^="blob:"]')).toHaveCount(5, { timeout: 15_000 });
}

async function download(page, trigger) {
  const [file] = await Promise.all([page.waitForEvent('download'), trigger()]);
  return { name: file.suggestedFilename(), bytes: new Uint8Array(await readFile(await file.path())) };
}

/** ツールのダイアログで作ったファイルを受け取る */
async function runTool(page) {
  await page.click('#tool-submit');
  await expect(page.locator('#result-dialog')).toBeVisible({ timeout: 20_000 });
  return download(page, () => page.click('[data-action="download"]'));
}

const pngWidth = (bytes) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(16);

test('クリック・Shift・Ctrl でページを選び、選択を外せる', async ({ page }) => {
  await openFiles(page);
  await expect(page.locator('#selection-count')).toContainText('クリックで選択');
  await cards(page).nth(1).click();
  expect(await selectedCount(page)).toBe(1);
  await cards(page).nth(3).click({ modifiers: ['Shift'] });
  expect(await selectedCount(page)).toBe(3); // 2〜4
  await cards(page).nth(0).click({ modifiers: ['ControlOrMeta'] });
  expect(await selectedCount(page)).toBe(4);
  await cards(page).nth(2).click({ modifiers: ['ControlOrMeta'] });
  expect(await selectedCount(page)).toBe(3);
  await expect(page.locator('#selection-count')).toHaveText('3 / 5 ページを選択中');

  await page.keyboard.press('Escape');
  expect(await selectedCount(page)).toBe(0);
  await page.click('#select-all');
  expect(await selectedCount(page)).toBe(5);
  await expect(page.locator('#select-all')).toHaveText('選択を解除');
  await page.click('#select-all');
  expect(await selectedCount(page)).toBe(0);
  await page.keyboard.press('ControlOrMeta+a');
  expect(await selectedCount(page)).toBe(5);

  // 選択の丸（タッチ操作用）でも選べる
  await page.keyboard.press('Escape');
  await cards(page).nth(4).locator('.select-box').click();
  await cards(page).nth(3).locator('.select-box').click();
  expect(await selectedCount(page)).toBe(2);
});

test('選んだページをまとめて回転・削除でき、削除は元に戻せる', async ({ page }) => {
  await openFiles(page);
  await expect(page.locator('[data-action="rotate-selected"]')).toBeDisabled();
  await cards(page).nth(0).click();
  await cards(page).nth(1).click({ modifiers: ['Shift'] });
  await page.click('[data-action="rotate-selected"]');
  const rotations = await page.evaluate(() => window.__relapdf.getDoc().pages.map((p) => p.rotation));
  expect(rotations).toEqual([90, 90, 0, 0, 0]);

  await page.click('[data-action="delete-selected"]');
  await expect(cards(page)).toHaveCount(3);
  await expect(page.locator('#toast')).toContainText('2ページを削除しました');
  await page.click('#toast-action');
  await expect(cards(page)).toHaveCount(5);
  await expect(page.locator('.page-card .thumb img[src^="blob:"]')).toHaveCount(5);

  // キーボード：Delete で削除、Ctrl/⌘+Z で元に戻す
  await cards(page).nth(4).click();
  await page.keyboard.press('Delete');
  await expect(cards(page)).toHaveCount(4);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(cards(page)).toHaveCount(5);
});

test('選んだページのうち1枚をドラッグすると、まとめて移動する', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'pc', 'マウスでのドラッグはPCで確かめる');
  await openFiles(page);
  await cards(page).nth(0).click();
  await cards(page).nth(1).click({ modifiers: ['Shift'] });
  const from = await cards(page).nth(0).locator('.thumb').boundingBox();
  const to = await cards(page).nth(3).locator('.thumb').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width * 0.8, to.y + to.height / 2, { steps: 8 });
  await expect(cards(page).nth(0)).toHaveAttribute('data-drag-count', '2');
  await page.mouse.up();
  expect(await names(page)).toEqual([
    'sample-3pages.pdf:3',
    'photo-landscape.jpg:1',
    'sample-3pages.pdf:1',
    'sample-3pages.pdf:2',
    'photo-landscape.png:1',
  ]);
});

test('取り出す：選んだページだけで新しいPDFを作る', async ({ page }) => {
  await openFiles(page);
  await cards(page).nth(1).click();
  await cards(page).nth(2).click({ modifiers: ['Shift'] });
  await page.fill('#file-name', '報告書');
  await page.click('[data-action="open-extract"]');
  await expect(page.locator('#tool-title')).toHaveText('ページを取り出す');
  await expect(page.locator('#extract-range')).toHaveValue('2-3');
  const { name, bytes } = await runTool(page);
  expect(name).toBe('報告書_2-3.pdf');
  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBe(2);
  expect(Math.round(pdf.getPage(0).getSize().width)).toBe(842); // 元の2ページ目（横向き）
});

test('分割：ページ範囲ごと・決まったページ数ずつ。範囲のまちがいはその場で知らせる', async ({ page }) => {
  await openFiles(page);
  await page.fill('#file-name', '資料');
  await page.click('[data-action="open-split"]');
  await page.fill('#split-ranges', '1-2, 9');
  await page.click('#tool-submit');
  await expect(page.locator('#tool-error')).toContainText('1〜5の外');
  await expect(page.locator('#tool-dialog')).toBeVisible();

  await page.fill('#split-ranges', '1-2, 3-5');
  const ranges = await runTool(page);
  expect(ranges.name).toBe('資料_分割.zip');
  const files = unzipSync(ranges.bytes);
  expect(Object.keys(files).sort()).toEqual(['資料_1-2.pdf', '資料_3-5.pdf']);
  expect((await PDFDocument.load(files['資料_3-5.pdf'])).getPageCount()).toBe(3);

  await page.click('[data-action="close-result"]:visible');
  await page.click('[data-action="open-split"]');
  await page.locator('input[name="split-mode"][value="every"]').check();
  await page.fill('#split-every', '2');
  const every = await runTool(page);
  expect(Object.keys(unzipSync(every.bytes)).sort()).toEqual(['資料_1-2.pdf', '資料_3-4.pdf', '資料_5.pdf']);
});

test('画像にする：1枚ならそのまま、複数ならZIP。解像度を選べる', async ({ page }) => {
  await openFiles(page);
  await page.fill('#file-name', 'scan');
  await page.click('[data-action="open-images"]');
  await page.fill('#images-range', '1');
  const single = await runTool(page);
  expect(single.name).toBe('scan_01.jpg');
  expect([single.bytes[0], single.bytes[1]]).toEqual([0xff, 0xd8]); // JPEG

  await page.click('[data-action="close-result"]:visible');
  await page.click('[data-action="open-images"]');
  await page.fill('#images-range', '1-3');
  await page.selectOption('#images-format', 'png');
  const zip = await runTool(page);
  expect(zip.name).toBe('scan_画像.zip');
  const files = unzipSync(zip.bytes);
  expect(Object.keys(files).sort()).toEqual(['scan_01.png', 'scan_02.png', 'scan_03.png']);
  expect(pngWidth(files['scan_01.png'])).toBe(1240); // A4縦（595pt）を150dpiで
  expect(pngWidth(files['scan_02.png'])).toBe(1754); // 横向きのページ

  await page.click('[data-action="close-result"]:visible');
  await page.click('[data-action="open-images"]');
  await page.fill('#images-range', '1');
  await page.selectOption('#images-format', 'png');
  await page.selectOption('#images-dpi', '300');
  const high = await runTool(page);
  expect(pngWidth(high.bytes)).toBe(2480);
});

test('ダブルクリックで大きく表示し、前後のページへ移れる', async ({ page }) => {
  await openFiles(page);
  await cards(page).nth(0).dblclick();
  const dialog = page.locator('#preview-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#preview-label')).toHaveText('1 / 5');
  await expect(page.locator('#preview-img')).toHaveAttribute('src', /^blob:/);
  await expect(page.locator('#preview-prev')).toBeDisabled();
  await page.click('#preview-next');
  await expect(page.locator('#preview-label')).toHaveText('2 / 5');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#preview-label')).toHaveText('3 / 5');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('PDFを読み込んだときだけ、しおりが引き継がれない注意を出す', async ({ page }) => {
  await page.goto('./');
  await page.click('[data-mode="detail"]');
  await page.setInputFiles('#input-files', [fixture('photo-landscape.jpg')]);
  await expect(cards(page)).toHaveCount(1);
  await expect(page.locator('#merge-hint')).toBeHidden();
  await page.setInputFiles('#input-files', [fixture('sample-3pages.pdf')]);
  await expect(page.locator('#merge-hint')).toBeVisible();
});
