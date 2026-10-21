// 書き込み（ページ番号など）に使う日本語フォント（ブラウザ側）
//
// フォント（約3.4MB）と fontkit（約0.8MB）は、書き込みをするときに初めて読み込む。
// どちらもオフライン用のキャッシュに入っているので、通信がなくても使える。

let fontPromise = null;

/** @returns {Promise<{bytes: Uint8Array, fontkit: object}>} */
export function loadMarkFont() {
  fontPromise ??= Promise.all([
    fetch(new URL('../../vendor/fonts/BIZUDGothic-Regular.ttf', import.meta.url)).then((response) => {
      if (!response.ok) throw new Error('日本語フォントを読み込めませんでした');
      return response.arrayBuffer();
    }),
    import('../../vendor/fontkit/fontkit.mjs'),
  ])
    .then(([buffer, module]) => ({ bytes: new Uint8Array(buffer), fontkit: module.default }))
    .catch((error) => {
      fontPromise = null; // 次にもう一度試せるように
      throw error;
    });
  return fontPromise;
}
