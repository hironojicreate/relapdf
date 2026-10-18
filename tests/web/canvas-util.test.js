import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipDrawRect } from '../../src/web/canvas-util.js';

test('はみ出していなければ、そのまま', () => {
  const rect = { sx: 10, sy: 10, sw: 20, sh: 20, dx: 0, dy: 0, dw: 100, dh: 100 };
  assert.deepEqual(clipDrawRect(rect, 200, 200), rect);
});

test('左上にはみ出した分は切り取り、描き先もその分ずらして縮める（縦横比は変えない）', () => {
  // 画像の(−10,−5)から20×20を、100×100に5倍で描く
  const r = clipDrawRect({ sx: -10, sy: -5, sw: 20, sh: 20, dx: 0, dy: 0, dw: 100, dh: 100 }, 200, 200);
  assert.deepEqual(r, { sx: 0, sy: 0, sw: 10, sh: 15, dx: 50, dy: 25, dw: 50, dh: 75 });
});

test('右下にはみ出した分も切り取る', () => {
  const r = clipDrawRect({ sx: 190, sy: 195, sw: 20, sh: 20, dx: 0, dy: 0, dw: 100, dh: 100 }, 200, 200);
  assert.deepEqual(r, { sx: 190, sy: 195, sw: 10, sh: 5, dx: 0, dy: 0, dw: 50, dh: 25 });
});

test('まったく重ならなければ null', () => {
  assert.equal(clipDrawRect({ sx: 300, sy: 0, sw: 20, sh: 20, dx: 0, dy: 0, dw: 100, dh: 100 }, 200, 200), null);
});
