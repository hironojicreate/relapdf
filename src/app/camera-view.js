// アプリ内カメラの画面（UI層）
//
// シャッターを押すたびに1枚ずつ写真にして、呼び出し元に渡す（連続撮影）。
// 「完了」を押すと、渡した写真の処理が終わるのを待ってから閉じる。

import { CameraError, captureFrame, startCamera, stopCamera } from '../web/camera.js';

/**
 * @param {object} options
 * @param {(frame: {blob: Blob, width: number, height: number}, number: number) => Promise<void>} options.onCapture
 * @param {() => void} options.onDone 「完了」で閉じたとき
 * @param {() => void} options.onUseOsCamera 「端末のカメラで撮る」を押したとき
 * @param {(text: string) => void} options.onBusy 処理待ちの表示
 */
export function createCameraView({ onCapture, onDone, onUseOsCamera, onBusy }) {
  const $ = (selector) => document.querySelector(selector);
  const root = $('#camera');
  const video = $('#camera-video');
  const count = $('#camera-count');
  const last = $('#camera-last');
  const shutter = $('#camera-shutter');
  const errorBox = $('#camera-error');
  const errorText = $('#camera-error-text');
  const doneButton = root.querySelector('[data-camera="done"]');

  let stream = null;
  let shots = 0;
  let pending = Promise.resolve();
  let lastUrl = null;
  let capturing = false;

  function isOpen() {
    return !root.hidden;
  }

  function setCount() {
    count.textContent = `${shots}枚`;
    last.hidden = shots === 0;
    // まだ1枚も撮っていないときは、撮らずに戻れることがわかるようにする
    doneButton.textContent = shots === 0 ? '閉じる' : '完了';
  }

  async function start() {
    errorBox.hidden = true;
    shutter.disabled = true;
    try {
      stream = await startCamera(video);
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
    shots = 0;
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
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = null;
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
      const frame = await captureFrame(video);
      shots += 1;
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = URL.createObjectURL(frame.blob);
      last.src = lastUrl;
      setCount();
      const number = shots;
      pending = pending.then(() => onCapture(frame, number)).catch((error) => console.error(error));
    } catch (error) {
      console.error(error);
    } finally {
      capturing = false;
    }
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
    else if (action === 'os-camera') {
      close();
      onUseOsCamera();
    }
  });

  return { open, close, isOpen };
}
