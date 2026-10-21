import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
test('font', async ({ page }) => {
  await page.goto('./');
  const b64 = readFileSync('/tmp/claude-0/-home-user-relapdf/f9522f65-aed2-5243-89c1-17414ffba8e1/scratchpad/m6/out.pdf').toString('base64');
  const text = await page.evaluate(async (b64) => {
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const doc = await pdfjs.getDocument({ data }).promise;
    const p = await doc.getPage(1);
    return (await p.getTextContent()).items.map((i) => i.str).join('|');
  }, b64);
  console.log('TEXT:', text);
  await page.click('[data-mode="detail"]');
  await page.setInputFiles('#input-files', ['/tmp/claude-0/-home-user-relapdf/f9522f65-aed2-5243-89c1-17414ffba8e1/scratchpad/m6/out.pdf']);
  await expect(page.locator('.page-card .thumb img[src^="blob:"]')).toHaveCount(1);
  await page.locator('.page-card .thumb').dblclick();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/claude-0/-home-user-relapdf/f9522f65-aed2-5243-89c1-17414ffba8e1/scratchpad/m6/font.png' });
});
