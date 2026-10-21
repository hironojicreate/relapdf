// アプリ内カメラの画面（UI層）
//
// シャッターを押すたびに1枚ずつ写真にして、呼び出し元に渡す（連続撮影）。
// 「完了」を押すと、渡した写真の処理が終わるのを待ってから閉じる。
// 「書類モード」がオンのときは、撮った写真に書類モード（背景を白く・文字をくっきり）を付けて渡す。

import { CameraError, applyCameraZoom, captureFrame, startCamera, stopCamera, zoomCapability } from '../web/camera.js';
import { brightnessFactor } from '../core/color.js';
import { clampZoom, pinchDistance, visibleVideoRegion } from '../web/zoom.js';
import { loadDocumentMode, saveDocumentMode } from '../web/document-mode.js';

const DIGITAL_ZOOM_MAX = 4; // カメラ自体がズームできないときの、拡大の上限（これ以上は粗くなる）
const HARDWARE_ZOOM_MAX = 10;

const BRIGHTNESS_KEY = 'relapdf:camera-brightness';

/**
 * @param {object} options
 * @param {(frame: {blob: Blob, width: number, height: number, corners: object[]|null, filter: string}, number: number) => Promise<string>} options.onCapture
 *   撮った写真を渡す（corners は見つけた書類の四隅、filter は色補正）。追加したページのIDを返す
 * @param {(pageId: string) => Promise<void>} options.onUndo 「最後の1枚を取り消す」を押したとき
 * @param {() => void} options.onDone 「完了」で閉じたとき
 * @param {() => void} options.onUseOsCamera 「端末のカメラで撮る」を押したとき
 * @param {(text: string) => void} options.onBusy 処理待ちの表示
 */
export function createCameraView({ onCapture, onUndo, onDone, onUseOsCamera, onBusy }) {
  const $ = (selector) => document.querySelector(selector);
  const root = $('#camera');
  const video = $('#camera-video');
  const count = $('#camera-count');
  const last = $('#camera-last');
  const shutter = $('#camera-shutter');
  const errorBox = $('#camera-error');
  const errorText = $('#camera-error-text');
  const doneButton = root.querySelector('[data-camera="done"]');
  const brightnessInput = $('#camera-brightness');
  const brightnessLabel = $('#camera-brightness-value');
  const zoomInput = $('#camera-zoom');
  const zoomLabel = $('#camera-zoom-value');
  const documentButton = $('#camera-document');

  let stream = null;
  let shots = []; // この撮影で撮った写真 { url, pageId: Promise<string> }
  let pending = Promise.resolve();
  let capturing = false;
  let messageTimer = 0;
  let brightness = 1; // 明るさの倍率（撮った写真にも同じ倍率をかける）
  let zoom = 1;
  let hardwareZoom = null; // カメラ自体がズームできるときの範囲 { min, max }

  // ---- ズーム ----
  // カメラ自体がズームできる機種はそれを使う（画質が落ちない）。
  // できない機種では映像を拡大して表示し、撮るときに画面に見えている範囲を切り取る（デジタルズーム）。

  function zoomRange() {
    return hardwareZoom
      ? { min: hardwareZoom.min, max: Math.min(hardwareZoom.max, HARDWARE_ZOOM_MAX) }
      : { min: 1, max: DIGITAL_ZOOM_MAX };
  }

  function setZoom(value) {
    const { min, max } = zoomRange();
    zoom = clampZoom(value, min, max);
    zoomInput.value = String(zoom);
    zoomLabel.textContent = `${zoom.toFixed(1)}×`;
    if (hardwareZoom) {
      video.style.transform = '';
      applyCameraZoom(stream, zoom).catch((error) => {
        // カメラのズームに失敗したら、デジタルズームに切り替える
        console.warn(error);
        hardwareZoom = null;
        setupZoom();
        setZoom(zoom);
      });
    } else {
      video.style.transform = zoom === 1 ? '' : `scale(${zoom})`;
    }
  }

  function setupZoom() {
    const { min, max } = zoomRange();
    zoomInput.min = String(min);
    zoomInput.max = String(max);
  }

  /** 撮るときに切り取る範囲（デジタルズームのときだけ） */
  function captureRegion() {
    if (hardwareZoom || zoom === 1) return undefined;
    return visibleVideoRegion({
      containerWidth: video.clientWidth,
      containerHeight: video.clientHeight,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      zoom,
    });
  }

  zoomInput.addEventListener('input', () => setZoom(Number(zoomInput.value)));

  // ピンチで拡大・縮小する（2本の指の間の距離の変化に合わせる）
  const touches = new Map();
  let pinch = null;
  root.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch' || event.target.closest('.camera-bottom, .camera-adjusts, .camera-error')) return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinch = { distance: pinchDistance(a, b), zoom };
    }
  });
  root.addEventListener('pointermove', (event) => {
    if (!touches.has(event.pointerId)) return;
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && touches.size === 2) {
      const [a, b] = [...touches.values()];
      setZoom(pinch.zoom * (pinchDistance(a, b) / pinch.distance));
    }
  });
  const endTouch = (event) => {
    touches.delete(event.pointerId);
    if (touches.size < 2) pinch = null;
  };
  root.addEventListener('pointerup', endTouch);
  root.addEventListener('pointercancel', endTouch);

  // 明るさ：前回の設定を覚えておく
  function setBrightness(amount, remember = true) {
    brightnessInput.value = String(amount);
    brightness = brightnessFactor(amount);
    video.style.filter = brightness === 1 ? '' : `brightness(${brightness})`;
    brightnessLabel.textContent = `${Math.round(brightness * 100)}%`;
    if (!remember) return;
    try {
      localStorage.setItem(BRIGHTNESS_KEY, String(amount));
    } catch {
      // 保存できなくても調整はできる
    }
  }
  try {
    setBrightness(Number(localStorage.getItem(BRIGHTNESS_KEY)) || 0, false);
  } catch {
    setBrightness(0, false);
  }
  let documentMode = loadDocumentMode();
  function setDocumentMode(on, remember = true) {
    documentMode = on;
    documentButton.setAttribute('aria-pressed', String(on));
    if (remember) saveDocumentMode(on);
  }
  setDocumentMode(documentMode, false);

  brightnessInput.addEventListener('input', () => setBrightness(Number(brightnessInput.value)));

  function isOpen() {
    return !root.hidden;
  }

  function setCount() {
    clearTimeout(messageTimer);
    count.textContent = `${shots.length}枚`;
    const latest = shots[shots.length - 1];
    last.hidden = !latest;
    if (latest) last.src = latest.url;
    else last.removeAttribute('src');
    // まだ1枚も撮っていないときは、撮らずに戻れることがわかるようにする
    doneButton.textContent = shots.length === 0 ? '閉じる' : '完了';
  }

  /** 枚数の表示の場所に、少しの間だけお知らせを出す */
  function flashMessage(text) {
    count.textContent = text;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(setCount, 1500);
  }

  async function start() {
    errorBox.hidden = true;
    shutter.disabled = true;
    try {
      stream = await startCamera(video);
      hardwareZoom = zoomCapability(stream);
      setupZoom();
      setZoom(zoom); // ほかのアプリから戻ってきたときは、それまでのズームのまま
      // 起動中に閉じられていたら、すぐ止める
      if (!isOpen()) {
        stopCamera(stream, video);
        stream = null;
        return;
      }
      shutter.disabled = false;
    } catch (error) {
      console.error(error);
      errorText.textContent = error instanceof CameraError ? error.message : 'カメラを開けませんでした';
      errorBox.hidden = false;
    }
  }

  function stop() {
    stopCamera(stream, video);
    stream = null;
  }

  function open() {
    zoom = 1;
    shots = [];
    pending = Promise.resolve();
    setCount();
    root.hidden = false;
    document.body.classList.add('camera-open');
    start();
  }

  function close() {
    stop();
    root.hidden = true;
    document.body.classList.remove('camera-open');
    for (const shot of shots) URL.revokeObjectURL(shot.url);
    shots = [];
    last.removeAttribute('src');
  }

  async function shoot() {
    if (!stream || capturing) return;
    capturing = true;
    root.classList.remove('flash');
    void root.offsetWidth; // アニメーションをもう一度動かすため
    root.classList.add('flash');
    navigator.vibrate?.(15);
    try {
      const frame = await captureFrame(video, { brightness, region: captureRegion() });
      frame.filter = documentMode ? 'document' : 'none';
      const number = shots.length + 1;
      pending = pending.then(() => onCapture(frame, number)).catch((error) => {
        console.error(error);
        return null;
      });
      shots.push({ url: URL.createObjectURL(frame.blob), pageId: pending });
      setCount();
    } catch (error) {
      console.error(error);
    } finally {
      capturing = false;
    }
  }

  /** 最後に撮った1枚を取り消す */
  function undoLast() {
    const shot = shots.pop();
    if (!shot) return;
    URL.revokeObjectURL(shot.url);
    setCount();
    flashMessage('1枚取り消しました');
    pending = pending.then(() => shot.pageId).then((id) => (id ? onUndo(id) : null)).catch((e) => console.error(e));
  }

  async function done() {
    onBusy?.('写真を保存中…');
    try {
      await pending;
    } finally {
      onBusy?.(null);
    }
    close();
    onDone();
  }

  // ほかのアプリに切り替えたらカメラを止め、戻ってきたら再開する
  document.addEventListener('visibilitychange', () => {
    if (!isOpen()) return;
    if (document.hidden) stop();
    else if (!stream && errorBox.hidden) start();
  });

  root.addEventListener('click', (event) => {
    const action = event.target.closest('[data-camera]')?.dataset.camera;
    if (action === 'shoot') shoot();
    else if (action === 'done') done();
    else if (action === 'brightness-reset') setBrightness(0);
    else if (action === 'zoom-reset') setZoom(zoomRange().min);
    else if (action === 'undo') undoLast();
    else if (action === 'document') setDocumentMode(!documentMode);
    else if (action === 'os-camera') {
      close();
      onUseOsCamera();
    }
  });

  return { open, close, isOpen, finish: done };
}
