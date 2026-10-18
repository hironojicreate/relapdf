import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBrightness, brightnessFactor } from '../../src/core/color.js';

test('明るさの値を倍率にする（-1で半分、0でそのまま、+1で2倍）', () => {
  assert.equal(brightnessFactor(0), 1);
  assert.equal(brightnessFactor(1), 2);
  assert.equal(brightnessFactor(-1), 0.5);
  assert.equal(brightnessFactor(0.5), 1.414);
  assert.equal(brightnessFactor(5), 2, '範囲外は端の値にする');
  assert.equal(brightnessFactor('abc'), 1);
});

test('明るさを変える：色だけ変えて、透明度は変えない。白は白のまま', () => {
  const image = { data: new Uint8ClampedArray([100, 50, 200, 128, 255, 255, 255, 255]), width: 2, height: 1 };
  applyBrightness(image, 2);
  assert.deepEqual([...image.data], [200, 100, 255, 128, 255, 255, 255, 255]);
  applyBrightness(image, 0.5);
  assert.deepEqual([...image.data.slice(0, 4)], [100, 50, 128, 128]);
});
