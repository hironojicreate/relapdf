// 画面テスト：M2（かんたんモード v1）
// 連続撮影・3ステップ・作業途中の自動保存・ドラッグでの並べ替え
import { test, expect } from '@playwright/test';

const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url).pathname;
const cards = (page) => page.locator('.page-card');
const loadedThumbs = (page) => page.locator('.page-card .thumb img[src^="blob:"]');
const currentStep = (page) => page.locator('#steps [aria-current="step"]');

// 並び順を、元データのファイル名の配列で返す
const order = (page) =>
  page.evaluate(() => {
    const doc = window.__relapdf.getDoc();
    return doc.pages.map((p) => doc.sources[p.content.sourceId].name);
  });

async function useEasyMode(page) {
  await page.goto('./');
  await page.click('[data-mode="easy"]');
}

test('アプリ内カメラで続けて3枚撮り、確認の段階に進む', async ({ page }) => {
  await useEasyMode(page);
  await expect(currentStep(page)).toContainText('撮る・選ぶ');
  await page.click('#empty [data-action="camera"]');
  await expect(page.locator('#camera')).toBeVisible();
  const shutter = page.locator('#camera-shutter');
  await expect(shutter).toBeEnabled();
  await expect(page.locator('[data-camera="done"]')).toHaveText('閉じる');

  for (let i = 1; i <= 3; i++) {
    await shutter.click();
    await expect(page.locator('#camera-count')).toHaveText(`${i}枚`);
  }
  await expect(page.locator('#camera-last')).toBeVisible();
  await expect(page.locator('[data-camera="done"]')).toHaveText('完了');
  await page.click('[data-camera="done"]');

  await expect(page.locator('#camera')).toBeHidden();
  await expect(cards(page)).toHaveCount(3);
  await expect(loadedThumbs(page)).toHaveCount(3);
  await expect(currentStep(page)).toContainText('確認');
  // カメラは止まっている
  expect(await page.evaluate(() => document.querySelector('#camera-video').srcObject)).toBeNull();
  const sizes = await page.evaluate(() => Object.values(window.__relapdf.getDoc().sources).map((s) => s.width * s.height));
  expect(sizes.every((n) => n > 0)).toBe(true);
});

test('カメラを使えないときは理由を表示し、端末のカメラアプリに切り替えられる', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('denied', 'NotAllowedError');
    };
  });
  await useEasyMode(page);
  await page.click('#empty [data-action="camera"]');
  await expect(page.locator('#camera-error')).toBeVisible();
  await expect(page.locator('#camera-error-text')).toContainText('許可されていません');
  await expect(page.locator('#camera-shutter')).toBeDisabled();

  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-camera="os-camera"]')]);
  expect(await chooser.element().getAttribute('capture')).toBe('environment');
  await expect(page.locator('#camera')).toBeHidden();
});

test('3ステップ：確認 → 保存 → 確認に戻る', async ({ page }) => {
  await useEasyMode(page);
  await page.setInputFiles('#input-photos', [fixture('photo-landscape.jpg'), fixture('photo-landscape.png')]);
  await expect(cards(page)).toHaveCount(2);
  await expect(currentStep(page)).toContainText('確認');
  await expect(page.locator('#export-bar')).toBeHidden();
  await expect(page.locator('#next-bar')).toContainText('2ページ');

  await page.click('[data-action="go-save"]');
  await expect(currentStep(page)).toContainText('保存');
  await expect(page.locator('#export-bar')).toBeVisible();
  await expect(page.locator('#workspace')).toBeHidden();
  await expect(page.locator('#save-summary')).toHaveText('2ページをPDFにします');

  await page.click('[data-action="back-to-confirm"]');
  await expect(currentStep(page)).toContainText('確認');
  await expect(page.locator('#workspace')).toBeVisible();
});

test('作業途中で読み込み直しても、続きから再開できる', async ({ page }) => {
  await useEasyMode(page);
  await page.setInputFiles('#input-photos', [fixture('photo-landscape.jpg')]);
  await expect(cards(page)).toHaveCount(1);
  await page.click('[data-mode="detail"]');
  await page.setInputFiles('#input-files', [fixture('sample-3pages.pdf')]);
  await expect(cards(page)).toHaveCount(4);
  await cards(page).nth(0).locator('[data-op="rotate"]').click();
  await page.click('[data-mode="easy"]');
  await page.click('[data-action="go-save"]');
  await page.fill('#file-name', '途中のPDF');
  await page.locator('#quality').selectOption('high');
  await page.evaluate(() => window.__relapdf.flushSave());

  await page.reload();
  await expect(page.locator('#toast')).toContainText('前回の続きから再開しました');
  await expect(currentStep(page)).toContainText('保存');
  await expect(page.locator('#file-name')).toHaveValue('途中のPDF');
  await expect(page.locator('#quality')).toHaveValue('high');
  await page.click('[data-action="back-to-confirm"]');
  await expect(cards(page)).toHaveCount(4);
  await expect(loadedThumbs(page)).toHaveCount(4, { timeout: 15_000 });
  const rotation = await page.evaluate(() => window.__relapdf.getDoc().pages[0].rotation);
  expect(rotation).toBe(90);

  // 「すべて削除」したら、読み込み直しても空のまま
  page.once('dialog', (dialog) => dialog.accept());
  await page.click('[data-action="clear"]');
  await expect(cards(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#empty')).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
});

test('PC：ページの絵をマウスでドラッグして並べ替える', async ({ page }) => {
  await page.goto('./');
  await page.click('[data-mode="detail"]');
  await page.setInputFiles('#input-files', [
    fixture('photo-landscape.jpg'),
    fixture('photo-landscape.png'),
    fixture('photo-exif-rotate90.jpg'),
  ]);
  await expect(loadedThumbs(page)).toHaveCount(3);
  const from = await cards(page).nth(0).locator('.thumb').boundingBox();
  const to = await cards(page).nth(2).locator('.thumb').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width * 0.8, to.y + to.height / 2, { steps: 8 });
  await expect(cards(page).nth(2)).toHaveClass(/drop-after/);
  await page.mouse.up();
  expect(await order(page)).toEqual(['photo-landscape.png', 'photo-exif-rotate90.jpg', 'photo-landscape.jpg']);
});

test('スマホ：つまみを押さえてドラッグして並べ替える', async ({ page }) => {
  await useEasyMode(page);
  await page.setInputFiles('#input-photos', [
    fixture('photo-landscape.jpg'),
    fixture('photo-landscape.png'),
    fixture('photo-exif-rotate90.jpg'),
  ]);
  await expect(loadedThumbs(page)).toHaveCount(3);
  // 画面の小さい端末では、3枚目は下にあるので見えるところまでスクロールする
  await cards(page).nth(2).locator('[data-drag-handle]').scrollIntoViewIfNeeded();
  const grip = await cards(page).nth(2).locator('[data-drag-handle]').boundingBox();
  const target = await cards(page).nth(0).locator('.thumb').boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width * 0.2, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await order(page)).toEqual(['photo-exif-rotate90.jpg', 'photo-landscape.jpg', 'photo-landscape.png']);
  // 並べ替えたあとも保存されている
  await page.evaluate(() => window.__relapdf.flushSave());
  await page.reload();
  await expect(cards(page)).toHaveCount(3);
  expect(await order(page)).toEqual(['photo-exif-rotate90.jpg', 'photo-landscape.jpg', 'photo-landscape.png']);
});

test('スマホ：指（タッチ操作）でつまみをドラッグして並べ替える', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name === 'pc', 'タッチ操作の端末だけ');
  await useEasyMode(page);
  await page.setInputFiles('#input-photos', [fixture('photo-landscape.jpg'), fixture('photo-landscape.png')]);
  await expect(loadedThumbs(page)).toHaveCount(2);
  const grip = await cards(page).nth(0).locator('[data-drag-handle]').boundingBox();
  const target = await cards(page).nth(1).locator('.thumb').boundingBox();
  // Chromium のタッチ入力を直接送る（Playwright の touchscreen はタップしかできないため）
  const cdp = await context.newCDPSession(page);
  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const sx = grip.x + grip.width / 2;
  const sy = grip.y + grip.height / 2;
  const ex = target.x + target.width * 0.8;
  const ey = target.y + target.height / 2;
  await touch('touchStart', sx, sy);
  for (let i = 1; i <= 10; i++) await touch('touchMove', sx + ((ex - sx) * i) / 10, sy + ((ey - sy) * i) / 10);
  await touch('touchEnd');
  await expect.poll(() => order(page)).toEqual(['photo-landscape.png', 'photo-landscape.jpg']);
});

test('カメラの明るさを調整でき、撮った写真にも反映され、次回も覚えている', async ({ page }) => {
  await useEasyMode(page);
  await page.click('#empty [data-action="camera"]');
  const shutter = page.locator('#camera-shutter');
  await expect(shutter).toBeEnabled();
  await expect(page.locator('#camera-brightness-value')).toHaveText('100%');

  // 写真の平均の明るさ（元データの中身から計算）
  const averages = () =>
    page.evaluate(async () => {
      const doc = window.__relapdf.getDoc();
      const results = [];
      for (const page of doc.pages) {
        const db = await new Promise((resolve) => {
          const req = indexedDB.open('relapdf');
          req.onsuccess = () => resolve(req.result);
        });
        const record = await new Promise((resolve) => {
          const req = db.transaction('sources').objectStore('sources').get(page.content.sourceId);
          req.onsuccess = () => resolve(req.result);
        });
        const bitmap = await createImageBitmap(new Blob([record.data], { type: record.type }));
        const c = new OffscreenCanvas(64, 48);
        const g = c.getContext('2d');
        g.drawImage(bitmap, 0, 0, 64, 48);
        const d = g.getImageData(0, 0, 64, 48).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
        results.push(sum / (d.length / 4) / 3);
      }
      return results;
    });

  await shutter.click();
  await expect(page.locator('#camera-count')).toHaveText('1枚');
  // いちばん暗くして撮る
  await page.locator('#camera-brightness').fill('-1');
  await expect(page.locator('#camera-brightness-value')).toHaveText('50%');
  expect(await page.locator('#camera-video').evaluate((v) => v.style.filter)).toBe('brightness(0.5)');
  await shutter.click();
  await expect(page.locator('#camera-count')).toHaveText('2枚');
  await page.click('[data-camera="done"]');
  await expect(cards(page)).toHaveCount(2);
  const [normal, dark] = await averages();
  expect(dark).toBeLessThan(normal * 0.7);

  // 次にカメラを開いたときも覚えている。数字を押すと元に戻る
  await page.click('#workspace [data-action="camera"]');
  await expect(page.locator('#camera-brightness-value')).toHaveText('50%');
  await page.click('#camera-brightness-value');
  await expect(page.locator('#camera-brightness-value')).toHaveText('100%');
  expect(await page.locator('#camera-video').evaluate((v) => v.style.filter)).toBe('');
});
