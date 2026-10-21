import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBrightness, brightnessFactor, applyDocumentFilter } from '../../src/core/color.js';

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

// ---- 書類モード ----

/** 左が暗く右が明るい（照明のムラ）紙に、文字の線と赤い印鑑がある絵 */
function unevenPage(width = 240, height = 320) {
  const data = new Uint8ClampedArray(width * height * 4);
  const paperAt = (x) => 140 + (x / width) * 100; // 140〜240
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const paper = paperAt(x);
      let rgb = [paper, paper * 0.98, paper * 0.94];
      if (y % 20 < 3 && x > 20 && x < 220) rgb = [paper * 0.3, paper * 0.3, paper * 0.3];
      if (Math.hypot(x - 180, y - 280) < 14) rgb = [paper * 0.85, paper * 0.25, paper * 0.25];
      data.set([...rgb, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

const pixel = (img, x, y) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];

test('書類モード：暗い所も明るい所も、紙は白に、文字は黒くなる', () => {
  const img = applyDocumentFilter(unevenPage());
  for (const x of [10, 60, 120, 200, 235]) {
    const [r, g, b] = pixel(img, x, 10);
    assert.ok(Math.min(r, g, b) >= 245, `紙 x=${x}: ${r},${g},${b}`);
  }
  for (const x of [30, 120, 210]) {
    const [r] = pixel(img, x, 41);
    assert.ok(r <= 60, `文字 x=${x}: ${r}`);
  }
});

test('書類モード：印鑑の赤は残る', () => {
  const [r, g, b] = pixel(applyDocumentFilter(unevenPage()), 180, 280);
  assert.ok(r > 180 && g < 80 && b < 80, `${r},${g},${b}`);
});

test('書類モード：大きな黒い文字の中も、白く抜けない', () => {
  const width = 200;
  const height = 200;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = x > 70 && x < 90 && y > 40 && y < 160 ? 40 : 220; // 太い縦棒（見出しの太い文字のつもり）
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  const img = applyDocumentFilter({ data, width, height });
  assert.ok(pixel(img, 80, 100)[0] <= 40, '太い線の真ん中');
  assert.ok(pixel(img, 150, 100)[0] >= 245, '紙');
});
