import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';
import fontkit from '../../vendor/fontkit/fontkit.mjs';
import {
  defaultMarks,
  describeMarks,
  fillPlaceholders,
  hasMarks,
  marksForPage,
  normalizeMarks,
  toPageSpace,
} from '../../src/core/marks.js';
import { addSource, appendSourcePages, createDocument, rotatePages, setMarks, validateDocument } from '../../src/core/page-list.js';
import { exportPdf } from '../../src/core/pdf-export.js';

// 文字の幅：1文字 = 大きさ × 1（計算を分かりやすくするため）
const measure = (text, size) => [...text].length * size;
const A4 = { width: 595, height: 842 };
const date = new Date(2026, 9, 21);

function marksWith(changes) {
  const m = defaultMarks();
  for (const [k, v] of Object.entries(changes)) m[k] = { ...m[k], ...v };
  return normalizeMarks(m);
}

test('設定の確かめ：足りない項目は初期値、おかしな値はエラー', () => {
  const m = normalizeMarks({ pageNumber: { enabled: 1 } });
  assert.equal(m.pageNumber.enabled, true);
  assert.equal(m.pageNumber.position, 'bottom-center');
  assert.equal(m.header.enabled, false);
  assert.throws(() => normalizeMarks({ pageNumber: { position: 'middle' } }), /位置が不正/);
  assert.throws(() => normalizeMarks({ watermark: { color: 'pink' } }), /色が不正/);
  assert.throws(() => normalizeMarks({ pageNumber: { start: -1 } }), /始まりが不正/);
  assert.equal(hasMarks(defaultMarks()), false);
  assert.equal(hasMarks(marksWith({ header: { enabled: true, text: '  ' } })), false, '空白だけの文字は書かない');
  assert.deepEqual(describeMarks(marksWith({ pageNumber: { enabled: true }, stamp: { enabled: true } })), ['ページ番号', 'スタンプ']);
});

test('ページリストに書き込みの設定を持てる（保存・読み込みもできる）', () => {
  const doc = setMarks(createDocument(), { pageNumber: { enabled: true, format: 'total' } });
  assert.equal(doc.marks.pageNumber.format, 'total');
  assert.ok(validateDocument(JSON.parse(JSON.stringify(doc))));
  assert.equal(setMarks(doc, null).marks, null);
  assert.throws(() => validateDocument({ ...doc, marks: { stamp: { position: 'center' } } }), /スタンプの位置/);
});

test('ヘッダー・フッターの {n} {total} {date} を置き換える', () => {
  assert.equal(fillPlaceholders('{date} 社内資料 {n}/{total}', { n: 2, total: 5, date }), '2026/10/21 社内資料 2/5');
});

test('ページ番号：下の中央。表紙を数えないときは2ページ目が1になる', () => {
  const m = marksWith({ pageNumber: { enabled: true, format: 'total' } });
  const [item] = marksForPage(m, { ...A4, index: 1, total: 4, date, measure });
  assert.equal(item.text, '2 / 4');
  assert.ok(Math.abs(item.x + measure(item.text, item.size) / 2 - A4.width / 2) < 0.01, '中央');
  assert.ok(item.y < 40, '下の端の近く');

  const skip = marksWith({ pageNumber: { enabled: true, format: 'total', skipFirst: true } });
  assert.equal(marksForPage(skip, { ...A4, index: 0, total: 4, date, measure }).length, 0, '表紙には書かない');
  assert.equal(marksForPage(skip, { ...A4, index: 1, total: 4, date, measure })[0].text, '1 / 3');

  const right = marksWith({ pageNumber: { enabled: true, position: 'top-right', format: 'ja', start: 10 } });
  const [r] = marksForPage(right, { ...A4, index: 0, total: 1, date, measure });
  assert.equal(r.text, '10ページ');
  assert.ok(r.x + measure(r.text, r.size) > A4.width - 40 && r.y > A4.height - 50, '右上');
});

test('フッターとページ番号が同じ下側にあるときは、重ならないようにずらす', () => {
  const m = marksWith({ pageNumber: { enabled: true }, footer: { enabled: true, text: '社外秘' } });
  const items = marksForPage(m, { ...A4, index: 0, total: 1, date, measure });
  const [footer, number] = items;
  assert.ok(number.y - footer.y > footer.size, `${number.y} と ${footer.y}`);
});

test('透かしは対角線に沿って、ページの中央に。スタンプは最初のページの右上に枠付きで', () => {
  const m = marksWith({ watermark: { enabled: true, text: '複製禁止' }, stamp: { enabled: true, text: '社外秘' } });
  const first = marksForPage(m, { ...A4, index: 0, total: 2, date, measure });
  const mark = first.find((i) => i.type === 'text' && i.text === '複製禁止');
  assert.ok(mark.angle > 50 && mark.angle < 60, `角度 ${mark.angle}`);
  // 文字の中心が、ページの中心の近くにある
  const rad = (mark.angle * Math.PI) / 180;
  const w = measure(mark.text, mark.size);
  const cx = mark.x + (Math.cos(rad) * w) / 2 - Math.sin(rad) * mark.size * 0.35;
  const cy = mark.y + (Math.sin(rad) * w) / 2 + Math.cos(rad) * mark.size * 0.35;
  assert.ok(Math.abs(cx - A4.width / 2) < 1 && Math.abs(cy - A4.height / 2) < 1, `${cx}, ${cy}`);
  assert.ok(mark.opacity < 0.5);

  const rect = first.find((i) => i.type === 'rect');
  assert.ok(rect.x + rect.width > A4.width - 40 && rect.y + rect.height > A4.height - 70, '右上');
  assert.equal(marksForPage(m, { ...A4, index: 1, total: 2, date, measure }).filter((i) => i.type === 'rect').length, 0, '2ページ目には付けない');
});

test('画面の向きの座標を、回転前のページの座標に戻す', () => {
  const box = { x: 0, y: 0, width: 100, height: 200 }; // 縦長のページ
  // 画面で見て左下の点が、回転前のどこにあたるか
  assert.deepEqual(toPageSpace(0, box, 0, 0), { x: 0, y: 0, angle: 0 });
  assert.deepEqual(toPageSpace(90, box, 0, 0), { x: 100, y: 0, angle: 90 }); // 右に90度回すと、右下が左下に来る
  assert.deepEqual(toPageSpace(180, box, 0, 0), { x: 100, y: 200, angle: 180 });
  assert.deepEqual(toPageSpace(270, box, 0, 0), { x: 0, y: 200, angle: 270 });
  // ページの範囲がずれているとき（CropBox の原点が0でない）
  assert.deepEqual(toPageSpace(0, { ...box, x: 10, y: 20 }, 5, 5), { x: 15, y: 25, angle: 0 });
});

test('書き出し：日本語の書き込みを、使う文字だけのフォントで埋め込む', async () => {
  const pdfBytes = new Uint8Array(await readFile(new URL('../fixtures/sample-3pages.pdf', import.meta.url)));
  const fontBytes = new Uint8Array(await readFile(new URL('../../vendor/fonts/BIZUDGothic-Regular.ttf', import.meta.url)));
  let doc = addSource(createDocument(), { id: 'pdf1', kind: 'pdf', pageCount: 3 });
  doc = appendSourcePages(doc, 'pdf1', { ids: ['a', 'b', 'c'] });
  doc = rotatePages(doc, ['b'], 90);
  const plain = await exportPdf(doc, { getSourceBytes: async () => pdfBytes, getImage: async () => null, date });
  doc = setMarks(doc, { pageNumber: { enabled: true, format: 'total' }, stamp: { enabled: true, text: '社外秘' } });
  let fontCalls = 0;
  const bytes = await exportPdf(doc, {
    getSourceBytes: async () => pdfBytes,
    getImage: async () => null,
    getFont: async () => {
      fontCalls += 1;
      return { bytes: fontBytes, fontkit };
    },
    date,
  });
  assert.equal(fontCalls, 1);
  // フォント全体（3MB以上）ではなく、使う文字だけが入っている
  assert.ok(bytes.length - plain.length < 40_000, `増えた大きさ ${bytes.length - plain.length}`);
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 3);
  assert.equal(pdf.getPage(1).getRotation().angle, 90, '回転はそのまま');
  const fonts = pdf.getPage(0).node.Resources().lookup(PDFName.of('Font'));
  assert.ok(fonts.keys().length >= 2, '元のフォントに、書き込み用のフォントが加わる');
});
