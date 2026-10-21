// 注釈・署名の画面（UI層）
//
// ページを大きく表示し、その上に文字・四角・丸・線・矢印・マーカー・署名や印鑑の画像を置く。
// 注釈は「ユーザーの回転をかける前」のページの座標で持つ（annotations.js）。
// 画面では、回転前のページの座標（ピクセル）で描いたものを、SVG の transform でページと同じ向きに回して見せる。
// こうすると、指の位置を回転前の座標に戻すのも getScreenCTM の逆変換だけで済む。

import { ANNOTATION_COLORS, TEXT_SIZES } from '../core/annotations.js';
import { newId } from '../core/page-list.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LINE_WIDTH = 2 / 595; // 線の太さ（ページの幅に対する割合。A4で2pt）
const HIGHLIGHT_OPACITY = 0.35;
const MIN_DRAG = 6; // これより短いなぞり方は、図形にしない（画面のピクセル）
const STAGE_PADDING = 12;

const css = (rgb) => `rgb(${rgb.map((v) => Math.round(v * 255)).join(',')})`;

/**
 * @param {object} deps
 * @param {(page: object) => Promise<Blob>} deps.renderPage ページの絵（ユーザーの回転をかけた向き）
 * @param {(sourceId: string) => Promise<string>} deps.getImageUrl 画像の注釈の表示用URL
 * @param {() => Promise<{sourceId: string, width: number, height: number} | null>} deps.pickImage 署名・印鑑の画像を選んでもらう
 * @param {(pageId: string, annotations: object[]) => void} deps.onApply 「完了」を押したとき
 */
export function createAnnotator({ renderPage, getImageUrl, pickImage, onApply }) {
  const $ = (selector) => document.querySelector(selector);
  const root = $('#annotator');
  const stage = $('#annotator-stage');
  const img = $('#annotator-page');
  const svg = $('#annotator-svg');
  const textBox = $('#annotator-text');
  const hint = $('#annotator-hint');
  const sizeSelect = $('#annotator-size');
  const deleteButton = root.querySelector('[data-annot="delete"]');

  let page = null;
  let list = []; // 編集中の注釈
  let tool = 'select';
  let color = 'red';
  let selectedId = null;
  let drag = null;
  let editing = null; // 文字の入力中 { id | null, x, y }
  let frame = null; // { base: {width, height}（回転前のページのピクセル）, view: {width, height}, rotation, scale }
  let pageUrl = null;
  const imageUrls = new Map();
  let opening = 0;

  async function open(target) {
    page = target;
    const token = ++opening;
    list = structuredClone(page.annotations ?? []);
    selectedId = null;
    setTool('select');
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
      for (const a of list) if (a.type === 'image') await loadImageUrl(a.sourceId);
      if (token !== opening) return;
      const view = { width: img.naturalWidth, height: img.naturalHeight };
      const sideways = page.rotation === 90 || page.rotation === 270;
      frame = { view, base: sideways ? { width: view.height, height: view.width } : view, rotation: page.rotation, scale: 1 };
      root.classList.remove('loading');
      layout();
      root.querySelector('[data-annot="apply"]').focus();
    } catch (error) {
      console.error(error);
      close();
    }
  }

  function close() {
    opening += 1;
    commitText();
    root.hidden = true;
    document.body.classList.remove('editor-open');
    page = null;
    frame = null;
    drag = null;
    svg.innerHTML = '';
    img.removeAttribute('src');
    if (pageUrl) URL.revokeObjectURL(pageUrl);
    pageUrl = null;
  }

  const isOpen = () => !root.hidden;

  async function loadImageUrl(sourceId) {
    if (!imageUrls.has(sourceId)) imageUrls.set(sourceId, await getImageUrl(sourceId));
    return imageUrls.get(sourceId);
  }

  /** 画面の大きさに合わせて、ページの絵と注釈の位置を決める */
  function layout() {
    if (!frame || !isOpen()) return;
    const rect = stage.getBoundingClientRect();
    const scale = Math.min((rect.width - STAGE_PADDING * 2) / frame.view.width, (rect.height - STAGE_PADDING * 2) / frame.view.height);
    frame.scale = Math.max(0.01, scale);
    const width = frame.view.width * frame.scale;
    const height = frame.view.height * frame.scale;
    const left = (rect.width - width) / 2;
    const top = (rect.height - height) / 2;
    for (const el of [img, svg]) {
      Object.assign(el.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    }
    svg.setAttribute('viewBox', `0 0 ${frame.view.width} ${frame.view.height}`);
    draw();
  }

  /** 回転前のページの座標を、画面の向きに回す変換 */
  function rootTransform() {
    const { width, height } = frame.view;
    switch (frame.rotation) {
      case 90:
        return `translate(${width},0) rotate(90)`;
      case 180:
        return `translate(${width},${height}) rotate(180)`;
      case 270:
        return `translate(0,${height}) rotate(270)`;
      default:
        return '';
    }
  }

  const el = (name, attrs = {}) => {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };

  /** 注釈をすべて描き直す */
  function draw() {
    if (!frame) return;
    const { width: W, height: H } = frame.base;
    const lw = LINE_WIDTH * W;
    const group = el('g', { id: 'annot-root', transform: rootTransform() });
    // ページ全体を覆う、指の位置を受け取るための透明な四角
    group.append(el('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent', class: 'annot-bg' }));
    for (const a of list) {
      const c = a.color ? css(ANNOTATION_COLORS[a.color]) : null;
      const g = el('g', { class: 'ann', 'data-id': a.id });
      switch (a.type) {
        case 'rect':
        case 'highlight':
        case 'redact':
        case 'ellipse': {
          const x = a.x * W;
          const y = a.y * H;
          const w = a.w * W;
          const h = a.h * H;
          const shape =
            a.type === 'ellipse'
              ? el('ellipse', { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 })
              : el('rect', { x, y, width: w, height: h });
          if (a.type === 'redact') shape.setAttribute('fill', '#000');
          else if (a.type === 'highlight') shape.setAttribute('fill', c), shape.setAttribute('fill-opacity', HIGHLIGHT_OPACITY);
          else shape.setAttribute('fill', 'transparent'), shape.setAttribute('stroke', c), shape.setAttribute('stroke-width', lw);
          g.append(shape);
          break;
        }
        case 'line':
        case 'arrow': {
          const p1 = { x: a.x1 * W, y: a.y1 * H };
          const p2 = { x: a.x2 * W, y: a.y2 * H };
          g.append(el('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, class: 'ann-hit', 'stroke-width': Math.max(lw * 6, 14 / frame.scale) }));
          g.append(el('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, stroke: c, 'stroke-width': lw, 'stroke-linecap': 'round' }));
          if (a.type === 'arrow') {
            const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            const size = Math.min((14 / 595) * W, len * 0.4);
            for (const sign of [1, -1]) {
              const t = Math.atan2(p2.y - p1.y, p2.x - p1.x) + Math.PI + (sign * 25 * Math.PI) / 180;
              g.append(el('line', { x1: p2.x, y1: p2.y, x2: p2.x + Math.cos(t) * size, y2: p2.y + Math.sin(t) * size, stroke: c, 'stroke-width': lw, 'stroke-linecap': 'round' }));
            }
          }
          break;
        }
        case 'text': {
          // 文字の左上を原点にして、文字の向きに回す
          const inner = el('g', { transform: `translate(${a.x * W},${a.y * H}) rotate(${a.rotation ?? 0})`, class: 'ann-content' });
          const size = a.size * W;
          const text = el('text', { 'font-size': size, fill: c, class: 'ann-text' });
          a.text.split(/\r\n|\r|\n/).forEach((line, i) => {
            const span = el('tspan', { x: 0, y: size * (0.88 + i * 1.3) });
            span.textContent = line || ' ';
            text.append(span);
          });
          inner.append(text);
          g.append(inner);
          break;
        }
        case 'image': {
          const inner = el('g', { transform: `translate(${a.x * W},${a.y * H}) rotate(${a.rotation ?? 0})`, class: 'ann-content' });
          const image = el('image', { x: 0, y: 0, width: a.w * W, height: a.h * W, preserveAspectRatio: 'none' });
          image.setAttribute('href', imageUrls.get(a.sourceId) ?? '');
          inner.append(image);
          g.append(inner);
          break;
        }
        default:
          break;
      }
      group.append(g);
    }
    svg.replaceChildren(group);
    // 文字は、囲む四角で押せるようにする（文字の大きさは描いてから分かる）
    for (const g of group.querySelectorAll('.ann')) {
      const text = g.querySelector('.ann-text');
      if (text) {
        const box = text.getBBox();
        text.before(el('rect', { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8, class: 'ann-hit' }));
      }
    }
    drawSelection(group);
    deleteButton.disabled = !selectedId;
  }

  /** 選んでいる注釈の枠と、大きさを変えるつまみ */
  function drawSelection(group) {
    const a = list.find((item) => item.id === selectedId);
    if (!a) return;
    const { width: W, height: H } = frame.base;
    const r = 9 / frame.scale; // つまみの大きさ（画面で約9px）
    const handle = (x, y, name, parent = group) =>
      parent.append(el('circle', { cx: x, cy: y, r, class: 'sel-handle', 'data-handle': name, 'stroke-width': 2 / frame.scale }));
    const outline = (x, y, w, h, parent = group) =>
      parent.append(el('rect', { x, y, width: w, height: h, class: 'sel-outline', 'stroke-width': 1.5 / frame.scale }));
    if (a.type === 'line' || a.type === 'arrow') {
      handle(a.x1 * W, a.y1 * H, 'p1');
      handle(a.x2 * W, a.y2 * H, 'p2');
    } else if (a.type === 'text' || a.type === 'image') {
      const node = group.querySelector(`.ann[data-id="${CSS.escape(a.id)}"] .ann-content`);
      const box = node.getBBox();
      outline(box.x - 4, box.y - 4, box.width + 8, box.height + 8, node);
      if (a.type === 'image') handle(a.w * W, a.h * W, 'resize', node);
    } else {
      outline(a.x * W, a.y * H, a.w * W, a.h * H);
      handle((a.x + a.w) * W, (a.y + a.h) * H, 'resize');
    }
  }

  /** 画面の位置を、回転前のページのピクセル座標にする（node を指定すると、その要素の中の座標） */
  function toLocal(event, node = svg.querySelector('#annot-root')) {
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return point.matrixTransform(node.getScreenCTM().inverse());
  }

  function setTool(next) {
    commitText();
    tool = next;
    for (const button of root.querySelectorAll('[data-tool]')) button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
    hint.textContent =
      tool === 'select'
        ? '注釈を押して選ぶと、動かしたり大きさを変えたりできます'
        : tool === 'text'
          ? '文字を置く場所を押してください'
          : tool === 'redact'
            ? '隠す部分をなぞってください。墨消ししたページは、作成するときに画像になり、下の文字も消えます'
            : 'ページの上をなぞってください';
    svg.style.cursor = tool === 'select' ? 'default' : 'crosshair';
  }

  function select(id) {
    selectedId = id;
    const a = list.find((item) => item.id === id);
    if (a?.color && a.type !== 'highlight') setColor(a.color, false);
    if (a?.type === 'text') {
      const key = Object.entries(TEXT_SIZES).find(([, v]) => Math.abs(v - a.size) < 1e-6)?.[0];
      if (key) sizeSelect.value = key;
    }
    draw();
  }

  function setColor(next, applyToSelected = true) {
    color = next;
    for (const button of root.querySelectorAll('[data-color]')) button.setAttribute('aria-pressed', String(button.dataset.color === color));
    if (!applyToSelected) return;
    const a = list.find((item) => item.id === selectedId);
    if (a?.color && a.type !== 'highlight') {
      a.color = color;
      draw();
    }
  }

  /** 新しく置く文字や画像の向き：画面で見て正しい向きになるよう、ページの回転と逆に回す */
  const uprightRotation = () => (360 - frame.rotation) % 360;

  // ---- 指・マウスの操作 ----

  svg.addEventListener('pointerdown', (event) => {
    if (!frame || event.button > 0) return;
    if (editing) {
      commitText();
      return;
    }
    const { width: W, height: H } = frame.base;
    const p = toLocal(event);
    event.preventDefault();

    if (tool === 'select') {
      const handle = event.target.closest('[data-handle]');
      const item = event.target.closest('.ann');
      if (handle && selectedId) {
        drag = { kind: handle.dataset.handle, id: selectedId, start: p };
      } else if (item) {
        const wasSelected = selectedId === item.dataset.id;
        if (!wasSelected) select(item.dataset.id);
        const a = list.find((x) => x.id === item.dataset.id);
        drag = { kind: 'move', id: a.id, start: p, original: structuredClone(a), moved: false, wasSelected };
      } else {
        select(null);
        return;
      }
      svg.setPointerCapture(event.pointerId);
      return;
    }
    if (tool === 'text') {
      startText(null, p.x / W, p.y / H);
      return;
    }
    // 図形：なぞった範囲で作る
    const a = { id: newId('ann'), type: tool };
    if (tool !== 'redact') a.color = tool === 'highlight' ? 'yellow' : color;
    if (tool === 'line' || tool === 'arrow') Object.assign(a, { x1: p.x / W, y1: p.y / H, x2: p.x / W, y2: p.y / H });
    else Object.assign(a, { x: p.x / W, y: p.y / H, w: 0, h: 0 });
    list.push(a);
    drag = { kind: 'create', id: a.id, start: p, startEvent: { x: event.clientX, y: event.clientY } };
    svg.setPointerCapture(event.pointerId);
  });

  svg.addEventListener('pointermove', (event) => {
    if (!drag || !frame) return;
    event.preventDefault();
    const { width: W, height: H } = frame.base;
    const p = toLocal(event);
    const a = list.find((item) => item.id === drag.id);
    if (!a) return;
    if (drag.kind === 'create') {
      if (a.type === 'line' || a.type === 'arrow') Object.assign(a, { x2: p.x / W, y2: p.y / H });
      else {
        const x0 = Math.min(drag.start.x, p.x);
        const y0 = Math.min(drag.start.y, p.y);
        Object.assign(a, { x: x0 / W, y: y0 / H, w: Math.abs(p.x - drag.start.x) / W, h: Math.abs(p.y - drag.start.y) / H });
      }
    } else if (drag.kind === 'move') {
      const dx = (p.x - drag.start.x) / W;
      const dy = (p.y - drag.start.y) / H;
      const o = drag.original;
      // 少しの指のぶれは、動かしたことにしない
      if (!drag.moved && Math.hypot(dx * W, dy * H) * frame.scale < 3) return;
      drag.moved = true;
      if (a.type === 'line' || a.type === 'arrow') Object.assign(a, { x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy });
      else Object.assign(a, { x: clamp(o.x + dx), y: clamp(o.y + dy) });
    } else if (drag.kind === 'p1' || drag.kind === 'p2') {
      const n = drag.kind === 'p1' ? 1 : 2;
      a[`x${n}`] = clamp(p.x / W);
      a[`y${n}`] = clamp(p.y / H);
    } else if (drag.kind === 'resize') {
      if (a.type === 'image') {
        // 画像は、画像の向きの座標で大きさを決め、縦横の比率は変えない
        const local = toLocal(event, svg.querySelector(`.ann[data-id="${CSS.escape(a.id)}"] .ann-content`));
        const ratio = a.h / a.w;
        const w = Math.max(0.02, local.x / W);
        Object.assign(a, { w, h: w * ratio });
      } else {
        Object.assign(a, { w: Math.max(0.005, p.x / W - a.x), h: Math.max(0.005, p.y / H - a.y) });
      }
    }
    draw();
  });

  const endDrag = (event) => {
    if (!drag) return;
    const current = drag;
    drag = null;
    if (current.kind === 'create') {
      const distance = Math.hypot(event.clientX - current.startEvent.x, event.clientY - current.startEvent.y);
      if (distance < MIN_DRAG) {
        // 押しただけのときは作らない
        list = list.filter((item) => item.id !== current.id);
        hint.textContent = 'なぞって、大きさを決めてください';
        draw();
        return;
      }
      // 作ったら「選ぶ」に戻し、すぐに動かしたり大きさを変えたりできるようにする
      setTool('select');
      select(current.id);
    } else if (current.kind === 'move' && !current.moved) {
      const a = list.find((item) => item.id === current.id);
      // 選んである文字をもう一度押したら、書き直す
      if (a?.type === 'text' && current.wasSelected) startText(a.id, a.x, a.y);
    }
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('dblclick', (event) => {
    const item = event.target.closest('.ann');
    const a = item && list.find((x) => x.id === item.dataset.id);
    if (a?.type === 'text') startText(a.id, a.x, a.y);
  });

  // ---- 文字の入力 ----

  /** 文字の入力欄を、置く場所（画面）に出す */
  function startText(id, x, y) {
    commitText();
    const a = id ? list.find((item) => item.id === id) : null;
    editing = { id, x, y };
    const { width: W, height: H } = frame.base;
    const point = svg.createSVGPoint();
    point.x = x * W;
    point.y = y * H;
    const screen = point.matrixTransform(svg.querySelector('#annot-root').getScreenCTM());
    const stageRect = stage.getBoundingClientRect();
    textBox.hidden = false;
    textBox.value = a?.text ?? '';
    Object.assign(textBox.style, {
      left: `${Math.min(screen.x - stageRect.left, stageRect.width - 180)}px`,
      top: `${Math.min(screen.y - stageRect.top, stageRect.height - 60)}px`,
      color: css(ANNOTATION_COLORS[a?.color ?? color]),
    });
    textBox.focus();
  }

  /** 入力した文字を、注釈にする（空なら消す） */
  function commitText() {
    if (!editing) return;
    const { id, x, y } = editing;
    editing = null;
    const value = textBox.value.replace(/\s+$/, '');
    textBox.hidden = true;
    if (id) {
      const a = list.find((item) => item.id === id);
      if (a && value) a.text = value;
      else list = list.filter((item) => item.id !== id);
    } else if (value) {
      const a = { id: newId('ann'), type: 'text', x, y, text: value, size: TEXT_SIZES[sizeSelect.value], color, rotation: uprightRotation() };
      list.push(a);
      selectedId = a.id;
      setTool('select');
    }
    draw();
  }

  textBox.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      editing = null;
      textBox.hidden = true;
      draw();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      commitText();
    }
  });
  textBox.addEventListener('blur', () => setTimeout(commitText, 0));

  // ---- 署名・印鑑の画像 ----

  async function placeImage() {
    commitText();
    const picked = await pickImage();
    if (!picked || !frame) return;
    await loadImageUrl(picked.sourceId);
    const { width: W, height: H } = frame.base;
    const rotation = uprightRotation();
    const sideways = rotation === 90 || rotation === 270;
    // 画面で見た幅が、ページの幅の約3割になる大きさで、ページの中央に置く
    const viewWidth = sideways ? H : W;
    let w = (viewWidth * 0.3) / W;
    let h = (w * picked.height) / picked.width;
    const maxH = ((sideways ? W : H) * 0.25) / W;
    if (h > maxH) {
      w *= maxH / h;
      h = maxH;
    }
    // 画像の左上（画像の向きで）を、画像の中心がページの中心に来る位置にする
    const cw = w * W;
    const ch = h * W;
    const center = { x: W / 2, y: H / 2 };
    const right = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] }[rotation];
    const down = { 0: [0, 1], 90: [-1, 0], 180: [0, -1], 270: [1, 0] }[rotation];
    const x = center.x - (right[0] * cw) / 2 - (down[0] * ch) / 2;
    const y = center.y - (right[1] * cw) / 2 - (down[1] * ch) / 2;
    const a = { id: newId('ann'), type: 'image', x: x / W, y: y / H, w, h, sourceId: picked.sourceId, rotation };
    list.push(a);
    setTool('select');
    select(a.id);
  }

  function removeSelected() {
    if (!selectedId) return;
    list = list.filter((item) => item.id !== selectedId);
    selectedId = null;
    draw();
  }

  function apply() {
    commitText();
    if (!page) return;
    const id = page.id;
    const result = list.filter((a) => (a.type === 'text' ? a.text.trim() : true));
    close();
    onApply(id, result);
  }

  root.addEventListener('click', (event) => {
    const toolButton = event.target.closest('[data-tool]');
    if (toolButton) return setTool(toolButton.dataset.tool);
    const colorButton = event.target.closest('[data-color]');
    if (colorButton) return setColor(colorButton.dataset.color);
    const action = event.target.closest('[data-annot]')?.dataset.annot;
    if (action === 'apply') apply();
    else if (action === 'cancel') close();
    else if (action === 'delete') removeSelected();
    else if (action === 'image') placeImage();
  });
  sizeSelect.addEventListener('change', () => {
    const a = list.find((item) => item.id === selectedId);
    if (a?.type === 'text') {
      a.size = TEXT_SIZES[sizeSelect.value];
      draw();
    }
  });
  root.addEventListener('keydown', (event) => {
    if (event.target === textBox) return;
    if (event.key === 'Escape') close();
    else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) {
      event.preventDefault();
      removeSelected();
    }
  });
  window.addEventListener('resize', layout);
  // 説明の文字が折り返して、描く場所の大きさが変わったときも、位置を合わせ直す
  new ResizeObserver(() => layout()).observe(stage);

  return { open, close, isOpen };
}

const clamp = (v) => Math.min(1.2, Math.max(-0.2, v));
