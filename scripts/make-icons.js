// icons/*.svg から、ホーム画面用のPNGアイコンを作る
//   node scripts/make-icons.js
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const root = new URL('../icons/', import.meta.url);
const targets = [
  { svg: 'icon.svg', out: 'icon-192.png', size: 192 },
  { svg: 'icon.svg', out: 'icon-512.png', size: 512 },
  { svg: 'icon-maskable.svg', out: 'icon-maskable-512.png', size: 512 },
  // iPhoneのホーム画面は角を自動で丸めるので、角のない版を使う
  { svg: 'icon-maskable.svg', out: 'apple-touch-icon.png', size: 180 },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const { svg, out, size } of targets) {
  const markup = await readFile(new URL(svg, root), 'utf8');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${markup}`,
  );
  await page.screenshot({ path: new URL(out, root).pathname, omitBackground: true });
}
await browser.close();
console.log('アイコンを作成しました');
