import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitLongSide, imagePageLayout, targetImageSize } from '../../src/core/layout.js';

const A4 = { short: 595.28, long: 841.89 };

test('A4：縦長の写真は縦向きのA4に、左右中央に収める', () => {
  const l = imagePageLayout(3000, 4000, 'a4');
  assert.equal(l.pageWidth, A4.short);
  assert.equal(l.pageHeight, A4.long);
  assert.equal(l.width, A4.short);
  assert.ok(l.height < A4.long);
  assert.ok(Math.abs(l.y - (A4.long - l.height) / 2) < 0.01);
  assert.equal(l.x, 0);
});

test('A4：横長の写真は横向きのA4にする', () => {
  const l = imagePageLayout(4000, 3000, 'a4');
  assert.equal(l.pageWidth, A4.long);
  assert.equal(l.pageHeight, A4.short);
  assert.equal(l.height, A4.short);
});

test('A4比率ちょうどの写真は余白なしで全面に置く', () => {
  const l = imagePageLayout(2480, 3508, 'a4');
  assert.ok(Math.abs(l.width - A4.short) < 0.5);
  assert.ok(Math.abs(l.height - A4.long) < 0.5);
});

test('写真のサイズのまま：用紙は写真と同じ比率で、長辺がA4の長辺', () => {
  const l = imagePageLayout(4000, 1000, 'image');
  assert.equal(l.pageWidth, A4.long);
  assert.equal(l.pageHeight, 210.47);
  assert.deepEqual([l.x, l.y], [0, 0]);
});

test('画質に合わせて縮小する（拡大はしない）', () => {
  // A4縦いっぱい（幅595.28pt＝8.27インチ）なら、標準150dpiで約1240px、高画質300dpiで約2480px
  const std = targetImageSize(2480, 3508, 'standard');
  assert.ok(Math.abs(std.width - 1240) <= 1);
  assert.equal(std.jpegQuality, 0.8);
  const high = targetImageSize(2480, 3508, 'high');
  assert.ok(Math.abs(high.width - 2480) <= 1);
  const small = targetImageSize(400, 300, 'high');
  assert.deepEqual([small.width, small.height], [400, 300]);
  assert.throws(() => targetImageSize(400, 300, 'ultra'), /画質/);
});

test('長辺を上限までに縮小する', () => {
  assert.deepEqual(fitLongSide(4032, 3024, 2016), { width: 2016, height: 1512 });
  assert.deepEqual(fitLongSide(100, 50, 2016), { width: 100, height: 50 });
  assert.throws(() => imagePageLayout(0, 10));
  assert.throws(() => imagePageLayout(10, 10, 'letter'), /用紙/);
});
