// 画面テストの設定
// iPhone・Android・PC の画面サイズとタッチ操作を再現する。
// ※ この環境には Chromium しかないため、iPhone も Chromium で再現している（Safari そのものではない）。
//   Safari 特有の動きは iPhone 実機で確認する。
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.js',
  timeout: 30_000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: 'retain-on-failure',
    // 文字コードの設定がない環境では、日本語のファイル名でダウンロードすると「download」に置き換わるため
    launchOptions: { env: { ...process.env, LANG: process.env.LANG || 'C.UTF-8' } },
  },
  webServer: {
    command: `node tests/e2e/server.js ${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'pc', use: { ...devices['Desktop Chrome'] } },
    { name: 'android', use: { ...devices['Pixel 7'] } },
    { name: 'iphone', use: { ...devices['iPhone 15'], browserName: 'chromium' } },
  ],
});
