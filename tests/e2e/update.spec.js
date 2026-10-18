// 画面テスト：自動アップデートとホーム画面への追加の案内
import { test, expect } from '@playwright/test';
import { startServer } from './server.js';

const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url).pathname;

// テストごとにサーバーを立て、「新しいバージョンを公開した」状態を作れるようにする
let server;
const release = { next: false };
test.beforeEach(async () => {
  release.next = false;
  server = await startServer(0, {
    transform: (file, body) =>
      release.next && file === 'precache-manifest.js'
        ? body.toString().replace(/"version": "([0-9a-f]+)"/, '"version": "$1-next"')
        : body,
  });
});
test.afterEach(async () => {
  await server.close();
});

/** 開いて、Service Worker がページを担当するまで待つ（2回目の表示からがアプリとしての状態） */
async function openApp(page) {
  await page.goto(server.url);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

const cacheNames = (page) => page.evaluate(() => caches.keys());

test('作業中でなければ、新しいバージョンを見つけたら自動で切り替わる', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('#update-banner')).toBeHidden();

  release.next = true; // 新しいバージョンを公開
  await page.evaluate(() => window.__relapdf.checkForUpdate());

  await expect(page.locator('#toast')).toContainText('最新版', { timeout: 15_000 });
  await expect.poll(() => cacheNames(page)).toEqual([expect.stringMatching(/^relapdf-[0-9a-f]+-next$/)]);
});

test('作業中は「更新する」で切り替えてもらい、作業はそのまま残る', async ({ page }) => {
  await openApp(page);
  await page.click('[data-mode="detail"]');
  await page.setInputFiles('#input-files', [fixture('photo-landscape.jpg'), fixture('photo-landscape.png')]);
  await expect(page.locator('.page-card')).toHaveCount(2);

  release.next = true;
  await page.evaluate(() => window.__relapdf.checkForUpdate());
  await expect(page.locator('#update-banner')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.page-card')).toHaveCount(2); // 勝手に読み込み直さない

  await page.click('[data-action="apply-update"]');
  await expect(page.locator('#toast')).toContainText('最新版', { timeout: 15_000 });
  await expect(page.locator('#update-banner')).toBeHidden();
  await expect(page.locator('.page-card')).toHaveCount(2);
  await expect(page.locator('.page-card .thumb img[src^="blob:"]')).toHaveCount(2);
});

test('作業中でも、ほかのアプリに切り替えている間に自動で切り替わる', async ({ page }) => {
  await openApp(page);
  await page.click('[data-mode="easy"]');
  await page.setInputFiles('#input-photos', [fixture('photo-landscape.jpg')]);
  await expect(page.locator('.page-card')).toHaveCount(1);
  release.next = true;
  await page.evaluate(() => window.__relapdf.checkForUpdate());
  await expect(page.locator('#update-banner')).toBeVisible({ timeout: 15_000 });

  // ほかのアプリに切り替えたことにする
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#toast')).toContainText('最新版', { timeout: 15_000 });
  await expect(page.locator('.page-card')).toHaveCount(1);
});

test('カメラや補正画面を使っている間は、勝手に切り替えない', async ({ page }) => {
  await openApp(page);
  await page.click('[data-mode="easy"]');
  await page.click('#empty [data-action="camera"]');
  await expect(page.locator('#camera')).toBeVisible();
  release.next = true;
  await page.evaluate(() => window.__relapdf.checkForUpdate());
  await expect(page.locator('#update-banner')).toBeAttached();
  await expect.poll(() => page.locator('#update-banner').isHidden(), { timeout: 15_000 }).toBe(false);
  await expect(page.locator('#camera')).toBeVisible(); // カメラはそのまま
});

test('ホーム画面への追加：iPhone は手順を、Chrome はインストール画面を出す', async ({ page }, testInfo) => {
  await page.goto(server.url);
  const link = page.locator('#empty [data-action="install"]');
  if (testInfo.project.name === 'iphone') {
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.locator('#install-dialog')).toBeVisible();
    await expect(page.locator('#install-dialog')).toContainText('ホーム画面に追加');
    await page.click('[data-action="close-install"]');
    await expect(page.locator('#install-dialog')).toBeHidden();
  } else {
    // ブラウザが「インストールできます」と知らせてきたことにする
    await page.evaluate(() => {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      event.prompt = async () => {};
      event.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(event);
    });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.locator('#toast')).toContainText('ホーム画面に追加しました');
  }
});
