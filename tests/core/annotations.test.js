import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';
import fontkit from '../../vendor/fontkit/fontkit.mjs';
import { annotationItems, normalizeAnnotation } from '../../src/core/annotations.js';
import {
  addSource,
  appendSourcePages,
  createBlankPage,
  createDocument,
  insertPages,
  pruneSources,
  rotatePages,
  setAnnotations,
  validateDocument,
} from '../../src/core/page-list.js';
import { exportPdf } from '../../src/core/pdf-export.js';

const A4 = { width: 595, height: 842 };

test('注釈の形を確かめる', () => {
  assert.deepEqual(normalizeAnnotation({ id: 'a', type: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.1, color: 'red', extra: 1 }), {
    id: 'a', type: 'rect', color: 'red', x: 0.1, y: 0.2, w: 0.3, h: 0.1,
  });
  assert.equal(normalizeAnnotation({ id: 't', type: 'text', x: 0, y: 0, text: 'a', size: 0.02, color: 'red' }).rotation, 0);
  assert.throws(() => normalizeAnnotation({ id: 't', type: 'text', x: 0, y: 0, text: 'a', size: 0.02, color: 'red', rotation: 45 }), /向きが不正/);
  assert.throws(() => normalizeAnnotation({ id: 'a', type: 'star', color: 'red' }), /種類が不正/);
  assert.throws(() => normalizeAnnotation({ id: 'a', type: 'rect', x: 0, y: 0, w: 0, h: 1, color: 'red' }), /大きさが不正/);
  assert.throws(() => normalizeAnnotation({ id: 'a', type: 'text', x: 0, y: 0, text: 'a', size: 0.02, color: 'pink' }), /色が不正/);
  assert.throws(() => normalizeAnnotation({ id: 'a', type: 'image', x: 0, y: 0, w: 1, h: 1 }), /元データ/);
});

test('回転していないページ：左上の割合を、左下が原点のポイントにする', () => {
  const [rect] = annotationItems([{ id: 'a', type: 'rect', x: 0.1, y: 0.2, w: 0.5, h: 0.25, color: 'red' }], { ...A4, rotation: 0 });
  assert.equal(rect.type, 'rect');
  assert.ok(Math.abs(rect.x - 59.5) < 1e-9 && Math.abs(rect.y - 842 * 0.55) < 1e-9, `${rect.x}, ${rect.y}`);
  assert.equal(rect.width, 297.5);
  assert.equal(rect.angle, 0);
  const [text] = annotationItems([{ id: 't', type: 'text', x: 0, y: 0, text: '確認\n済み', size: 0.02, color: 'black' }], { ...A4, rotation: 0 });
  assert.ok(text.y < 842 && text.y > 830, '1行目は上の端の近く');
});

test('右に90度回したページ：注釈もページの中身と一緒に回る', () => {
  // 回転前の左上の点は、画面では右上に来る
  const [line] = annotationItems([{ id: 'l', type: 'line', x1: 0, y1: 0, x2: 0.5, y2: 0, color: 'blue' }], { ...A4, rotation: 90 });
  // 画面では横842・縦595。回転前の左上 → 画面の右上 (842, 595)、上の辺の中ほど → 右の辺の中ほど
  assert.ok(Math.abs(line.x1 - 842) < 1e-9 && Math.abs(line.y1 - 595) < 1e-9);
  assert.ok(Math.abs(line.x2 - 842) < 1e-9 && Math.abs(line.y2 - 297.5) < 1e-9);
  const [rect] = annotationItems([{ id: 'a', type: 'rect', x: 0, y: 0, w: 0.5, h: 0.5, color: 'red' }], { ...A4, rotation: 90 });
  assert.equal(rect.angle, 270, '横向きの辺は、画面では下向き');
});

test('回転したページに、画面で正しい向きに置いた文字・画像は、画面では横向き（0度）のまま', () => {
  // 右に90度回したページで、画面で見て横書きにした文字は、回転前のページに対して左に90度（右に270度）回っている
  const [text] = annotationItems([{ id: 't', type: 'text', x: 0.5, y: 0.5, text: '承認', size: 0.03, color: 'red', rotation: 270 }], { ...A4, rotation: 90 });
  assert.equal(text.angle, 0);
  const [image] = annotationItems([{ id: 'i', type: 'image', x: 0.5, y: 0.5, w: 0.2, h: 0.1, sourceId: 's', rotation: 270 }], { ...A4, rotation: 90 });
  assert.equal(image.angle, 0);
  // 画像の左上（画面で）が、置いた位置に来る：左下の角は、そこから画像の高さだけ下
  const anchor = { x: (1 - 0.5) * 842, y: (1 - 0.5) * 595 };
  assert.ok(Math.abs(image.x - anchor.x) < 1e-9, `${image.x}`);
  assert.ok(Math.abs(image.y - (anchor.y - 0.1 * 595)) < 1e-9, `${image.y}`);
});

test('ページリスト：注釈を置き、画像の注釈が使う元データは残す', () => {
  let doc = addSource(createDocument(), { id: 'sig', kind: 'image', width: 200, height: 80, asset: true });
  doc = insertPages(doc, [createBlankPage(undefined, 'p1')]);
  assert.equal(doc.sources.sig.asset, true);
  doc = setAnnotations(doc, 'p1', [{ id: 'i', type: 'image', x: 0.6, y: 0.8, w: 0.25, h: 0.1, sourceId: 'sig' }]);
  assert.ok(validateDocument(JSON.parse(JSON.stringify(doc))));
  assert.equal(pruneSources(doc).removedSourceIds.length, 0, '使っている署名は残す');
  const cleared = setAnnotations(doc, 'p1', []);
  assert.equal(cleared.pages[0].annotations, undefined);
  assert.deepEqual(pruneSources(cleared).removedSourceIds, ['sig'], '使わなくなった署名は消す');
  assert.throws(() => setAnnotations(doc, 'p1', [{ id: 'i', type: 'image', x: 0, y: 0, w: 1, h: 1, sourceId: 'none' }]), /画像が見つかりません/);
});

test('書き出し：文字・図形・署名の画像を、回転したページにも描く', async () => {
  const pdfBytes = new Uint8Array(await readFile(new URL('../fixtures/sample-3pages.pdf', import.meta.url)));
  const png = new Uint8Array(await readFile(new URL('../fixtures/photo-landscape.png', import.meta.url)));
  const fontBytes = new Uint8Array(await readFile(new URL('../../vendor/fonts/BIZUDGothic-Regular.ttf', import.meta.url)));
  let doc = addSource(createDocument(), { id: 'pdf1', kind: 'pdf', pageCount: 3 });
  doc = addSource(doc, { id: 'sig', kind: 'image', width: 400, height: 300, asset: true });
  doc = appendSourcePages(doc, 'pdf1', { ids: ['a', 'b', 'c'] });
  doc = rotatePages(doc, ['b'], 90);
  const list = [
    { id: '1', type: 'text', x: 0.1, y: 0.1, text: '確認しました', size: 0.025, color: 'red' },
    { id: '2', type: 'arrow', x1: 0.2, y1: 0.5, x2: 0.5, y2: 0.4, color: 'blue' },
    { id: '3', type: 'ellipse', x: 0.3, y: 0.3, w: 0.2, h: 0.1, color: 'green' },
    { id: '4', type: 'highlight', x: 0.1, y: 0.6, w: 0.5, h: 0.03, color: 'yellow' },
    { id: '5', type: 'image', x: 0.6, y: 0.8, w: 0.25, h: 0.1, sourceId: 'sig' },
  ];
  doc = setAnnotations(doc, 'a', list);
  doc = setAnnotations(doc, 'b', list);
  let imageCalls = 0;
  const bytes = await exportPdf(doc, {
    getSourceBytes: async () => pdfBytes,
    getImage: async () => null,
    getFont: async () => ({ bytes: fontBytes, fontkit }),
    getAnnotationImage: async () => {
      imageCalls += 1;
      return { bytes: png, format: 'png' };
    },
  });
  assert.equal(imageCalls, 1, '同じ画像は1回だけ埋め込む');
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 3);
  assert.equal(pdf.getPage(1).getRotation().angle, 90);
});
