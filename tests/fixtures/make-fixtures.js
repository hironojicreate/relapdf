// テスト用の画像・PDFを作る（一度だけ実行して、できたファイルをリポジトリに入れる）
//   node tests/fixtures/make-fixtures.js
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { PDFDocument, StandardFonts, degrees } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';

const dir = new URL('./', import.meta.url);

// ブラウザのcanvasで画像を作る
const browser = await chromium.launch();
const page = await browser.newPage();
async function draw(type, width, height) {
  const dataUrl = await page.evaluate(
    ({ type, width, height }) => {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, width, height);
      // 左上に赤い四角を置き、向きが分かるようにする
      g.fillStyle = '#e00000';
      g.fillRect(0, 0, Math.round(width / 4), Math.round(height / 4));
      g.fillStyle = '#0000e0';
      g.fillRect(Math.round(width / 3), Math.round(height / 3), Math.round(width / 3), Math.round(height / 3));
      return c.toDataURL(type, 0.9);
    },
    { type, width, height },
  );
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

const landscapePng = await draw('image/png', 400, 300);
const landscapeJpg = await draw('image/jpeg', 400, 300);

// 机の上の書類を斜めから撮ったような写真（4点補正・自動検出の確認用）
const documentPhoto = Buffer.from(
  (
    await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 1200;
      c.height = 1600;
      const g = c.getContext('2d');
      const bg = g.createLinearGradient(0, 0, 1200, 1600);
      bg.addColorStop(0, '#6b5a48');
      bg.addColorStop(1, '#4a3d31');
      g.fillStyle = bg;
      g.fillRect(0, 0, 1200, 1600);
      // 書類の四隅（左上・右上・右下・左下）
      const q = [
        [260, 230],
        [980, 300],
        [1060, 1380],
        [150, 1290],
      ];
      g.fillStyle = '#f4f2ec';
      g.beginPath();
      q.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fill();
      // 文字の行の代わりに、書類の傾きに合わせた灰色の線を描く
      const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      g.strokeStyle = '#6d6a66';
      g.lineWidth = 9;
      for (let i = 0; i < 16; i++) {
        const t = 0.1 + i * 0.05;
        const left = lerp(q[0], q[3], t);
        const right = lerp(q[1], q[2], t);
        const len = i % 4 === 3 ? 0.5 : 0.85;
        const a = lerp(left, right, 0.08);
        const b = lerp(left, right, len);
        g.beginPath();
        g.moveTo(...a);
        g.lineTo(...b);
        g.stroke();
      }
      return c.toDataURL('image/jpeg', 0.85);
    })
  ).split(',')[1],
  'base64',
);
await browser.close();

// 写真の回転情報（EXIF Orientation = 6：右に90度回して表示）を付けたJPEG
function withExifOrientation(jpeg, orientation) {
  // APP1(Exif) セグメント：TIFFヘッダー（ビッグエンディアン）＋ IFD0 に Orientation 1項目だけ
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // ヘッダー、IFD0は8バイト目から
    0x00, 0x01, // 項目数 1
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation
    0x00, 0x00, 0x00, 0x00, // 次のIFDなし
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const length = payload.length + 2;
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, length >> 8, length & 0xff]), payload]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

// 3ページのPDF（2ページ目は横向き、3ページ目はもともと90度回転が付いている）
async function samplePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const sizes = [
    [595.28, 841.89],
    [841.89, 595.28],
    [595.28, 841.89],
  ];
  sizes.forEach(([w, h], i) => {
    const p = pdf.addPage([w, h]);
    p.drawText(`Page ${i + 1}`, { x: 50, y: h - 100, size: 48, font });
  });
  pdf.getPage(2).setRotation(degrees(90));
  return pdf.save({ useObjectStreams: false });
}

await writeFile(new URL('photo-landscape.png', dir), landscapePng);
await writeFile(new URL('photo-landscape.jpg', dir), landscapeJpg);
await writeFile(new URL('photo-exif-rotate90.jpg', dir), withExifOrientation(landscapeJpg, 6));
await writeFile(new URL('sample-3pages.pdf', dir), await samplePdf());
await writeFile(new URL('document-photo.jpg', dir), documentPhoto);
console.log('テスト用ファイルを作成しました');
