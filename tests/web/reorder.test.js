import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertionIndexAt, moveTargetIndex } from '../../src/web/reorder.js';

// 3列×2行に並んだページ（幅100・高さ100、間隔10）
const rects = Array.from({ length: 5 }, (_, i) => ({
  left: (i % 3) * 110,
  top: Math.floor(i / 3) * 110,
  width: 100,
  height: 100,
}));

test('ページの左半分なら前、右半分なら後ろに入れる', () => {
  assert.equal(insertionIndexAt(rects, 20, 50), 0);
  assert.equal(insertionIndexAt(rects, 80, 50), 1);
  assert.equal(insertionIndexAt(rects, 130, 50), 1);
  assert.equal(insertionIndexAt(rects, 300, 50), 3, '1行目の最後のページの右');
});

test('2行目や、並びの外側でも一番近いページで決める', () => {
  assert.equal(insertionIndexAt(rects, 20, 160), 3);
  assert.equal(insertionIndexAt(rects, 200, 160), 5, '最後のページの右');
  assert.equal(insertionIndexAt(rects, 500, 500), 5);
  assert.equal(insertionIndexAt(rects, -50, -50), 0);
  assert.equal(insertionIndexAt([], 0, 0), 0);
});

test('行の境目では、指のある行を優先する', () => {
  // 1行目の右端の少し下（2行目の高さ）にある指は、2行目として扱う
  assert.equal(insertionIndexAt(rects, 280, 130), 5);
});

test('挿入位置を移動先に変える', () => {
  assert.equal(moveTargetIndex(3, 0), 2, '0番目を2番目の後ろへ');
  assert.equal(moveTargetIndex(0, 3), 0);
  assert.equal(moveTargetIndex(1, 1), null, '自分の前＝動かない');
  assert.equal(moveTargetIndex(2, 1), null, '自分の後ろ＝動かない');
});
