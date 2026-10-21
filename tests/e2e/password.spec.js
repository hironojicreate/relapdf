// 画面テスト：M7（パスワードをかける・外す）
// テスト用のPDF：locked.pdf（開くときのパスワード「relapdf」）、restricted.pdf（開くときのパスワードはなく、編集だけ制限）
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';

const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url).pathname;
const cards = (page) => page.locator('.page-card');

async function detail(page) {
  await page.goto('./');
  await page.click('[data-mode="detail"]');
}

test('パスワード付きのPDFは、パスワードを聞いて外してから読み込む（違えばもう一度聞く）', async ({ page }) => {
  await detail(page);
  await page.setInputFiles('#input-files', [fixture('locked.pdf')]);
  const dialog = page.locator('#password-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('locked.pdf');
  await page.fill('#password-input', 'wrong');
  await dialog.locator('button[type="submit"]').click();
  await expect(page.locator('#password-error')).toContainText('パスワードが違います');
  await page.fill('#password-input', 'relapdf');
  await dialog.locator('button[type="submit"]').click();
  await expect(cards(page)).toHaveCount(3);
  await expect(page.locator('#toast')).toContainText('パスワードを外して読み込みました');
  await expect(page.locator('.page-card .thumb img[src^="blob:"]')).toHaveCount(3);

  // 書き出したPDFには、パスワードはかかっていない
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]:visible')]);
  const pdf = await PDFDocument.load(await readFile(await download.path()));
  expect(pdf.getPageCount()).toBe(3);
});

test('パスワードを聞かれて「読み込まない」を押したら、読み込まない', async ({ page }) => {
  await detail(page);
  await page.setInputFiles('#input-files', [fixture('locked.pdf')]);
  await page.click('[data-action="password-cancel"]');
  await expect(page.locator('#toast')).toContainText('パスワードが必要なため、読み込みませんでした');
  await expect(cards(page)).toHaveCount(0);
});

test('編集の制限だけのPDFは、パスワードを聞かずに読み込む', async ({ page }) => {
  await detail(page);
  await page.setInputFiles('#input-files', [fixture('restricted.pdf')]);
  await expect(cards(page)).toHaveCount(3);
  await expect(page.locator('#password-dialog')).toBeHidden();
});

test('作成するPDFにパスワードをかける。パスワードは端末に保存しない', async ({ page }) => {
  await detail(page);
  await page.setInputFiles('#input-files', [fixture('sample-3pages.pdf')]);
  await expect(cards(page)).toHaveCount(3);
  await page.click('[data-action="open-protect"]');
  const dialog = page.locator('#protect-dialog');
  await page.fill('#protect-password', 'abcd1234');
  await page.fill('#protect-again', 'abcd9999');
  await dialog.locator('button[type="submit"]').click();
  await expect(page.locator('#protect-error')).toContainText('2つのパスワードが違います');
  await page.fill('#protect-again', 'abcd1234');
  await dialog.locator('button[type="submit"]').click();
  await expect(page.locator('#protect-status')).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]:visible')]);
  const bytes = await readFile(await download.path());
  // pdf-lib では読めない（暗号化されている）。PDF.js にパスワードを渡すと開ける
  await expect(PDFDocument.load(bytes)).rejects.toThrow(/encrypted/i);
  const pages = await page.evaluate(async (b64) => {
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const pdf = await pdfjs.getDocument({ data, password: 'abcd1234' }).promise;
    return pdf.numPages;
  }, Buffer.from(bytes).toString('base64'));
  expect(pages).toBe(3);

  // 読み込み直すと、パスワードの設定は消えている（保存していない）
  await page.evaluate(() => window.__relapdf.flushSave());
  await page.reload();
  await expect(cards(page)).toHaveCount(3);
  await expect(page.locator('#protect-status')).toBeHidden();
  const saved = await page.evaluate(() => JSON.stringify(window.__relapdf.getDoc()));
  expect(saved).not.toContain('abcd1234');
});
