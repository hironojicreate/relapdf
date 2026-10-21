import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';
import {
  addSource,
  appendSourcePages,
  createBlankPage,
  createDocument,
  createSourcePage,
  insertPages,
  movePages,
  rotatePages,
} from '../../src/core/page-list.js';
import { EncryptedPdfError, InvalidPdfError, exportPdf, inspectPdf } from '../../src/core/pdf-export.js';

const fixture = (name) => readFile(new URL(`../fixtures/${name}`, import.meta.url)).then((b) => new Uint8Array(b));

async function setup() {
  const pdfBytes = await fixture('sample-3pages.pdf');
  const jpg = await fixture('photo-landscape.jpg');
  const png = await fixture('photo-landscape.png');
  let doc = createDocument();
  doc = addSource(doc, { id: 'pdf1', kind: 'pdf', pageCount: 3 });
  doc = addSource(doc, { id: 'jpg', kind: 'image', width: 400, height: 300 });
  doc = addSource(doc, { id: 'png', kind: 'image', width: 400, height: 300 });
  doc = appendSourcePages(doc, 'pdf1', { ids: ['p1', 'p2', 'p3'] });
  doc = appendSourcePages(doc, 'jpg', { ids: ['j'] });
  doc = appendSourcePages(doc, 'png', { ids: ['g'] });
  const options = {
    getSourceBytes: async (id) => {
      assert.equal(id, 'pdf1');
      return pdfBytes;
    },
    getImage: async (page) =>
      page.content.sourceId === 'jpg'
        ? { bytes: jpg, format: 'jpeg', width: 400, height: 300 }
        : { bytes: png, format: 'png', width: 400, height: 300 },
    date: new Date('2026-10-18T00:00:00Z'),
  };
  return { doc, options, pdfBytes };
}

const sizeOf = (page) => {
  const { width, height } = page.getSize();
  return [Math.round(width), Math.round(height)];
};

test('PDFのページ数と、入力欄（フォーム）の数を調べられる', async () => {
  assert.deepEqual(await inspectPdf(await fixture('sample-3pages.pdf')), { pageCount: 3, formFieldCount: 0 });
  assert.deepEqual(await inspectPdf(await fixture('form.pdf')), { pageCount: 2, formFieldCount: 5 });
});

test('PDFと画像を並びの順番で1つのPDFにする', async () => {
  const { doc, options } = await setup();
  const reordered = movePages(doc, ['j'], 0);
  const out = await PDFDocument.load(await exportPdf(reordered, { ...options, title: 'テスト' }), { updateMetadata: false });
  assert.equal(out.getPageCount(), 5);
  const pages = out.getPages();
  assert.deepEqual(sizeOf(pages[0]), [842, 595], '横長の写真は横向きのA4');
  assert.deepEqual(sizeOf(pages[1]), [595, 842]);
  assert.deepEqual(sizeOf(pages[2]), [842, 595], 'PDFの横向きページはそのまま');
  assert.equal(out.getTitle(), 'テスト');
  assert.equal(out.getProducer(), 'RelaPDF');
});

test('回転：PDFにもともと付いている回転にユーザーの回転を足す', async () => {
  const { doc, options } = await setup();
  const rotated = rotatePages(doc, ['p1', 'p3', 'j'], 90);
  const out = await PDFDocument.load(await exportPdf(rotated, options));
  const angles = out.getPages().map((p) => p.getRotation().angle);
  assert.deepEqual(angles, [90, 0, 180, 90, 0]);
});

test('同じページを2回使っても、別のページとして出力される', async () => {
  const { doc, options } = await setup();
  const twice = insertPages(doc, [createSourcePage(doc, 'pdf1', 0, 'p1copy')]);
  const out = await PDFDocument.load(await exportPdf(twice, options));
  assert.equal(out.getPageCount(), 6);
});

test('写真のサイズのまま、と白紙ページ', async () => {
  const { doc, options } = await setup();
  const withBlank = insertPages(doc, [createBlankPage({ width: 300, height: 400 }, 'b')], 0);
  const out = await PDFDocument.load(await exportPdf(withBlank, { ...options, paper: 'image' }));
  const pages = out.getPages();
  assert.deepEqual(sizeOf(pages[0]), [300, 400]);
  assert.deepEqual(sizeOf(pages[4]), [842, 631], '400x300の写真は長辺842ptで同じ比率');
});

test('ページがなければエラー', async () => {
  const { options } = await setup();
  await assert.rejects(() => exportPdf(createDocument(), options), /ページがありません/);
});

test('パスワード付きPDFはわかりやすいエラーにする', async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const encrypt = pdf.context.obj({ Filter: 'Standard', V: 1, R: 2 });
  pdf.context.trailerInfo.Encrypt = pdf.context.register(encrypt);
  const bytes = await pdf.save({ useObjectStreams: false });
  await assert.rejects(() => inspectPdf(bytes), EncryptedPdfError);
});

test('PDFではないファイルはわかりやすいエラーにする', async () => {
  await assert.rejects(() => inspectPdf(new TextEncoder().encode('hello')), InvalidPdfError);
});


test('文書のプロパティ（タイトル・作成者・件名・キーワード）を書き込む', async () => {
  const { setProperties } = await import('../../src/core/page-list.js');
  const { doc, options } = await setup();
  const withProps = setProperties(doc, { title: '  見積書  ', author: '山田', subject: '', keywords: '見積, 2026、急ぎ' });
  assert.deepEqual(withProps.properties, { title: '見積書', author: '山田', keywords: '見積, 2026、急ぎ' });
  const pdf = await PDFDocument.load(await exportPdf(withProps, { ...options, title: 'ファイル名' }), { updateMetadata: false });
  assert.equal(pdf.getTitle(), '見積書');
  assert.equal(pdf.getAuthor(), '山田');
  assert.equal(pdf.getKeywords(), '見積 2026 急ぎ');
  assert.equal(setProperties(doc, { title: ' ' }).properties, null);
});

test('暗号化の情報がそろっているかを見分ける（パスワードを聞くか、壊れたファイルとして扱うか）', async () => {
  const { hasValidEncryption } = await import('../../src/core/pdf-export.js');
  assert.equal(await hasValidEncryption(await fixture('locked.pdf')), true);
  const broken = await PDFDocument.create();
  broken.addPage();
  broken.context.trailerInfo.Encrypt = broken.context.register(broken.context.obj({ Filter: 'Standard' }));
  assert.equal(await hasValidEncryption(await broken.save({ useObjectStreams: false })), false);
  assert.equal(await hasValidEncryption(await fixture('sample-3pages.pdf')), false);
  await assert.rejects(inspectPdf(await fixture('locked.pdf')), EncryptedPdfError);
});
