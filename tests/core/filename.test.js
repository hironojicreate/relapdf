import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultFileName, numberedName, sanitizeFileName, stripExtension } from '../../src/core/filename.js';

test('初期のファイル名は日時入り', () => {
  assert.equal(defaultFileName(new Date(2026, 9, 18, 9, 5)), 'RelaPDF_20261018_0905.pdf');
});

test('使えない文字を置き換え、拡張子を付ける', () => {
  assert.equal(sanitizeFileName('見積書'), '見積書.pdf');
  assert.equal(sanitizeFileName('a/b:c*?.pdf'), 'a_b_c__.pdf');
  assert.equal(sanitizeFileName('  請求書.PDF  '), '請求書.pdf');
  assert.equal(sanitizeFileName('report...'), 'report.pdf');
  assert.equal(sanitizeFileName('', '.pdf', 'x.pdf'), 'x.pdf');
  assert.equal(sanitizeFileName('写真', '.zip'), '写真.zip');
});

test('拡張子を除く', () => {
  assert.equal(stripExtension('見積書.pdf'), '見積書');
  assert.equal(stripExtension('archive.tar.gz'), 'archive.tar');
  assert.equal(stripExtension('.hidden'), '.hidden');
  assert.equal(stripExtension('noext'), 'noext');
});

test('連番のファイル名は、全体の数に合わせて桁をそろえる', () => {
  assert.equal(numberedName('見積書', 3, 12, '.jpg'), '見積書_03.jpg');
  assert.equal(numberedName('scan', 7, 120, '.png'), 'scan_007.png');
  assert.equal(numberedName('a', 1, 1, '.pdf'), 'a_01.pdf');
});
