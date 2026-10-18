import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  A4_RATIO,
  applyHomography,
  defaultCorners,
  fromDisplayPoint,
  homography,
  isConvexQuad,
  outputSize,
  toDisplayPoint,
  toPixels,
  warpPerspective,
} from '../../src/core/perspective.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const rect = (w, h) => [
  { x: 0, y: 0 },
  { x: w, y: 0 },
  { x: w, y: h },
  { x: 0, y: h },
];

test('射影変換：4つの点が指定どおりに移る', () => {
  const to = [
    { x: 12, y: 30 },
    { x: 410, y: 8 },
    { x: 380, y: 560 },
    { x: 40, y: 500 },
  ];
  const h = homography(rect(100, 140), to);
  rect(100, 140).forEach((p, i) => {
    const q = applyHomography(h, p.x, p.y);
    near(q.x, to[i].x, 1e-6);
    near(q.y, to[i].y, 1e-6);
  });
});

test('射影変換：同じ四角形どうしなら、何も変わらない', () => {
  const h = homography(rect(10, 10), rect(10, 10));
  const q = applyHomography(h, 3.5, 7.25);
  near(q.x, 3.5);
  near(q.y, 7.25);
});

test('補正後の大きさ：辺の長い方を使う。A4比率にも合わせられる', () => {
  const corners = [
    { x: 10, y: 10 },
    { x: 210, y: 20 },
    { x: 200, y: 310 },
    { x: 0, y: 300 },
  ];
  const free = outputSize(corners);
  assert.equal(free.width, 200);
  assert.equal(free.height, 290); // 左右の辺は約290.2
  const a4 = outputSize(corners, 'a4');
  assert.equal(a4.height, 290);
  assert.equal(a4.width, Math.round(Math.hypot(10, 290) / A4_RATIO));
  // 横長ならA4の横向き
  const wide = outputSize(rect(400, 100), 'a4');
  assert.equal(wide.width, 400);
  assert.equal(wide.height, Math.round(400 / A4_RATIO));
});

test('四角形の形を調べる：ねじれ・へこみ・つぶれはだめ', () => {
  assert.equal(isConvexQuad(defaultCorners()), true);
  const twisted = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ];
  assert.equal(isConvexQuad(twisted), false);
  const dent = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0.3, y: 0.3 },
    { x: 0, y: 1 },
  ];
  assert.equal(isConvexQuad(dent), false);
  const flat = [
    { x: 0, y: 0 },
    { x: 0.5, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ];
  assert.equal(isConvexQuad(flat), false);
});

test('画面の向き（ページの回転）との座標の変換は、行って戻ると元どおり', () => {
  const p = { x: 0.2, y: 0.7 };
  assert.deepEqual(toDisplayPoint(p, 0), p);
  // 右に90度回すと、左下の点は左上の方へ
  const d90 = toDisplayPoint(p, 90);
  near(d90.x, 0.3);
  near(d90.y, 0.2);
  for (const r of [0, 90, 180, 270]) {
    const back = fromDisplayPoint(toDisplayPoint(p, r), r);
    near(back.x, p.x);
    near(back.y, p.y);
  }
  // 元画像の左上は、90度回転後は右上に見える
  assert.deepEqual(toDisplayPoint({ x: 0, y: 0 }, 90), { x: 1, y: 0 });
});

// 位置で色が決まる画像（R = x、G = y）
function gradient(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = x;
      data[i + 1] = y;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}
const pixel = (img, x, y) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

test('引き伸ばし：画像全体を同じ大きさにすれば、元の画像と同じ', () => {
  const src = gradient(64, 48);
  const out = warpPerspective(src, rect(64, 48), 64, 48);
  assert.deepEqual(pixel(out, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(pixel(out, 63, 47), [63, 47, 0, 255]);
  assert.deepEqual(pixel(out, 20, 30), [20, 30, 0, 255]);
});

test('引き伸ばし：一部分を切り出して拡大する', () => {
  const src = gradient(100, 100);
  // 20〜60 の正方形を 80×80 に拡大 → 出力の2ピクセルが元の1ピクセル
  const corners = [
    { x: 20, y: 20 },
    { x: 60, y: 20 },
    { x: 60, y: 60 },
    { x: 20, y: 60 },
  ];
  const out = warpPerspective(src, corners, 80, 80);
  assert.equal(out.width, 80);
  const [r, g] = pixel(out, 40, 20);
  near(r, 40, 1.01);
  near(g, 30, 1.01);
});

test('引き伸ばし：台形を長方形にする（左右の辺が内側に傾いた写真）', () => {
  const src = gradient(200, 200);
  const corners = [
    { x: 50, y: 0 },
    { x: 150, y: 0 },
    { x: 200, y: 200 },
    { x: 0, y: 200 },
  ];
  const out = warpPerspective(src, corners, 100, 100);
  // 出力の左上・右上は、台形の上の辺の両端
  near(pixel(out, 0, 0)[0], 50, 2);
  near(pixel(out, 99, 0)[0], 150, 2);
  // 出力の左下は、台形の左下の角
  near(pixel(out, 0, 99)[0], 0, 2);
  near(pixel(out, 0, 99)[1], 199, 2);
});

test('割合の四隅をピクセルにする', () => {
  assert.deepEqual(toPixels([{ x: 0.5, y: 0.25 }], 200, 100), [{ x: 100, y: 25 }]);
});
