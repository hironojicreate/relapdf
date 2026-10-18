// 画面テスト：読み込み → サムネイル → PDF作成 → 保存 の流れを、PC・Android・iPhone の画面で確かめる
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';

const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url).pathname;
const isMobile = (testInfo) => testInfo.project.name !== 'pc';

// コンソールのエラー（CSP違反を含む）を集める
function watchErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

// その端末のモードで、ファイルを追加する
async function addFiles(page, files, testInfo) {
  const input = isMobile(testInfo) && files.every((f) => !String(f.name ?? f).endsWith('.pdf')) ? '#input-photos' : '#input-files';
  if (isMobile(testInfo) && input === '#input-files') {
    // PDFは詳細モードで追加する
    await page.click('[data-mode="detail"]');
  }
  await page.setInputFiles(input, files);
}

async function exportAndDownload(page) {
  await page.click('[data-action="export"]');
  await expect(page.locator('#result-dialog')).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="download"]')]);
  const bytes = await readFile(await download.path());
  return { name: download.suggestedFilename(), pdf: await PDFDocument.load(bytes) };
}

const cards = (page) => page.locator('.page-card');
const loadedThumbs = (page) => page.locator('.page-card .thumb img[src^="blob:"]');

test('起動時にエラーが出ず、端末に合ったモードになる', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await page.goto('./');
  await expect(page.locator('h1')).toHaveText('RelaPDF');
  const expected = isMobile(testInfo) ? 'mode-easy' : 'mode-detail';
  await expect(page.locator('body')).toHaveClass(new RegExp(expected));
  await expect(page.locator('#empty')).toBeVisible();
  expect(errors).toEqual([]);
});

test('手動で切り替えたモードは、開き直しても残る', async ({ page }, testInfo) => {
  await page.goto('./');
  const other = isMobile(testInfo) ? 'detail' : 'easy';
  await page.click(`[data-mode="${other}"]`);
  await expect(page.locator('body')).toHaveClass(new RegExp(`mode-${other}`));
  await page.reload();
  await expect(page.locator('body')).toHaveClass(new RegExp(`mode-${other}`));
  await expect(page.locator(`[data-mode="${other}"]`)).toHaveAttribute('aria-pressed', 'true');
});

test('写真1枚をPDFにして保存できる（M1の完了の目安）', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await page.goto('./');
  await addFiles(page, [fixture('photo-landscape.jpg')], testInfo);
  await expect(cards(page)).toHaveCount(1);
  await expect(loadedThumbs(page)).toHaveCount(1);
  await expect(page.locator('#page-count')).toHaveText('1ページ');

  await page.fill('#file-name', '見積書');
  const { name, pdf } = await exportAndDownload(page);
  expect(name).toBe('見積書.pdf');
  expect(pdf.getPageCount()).toBe(1);
  const { width, height } = pdf.getPage(0).getSize();
  expect([Math.round(width), Math.round(height)]).toEqual([842, 595]); // 横長の写真 → 横向きA4
  expect(errors).toEqual([]);
});

test('写真の回転情報（EXIF）を反映して読み込む', async ({ page }, testInfo) => {
  await page.goto('./');
  await addFiles(page, [fixture('photo-exif-rotate90.jpg')], testInfo);
  await expect(cards(page)).toHaveCount(1);
  const source = await page.evaluate(() => Object.values(window.__relapdf.getDoc().sources)[0]);
  // 保存されている画像は横400×縦300だが、回転情報で縦長として扱う
  expect([source.width, source.height]).toEqual([300, 400]);
  const { pdf } = await exportAndDownload(page);
  const { width, height } = pdf.getPage(0).getSize();
  expect([Math.round(width), Math.round(height)]).toEqual([595, 842]);
});

test('PDFを読み込んでサムネイルを表示し、回転・並べ替え・削除して書き出す', async ({ page }, testInfo) => {
  const errors = watchErrors(page);
  await page.goto('./');
  await addFiles(page, [fixture('sample-3pages.pdf')], testInfo);
  await expect(cards(page)).toHaveCount(3);
  await expect(loadedThumbs(page)).toHaveCount(3, { timeout: 15_000 });

  // 1ページ目を回転、2ページ目を先頭へ、3ページ目を削除
  await cards(page).nth(0).locator('[data-op="rotate"]').click();
  await cards(page).nth(1).locator('[data-op="move-left"]').click();
  await cards(page).nth(2).locator('[data-op="delete"]').click();
  await expect(cards(page)).toHaveCount(2);

  const { pdf } = await exportAndDownload(page);
  expect(pdf.getPageCount()).toBe(2);
  const pages = pdf.getPages();
  // 先頭は元の2ページ目（横向き）、次は元の1ページ目（90度回転）
  expect(Math.round(pages[0].getSize().width)).toBe(842);
  expect(pages[1].getRotation().angle).toBe(90);
  expect(errors).toEqual([]);
});

test('PDFと写真をまとめて1つのPDFにできる', async ({ page }, testInfo) => {
  await page.goto('./');
  if (isMobile(testInfo)) await page.click('[data-mode="detail"]');
  await page.setInputFiles('#input-files', [fixture('sample-3pages.pdf'), fixture('photo-landscape.png')]);
  await expect(cards(page)).toHaveCount(4);
  const { pdf } = await exportAndDownload(page);
  expect(pdf.getPageCount()).toBe(4);
});

test('パスワード付きPDFや対応していないファイルは、わかりやすく知らせる', async ({ page }, testInfo) => {
  await page.goto('./');
  if (isMobile(testInfo)) await page.click('[data-mode="detail"]');
  const encrypted = await PDFDocument.create();
  encrypted.addPage();
  encrypted.context.trailerInfo.Encrypt = encrypted.context.register(encrypted.context.obj({ Filter: 'Standard' }));
  await page.setInputFiles('#input-files', [
    { name: 'locked.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await encrypted.save({ useObjectStreams: false })) },
    { name: 'memo.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
  ]);
  const toast = page.locator('#toast');
  await expect(toast).toHaveClass(/show/);
  await expect(toast).toContainText('パスワード付きのPDF');
  await expect(toast).toContainText('対応していないファイル');
  await expect(cards(page)).toHaveCount(0);
});

test('一度開けば、オフラインでも起動してPDFを読み込める', async ({ page, context }, testInfo) => {
  await page.goto('./');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // Service Worker がこのページを担当するまで待つ（初回は再読み込みが必要）
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('h1')).toHaveText('RelaPDF');
  await addFiles(page, [fixture('sample-3pages.pdf')], testInfo);
  await expect(loadedThumbs(page)).toHaveCount(3, { timeout: 15_000 });
  const { pdf } = await exportAndDownload(page);
  expect(pdf.getPageCount()).toBe(3);
});
