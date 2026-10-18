// canvas の小さな道具（ブラウザ側の部品。計算部分は画面に触らない純粋な関数）

/**
 * drawImage で、画像の外にはみ出した範囲を切り取る位置を計算する。
 * Safari は、画像の外にはみ出した範囲を指定すると、切り取らずに引き伸ばしてしまう。
 * そのため、はみ出さない範囲と、それに合わせた描き先を自分で計算する。
 * @returns {{sx, sy, sw, sh, dx, dy, dw, dh} | null} 描く部分がなければ null
 */
export function clipDrawRect({ sx, sy, sw, sh, dx, dy, dw, dh }, imageWidth, imageHeight) {
  const x0 = Math.max(sx, 0);
  const y0 = Math.max(sy, 0);
  const x1 = Math.min(sx + sw, imageWidth);
  const y1 = Math.min(sy + sh, imageHeight);
  if (x1 <= x0 || y1 <= y0) return null;
  const kx = dw / sw;
  const ky = dh / sh;
  return {
    sx: x0,
    sy: y0,
    sw: x1 - x0,
    sh: y1 - y0,
    dx: dx + (x0 - sx) * kx,
    dy: dy + (y0 - sy) * ky,
    dw: (x1 - x0) * kx,
    dh: (y1 - y0) * ky,
  };
}

/** 画像の外にはみ出す範囲を指定しても、どのブラウザでも同じ結果になる drawImage */
export function drawImageClipped(ctx, image, rect, imageWidth, imageHeight) {
  const r = clipDrawRect(rect, imageWidth, imageHeight);
  if (r) ctx.drawImage(image, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
}
