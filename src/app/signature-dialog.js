// 署名・印鑑の画像を作る画面（UI層）
//
// 「画像を選ぶ」：紙に書いた署名や押した印鑑の写真から、白い紙の部分を透明にして切り抜く
// 「手で書く」：枠の中に指やマウスで書く
// インクの色をそろえることもできる（印鑑を朱色に、など）。できた画像は PNG（透明あり）にする。

import { opaqueBounds, removeWhiteBackground } from '../core/color.js';
import { fitLongSide } from '../core/layout.js';
import { decodeImage } from '../web/image.js';

const MAX_SIDE = 1200; // 作る画像の長辺の上限（ピクセル）
const INK = Object.freeze({ black: [30, 30, 30], blue: [25, 60, 170], red: [205, 25, 35] });
const PEN_WIDTH = 7;

/**
 * @param {object} deps
 * @param {() => Array<{sourceId: string, url: string, width: number, height: number}>} deps.getRecent 前に使った画像
 * @param {(blob: Blob, width: number, height: number) => Promise<string>} deps.createAsset 画像を保存して sourceId を返す
 */
export function createSignatureDialog({ getRecent, createAsset }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $('#signature-dialog');
  const form = $('#signature-form');
  const fileInput = $('#signature-file');
  const pad = $('#signature-pad');
  const preview = $('#signature-preview');
  const empty = $('#signature-empty');
  const colorSelect = $('#signature-color');
  const submit = $('#signature-submit');
  const errorBox = $('#signature-error');
  const recent = $('#signature-recent');
  const recentList = $('#signature-recent-list');

  let tab = 'pick';
  let picked = null; // 選んだ画像の画素（色を変えるたびに、ここから作り直す）
  let result = null; // 今の見本 { canvas }
  let resolve = null;
  let drawing = null;
  let padDirty = false;

  function open() {
    reset();
    const items = getRecent();
    recent.hidden = items.length === 0;
    recentList.innerHTML = '';
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = 'この画像を置く';
      button.innerHTML = '<img alt="">';
      button.querySelector('img').src = item.url;
      button.addEventListener('click', () => finish({ sourceId: item.sourceId, width: item.width, height: item.height }));
      recentList.append(button);
    }
    dialog.showModal();
    return new Promise((r) => (resolve = r));
  }

  function reset() {
    picked = null;
    result = null;
    padDirty = false;
    errorBox.textContent = '';
    colorSelect.value = 'keep';
    pad.getContext('2d').clearRect(0, 0, pad.width, pad.height);
    preview.width = 1;
    preview.height = 1;
    empty.hidden = false;
    submit.disabled = true;
    setTab('pick');
  }

  function finish(value) {
    const done = resolve;
    resolve = null;
    if (dialog.open) dialog.close();
    done?.(value);
  }

  function setTab(next) {
    tab = next;
    for (const button of form.querySelectorAll('[data-sig-tab]')) button.setAttribute('aria-pressed', String(button.dataset.sigTab === tab));
    for (const panel of form.querySelectorAll('[data-sig-panel]')) panel.hidden = panel.dataset.sigPanel !== tab;
    refresh();
  }

  /** 選んだ画像または手書きから、見本（透明あり・余白を切り落としたもの）を作る */
  function refresh() {
    const ink = INK[colorSelect.value] ?? null;
    let image = null;
    if (tab === 'pick' && picked) {
      image = new ImageData(new Uint8ClampedArray(picked.data), picked.width, picked.height);
      removeWhiteBackground(image, { color: ink });
    } else if (tab === 'draw' && padDirty) {
      image = pad.getContext('2d').getImageData(0, 0, pad.width, pad.height);
      if (ink) {
        for (let i = 0; i < image.data.length; i += 4) image.data.set(ink, i);
      }
    }
    const bounds = image && opaqueBounds(image);
    if (!bounds) {
      result = null;
      preview.width = 1;
      preview.height = 1;
      empty.hidden = false;
      submit.disabled = true;
      return;
    }
    // 余白を切り落とす（少しだけ余白を残す）
    const margin = 4;
    const x = Math.max(0, bounds.x - margin);
    const y = Math.max(0, bounds.y - margin);
    const w = Math.min(image.width - x, bounds.width + margin * 2);
    const h = Math.min(image.height - y, bounds.height + margin * 2);
    const full = document.createElement('canvas');
    full.width = image.width;
    full.height = image.height;
    full.getContext('2d').putImageData(image, 0, 0);
    const size = fitLongSide(w, h, MAX_SIDE);
    preview.width = size.width;
    preview.height = size.height;
    const ctx = preview.getContext('2d');
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(full, x, y, w, h, 0, 0, size.width, size.height);
    full.width = 0;
    full.height = 0;
    result = { width: size.width, height: size.height };
    empty.hidden = true;
    submit.disabled = false;
  }

  async function choose(file) {
    errorBox.textContent = '';
    try {
      const decoded = await decodeImage(file, file.name);
      try {
        const size = fitLongSide(decoded.width, decoded.height, 1600);
        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(decoded.source, 0, 0, size.width, size.height);
        picked = ctx.getImageData(0, 0, size.width, size.height);
        canvas.width = 0;
        canvas.height = 0;
      } finally {
        decoded.close();
      }
      refresh();
      if (!result) errorBox.textContent = '署名や印鑑が見つかりませんでした。白い紙に書いたものを撮ってください';
    } catch (error) {
      errorBox.textContent = error.message;
    }
  }

  // ---- 手で書く ----

  const padPoint = (event) => {
    const rect = pad.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * pad.width, y: ((event.clientY - rect.top) / rect.height) * pad.height };
  };
  pad.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    pad.setPointerCapture(event.pointerId);
    drawing = { pointerId: event.pointerId, last: padPoint(event) };
    const ctx = pad.getContext('2d');
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(drawing.last.x, drawing.last.y, PEN_WIDTH / 2, 0, Math.PI * 2);
    ctx.fill();
    padDirty = true;
  });
  pad.addEventListener('pointermove', (event) => {
    if (!drawing || event.pointerId !== drawing.pointerId) return;
    event.preventDefault();
    const p = padPoint(event);
    const ctx = pad.getContext('2d');
    ctx.strokeStyle = '#111';
    ctx.lineWidth = PEN_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(drawing.last.x, drawing.last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    drawing.last = p;
  });
  const endStroke = () => {
    if (!drawing) return;
    drawing = null;
    refresh();
  };
  pad.addEventListener('pointerup', endStroke);
  pad.addEventListener('pointercancel', endStroke);

  // ---- ボタン ----

  form.addEventListener('click', (event) => {
    const tabButton = event.target.closest('[data-sig-tab]');
    if (tabButton) return setTab(tabButton.dataset.sigTab);
    const action = event.target.closest('[data-sig]')?.dataset.sig;
    if (action === 'choose') fileInput.click();
    else if (action === 'clear') {
      pad.getContext('2d').clearRect(0, 0, pad.width, pad.height);
      padDirty = false;
      refresh();
    } else if (action === 'cancel') finish(null);
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (file) choose(file);
  });
  colorSelect.addEventListener('change', refresh);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!result) return;
    submit.disabled = true;
    try {
      const blob = await new Promise((r, reject) => preview.toBlob((b) => (b ? r(b) : reject(new Error('画像を作れませんでした'))), 'image/png'));
      const sourceId = await createAsset(blob, result.width, result.height);
      finish({ sourceId, width: result.width, height: result.height });
    } catch (error) {
      errorBox.textContent = error.message;
      submit.disabled = false;
    }
  });
  dialog.addEventListener('close', () => {
    if (resolve) finish(null);
  });

  return { open, isOpen: () => dialog.open };
}
