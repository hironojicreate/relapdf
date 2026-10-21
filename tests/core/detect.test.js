import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convexHull, detectDocument, otsuThreshold } from '../../src/core/detect.js';

// 机（暗い・少しムラあり）の上に、斜めに置いた紙（明るい・文字の線あり）の絵を作る
function scene({ width = 300, height = 400, quad, paper = 235, desk = 90, noise = 12, lines = true, seed = 1 }) {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const inside = (x, y) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % 4];
      const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (c === 0) continue;
      if (sign === 0) sign = Math.sign(c);
      else if (Math.sign(c) !== sign) return false;
    }
    return true;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = desk + (x / width) * 30 + (rand() - 0.5) * noise;
      if (inside(x + 0.5, y + 0.5)) {
        v = paper + (rand() - 0.5) * noise;
        // 文字の行の代わりの、暗い横線
        if (lines && y % 18 < 3 && x % 60 > 8) v = 70;
      }
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = v * 0.97;
      data[i + 2] = v * 0.9;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

const quadPx = [
  { x: 60, y: 50 },
  { x: 250, y: 70 },
  { x: 270, y: 350 },
  { x: 40, y: 330 },
];

function assertCorners(found, expectedPx, width, height, tolerance = 0.025) {
  assert.ok(found, '四隅が見つかる');
  found.corners.forEach((c, i) => {
    const ex = expectedPx[i].x / width;
    const ey = expectedPx[i].y / height;
    assert.ok(Math.abs(c.x - ex) < tolerance && Math.abs(c.y - ey) < tolerance, `角${i + 1}: (${c.x.toFixed(3)}, ${c.y.toFixed(3)}) ≈ (${ex.toFixed(3)}, ${ey.toFixed(3)})`);
  });
}

test('暗い机の上の、斜めに置いた紙の四隅を見つける', () => {
  assertCorners(detectDocument(scene({ quad: quadPx })), quadPx, 300, 400);
});

test('白い机の上の、暗い紙でも見つける', () => {
  const found = detectDocument(scene({ quad: quadPx, paper: 70, desk: 215, lines: false }));
  assertCorners(found, quadPx, 300, 400);
});

test('台形に大きくゆがんだ紙（斜め上から撮った写真）', () => {
  const trapezoid = [
    { x: 110, y: 60 },
    { x: 200, y: 60 },
    { x: 285, y: 380 },
    { x: 20, y: 380 },
  ];
  assertCorners(detectDocument(scene({ quad: trapezoid })), trapezoid, 300, 400);
});

test('紙が写っていない写真や、写真全体が紙のときは null', () => {
  const flat = scene({ quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], lines: false });
  assert.equal(detectDocument(flat), null, 'ムラのある机だけ');
  const full = scene({ quad: [{ x: -1, y: -1 }, { x: 301, y: -1 }, { x: 301, y: 401 }, { x: -1, y: 401 }], lines: false });
  assert.equal(detectDocument(full), null, '写真全体が紙');
  const tiny = scene({ quad: [{ x: 100, y: 100 }, { x: 130, y: 100 }, { x: 130, y: 130 }, { x: 100, y: 130 }] });
  assert.equal(detectDocument(tiny), null, '紙が小さすぎる');
});

test('丸いもの（四角くない）は、紙とみなさない', () => {
  const width = 300;
  const height = 300;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.hypot(x - 150, y - 150) < 110 ? 230 : 60;
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  assert.equal(detectDocument({ data, width, height }), null);
});

test('大津の方法と凸包', () => {
  const gray = new Uint8ClampedArray([10, 12, 11, 200, 210, 205]);
  const t = otsuThreshold(gray);
  assert.ok(t >= 12 && t < 200);
  const hull = convexHull([
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 2 },
    { x: 0, y: 2 },
  ]);
  assert.equal(hull.length, 4);
});
