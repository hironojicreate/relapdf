import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';
import fontkit from '../../vendor/fontkit/fontkit.mjs';
import { normalizeFormValues, readFormFieldsFromBytes } from '../../src/core/forms.js';
import { addSource, appendSourcePages, createDocument, pruneSources, removePages, setFormValues, validateDocument } from '../../src/core/page-list.js';
import { exportPdf } from '../../src/core/pdf-export.js';

const read = (path) => readFile(new URL(path, import.meta.url)).then((b) => new Uint8Array(b));

test('入力欄を読み取る（種類・選択肢・どのページにあるか・説明）', async () => {
  const fields = await readFormFieldsFromBytes(await read('../fixtures/form.pdf'));
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.deepEqual(Object.keys(byName), ['name', 'agree', 'contact', 'pref', 'note']);
  assert.equal(byName.name.label, 'Your name');
  assert.equal(byName.agree.type, 'checkbox');
  assert.deepEqual(byName.contact.options, ['mail', 'phone']);
  assert.equal(byName.pref.type, 'dropdown');
  assert.deepEqual(byName.note.pages, [1]);
  assert.equal(byName.note.multiline, true);
});

test('入力内容はPDFごとに持ち、そのPDFを使わなくなったら消える', () => {
  let doc = addSource(createDocument(), { id: 'f', kind: 'pdf', pageCount: 2, formFieldCount: 5 });
  doc = appendSourcePages(doc, 'f', { ids: ['a', 'b'] });
  assert.equal(doc.sources.f.formFieldCount, 5);
  doc = setFormValues(doc, 'f', { name: '山田', agree: true });
  assert.ok(validateDocument(JSON.parse(JSON.stringify(doc))));
  assert.deepEqual(setFormValues(doc, 'f', {}).forms, {});
  assert.throws(() => normalizeFormValues({ name: 3 }), /値が不正/);
  const pruned = pruneSources(removePages(doc, ['a', 'b'])).doc;
  assert.deepEqual(pruned.forms, {});
});

test('書き出し：日本語で入力して、入力欄を固定する（ほかのPDFと結合しても使える）', async () => {
  const formBytes = await read('../fixtures/form.pdf');
  const sample = await read('../fixtures/sample-3pages.pdf');
  const fontBytes = await read('../../vendor/fonts/BIZUDGothic-Regular.ttf');
  let doc = addSource(createDocument(), { id: 'f', kind: 'pdf', pageCount: 2, formFieldCount: 5 });
  doc = addSource(doc, { id: 's', kind: 'pdf', pageCount: 3 });
  doc = appendSourcePages(doc, 'f', { ids: ['a', 'b'] });
  doc = appendSourcePages(doc, 's', { ids: ['c'] });
  doc = setFormValues(doc, 'f', { name: '山田 花子', agree: true, contact: 'phone', pref: 'Osaka', note: '午前中に\nお願いします' });
  const bytes = await exportPdf(doc, {
    getSourceBytes: async (id) => (id === 'f' ? formBytes : sample),
    getImage: async () => null,
    getFont: async () => ({ bytes: fontBytes, fontkit }),
  });
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 5);
  // 入力欄は残っていない（ページの中身になった）
  assert.equal(pdf.getForm().getFields().length, 0);
  assert.ok(bytes.length < 200_000, `大きさ ${bytes.length}`);
});

test('複数行の欄は、幅に収まるよう1文字ずつ折り返す（改行は残す）', async () => {
  const { wrapText } = await import('../../src/core/forms.js');
  const measure = (t) => [...t].length * 10;
  assert.equal(wrapText('あいうえおかきくけこ', measure, 45), 'あいうえ\nおかきく\nけこ');
  assert.equal(wrapText('一行目\n二行目', measure, 100), '一行目\n二行目');
});
