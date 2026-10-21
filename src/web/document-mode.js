// 「書類モード」を撮影・取り込みのときに使うかどうかの設定（ブラウザ側）
//
// 最初は使う（オン）。カメラ画面のボタンで切り替えると、端末に覚えておく。

const KEY = 'relapdf:document-mode';

/** 書類モードを使う設定か */
export function loadDocumentMode() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function saveDocumentMode(on) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // 保存できなくても、今回の撮影では切り替わる
  }
}
