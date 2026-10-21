// 注釈（文字・四角・丸・線・矢印・マーカー・画像）（Core層）
//
// ページごとに、ページの上に置く図形や文字を持つ（page.annotations）。署名・印鑑の画像も「画像の注釈」として置く。
// 位置は「ユーザーの回転をかける前」のページに対する0〜1の割合（左上が原点）で持つ。
// こうしておくと、あとからページを回転しても、注釈がページの中身と一緒に回る（4点補正の四隅と同じ考え方）。
// PDFに書き出すときは、画面で見たときの向きの座標（ポイント・左下が原点）にしてから、marks.js と同じ方法で書き込む。

import { MARK_COLORS } from './marks.js';

// page-list.js から読み込まれるので、page-list.js に頼るファイル（perspective.js など）は読み込まない（循環を避ける）

/** 回転前の0〜1の座標（左上が原点）を、右に rotation 度回した画面の座標にする（perspective.js の toDisplayPoint と同じ） */
function toDisplayPoint({ x, y }, rotation) {
  switch (rotation) {
    case 90:
      return { x: 1 - y, y: x };
    case 180:
      return { x: 1 - x, y: 1 - y };
    case 270:
      return { x: y, y: 1 - x };
    default:
      return { x, y };
  }
}

export const ANNOTATION_TYPES = Object.freeze(['text', 'rect', 'ellipse', 'line', 'arrow', 'highlight', 'image']);

/** 注釈の色。マーカーは黄色が基本 */
export const ANNOTATION_COLORS = Object.freeze({
  red: MARK_COLORS.red,
  blue: MARK_COLORS.blue,
  black: MARK_COLORS.black,
  yellow: [1, 0.86, 0.1],
  green: [0.2, 0.7, 0.3],
});

/**
 * 文字の大きさの選択肢（ページの幅に対する割合）。A4の縦なら、小 約11pt・中 約15pt・大 約21pt・特大 約30pt。
 * 割合で持つのは、補正画面などの縮小した絵の上でも、書き出したPDFと同じ見た目にするため。
 */
export const TEXT_SIZES = Object.freeze({ small: 0.018, medium: 0.025, large: 0.035, xlarge: 0.05 });

const LINE_WIDTH = 2; // 線の太さ（ポイント）
const HIGHLIGHT_OPACITY = 0.35;
const LINE_HEIGHT = 1.3;

/** 文字や画像を右に回したときの「下」の向き（回転前のページの座標で。左上が原点） */
const DOWN = Object.freeze({ 0: [0, 1], 90: [-1, 0], 180: [0, -1], 270: [1, 0] });

/**
 * 注釈の形を確かめ、整えた新しい注釈を返す。おかしな値はエラーにする。
 * - text：x, y（文字の左上）, text, size（ページの幅に対する割合）, color, rotation
 * - image：x, y（画像の左上）, w, h（画像の幅・高さ。どちらもページの幅に対する割合）, sourceId, rotation
 * - rect / ellipse / highlight：x, y, w, h（左上と大きさ）, color
 * - line / arrow：x1, y1, x2, y2, color
 * rotation は、文字や画像をページ（回転前）に対して右に回す角度。回転したページに置くとき、画面で正しい向きに見えるようにする
 */
export function normalizeAnnotation(a) {
  if (!a || typeof a !== 'object') throw new Error('注釈が不正です');
  if (!ANNOTATION_TYPES.includes(a.type)) throw new Error(`注釈の種類が不正です: ${a.type}`);
  if (typeof a.id !== 'string' || !a.id) throw new Error('注釈のIDがありません');
  const num = (v, name) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < -1 || v > 2) throw new Error(`注釈の位置が不正です: ${name}`);
    return v;
  };
  const out = { id: a.id, type: a.type };
  if (a.type !== 'image') {
    if (!ANNOTATION_COLORS[a.color]) throw new Error(`注釈の色が不正です: ${a.color}`);
    out.color = a.color;
  }
  if (a.type === 'line' || a.type === 'arrow') {
    for (const key of ['x1', 'y1', 'x2', 'y2']) out[key] = num(a[key], key);
    return out;
  }
  out.x = num(a.x, 'x');
  out.y = num(a.y, 'y');
  if (a.type === 'text' || a.type === 'image') {
    const rotation = a.rotation ?? 0;
    if (![0, 90, 180, 270].includes(rotation)) throw new Error(`注釈の向きが不正です: ${rotation}`);
    out.rotation = rotation;
  }
  if (a.type === 'text') {
    out.text = String(a.text ?? '');
    if (!(a.size > 0 && a.size <= 0.5)) throw new Error(`文字の大きさが不正です: ${a.size}`);
    out.size = a.size;
    return out;
  }
  out.w = num(a.w, 'w');
  out.h = num(a.h, 'h');
  if (!(out.w > 0 && out.h > 0)) throw new Error('注釈の大きさが不正です');
  if (a.type === 'image') {
    if (typeof a.sourceId !== 'string' || !a.sourceId) throw new Error('画像の注釈に元データがありません');
    out.sourceId = a.sourceId;
  }
  return out;
}

/** 注釈の並びを確かめる */
export function normalizeAnnotations(list) {
  if (!Array.isArray(list)) throw new Error('注釈の一覧が不正です');
  const seen = new Set();
  return list.map((a) => {
    const n = normalizeAnnotation(a);
    if (seen.has(n.id)) throw new Error(`注釈のIDが重複しています: ${n.id}`);
    seen.add(n.id);
    return n;
  });
}

/**
 * 1ページの注釈を、画面で見たときの向きの描く内容（ポイント・左下が原点）にする。
 * @param {object[]} annotations
 * @param {object} frame
 * @param {number} frame.width ユーザーの回転をかける前のページの幅（ポイント）
 * @param {number} frame.height 同じく高さ
 * @param {number} frame.rotation ユーザーの回転（右回り）
 * @param {(text: string, size: number) => number} frame.measure 文字の幅
 * @returns {object[]} marks.js の marksForPage と同じ形（text・rect）に加えて、
 *   ellipse（cx, cy, rx, ry, angle）、line（x1, y1, x2, y2）、image（x, y, width, height, angle, sourceId）
 */
export function annotationItems(annotations, { width, height, rotation }) {
  const sideways = rotation === 90 || rotation === 270;
  const view = { width: sideways ? height : width, height: sideways ? width : height };
  // 回転前の0〜1の座標 → 画面で見たときのポイント（左下が原点）
  const at = (x, y) => {
    const d = toDisplayPoint({ x, y }, rotation);
    return { x: d.x * view.width, y: (1 - d.y) * view.height };
  };
  const angle = (360 - rotation) % 360; // 回転前に横向きのものは、画面では左回りにこの角度
  // 回転前のページのポイント（左上が原点）→ 画面で見たときのポイント
  const atPt = (u, v) => at(u / width, v / height);
  const items = [];
  for (const a of annotations) {
    const color = a.type === 'image' ? null : ANNOTATION_COLORS[a.color];
    switch (a.type) {
      case 'text': {
        // 1行ずつ、左上から「下」（文字の向きでの下）へ。行の始まり（左下）の位置を求める
        const size = a.size * width;
        const down = DOWN[a.rotation ?? 0];
        const textAngle = (360 - ((rotation + (a.rotation ?? 0)) % 360)) % 360;
        a.text.split(/\r\n|\r|\n/).forEach((line, i) => {
          if (!line) return;
          const off = size * (0.88 + i * LINE_HEIGHT);
          const p = atPt(a.x * width + down[0] * off, a.y * height + down[1] * off);
          items.push({ type: 'text', text: line, x: p.x, y: p.y, size, angle: textAngle, color, opacity: 1 });
        });
        break;
      }
      case 'image': {
        // 画像の左下の角（画像の向きで）が、描くときの起点になる
        const w = a.w * width;
        const h = a.h * width;
        const down = DOWN[a.rotation ?? 0];
        const p = atPt(a.x * width + down[0] * h, a.y * height + down[1] * h);
        const imageAngle = (360 - ((rotation + (a.rotation ?? 0)) % 360)) % 360;
        items.push({ type: 'image', x: p.x, y: p.y, width: w, height: h, angle: imageAngle, sourceId: a.sourceId });
        break;
      }
      case 'rect':
      case 'highlight': {
        // 回転前の左下の角が、描くときの起点になる
        const p = at(a.x, a.y + a.h);
        const box = { x: p.x, y: p.y, width: a.w * width, height: a.h * height, angle };
        if (a.type === 'highlight') items.push({ type: 'rect', ...box, color, fill: true, borderWidth: 0, opacity: HIGHLIGHT_OPACITY });
        else items.push({ type: 'rect', ...box, color, borderWidth: LINE_WIDTH, opacity: 1 });
        break;
      }
      case 'ellipse': {
        const c = at(a.x + a.w / 2, a.y + a.h / 2);
        items.push({ type: 'ellipse', cx: c.x, cy: c.y, rx: (a.w * width) / 2, ry: (a.h * height) / 2, angle, color, borderWidth: LINE_WIDTH, opacity: 1 });
        break;
      }
      case 'line':
      case 'arrow': {
        const p1 = at(a.x1, a.y1);
        const p2 = at(a.x2, a.y2);
        items.push({ type: 'line', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, color, width: LINE_WIDTH, opacity: 1 });
        if (a.type === 'arrow') items.push(...arrowHead(p1, p2, color));
        break;
      }
      default:
        break;
    }
  }
  return items;
}

/** 矢印の先（2本の短い線） */
function arrowHead(from, to, color) {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (len < 1) return [];
  const size = Math.min(14, len * 0.4);
  const ux = (to.x - from.x) / len;
  const uy = (to.y - from.y) / len;
  const wing = (sign) => {
    const cos = Math.cos((sign * 25 * Math.PI) / 180);
    const sin = Math.sin((sign * 25 * Math.PI) / 180);
    const dx = -(ux * cos - uy * sin) * size;
    const dy = -(ux * sin + uy * cos) * size;
    return { type: 'line', x1: to.x, y1: to.y, x2: to.x + dx, y2: to.y + dy, color, width: LINE_WIDTH, opacity: 1 };
  };
  return [wing(1), wing(-1)];
}

/** 注釈で使っている画像の元データ（署名・印鑑） */
export function annotationSourceIds(pages) {
  const ids = new Set();
  for (const page of pages) {
    for (const a of page.annotations ?? []) if (a.type === 'image') ids.add(a.sourceId);
  }
  return ids;
}
