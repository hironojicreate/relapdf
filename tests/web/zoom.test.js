import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampZoom, pinchDistance, visibleVideoRegion } from '../../src/web/zoom.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} ≈ ${b}`);

test('ズームなしなら、映像全体が見えている', () => {
  const r = visibleVideoRegion({ containerWidth: 390, containerHeight: 800, videoWidth: 1920, videoHeight: 1080 });
  assert.deepEqual(r, { sx: 0, sy: 0, sw: 1920, sh: 1080 });
});

test('縦長の画面で横長の映像を2倍にすると、横は半分、縦は（上下に余白があれば）全部見える', () => {
  const r = visibleVideoRegion({ containerWidth: 400, containerHeight: 800, videoWidth: 1600, videoHeight: 1200, zoom: 2 });
  near(r.sw, 800);
  near(r.sx, 400);
  near(r.sh, 1200); // 映像の高さ 300px × 2 = 600px は 800px に収まる
  near(r.sy, 0);
});

test('3倍にすると、縦も画面からはみ出して切り取られる', () => {
  const r = visibleVideoRegion({ containerWidth: 400, containerHeight: 800, videoWidth: 1600, videoHeight: 1200, zoom: 3 });
  near(r.sw, 1600 / 3);
  near(r.sh, 800 / 0.75); // 見えている高さ 800px ÷ 倍率（0.25 × 3）
  near(r.sy, (1200 - 800 / 0.75) / 2);
});

test('ピンチの距離と、ズームの値をそろえる', () => {
  assert.equal(pinchDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(clampZoom(2.345, 1, 4), 2.3);
  assert.equal(clampZoom(9, 1, 4), 4);
  assert.equal(clampZoom(0.5, 1, 4), 1);
});
