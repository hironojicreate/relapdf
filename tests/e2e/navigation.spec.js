// 画面テスト：手順（①②③）のタップ、最初からやり直す（元に戻す）、スマホの「戻る」操作、カメラの取り消し
import { test, expect } from '@playwright/test';

const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url).pathname;
const cards = (page) => page.locator('.page-card');
const step = (page, name) => page.locator(`#steps [data-step="${name}"]`);
const currentStep = (page) => page.locator('#steps [aria-current="step"]');
const pageCount = (page) => page.evaluate(() => window.__relapdf.getDoc().pages.length);

async function startWithPhotos(page) {
  await page.goto('./');
  await page.click('[data-mode="easy"]');
  await page.setInputFiles('#input-photos', [fixture('photo-landscape.jpg'), fixture('photo-landscape.png')]);
  await expect(cards(page)).toHaveCount(2);
  await expect(currentStep(page)).toContainText('確認');
}

test('手順のボタンで、どの段階にもすぐ移れる（写真は残る）', async ({ page }) => {
  await page.goto('./');
  await page.click('[data-mode="easy"]');
  // 写真がないときは②③に進めない
  await expect(step(page, 'confirm')).toBeDisabled();
  await expect(step(page, 'save')).toBeDisabled();

  await page.setInputFiles('#input-photos', [fixture('photo-landscape.jpg'), fixture('photo-landscape.png')]);
  await expect(currentStep(page)).toContainText('確認');

  await step(page, 'save').click();
  await expect(currentStep(page)).toContainText('保存');
  await expect(page.locator('#export-bar')).toBeVisible();

  // ①に戻っても写真は残り、追加で撮れることと、やり直せることがわかる
  await step(page, 'capture').click();
  await expect(currentStep(page)).toContainText('撮る・選ぶ');
  await expect(page.locator('#empty-title-easy')).toHaveText('写真を追加する');
  await expect(page.locator('#capture-more')).toContainText('2 ページあります');
  await expect(page.locator('#capture-restart')).toBeVisible();
  await expect(page.locator('#next-bar')).toContainText('確認へ進む（2ページ）');
  expect(await pageCount(page)).toBe(2);

  // ①から写真を追加すると、②に進んで後ろに追加されている
  await page.setInputFiles('#input-photos', [fixture('photo-exif-rotate90.jpg')]);
  await expect(currentStep(page)).toContainText('確認');
  await expect(cards(page)).toHaveCount(3);

  await step(page, 'capture').click();
  await page.click('#next-bar [data-action="go-confirm"]');
  await expect(currentStep(page)).toContainText('確認');
});

test('最初からやり直すと①に戻り、「元に戻す」で取り消せる', async ({ page }) => {
  await startWithPhotos(page);
  await step(page, 'save').click();
  await page.fill('#file-name', '請求書');
  await page.click('#export-bar [data-action="restart"]');

  await expect(currentStep(page)).toContainText('撮る・選ぶ');
  await expect(page.locator('#empty-title-easy')).toHaveText('写真をPDFに');
  expect(await pageCount(page)).toBe(0);
  await expect(page.locator('#toast')).toContainText('すべて削除しました');
  await page.click('#toast-action');

  await expect(currentStep(page)).toContainText('保存');
  await expect(page.locator('#file-name')).toHaveValue('請求書');
  expect(await pageCount(page)).toBe(2);
  await expect(page.locator('#toast')).toContainText('元に戻しました');
});

test('②の「すべて削除」も元に戻せる。時間が過ぎたら端末からも消える', async ({ page }) => {
  await startWithPhotos(page);
  await page.click('#workspace [data-action="clear"]');
  expect(await pageCount(page)).toBe(0);
  await page.click('#toast-action');
  await expect(cards(page)).toHaveCount(2);
  await expect(page.locator('.page-card .thumb img[src^="blob:"]')).toHaveCount(2);

  await page.click('#workspace [data-action="clear"]');
  await expect(page.locator('#toast-action')).toBeVisible();
  await expect(page.locator('#toast')).not.toHaveClass(/show/, { timeout: 10_000 });
  const stored = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('relapdf');
        req.onsuccess = () => {
          const keys = req.result.transaction('sources').objectStore('sources').getAllKeys();
          keys.onsuccess = () => resolve(keys.result.length);
        };
      }),
  );
  expect(stored).toBe(0);
  await page.reload();
  await expect(page.locator('#empty')).toBeVisible();
});

test('スマホの「戻る」操作で、③ → ② → ① と戻れる（「進む」もできる）', async ({ page }) => {
  await startWithPhotos(page);
  await page.click('[data-action="go-save"]');
  await expect(currentStep(page)).toContainText('保存');

  await page.goBack();
  await expect(currentStep(page)).toContainText('確認');
  await page.goBack();
  await expect(currentStep(page)).toContainText('撮る・選ぶ');
  expect(await pageCount(page)).toBe(2);
  await page.goForward();
  await expect(currentStep(page)).toContainText('確認');
});

test('カメラや補正画面を開いているときの「戻る」は、その画面だけを閉じる', async ({ page }) => {
  await page.goto('./');
  await page.click('[data-mode="easy"]');
  await page.click('#empty [data-action="camera"]');
  await expect(page.locator('#camera')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#camera')).toBeHidden();
  await expect(page.locator('h1')).toHaveText('RelaPDF');
  await expect(currentStep(page)).toContainText('撮る・選ぶ');

  await page.setInputFiles('#input-photos', [fixture('photo-landscape.jpg')]);
  await cards(page).nth(0).locator('.thumb').click();
  await expect(page.locator('#editor')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#editor')).toBeHidden();
  await expect(currentStep(page)).toContainText('確認');
});

test('カメラで撮った最後の1枚を取り消せる', async ({ page }) => {
  await page.goto('./');
  await page.click('[data-mode="easy"]');
  await page.click('#empty [data-action="camera"]');
  const shutter = page.locator('#camera-shutter');
  await expect(shutter).toBeEnabled();
  for (let i = 1; i <= 3; i++) {
    await shutter.click();
    await expect(page.locator('#camera-count')).toHaveText(`${i}枚`);
  }
  await page.click('[data-camera="undo"]');
  await expect(page.locator('#camera-count')).toHaveText('1枚取り消しました');
  await expect(page.locator('#camera-count')).toHaveText('2枚');
  await page.click('[data-camera="done"]');
  await expect(cards(page)).toHaveCount(2);

  // 全部取り消すと「閉じる」に戻る
  await page.click('#workspace [data-action="camera"]');
  await expect(shutter).toBeEnabled();
  await shutter.click();
  await expect(page.locator('#camera-count')).toHaveText('1枚');
  await page.click('[data-camera="undo"]');
  await expect(page.locator('[data-camera="done"]')).toHaveText('閉じる');
  await expect(page.locator('#camera-last')).toBeHidden();
  await page.click('[data-camera="done"]');
  await expect(cards(page)).toHaveCount(2);
});
