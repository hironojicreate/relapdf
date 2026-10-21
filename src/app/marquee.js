// 囲んで選ぶ（詳細モード・マウス）（UI層）
//
// ページのない所からマウスでドラッグすると青い薄い四角を出し、四角にかかったページをまとめて選ぶ。
// Shift・Ctrl・⌘ を押しながらだと、今の選択に付け足す。

const THRESHOLD = 4; // これだけ動かしたら「囲む」とみなす（クリックと区別するため）

/**
 * @param {HTMLElement} area 囲み始められる範囲（ページの上・ボタン・上下のバーからは始めない）
 * @param {object} options
 * @param {() => boolean} options.enabled 今使えるか
 * @param {() => HTMLElement[]} options.cards ページの要素（data-id を持つ）
 * @param {(ids: string[], info: { add: boolean }) => void} options.onSelect 囲んでいるページが変わるたびに呼ぶ
 */
export function enableMarqueeSelect(area, { enabled, cards, onSelect }) {
  let state = null;
  const box = document.createElement('div');
  box.className = 'marquee';
  box.hidden = true;
  box.setAttribute('aria-hidden', 'true');
  document.body.append(box);

  area.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || !enabled()) return;
    // ページ・ボタン・入力欄の上からは始めない（ページのドラッグやクリックと区別する）
    if (event.target.closest('.page-card, button, input, select, textarea, label, a, dialog, header, footer, .toolbar, .selection-bar')) return;
    state = {
      pointerId: event.pointerId,
      startX: event.pageX,
      startY: event.pageY,
      add: event.shiftKey || event.ctrlKey || event.metaKey,
      started: false,
      last: '',
    };
  });

  window.addEventListener('pointermove', (event) => {
    if (!state || event.pointerId !== state.pointerId) return;
    const x = event.pageX;
    const y = event.pageY;
    if (!state.started) {
      if (Math.hypot(x - state.startX, y - state.startY) < THRESHOLD) return;
      state.started = true;
      document.body.classList.add('is-marquee');
    }
    event.preventDefault();
    const rect = {
      left: Math.min(x, state.startX),
      top: Math.min(y, state.startY),
      right: Math.max(x, state.startX),
      bottom: Math.max(y, state.startY),
    };
    Object.assign(box.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.right - rect.left}px`,
      height: `${rect.bottom - rect.top}px`,
    });
    box.hidden = false;
    const ids = cards()
      .filter((card) => {
        const r = card.getBoundingClientRect();
        const left = r.left + scrollX;
        const top = r.top + scrollY;
        return left < rect.right && left + r.width > rect.left && top < rect.bottom && top + r.height > rect.top;
      })
      .map((card) => card.dataset.id);
    const key = ids.join(',');
    if (key === state.last) return;
    state.last = key;
    onSelect(ids, { add: state.add });
  });

  const end = (event) => {
    if (!state || event.pointerId !== state.pointerId) return;
    const started = state.started;
    state = null;
    box.hidden = true;
    document.body.classList.remove('is-marquee');
    // 囲み終わったあとの「クリック」で、選択が外れないようにする
    if (started) {
      const swallow = (e) => {
        e.stopPropagation();
        e.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 300);
    }
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}
