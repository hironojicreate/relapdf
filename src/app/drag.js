// ドラッグでの並べ替え（UI層）
//
// - スマホ：各ページのつまみ（data-drag-handle）を押さえて動かす
// - PC：マウスでページの絵をつかんで動かす
// 指を離した位置に、ページを移動する。画面の端に近づくと自動でスクロールする。

import { insertionIndexAt, moveTargetIndex } from '../web/reorder.js';

const MOUSE_THRESHOLD = 6; // マウスはこれだけ動かしたらドラッグとみなす（クリックと区別するため）
const EDGE = 80; // 画面の上下の端からこの距離に入ったら自動スクロール

/**
 * @param {HTMLElement} grid ページの一覧
 * @param {(pageId: string, toIndex: number) => void} onMove
 */
export function enableDragReorder(grid, onMove) {
  let state = null;

  grid.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || state) return;
    const handle = event.target.closest('[data-drag-handle]');
    const mouseOnThumb = event.pointerType === 'mouse' && event.target.closest('.thumb');
    if (!handle && !mouseOnThumb) return;
    const card = event.target.closest('.page-card');
    if (!card) return;
    if (handle) event.preventDefault();
    state = {
      card,
      pointerId: event.pointerId,
      startX: event.pageX,
      startY: event.pageY,
      x: event.clientX,
      y: event.clientY,
      started: false,
      insertBefore: null,
    };
    if (handle) begin();
  });

  function cards() {
    return [...grid.querySelectorAll('.page-card')];
  }

  function begin() {
    const list = cards();
    state.started = true;
    state.fromIndex = list.indexOf(state.card);
    state.rects = list.map((c) => {
      const r = c.getBoundingClientRect();
      return { left: r.left + scrollX, top: r.top + scrollY, width: r.width, height: r.height };
    });
    state.card.classList.add('dragging');
    grid.classList.add('is-dragging');
    try {
      state.card.setPointerCapture(state.pointerId);
    } catch {
      // 捕捉できなくても、window で動きを受け取れる
    }
    state.frame = requestAnimationFrame(autoScroll);
  }

  function follow() {
    const pageX = state.x + scrollX;
    const pageY = state.y + scrollY;
    state.card.style.transform = `translate(${pageX - state.startX}px, ${pageY - state.startY}px)`;
    const insertBefore = insertionIndexAt(state.rects, pageX, pageY);
    if (insertBefore === state.insertBefore) return;
    state.insertBefore = insertBefore;
    const list = cards();
    for (const c of list) c.classList.remove('drop-before', 'drop-after');
    if (moveTargetIndex(insertBefore, state.fromIndex) === null) return;
    if (insertBefore < list.length) list[insertBefore].classList.add('drop-before');
    else list[list.length - 1].classList.add('drop-after');
  }

  function autoScroll() {
    if (!state?.started) return;
    let dy = 0;
    if (state.y < EDGE) dy = -Math.ceil((EDGE - state.y) / 6);
    else if (state.y > innerHeight - EDGE) dy = Math.ceil((state.y - (innerHeight - EDGE)) / 6);
    if (dy !== 0) {
      scrollBy(0, dy);
      follow();
    }
    state.frame = requestAnimationFrame(autoScroll);
  }

  function finish(commit) {
    if (!state) return;
    const { started, card, insertBefore, fromIndex, frame } = state;
    state = null;
    if (!started) return;
    cancelAnimationFrame(frame);
    card.classList.remove('dragging');
    card.style.transform = '';
    grid.classList.remove('is-dragging');
    for (const c of cards()) c.classList.remove('drop-before', 'drop-after');
    if (!commit || insertBefore === null) return;
    const to = moveTargetIndex(insertBefore, fromIndex);
    if (to !== null) onMove(card.dataset.id, to);
  }

  window.addEventListener('pointermove', (event) => {
    if (!state || event.pointerId !== state.pointerId) return;
    state.x = event.clientX;
    state.y = event.clientY;
    if (!state.started) {
      if (Math.hypot(event.pageX - state.startX, event.pageY - state.startY) < MOUSE_THRESHOLD) return;
      begin();
    }
    event.preventDefault();
    follow();
  });
  window.addEventListener('pointerup', (event) => {
    if (state && event.pointerId === state.pointerId) finish(true);
  });
  window.addEventListener('pointercancel', (event) => {
    if (state && event.pointerId === state.pointerId) finish(false);
  });
  // つまみを押したままのときに、ページがスクロールしないようにする（iPhone）
  grid.addEventListener('touchmove', (event) => {
    if (state?.started) event.preventDefault();
  }, { passive: false });
}
