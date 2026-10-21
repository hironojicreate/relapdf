import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';
import { cropToPageBox, describeLayout, hasLayout, normalizeCrop, normalizeLayout, planSheets } from '../../src/core/imposition.js';
import { addSource, appendSourcePages, createDocument, rotatePages, setCrop, setLayout, validateDocument } from '../../src/core/page-list.js';
import { exportPdf } from '../../src/core/pdf-export.js';

const A4 = { width: 595.28, height: 841.89 };
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg ?? ''} ${a} ≈ ${b}`);

test('設定を確かめる', () => {
  assert.deepEqual(normalizeLayout({ nup: 2 }), { paper: 'none', orientation: 'auto', nup: 2, margin: 'none', border: false });
  assert.throws(() => normalizeLayout({ nup: 3 }), /割付の数/);
  assert.throws(() => normalizeLayout({ paper: 'A9' }), /用紙サイズ/);
  assert.equal(hasLayout(normalizeLayout({})), false);
  assert.equal(describeLayout(normalizeLayout({ paper: 'B5' })), 'B5に合わせる');
  assert.equal(describeLayout(normalizeLayout({ nup: 4 })), 'A4に4ページずつ');
  assert.throws(() => normalizeCrop({ x: 0.5, y: 0, w: 0.6, h: 1 }), /範囲が不正/);
});

test('用紙サイズの変換：A3のページをA4に縮めて、真ん中に置く', () => {
  const [sheet] = planSheets([{ width: 841.89, height: 1190.55 }], normalizeLayout({ paper: 'A4' }));
  close(sheet.width, A4.width);
  close(sheet.height, A4.height);
  const [cell] = sheet.cells;
  close(cell.scale, A4.width / 841.89);
  close(cell.x, 0);
});

test('2in1：縦長のページ2枚を、横向きのA4に左右に並べる。4in1は縦向きに2×2', () => {
  const pages = [A4, A4, A4];
  const sheets = planSheets(pages, normalizeLayout({ nup: 2 }));
  assert.equal(sheets.length, 2);
  assert.ok(sheets[0].width > sheets[0].height, '横向きの用紙');
  const [left, right] = sheets[0].cells;
  assert.ok(left.x < right.x && Math.abs(left.y - right.y) < 0.01, '左右に並ぶ');
  assert.equal(sheets[1].cells.length, 1, '最後の用紙は1ページだけ');

  const [four] = planSheets([A4, A4, A4, A4], normalizeLayout({ nup: 4, margin: 'small' }));
  assert.ok(four.height > four.width);
  const [a, b, c] = four.cells;
  assert.ok(a.x < b.x && a.y > c.y, '左上 → 右上 → 左下の順');
  assert.ok(a.x >= 18 && a.y + a.height <= four.height - 18 + 0.01, '余白');
});

test('トリミングの範囲を、PDFの座標にする（もともと回転しているページも）', () => {
  const box = { x: 0, y: 0, width: 600, height: 800 };
  // 上半分（回転なし）
  assert.deepEqual(cropToPageBox({ x: 0, y: 0, w: 1, h: 0.5 }, box, 0), { x: 0, y: 400, width: 600, height: 400 });
  // もともと右に90度回っているページ：画面では横800・縦600。画面の左半分は、PDFでは下半分
  assert.deepEqual(cropToPageBox({ x: 0, y: 0, w: 0.5, h: 1 }, box, 90), { x: 0, y: 0, width: 600, height: 400 });
});

test('書き出し：トリミングと2in1（回転したページも、画面の向きで並べる）', async () => {
  const pdfBytes = new Uint8Array(await readFile(new URL('../fixtures/sample-3pages.pdf', import.meta.url)));
  let doc = addSource(createDocument(), { id: 'pdf1', kind: 'pdf', pageCount: 3 });
  doc = appendSourcePages(doc, 'pdf1', { ids: ['a', 'b', 'c'] });
  doc = rotatePages(doc, ['b'], 90);
  doc = setCrop(doc, ['a'], { x: 0, y: 0, w: 1, h: 0.5 });
  assert.ok(validateDocument(JSON.parse(JSON.stringify(doc))));
  const options = { getSourceBytes: async () => pdfBytes, getImage: async () => null };

  const cropped = await PDFDocument.load(await exportPdf(doc, options));
  const box = cropped.getPage(0).getCropBox();
  close(box.height, 841.89 / 2, '上半分だけ見せる');
  close(box.y, 841.89 / 2);

  // （トリミングした1ページ目は横長になるので、2in1 はトリミングしていない状態で確かめる）
  const sheets = await PDFDocument.load(await exportPdf(setLayout(setCrop(doc, ['a'], null), { nup: 2 }), options));
  assert.equal(sheets.getPageCount(), 2);
  const { width, height } = sheets.getPage(0).getSize();
  assert.ok(width > height, '横向きのA4');
  close(width, 841.89);
});

test('トリミングの範囲を、画面の向きと回転前の向きで行き来する', async () => {
  const { cropFromDisplay, cropToDisplay } = await import('../../src/core/imposition.js');
  const display = { x: 0, y: 0, w: 0.5, h: 1 }; // 画面で左半分
  // 右に90度回したページ：画面の左半分は、回転前の下半分
  const base = cropFromDisplay(display, 90);
  for (const [k, v] of Object.entries({ x: 0, y: 0.5, w: 1, h: 0.5 })) close(base[k], v, k);
  const back = cropToDisplay(base, 90);
  for (const [k, v] of Object.entries(display)) close(back[k], v, k);
});

test('割付しても、写真のページの画像は抜け落ちない', async () => {
  const { PDFName, PDFRawStream } = await import('../../vendor/pdf-lib/pdf-lib.esm.min.js');
  const jpg = new Uint8Array(await readFile(new URL('../fixtures/photo-landscape.jpg', import.meta.url)));
  let doc = addSource(createDocument(), { id: 'j', kind: 'image', width: 400, height: 300 });
  doc = appendSourcePages(doc, 'j', { ids: ['a', 'b'] });
  doc = setLayout(doc, { nup: 2 });
  const bytes = await exportPdf(doc, {
    getSourceBytes: async () => null,
    getImage: async () => ({ bytes: jpg, format: 'jpeg', width: 400, height: 300 }),
  });
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1);
  const images = [...pdf.context.enumerateIndirectObjects()].filter(
    ([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'),
  );
  assert.ok(images.length >= 1, '画像が入っている');
});
