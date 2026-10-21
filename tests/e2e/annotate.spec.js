// 画面テスト：M6（注釈・署名：文字・図形・署名や印鑑の画像をページに置く）
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFRawStream } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';

const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url).pathname;
const cards = (page) => page.locator('.page-card');
const annotations = (page, i = 0) => page.evaluate((index) => window.__relapdf.getDoc().pages[index].annotations ?? [], i);

async function openPdf(page) {
  await page.goto('./');
  await page.click('[data-mode="detail"]');
  await page.setInputFiles('#input-files', [fixture('sample-3pages.pdf')]);
  await expect(page.locator('.page-card .thumb img[src^="blob:"]')).toHaveCount(3);
}

async function openAnnotator(page, index) {
  await page.evaluate(() => document.querySelector('#page-grid').scrollIntoView());
  // 押すたびに選ぶ・外すが切り替わるので、選ばれていないときだけ押す
  if (!(await cards(page).nth(index).evaluate((el) => el.classList.contains('selected')))) {
    await cards(page).nth(index).locator('.thumb').click();
  }
  await page.click('[data-action="open-annotator"]');
  await expect(page.locator('#annotator')).toBeVisible();
  await expect(page.locator('#annotator')).not.toHaveClass(/loading/);
  return page.locator('#annotator-page').boundingBox();
}

/** ページの絵の上を、割合で指定してなぞる */
async function dragOn(page, box, [x1, y1], [x2, y2]) {
  await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * x2, box.y + box.height * y2, { steps: 6 });
  await page.mouse.up();
}

/** できたPDFの文字と、画面で見たときの文字の向き（度） */
async function readTexts(page, bytes) {
  return page.evaluate(async (b64) => {
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    const pdf = await pdfjs.getDocument({ data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i);
      const viewport = p.getViewport({ scale: 1 });
      pages.push(
        (await p.getTextContent()).items
          .filter((item) => item.str.trim())
          .map((item) => {
            const [a, b] = pdfjs.Util.transform(viewport.transform, item.transform);
            return { text: item.str, angle: Math.round((Math.atan2(b, a) * 180) / Math.PI) };
          }),
      );
    }
    return pages;
  }, Buffer.from(bytes).toString('base64'));
}

test('四角・矢印・文字を置き、動かしたり消したりして、PDFに書き出す', async ({ page }) => {
  await openPdf(page);
  let box = await openAnnotator(page, 0);

  // 四角
  await page.click('[data-tool="rect"]');
  await dragOn(page, box, [0.2, 0.3], [0.6, 0.45]);
  // 矢印（青）
  await page.click('[data-color="blue"]');
  await page.click('[data-tool="arrow"]');
  await dragOn(page, box, [0.2, 0.7], [0.5, 0.6]);
  // 文字
  await page.click('[data-tool="text"]');
  await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.1);
  await expect(page.locator('#annotator-text')).toBeVisible();
  await page.keyboard.type('確認済み');
  // 押しただけ（なぞっていない）では、図形はできない
  await page.click('[data-tool="ellipse"]');
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.8);
  await page.click('[data-annot="apply"]');
  await expect(page.locator('#annotator')).toBeHidden();

  let list = await annotations(page);
  expect(list.map((a) => a.type).sort()).toEqual(['arrow', 'rect', 'text']);
  const rect = list.find((a) => a.type === 'rect');
  expect(rect.x).toBeCloseTo(0.2, 1);
  expect(rect.w).toBeCloseTo(0.4, 1);
  expect(list.find((a) => a.type === 'arrow').color).toBe('blue');
  await expect(cards(page).nth(0).locator('.badge')).toHaveText('注釈3');

  // 開き直して、四角を動かし、矢印を消す
  box = await openAnnotator(page, 0);
  await page.click('[data-tool="select"]');
  await dragOn(page, box, [0.2, 0.37], [0.3, 0.47]); // 四角の左の辺をつかんで動かす
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.65); // 矢印を選ぶ
  await page.click('[data-annot="delete"]');
  await page.click('[data-annot="apply"]');
  list = await annotations(page);
  expect(list.map((a) => a.type).sort()).toEqual(['rect', 'text']);
  expect(list.find((a) => a.type === 'rect').x).toBeCloseTo(0.3, 1);

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]:visible')]);
  const texts = await readTexts(page, await readFile(await download.path()));
  expect(texts[0].some((item) => item.text === '確認済み')).toBe(true);
});

test('回転したページに置いた文字は、画面で見たとおり横書きで書き出す', async ({ page }) => {
  await openPdf(page);
  await cards(page).nth(1).locator('[data-op="rotate"]').click(); // 2ページ目（横向き）を右に回す
  const box = await openAnnotator(page, 1);
  await page.click('[data-tool="text"]');
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.keyboard.type('承認');
  await page.click('[data-annot="apply"]');
  const [text] = await annotations(page, 1);
  expect(text.rotation).toBe(270); // 回転前のページに対しては左に90度

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]:visible')]);
  const texts = await readTexts(page, await readFile(await download.path()));
  const item = texts[1].find((t) => t.text === '承認');
  expect(item.angle).toBe(0);
  // 元の「Page 2」の文字は、ページと一緒に回っている
  expect(Math.abs(texts[1].find((t) => t.text === 'Page 2').angle)).toBe(90);
});

test('署名を手で書いてページに置き、次からは「前に使った画像」から選べる', async ({ page }) => {
  await openPdf(page);
  const box = await openAnnotator(page, 0);
  await page.click('[data-annot="image"]');
  const dialog = page.locator('#signature-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#signature-recent')).toBeHidden();
  await dialog.locator('[data-sig-tab="draw"]').click();
  const pad = await page.locator('#signature-pad').boundingBox();
  await page.mouse.move(pad.x + pad.width * 0.1, pad.y + pad.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(pad.x + pad.width * (0.1 + i * 0.07), pad.y + pad.height * (0.6 - (i % 2) * 0.3));
  await page.mouse.up();
  await dialog.locator('#signature-color').selectOption('blue');
  await expect(page.locator('#signature-submit')).toBeEnabled();
  await page.click('#signature-submit');
  await expect(dialog).toBeHidden();
  // 置いた画像は選ばれていて、大きさを変えられる
  const handle = page.locator('#annotator-svg [data-handle="resize"]');
  await expect(handle).toBeVisible();
  const h = await handle.boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + box.width * 0.1, h.y + h.height / 2 + 20, { steps: 5 });
  await page.mouse.up();
  await page.click('[data-annot="apply"]');

  const [image] = await annotations(page);
  expect(image.type).toBe('image');
  expect(image.w).toBeGreaterThan(0.35); // 最初は約0.3 → 大きくした
  const source = await page.evaluate((id) => window.__relapdf.getDoc().sources[id], image.sourceId);
  expect(source.asset).toBe(true);
  expect(source.mimeType).toBe('image/png');

  // 別のページでは、前に使った画像から選べる
  await page.keyboard.press('Escape'); // 選択を外す
  await openAnnotator(page, 2);
  await page.click('[data-annot="image"]');
  await expect(page.locator('#signature-recent')).toBeVisible();
  await page.locator('#signature-recent-list button').first().click();
  await page.click('[data-annot="apply"]');
  expect((await annotations(page, 2))[0].sourceId).toBe(image.sourceId);

  // 書き出すと、画像は1回だけ入る（透明の部分＝マスクと合わせて2つ）
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]:visible')]);
  const pdf = await PDFDocument.load(await readFile(await download.path()));
  let images = 0;
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) images += 1;
  }
  expect(images).toBe(2);
});

test('墨消し：黒く塗った下の文字は、書き出したPDFから消える（そのページは画像になる）', async ({ page }) => {
  await openPdf(page);
  await openAnnotator(page, 0);
  await page.click('[data-tool="redact"]');
  await expect(page.locator('#annotator-hint')).toContainText('下の文字も消えます');
  // 説明が長くなって折り返すと、ページの絵の位置が変わるので、測り直す
  await page.waitForTimeout(100);
  const box = await page.locator('#annotator-page').boundingBox();
  // 左上の「Page 1」の文字のあたりを塗る
  await dragOn(page, box, [0.03, 0.03], [0.5, 0.15]);
  await page.click('[data-annot="apply"]');
  await expect(cards(page).nth(0).locator('.badge')).toContainText('墨消し');

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="export"]:visible')]);
  const bytes = await readFile(await download.path());
  const texts = await readTexts(page, bytes);
  expect(texts[0]).toEqual([]); // 1ページ目は画像になり、文字のデータはない
  expect(texts[1].some((t) => t.text === 'Page 2')).toBe(true); // ほかのページはそのまま
  const pdf = await PDFDocument.load(bytes);
  const { width, height } = pdf.getPage(0).getSize();
  expect(Math.round(width)).toBe(595); // 大きさは元のページと同じ
  expect(Math.round(height)).toBe(842);
});
