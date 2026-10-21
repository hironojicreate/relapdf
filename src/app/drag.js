// ドラッグでの並べ替え（UI層）
//
// - マウス：ページの絵をつかんで動かす
// - タッチ：ページを長押し（約0.4秒）してから動かす。かんたんモードの「つまみ」は押した瞬間から動かせる
// ドラッグ中は、落ちる場所に太い線と「○番目へ」を出す。画面の端に近づくと自動でスクロールする。
// 選んだページが複数あるとき（詳細モード）に、そのうちの1枚をつかむと、選んだページをまとめて動かす。

import { dropTargetAt, positionAfterMove } from '../web/reorder.js';

const MOUSE_THRESHOLD = 6; // マウスはこれだけ動かしたらドラッグとみなす（クリックと区別するため）
const LONG_PRESS = 400; // タッチでドラッグを始めるまでの長押しの時間（ミリ秒）
const TOUCH_SLOP = 10; // 長押しの間にこれ以上動いたら、ドラッグではなくスクロールとみなす
const EDGE = 80; // 画面の上下の端からこの距離に入ったら自動スクロール
const MARKER_GAP = 6; // 線をページの端からどれだけ離すか（ページの間のすき間の半分）

/**
 * @param {HTMLElement} grid ページの一覧
 * @param {(pageId: string, insertBefore: number) => void} onDrop
 *   離したとき。insertBefore は「今の並びで、何番目のページの前に入れるか」（0〜ページ数）
 */
export function enableDragReorder(grid, onDrop) {
  let state = null;
  const marker = createMarker();

  grid.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || state) return;
    const card = event.target.closest('.page-card');
    if (!card) return;
    const handle = event.target.closest('[data-drag-handle]');
    const touch = event.pointerType !== 'mouse';
    // ボタン（つまみ以外）を押したときは、ドラッグにしない
    if (!handle && event.target.closest('button')) return;
    if (!handle && !touch && !event.target.closest('.thumb')) return;
    if (handle) event.preventDefault();
    state = {
      card,
      pointerId: event.pointerId,
      touch,
      startX: event.pageX,
      startY: event.pageY,
      x: event.clientX,
      y: event.clientY,
      started: false,
      target: null,
    };
    if (handle) begin();
    else if (touch) state.pressTimer = setTimeout(begin, LONG_PRESS);
  });

  function cards() {
    return [...grid.querySelectorAll('.page-card')];
  }

  function begin() {
    if (!state || state.started) return;
    const list = cards();
    state.started = true;
    state.fromIndex = list.indexOf(state.card);
    // 選んだページのうちの1枚をつかんだときは、まとめて動かす
    const selected = state.card.classList.contains('selected') ? list.filter((c) => c.classList.contains('selected')) : [];
    state.multi = selected.length > 1;
    state.movingIndexes = state.multi ? selected.map((c) => list.indexOf(c)) : [state.fromIndex];
    if (state.multi) state.card.dataset.dragCount = String(selected.length);
    state.rects = list.map((c) => {
      const r = c.getBoundingClientRect();
      return { left: r.left + scrollX, top: r.top + scrollY, width: r.width, height: r.height };
    });
    state.card.classList.add('dragging');
    grid.classList.add('is-dragging');
    navigator.vibrate?.(10);
    try {
      state.card.setPointerCapture(state.pointerId);
    } catch {
      // 捕捉できなくても、window で動きを受け取れる
    }
    state.frame = requestAnimationFrame(autoScroll);
    follow();
  }

  function follow() {
    const pageX = state.x + scrollX;
    const pageY = state.y + scrollY;
    state.card.style.transform = `translate(${pageX - state.startX}px, ${pageY - state.startY}px)`;
    const target = dropTargetAt(state.rects, pageX, pageY);
    state.target = target;
    const to = positionAfterMove(target.insertBefore, state.movingIndexes);
    // 位置が変わらないとき（自分の前後に落とすとき）は、線を出さない
    const unchanged = !state.multi && to === state.fromIndex;
    if (unchanged || target.anchor < 0) {
      marker.hidden = true;
      return;
    }
    const r = state.rects[target.anchor];
    const x = target.side === 'before' ? r.left - MARKER_GAP : r.left + r.width + MARKER_GAP;
    Object.assign(marker.style, { left: `${x}px`, top: `${r.top - 4}px`, height: `${r.height + 8}px` });
    marker.querySelector('span').textContent = `${to + 1}番目へ`;
    marker.hidden = false;
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
    const { started, card, target, frame, pressTimer } = state;
    const movingIndexes = state.movingIndexes ?? [];
    const multi = state.multi;
    const fromIndex = state.fromIndex;
    state = null;
    clearTimeout(pressTimer);
    if (!started) return;
    cancelAnimationFrame(frame);
    card.classList.remove('dragging');
    card.style.transform = '';
    delete card.dataset.dragCount;
    grid.classList.remove('is-dragging');
    marker.hidden = true;
    swallowNextClick();
    if (!commit || !target) return;
    if (!multi && positionAfterMove(target.insertBefore, movingIndexes) === fromIndex) return;
    onDrop(card.dataset.id, target.insertBefore);
  }

  // ドラッグを離した直後の「クリック」で、補正画面などが開いたり選択が変わったりしないようにする
  function swallowNextClick() {
    const swallow = (e) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    // クリックが起きなかった場合（タッチ操作など）に備えて、少しあとに外す
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 300);
  }

  window.addEventListener('pointermove', (event) => {
    if (!state || event.pointerId !== state.pointerId) return;
    state.x = event.clientX;
    state.y = event.clientY;
    if (!state.started) {
      const moved = Math.hypot(event.pageX - state.startX, event.pageY - state.startY);
      if (state.touch) {
        // 長押しの前に指が動いたら、スクロールとみなしてドラッグをやめる
        if (moved > TOUCH_SLOP) finish(false);
        return;
      }
      if (moved < MOUSE_THRESHOLD) return;
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
  // ドラッグ中は、ページがスクロールしないようにする（タッチ）
  grid.addEventListener(
    'touchmove',
    (event) => {
      if (state?.started) event.preventDefault();
    },
    { passive: false },
  );
  // 長押しのときに、写真の保存などのメニューが出ないようにする
  grid.addEventListener('contextmenu', (event) => {
    if (state || event.target.closest('.page-card .thumb')) event.preventDefault();
  });
}

/** 落ちる場所の目印（太い線と「○番目へ」） */
function createMarker() {
  const marker = document.createElement('div');
  marker.className = 'drop-marker';
  marker.hidden = true;
  marker.setAttribute('aria-hidden', 'true');
  marker.innerHTML = '<span></span>';
  document.body.append(marker);
  return marker;
}
