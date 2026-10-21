// カメラのズームの計算（ブラウザ側の部品。画面には触らない純粋な関数）
//
// カメラ自体がズームできない機種では、映像を拡大して表示し（デジタルズーム）、
// 撮るときは「画面に見えている範囲」だけを切り取る。見たままが写真になる。

/**
 * 画面に見えている映像の範囲を、映像のピクセル座標で求める。
 * 映像は表示エリアに収まるように置き（object-fit: contain）、中央を基準に zoom 倍に拡大している前提。
 * @returns {{ sx: number, sy: number, sw: number, sh: number }}
 */
export function visibleVideoRegion({ containerWidth, containerHeight, videoWidth, videoHeight, zoom = 1 }) {
  const fit = Math.min(containerWidth / videoWidth, containerHeight / videoHeight) * zoom;
  // 表示されている映像の大きさ（はみ出した部分も含む）と、表示エリアの中で見えている幅・高さ
  const shownWidth = Math.min(containerWidth, videoWidth * fit);
  const shownHeight = Math.min(containerHeight, videoHeight * fit);
  const sw = shownWidth / fit;
  const sh = shownHeight / fit;
  return { sx: (videoWidth - sw) / 2, sy: (videoHeight - sh) / 2, sw, sh };
}

/** ピンチの2本の指の距離 */
export function pinchDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** ズームの値を範囲に収め、0.1刻みにそろえる */
export function clampZoom(value, min, max) {
  return Math.round(Math.min(max, Math.max(min, value)) * 10) / 10;
}
