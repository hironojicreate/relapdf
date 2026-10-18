// 4点補正の画面（UI層）
//
// 写真の上に四角形を表示し、四隅の丸（角）と辺の中点の丸をつまんで、書類の四隅に合わせてもらう。
// つまんでいる間は、指で隠れる部分を拡大した「ルーペ」を表示する。
// 画面にはページの回転をかけた向きで表示し、保存するときに回転前の座標に戻す。
// 書類の端が写真からはみ出していることもあるので、四隅は写真の外（画面の端まで）にも動かせる。

import { fitLongSide } from '../core/layout.js';
import { PERSPECTIVE_MARGIN } from '../core/page-list.js';
import { defaultCorners, fromDisplayPoint, isConvexQuad, toDisplayPoint } from '../core/perspective.js';
import { drawImageClipped } from '../web/canvas-util.js';
import { decodeImage } from '../web/image.js';

const DISPLAY_LONG_SIDE = 1600; // 補正画面に表示する画像の長辺（メモリを節約するため縮小する）
const LOUPE_ZOOM = 3;
const STAGE_PADDING = 22; // 角の丸が画面の端で切れないための余白

/**
 * @param {object} options
 * @param {(page: object) => Promise<Blob>} options.getBlob 写真の中身を返す
 * @param {(pageId: string, perspective: object|null) => void} options.onApply 「完了」「補正しない」を押したとき
 */
export function createPerspectiveEditor({ getBlob, onApply }) {
  const $ = (selector) => document.querySelector(selector);
  const root = $('#editor');
  const stage = $('#editor-stage');
  const canvas = $('#editor-canvas');
  const overlay = $('#editor-overlay');
  const loupe = $('#editor-loupe');
  const a4Toggle = $('#editor-a4');

  let page = null;
  let base = null; // 回転をかけて縮小した表示用の画像（canvas）
  let corners = []; // 画面の向きでの四隅（0〜1）
  let box = null; // 画像を表示している位置と大きさ（stage の中、CSSピクセル）
  let drag = null;
  let opening = 0;

  async function open(target) {
    page = target;
    const token = ++opening;
    root.hidden = false;
    document.body.classList.add('editor-open');
    root.classList.add('loading');
    a4Toggle.checked = page.perspective?.aspect === 'a4';
    corners = (page.perspective?.corners ?? defaultCorners()).map((c) => toDisplayPoint(c, page.rotation));
    try {
      const prepared = await prepareBase(await getBlob(page), page.rotation);
      if (token !== opening) return; // 準備中に閉じられた
      base = prepared;
      root.classList.remove('loading');
      layout();
      root.querySelector('[data-editor="apply"]').focus();
    } catch (error) {
      console.error(error);
      close();
    }
  }

  function close() {
    opening += 1;
    root.hidden = true;
    document.body.classList.remove('editor-open');
    loupe.hidden = true;
    drag = null;
    page = null;
    if (base) {
      base.width = 0;
      base.height = 0;
    }
    base = null;
  }

  function isOpen() {
    return !root.hidden;
  }

  /** 写真を縮小し、ページの回転をかけた向きで描いておく */
  async function prepareBase(blob, rotation) {
    const decoded = await decodeImage(blob);
    try {
      const size = fitLongSide(decoded.width, decoded.height, DISPLAY_LONG_SIDE);
      const sideways = rotation === 90 || rotation === 270;
      const c = document.createElement('canvas');
      c.width = sideways ? size.height : size.width;
      c.height = sideways ? size.width : size.height;
      const ctx = c.getContext('2d');
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.drawImage(decoded.source, -size.width / 2, -size.height / 2, size.width, size.height);
      return c;
    } finally {
      decoded.close();
    }
  }

  /** 画面の大きさに合わせて、画像と四角形の位置を決め直す */
  function layout() {
    if (!base || !isOpen()) return;
    const rect = stage.getBoundingClientRect();
    const availW = Math.max(1, rect.width - STAGE_PADDING * 2);
    const availH = Math.max(1, rect.height - STAGE_PADDING * 2);
    const scale = Math.min(availW / base.width, availH / base.height);
    const width = Math.round(base.width * scale);
    const height = Math.round(base.height * scale);
    box = { left: Math.round((rect.width - width) / 2), top: Math.round((rect.height - height) / 2), width, height };

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    Object.assign(canvas.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${width}px`, height: `${height}px` });
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, 0, 0, canvas.width, canvas.height);

    overlay.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    overlay.setAttribute('width', rect.width);
    overlay.setAttribute('height', rect.height);
    drawOverlay();
  }

  const toStage = (p) => ({ x: box.left + p.x * box.width, y: box.top + p.y * box.height });

  function drawOverlay() {
    if (!box) return;
    const pts = corners.map(toStage);
    const quad = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z';
    const rect = stage.getBoundingClientRect();
    const outer = `M0,0 h${rect.width} v${rect.height} h${-rect.width} Z`;
    let html = `<path class="shade" d="${outer} ${quad}" fill-rule="evenodd"/>`;
    html += `<path class="quad" d="${quad}"/>`;
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % 4];
      const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      html += `<g class="handle mid" data-handle="m${i}" role="button" aria-label="辺${i + 1}を動かす">`;
      html += `<circle class="hit" cx="${m.x}" cy="${m.y}" r="22"/><circle class="dot" cx="${m.x}" cy="${m.y}" r="7"/></g>`;
    });
    pts.forEach((p, i) => {
      html += `<g class="handle corner" data-handle="c${i}" role="button" aria-label="角${i + 1}を動かす">`;
      html += `<circle class="hit" cx="${p.x}" cy="${p.y}" r="26"/><circle class="dot" cx="${p.x}" cy="${p.y}" r="12"/></g>`;
    });
    overlay.innerHTML = html;
  }

  /** 画面上の位置を、画像に対する割合（0〜1）にする */
  function toNormalized(clientX, clientY) {
    const rect = stage.getBoundingClientRect();
    return { x: (clientX - rect.left - box.left) / box.width, y: (clientY - rect.top - box.top) / box.height };
  }

  const clampMargin = (v) => Math.min(1 + PERSPECTIVE_MARGIN, Math.max(-PERSPECTIVE_MARGIN, v));

  /** 丸を動かせる範囲（写真の外は PERSPECTIVE_MARGIN まで。ただし画面の外には出さない） */
  function bounds() {
    const rect = stage.getBoundingClientRect();
    return {
      minX: Math.max(-PERSPECTIVE_MARGIN, -box.left / box.width),
      maxX: Math.min(1 + PERSPECTIVE_MARGIN, (rect.width - box.left) / box.width),
      minY: Math.max(-PERSPECTIVE_MARGIN, -box.top / box.height),
      maxY: Math.min(1 + PERSPECTIVE_MARGIN, (rect.height - box.top) / box.height),
    };
  }

  overlay.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('[data-handle]');
    if (!handle || !box) return;
    event.preventDefault();
    const id = handle.dataset.handle;
    drag = {
      kind: id[0],
      index: Number(id.slice(1)),
      pointerId: event.pointerId,
      start: toNormalized(event.clientX, event.clientY),
      startCorners: corners.map((c) => ({ ...c })),
    };
    overlay.setPointerCapture(event.pointerId);
    showLoupe();
  });

  overlay.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const p = toNormalized(event.clientX, event.clientY);
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    const next = drag.startCorners.map((c) => ({ ...c }));
    const b = bounds();
    const move = (i) => {
      next[i] = {
        x: Math.min(b.maxX, Math.max(b.minX, drag.startCorners[i].x + dx)),
        y: Math.min(b.maxY, Math.max(b.minY, drag.startCorners[i].y + dy)),
      };
    };
    if (drag.kind === 'c') move(drag.index);
    else {
      // 辺の中点を動かすと、その辺の両端の角が一緒に動く
      move(drag.index);
      move((drag.index + 1) % 4);
    }
    // ねじれた形になる動きは受け付けない
    if (!isConvexQuad(next)) return;
    corners = next;
    drawOverlay();
    showLoupe();
  });

  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    loupe.hidden = true;
  };
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);

  /** つまんでいる丸のまわりを拡大して表示する */
  function showLoupe() {
    if (!drag || !base) return;
    const point =
      drag.kind === 'c'
        ? corners[drag.index]
        : {
            x: (corners[drag.index].x + corners[(drag.index + 1) % 4].x) / 2,
            y: (corners[drag.index].y + corners[(drag.index + 1) % 4].y) / 2,
          };
    // 指の反対側に出す（左上をつまんでいるときは右上に）
    loupe.classList.toggle('right', point.x < 0.5 && point.y < 0.45);
    loupe.hidden = false;

    const size = loupe.width;
    const ctx = loupe.getContext('2d');
    ctx.fillStyle = '#20242c';
    ctx.fillRect(0, 0, size, size);
    const cssSize = loupe.getBoundingClientRect().width || size / 2;
    const region = (cssSize / LOUPE_ZOOM) * (base.width / box.width);
    const bx = point.x * base.width;
    const by = point.y * base.height;
    // 写真の外にかかる部分は切り取って描く（Safari で引き伸ばされないように）
    drawImageClipped(
      ctx,
      base,
      { sx: bx - region / 2, sy: by - region / 2, sw: region, sh: region, dx: 0, dy: 0, dw: size, dh: size },
      base.width,
      base.height,
    );
    // 四角形の線
    const toLoupe = (c) => ({
      x: ((c.x * base.width - (bx - region / 2)) / region) * size,
      y: ((c.y * base.height - (by - region / 2)) / region) * size,
    });
    ctx.strokeStyle = 'rgba(47, 109, 246, .95)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    corners.map(toLoupe).forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    // 中心の十字
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(size / 2 - 14, size / 2);
    ctx.lineTo(size / 2 + 14, size / 2);
    ctx.moveTo(size / 2, size / 2 - 14);
    ctx.lineTo(size / 2, size / 2 + 14);
    ctx.stroke();
  }

  function apply() {
    if (!page) return;
    const value = {
      corners: corners
        .map((c) => fromDisplayPoint(c, page.rotation))
        .map((c) => ({ x: clampMargin(c.x), y: clampMargin(c.y) })),
      aspect: a4Toggle.checked ? 'a4' : 'free',
    };
    const id = page.id;
    close();
    onApply(id, value);
  }

  function remove() {
    if (!page) return;
    const id = page.id;
    close();
    onApply(id, null);
  }

  root.addEventListener('click', (event) => {
    const action = event.target.closest('[data-editor]')?.dataset.editor;
    if (action === 'apply') apply();
    else if (action === 'cancel') close();
    else if (action === 'remove') remove();
    else if (action === 'reset') {
      corners = defaultCorners();
      drawOverlay();
    }
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  window.addEventListener('resize', layout);

  return { open, close, isOpen };
}
