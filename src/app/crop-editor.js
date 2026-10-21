// トリミングの画面（UI層）
//
// ページを大きく表示し、残す範囲を四角で囲んでもらう。四隅と辺の丸をつまむと大きさが、内側をつまむと位置が変わる。
// 範囲は画面で見たときの向きで扱い、保存するときに回転前の向きに戻す（imposition.js の cropFromDisplay）。

import { cropToDisplay } from '../core/imposition.js';

const MIN_SIZE = 0.05; // 残す範囲の最小（ページの幅・高さに対する割合）
const STAGE_PADDING = 22;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @param {object} deps
 * @param {(page: object) => Promise<Blob>} deps.renderPage ページの絵（ユーザーの回転をかけた向き）
 * @param {(rect: {x: number, y: number, w: number, h: number} | null, applyToAll: boolean) => void} deps.onApply
 *   「完了」（範囲は画面の向き）・「トリミングしない」（null）を押したとき。applyToAll は、選んだページすべてに使うか
 */
export function createCropEditor({ renderPage, onApply }) {
  const $ = (selector) => document.querySelector(selector);
  const root = $('#cropper');
  const stage = $('#cropper-stage');
  const img = $('#cropper-page');
  const svg = $('#cropper-svg');
  const applyAll = $('#cropper-all');
  const applyAllRow = $('#cropper-all-row');

  let rect = { x: 0, y: 0, w: 1, h: 1 }; // 画面の向きでの残す範囲（0〜1）
  let box = null; // ページの絵の位置と大きさ（stage の中、CSSピクセル）
  let drag = null;
  let pageUrl = null;
  let opening = 0;

  /**
   * @param {object} page 範囲の見本にするページ
   * @param {number} count 選んでいるページの数（2以上なら「すべてに使う」を出す）
   */
  async function open(page, count = 1) {
    const token = ++opening;
    rect = page.crop ? cropToDisplay(page.crop, page.rotation) : { x: 0, y: 0, w: 1, h: 1 };
    applyAllRow.hidden = count < 2;
    applyAll.checked = count >= 2;
    root.hidden = false;
    root.classList.add('loading');
    document.body.classList.add('editor-open');
    try {
      const blob = await renderPage(page);
      if (token !== opening) return;
      if (pageUrl) URL.revokeObjectURL(pageUrl);
      pageUrl = URL.createObjectURL(blob);
      img.src = pageUrl;
      await img.decode();
      if (token !== opening) return;
      root.classList.remove('loading');
      layout();
      root.querySelector('[data-crop="apply"]').focus();
    } catch (error) {
      console.error(error);
      close();
    }
  }

  function close() {
    opening += 1;
    root.hidden = true;
    document.body.classList.remove('editor-open');
    drag = null;
    img.removeAttribute('src');
    if (pageUrl) URL.revokeObjectURL(pageUrl);
    pageUrl = null;
  }

  const isOpen = () => !root.hidden;

  function layout() {
    if (!isOpen() || !img.naturalWidth) return;
    const area = stage.getBoundingClientRect();
    const scale = Math.min((area.width - STAGE_PADDING * 2) / img.naturalWidth, (area.height - STAGE_PADDING * 2) / img.naturalHeight);
    const width = img.naturalWidth * scale;
    const height = img.naturalHeight * scale;
    box = { left: (area.width - width) / 2, top: (area.height - height) / 2, width, height };
    Object.assign(img.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${width}px`, height: `${height}px` });
    svg.setAttribute('viewBox', `0 0 ${area.width} ${area.height}`);
    draw();
  }

  /** 残す範囲の外を暗くし、枠とつまむ丸を描く */
  function draw() {
    if (!box) return;
    const area = stage.getBoundingClientRect();
    const x = box.left + rect.x * box.width;
    const y = box.top + rect.y * box.height;
    const w = rect.w * box.width;
    const h = rect.h * box.height;
    const el = (name, attrs) => {
      const node = document.createElementNS(SVG_NS, name);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      return node;
    };
    const nodes = [
      el('path', { class: 'shade', 'fill-rule': 'evenodd', d: `M0,0h${area.width}v${area.height}h${-area.width}Z M${x},${y}h${w}v${h}h${-w}Z` }),
      el('rect', { class: 'quad crop-frame', x, y, width: w, height: h, 'data-handle': 'move' }),
    ];
    // 四隅（c）と辺の中点（e）。名前は動かす辺（n=上, s=下, w=左, e=右）
    const handles = { nw: [x, y], ne: [x + w, y], se: [x + w, y + h], sw: [x, y + h], n: [x + w / 2, y], e: [x + w, y + h / 2], s: [x + w / 2, y + h], w: [x, y + h / 2] };
    for (const [name, [cx, cy]] of Object.entries(handles)) {
      const corner = name.length === 2;
      const g = el('g', { class: `handle ${corner ? 'corner' : 'mid'}`, 'data-handle': name });
      g.append(el('circle', { class: 'hit', cx, cy, r: 24 }), el('circle', { class: 'dot', cx, cy, r: corner ? 11 : 7 }));
      nodes.push(g);
    }
    svg.replaceChildren(...nodes);
  }

  const toUnit = (event) => {
    const area = stage.getBoundingClientRect();
    return { x: (event.clientX - area.left - box.left) / box.width, y: (event.clientY - area.top - box.top) / box.height };
  };

  svg.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('[data-handle]');
    if (!handle || !box) return;
    event.preventDefault();
    drag = { kind: handle.dataset.handle, start: toUnit(event), from: { ...rect }, pointerId: event.pointerId };
    svg.setPointerCapture(event.pointerId);
  });

  svg.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const p = toUnit(event);
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    const f = drag.from;
    if (drag.kind === 'move') {
      rect = { ...f, x: clamp(f.x + dx, 0, 1 - f.w), y: clamp(f.y + dy, 0, 1 - f.h) };
    } else {
      let left = f.x;
      let top = f.y;
      let right = f.x + f.w;
      let bottom = f.y + f.h;
      if (drag.kind.includes('w')) left = clamp(f.x + dx, 0, right - MIN_SIZE);
      if (drag.kind.includes('e')) right = clamp(f.x + f.w + dx, left + MIN_SIZE, 1);
      if (drag.kind.includes('n')) top = clamp(f.y + dy, 0, bottom - MIN_SIZE);
      if (drag.kind.includes('s')) bottom = clamp(f.y + f.h + dy, top + MIN_SIZE, 1);
      rect = { x: left, y: top, w: right - left, h: bottom - top };
    }
    draw();
  });

  const endDrag = (event) => {
    if (drag && event.pointerId === drag.pointerId) drag = null;
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  root.addEventListener('click', (event) => {
    const action = event.target.closest('[data-crop]')?.dataset.crop;
    if (action === 'cancel') close();
    else if (action === 'reset') {
      rect = { x: 0, y: 0, w: 1, h: 1 };
      draw();
    } else if (action === 'apply' || action === 'remove') {
      const all = applyAll.checked && !applyAllRow.hidden;
      // 全体を選んだままなら、トリミングしないのと同じ
      const whole = rect.x <= 0.001 && rect.y <= 0.001 && rect.w >= 0.999 && rect.h >= 0.999;
      const value = action === 'remove' || whole ? null : { ...rect };
      close();
      onApply(value, all);
    }
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  window.addEventListener('resize', layout);

  return { open, close, isOpen };
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
