// かんたんモード／詳細モードの判定と記憶（ブラウザ側）

export const MODES = Object.freeze(['easy', 'detail']);
const STORAGE_KEY = 'relapdf:mode';

/**
 * 端末の特徴からモードを決める（画面には触らない純粋な関数）。
 * - タッチ操作が中心の端末（スマホ・タブレット）→ かんたんモード
 * - マウス操作でも、画面の幅が狭いとき → かんたんモード
 * - それ以外（PC）→ 詳細モード
 */
export function detectMode({ width, coarsePointer }) {
  if (coarsePointer) return 'easy';
  return width < 600 ? 'easy' : 'detail';
}

/** 今の端末に合うモードを返す。手動で選んだことがあれば、そちらを優先する */
export function currentMode(win = globalThis) {
  const saved = readSaved(win);
  if (saved) return saved;
  return detectMode({
    width: win.innerWidth,
    coarsePointer: win.matchMedia?.('(pointer: coarse)').matches ?? false,
  });
}

/** 手動で選んだモードを記憶する */
export function saveMode(mode, win = globalThis) {
  if (!MODES.includes(mode)) throw new Error(`モードの指定が不正です: ${mode}`);
  try {
    win.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // プライベートブラウズなどで保存できなくても、そのまま使えるようにする
  }
}

function readSaved(win) {
  try {
    const value = win.localStorage?.getItem(STORAGE_KEY);
    return MODES.includes(value) ? value : null;
  } catch {
    return null;
  }
}
