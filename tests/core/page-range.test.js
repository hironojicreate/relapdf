import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPageRange, parsePageRange } from '../../src/core/page-range.js';

test('単独のページと範囲を読み取る（1始まり→0始まり）', () => {
  assert.deepEqual(parsePageRange('1-3, 5', 10), [0, 1, 2, 4]);
  assert.deepEqual(parsePageRange('7', 10), [6]);
});

test('開始・終了を省略した範囲', () => {
  assert.deepEqual(parsePageRange('8-', 10), [7, 8, 9]);
  assert.deepEqual(parsePageRange('-2', 10), [0, 1]);
});

test('重なりはまとめて昇順にする', () => {
  assert.deepEqual(parsePageRange('5, 1-3, 2', 10), [0, 1, 2, 4]);
});

test('全角数字・全角記号・読点・空白区切りも受け付ける', () => {
  assert.deepEqual(parsePageRange('１－３、５', 10), [0, 1, 2, 4]);
  assert.deepEqual(parsePageRange('1〜2　4', 10), [0, 1, 3]);
  assert.deepEqual(parsePageRange('1 - 3', 10), [0, 1, 2]);
});

test('範囲外や読み取れない入力はエラー', () => {
  assert.throws(() => parsePageRange('', 10), /空/);
  assert.throws(() => parsePageRange('0', 10), /外/);
  assert.throws(() => parsePageRange('11', 10), /外/);
  assert.throws(() => parsePageRange('5-3', 10), /外/);
  assert.throws(() => parsePageRange('a', 10), /読み取れません/);
  assert.throws(() => parsePageRange('-', 10), /読み取れません/);
});

test('ページ番号の配列を短い範囲の文字列にする', () => {
  assert.equal(formatPageRange([0, 1, 2, 4]), '1-3, 5');
  assert.equal(formatPageRange([4, 2, 3, 3]), '3-5');
  assert.equal(formatPageRange([]), '');
});
