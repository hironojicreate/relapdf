// 画面テスト：端末内の保存領域（作業途中の自動保存・削除したときの片付け）
import { test, expect } from '@playwright/test';

const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url).pathname;
const cards = (page) => page.locator('.page-card');

/** 端末に保存されている元データ（写真・PDFの中身）の数 */
const storedSources = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('relapdf');
        req.onsuccess = () => {
          const db = req.result;
          const keys = db.transaction('sources').objectStore('sources').getAllKeys();
          keys.onsuccess = () => {
            resolve(keys.result.length);
            db.close();
          };
        };
      }),
  );

async function addPhotos(page, count) {
  await page.goto('./');
  await page.click('[data-mode="easy"]');
  const files = ['photo-landscape.jpg', 'photo-landscape.png', 'photo-exif-rotate90.jpg'].slice(0, count);
  await page.setInputFiles('#input-photos', files.map(fixture));
  await expect(cards(page)).toHaveCount(count);
  await expect.poll(() => storedSources(page)).toBe(count);
}

test('ページを削除すると、元に戻せる時間が過ぎたあと、端末に保存した中身も消える', async ({ page }) => {
  await addPhotos(page, 2);
  await cards(page).nth(0).locator('[data-op="delete"]').click();
  await expect(cards(page)).toHaveCount(1);
  expect(await storedSources(page)).toBe(2); // 「元に戻す」を押せる間は残す
  await expect.poll(() => storedSources(page), { timeout: 10_000 }).toBe(1);

  // 最初からやり直すと、すべて消える
  await page.click('[data-action="go-save"]');
  await page.click('#export-bar [data-action="restart"]');
  await expect(cards(page)).toHaveCount(0);
  await expect.poll(() => storedSources(page), { timeout: 10_000 }).toBe(0);
});

test('作業の記録がないのに中身だけ残っていたら、起動したときに消す', async ({ page }) => {
  await addPhotos(page, 1);
  // アプリを閉じてから（閉じるときにも記録を保存するため）、作業の記録だけを消す（保存の途中で閉じた場合のつもり）
  await page.goto('./tests/fixtures/photo-landscape.png');
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('relapdf');
        req.onsuccess = () => {
          const tx = req.result.transaction('state', 'readwrite');
          tx.objectStore('state').clear();
          tx.oncomplete = () => resolve();
        };
      }),
  );
  await page.goto('./');
  await expect.poll(() => storedSources(page)).toBe(0);
});

test('端末の保存領域とのつながりが切れても、つなぎ直して保存を続ける（iPhoneで裏に回したとき）', async ({ page }) => {
  // 次の1回だけ、つながりが切れたことにする
  await page.addInitScript(() => {
    const original = IDBDatabase.prototype.transaction;
    window.__dropConnection = () => {
      IDBDatabase.prototype.transaction = function (...args) {
        IDBDatabase.prototype.transaction = original;
        this.close();
        throw new DOMException('The database connection is closing.', 'InvalidStateError');
      };
    };
  });
  await addPhotos(page, 1);
  await page.evaluate(() => window.__dropConnection());
  await page.setInputFiles('#input-photos', [fixture('photo-landscape.png')]);
  await expect(cards(page)).toHaveCount(2);
  await expect.poll(() => storedSources(page)).toBe(2);
  await expect(page.locator('#toast')).not.toHaveClass(/error/);

  await page.evaluate(() => window.__relapdf.flushSave());
  await page.reload();
  await expect(cards(page)).toHaveCount(2);
});
