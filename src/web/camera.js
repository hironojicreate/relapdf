// アプリ内カメラ（ブラウザ側）
//
// getUserMedia でカメラの映像を表示し、シャッターを押したときの1コマを写真にする。
// 画面の向きを固定していなければ、映像は端末の向きに合わせて回るので、撮った写真もその向きになる。

import { MAX_SOURCE_LONG_SIDE, fitLongSide } from '../core/layout.js';
import { applyBrightness } from '../core/color.js';
import { encodeImage } from './image.js';

/** カメラを使えないときのエラー。reason は画面に出す説明 */
export class CameraError extends Error {
  constructor(reason, cause) {
    super(reason);
    this.name = 'CameraError';
    this.cause = cause;
  }
}

/** この環境でアプリ内カメラを試せるか（https でないと使えない） */
export function cameraSupported() {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/**
 * 背面カメラを開いて、video に映す。
 * @returns {Promise<MediaStream>}
 */
export async function startCamera(video) {
  if (!cameraSupported()) {
    throw new CameraError('このブラウザでは、アプリ内のカメラを使えません');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        // できるだけ高い解像度で（書類の文字を読めるように）
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
    });
  } catch (error) {
    throw new CameraError(describeCameraError(error), error);
  }
  video.srcObject = stream;
  video.muted = true;
  video.setAttribute('playsinline', '');
  try {
    await video.play();
  } catch (error) {
    stopCamera(stream, video);
    throw new CameraError('カメラの映像を表示できませんでした', error);
  }
  return stream;
}

/** カメラを止める（電池とプライバシーのため、使わないときは必ず止める） */
export function stopCamera(stream, video) {
  for (const track of stream?.getTracks() ?? []) track.stop();
  if (video) video.srcObject = null;
}

/**
 * 今映っている1コマを写真（JPEG）にする。長辺は元データの上限までに縮小する。
 * @param {HTMLVideoElement} video
 * @param {{ brightness?: number }} [options] brightness は明るさの倍率（1 でそのまま）
 * @returns {Promise<{blob: Blob, width: number, height: number}>}
 */
export async function captureFrame(video, { brightness = 1 } = {}) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error('カメラの準備ができていません');
  const size = fitLongSide(width, height, MAX_SOURCE_LONG_SIDE);
  if (brightness === 1) {
    const blob = await encodeImage(video, size.width, size.height, { quality: 0.92 });
    return { blob, width: size.width, height: size.height };
  }
  // 明るさを変えるときは、1コマを描いてから色を調整する
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, size.width, size.height);
  const image = ctx.getImageData(0, 0, size.width, size.height);
  applyBrightness(image, brightness);
  ctx.putImageData(image, 0, 0);
  try {
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('写真を作れませんでした'))), 'image/jpeg', 0.92);
    });
    return { blob, width: size.width, height: size.height };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function describeCameraError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'カメラの使用が許可されていません。ブラウザの設定で許可するか、端末のカメラで撮ってください';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'カメラが見つかりませんでした';
    case 'NotReadableError':
    case 'AbortError':
      return 'カメラを開けませんでした。ほかのアプリがカメラを使っていないか確認してください';
    default:
      return 'カメラを開けませんでした';
  }
}
