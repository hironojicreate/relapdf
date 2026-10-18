// 画面テスト：M3（4点補正）
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';

const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url).pathname;
const cards = (page) => page.locator('.page-card');
const loadedThumbs = (page) => page.locator('.page-card .thumb img[src^="blob:"]');
const pageState = (page, i = 0) => page.evaluate((index) => window.__relapdf.getDoc().pages[index], i);

async function addPhoto(page, name = 'photo-landscape.jpg') {
  await page.goto('./');
  await page.click('[data-mode="easy"]');
  await page.setInputFiles('#input-photos', [fixture(name)]);
  await expect(loadedThumbs(page)).toHaveCount(1);
}

async function openEditor(page, i = 0) {
  await cards(page).nth(i).locator('[data-op="perspective"].icon-btn').click();
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#editor')).not.toHaveClass(/loading/);
  await expect(page.locator('#editor-overlay [data-handle]')).toHaveCount(8);
}

/** 補正画面の丸を、画像の幅・高さに対する割合（dx, dy）だけ動かす */
async function dragHandle(page, handle, dx, dy, { hold } = {}) {
  const dot = await page.locator(`#editor-overlay [data-handle="${handle}"] .dot`).boundingBox();
  const img = await page.locator('#editor-canvas').boundingBox();
  const x = dot.x + dot.width / 2;
  const y = dot.y + dot.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx * img.width, y + dy * img.height, { steps: 6 });
  if (hold) await hold();
  await page.mouse.up();
}

test('四隅を動かして補正すると、サムネイルと書き出しに反映される', async ({ page }) => {
  await addPhoto(page);
  const before = await loadedThumbs(page).getAttribute('src');
  await openEditor(page);

  // 右上と右下の角を左に寄せて、縦長の四角形にする（ルーペも確認）
  await dragHandle(page, 'c1', -0.45, 0, {
    hold: async () => {
      await expect(page.locator('#editor-loupe')).toBeVisible();
    },
  });
  await expect(page.locator('#editor-loupe')).toBeHidden();
  await dragHandle(page, 'c2', -0.45, 0);
  await page.click('[data-editor="apply"]');

  await expect(page.locator('#editor')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('補正しました');
  const state = await pageState(page);
  expect(state.perspective.aspect).toBe('free');
  expect(state.perspective.corners[1].x).toBeLessThan(0.55);
  await expect(cards(page).nth(0).locator('.badge')).toHaveText('補正済み');
  await expect(loadedThumbs(page)).toHaveCount(1);
  await expect.poll(() => loadedThumbs(page).getAttribute('src')).not.toBe(before);

  // 縦長に補正したので、横長の写真でもA4の縦向きになる
  await page.click('[data-action="go-save"]');
  await page.click('[data-action="export"]:visible');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="download"]')]);
  const pdf = await PDFDocument.load(await readFile(await download.path()));
  const { width, height } = pdf.getPage(0).getSize();
  expect([Math.round(width), Math.round(height)]).toEqual([595, 842]);
});

test('辺の中点を動かすと、その辺の両端の角が一緒に動く', async ({ page }) => {
  await addPhoto(page);
  await openEditor(page);
  // m1 = 右の辺（右上と右下の間）
  await dragHandle(page, 'm1', 0.05, 0);
  await page.click('[data-editor="apply"]');
  const { corners } = (await pageState(page)).perspective;
  expect(corners[1].x).toBeGreaterThan(0.95);
  expect(corners[2].x).toBeGreaterThan(0.95);
  expect(corners[0].x).toBeCloseTo(0.08, 2);
});

test('ねじれた形にはならない', async ({ page }) => {
  await addPhoto(page);
  await openEditor(page);
  // 左上の角を右下の角の向こうまで動かそうとしても、形が崩れる手前で止まる
  await dragHandle(page, 'c0', 0.95, 0.95);
  await page.click('[data-editor="apply"]');
  const { corners } = (await pageState(page)).perspective;
  const convex = await page.evaluate(async (c) => {
    const { isConvexQuad } = await import('./src/core/perspective.js');
    return isConvexQuad(c);
  }, corners);
  expect(convex).toBe(true);
});

test('A4比率・キャンセル・補正しない', async ({ page }) => {
  await addPhoto(page);
  await openEditor(page);
  await dragHandle(page, 'c0', 0.05, 0.05);
  await page.click('[data-editor="cancel"]');
  expect((await pageState(page)).perspective).toBeNull();

  await openEditor(page);
  await page.locator('#editor-a4').check();
  await page.click('[data-editor="apply"]');
  expect((await pageState(page)).perspective.aspect).toBe('a4');

  await openEditor(page);
  await expect(page.locator('#editor-a4')).toBeChecked();
  await page.click('[data-editor="remove"]');
  expect((await pageState(page)).perspective).toBeNull();
  await expect(page.locator('#toast')).toContainText('補正を外しました');
  await expect(cards(page).nth(0).locator('.badge')).toHaveCount(0);
});

test('回転したページは回転した向きで表示し、回転前の座標で保存する', async ({ page }) => {
  await addPhoto(page);
  await cards(page).nth(0).locator('[data-op="rotate"]').click();
  await openEditor(page);
  const box = await page.locator('#editor-canvas').boundingBox();
  expect(box.height).toBeGreaterThan(box.width); // 横長の写真を90度回したので縦長に見える
  // 画面で左上に見えている角（回転前の写真の左下の角＝c3）を、さらに左上の端まで動かす
  const handles = await page.locator('#editor-overlay .corner .dot').evaluateAll((dots) =>
    dots.map((d) => ({ id: d.parentElement.dataset.handle, x: +d.getAttribute('cx'), y: +d.getAttribute('cy') })),
  );
  const topLeft = handles.reduce((a, b) => (b.x + b.y < a.x + a.y ? b : a));
  expect(topLeft.id).toBe('c3');
  await dragHandle(page, topLeft.id, -0.2, -0.2);
  await page.click('[data-editor="apply"]');
  const { corners } = (await pageState(page)).perspective;
  // 画面の左上は、回転前の写真では左下にあたる
  expect(corners.some((c) => c.x < 0.01 && c.y > 0.99)).toBe(true);
});

test('写真のサムネイルをタップしても開き、補正は読み込み直しても残る', async ({ page }) => {
  await addPhoto(page);
  await cards(page).nth(0).locator('.thumb').click();
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#editor')).not.toHaveClass(/loading/);
  await dragHandle(page, 'c0', -0.05, -0.05);
  await page.click('[data-editor="apply"]');
  await page.evaluate(() => window.__relapdf.flushSave());
  await page.reload();
  await expect(cards(page).nth(0).locator('.badge')).toHaveText('補正済み');
  expect((await pageState(page)).perspective.corners[0].x).toBeLessThan(0.05);
});

test('PC：ページの絵をドラッグしたときは補正画面を開かない', async ({ page }) => {
  await page.goto('./');
  await page.click('[data-mode="detail"]');
  await page.setInputFiles('#input-files', [fixture('photo-landscape.jpg'), fixture('photo-landscape.png')]);
  await expect(loadedThumbs(page)).toHaveCount(2);
  const from = await cards(page).nth(0).locator('.thumb').boundingBox();
  const to = await cards(page).nth(1).locator('.thumb').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width * 0.8, to.y + to.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('#editor')).toBeHidden();
  const names = await page.evaluate(() => {
    const doc = window.__relapdf.getDoc();
    return doc.pages.map((p) => doc.sources[p.content.sourceId].name);
  });
  expect(names).toEqual(['photo-landscape.png', 'photo-landscape.jpg']);
});

test('四隅は写真の外（画面の端の方）まで動かせて、はみ出した部分は白で書き出す', async ({ page }) => {
  await addPhoto(page);
  await openEditor(page);
  // 左上の角を、写真の外へ大きく動かす
  await dragHandle(page, 'c0', -0.6, -0.6);
  // 丸は画面（補正画面の表示エリア）の中に残る
  const dot = await page.locator('#editor-overlay [data-handle="c0"] .dot').boundingBox();
  const stage = await page.locator('#editor-stage').boundingBox();
  expect(dot.x + dot.width / 2).toBeGreaterThanOrEqual(stage.x - 1);
  expect(dot.y + dot.height / 2).toBeGreaterThanOrEqual(stage.y - 1);
  await page.click('[data-editor="apply"]');
  const { corners } = (await pageState(page)).perspective;
  expect(Math.min(corners[0].x, corners[0].y)).toBeLessThan(0);
  expect(Math.min(corners[0].x, corners[0].y)).toBeGreaterThanOrEqual(-0.25);

  await page.click('[data-action="go-save"]');
  await page.click('[data-action="export"]:visible');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-action="download"]')]);
  const pdf = await PDFDocument.load(await readFile(await download.path()));
  expect(pdf.getPageCount()).toBe(1);
});
