// 自動アップデート（ブラウザ側）
//
// Service Worker を登録し、新しいバージョンが公開されていないかを確かめる。
// - 確かめるとき：起動したとき、アプリに戻ってきたとき（前回から10分以上たっていれば）、開いている間は1時間ごと
// - 新しいバージョンが見つかると、裏で全ファイルを取り込み（sw.js の install）、終わったら onReady を呼ぶ
// - apply() で新しいバージョンに切り替え、ページを読み込み直す
//
// 作業中の状態は自動保存されているので、読み込み直しても続きから再開できる。

const CHECK_INTERVAL = 60 * 60 * 1000;
const MIN_CHECK_GAP = 10 * 60 * 1000;

/**
 * @param {object} options
 * @param {() => void} options.onReady 新しいバージョンの準備ができたとき
 * @param {() => Promise<void>} [options.beforeReload] 読み込み直す直前（作業の保存など）
 * @returns {{ check: () => Promise<void>, apply: () => Promise<void>, get ready(): boolean }}
 */
export function setupUpdater({ onReady, beforeReload }) {
  const sw = navigator.serviceWorker;
  const noop = { check: async () => {}, apply: async () => {}, ready: false };
  if (!sw || location.protocol === 'file:') return noop;

  // 最初の訪問では「切り替え」が起きても読み込み直さない（古いバージョンがないため）
  const hadController = Boolean(sw.controller);
  let registration = null;
  let waiting = null;
  let lastCheck = 0;
  let reloading = false;

  function setWaiting(worker) {
    if (!worker || !hadController) return;
    waiting = worker;
    onReady();
  }

  function watch(worker) {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') setWaiting(worker);
    });
  }

  sw.register('./sw.js')
    .then((reg) => {
      registration = reg;
      if (reg.waiting) setWaiting(reg.waiting);
      watch(reg.installing);
      reg.addEventListener('updatefound', () => watch(reg.installing));
      lastCheck = Date.now(); // register 自体が更新の確認を兼ねる
    })
    .catch((error) => console.warn('Service Worker を登録できませんでした', error));

  // 新しい Service Worker に切り替わったら、新しいファイルで開き直す
  sw.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  async function check() {
    if (!registration || waiting) return;
    lastCheck = Date.now();
    try {
      await registration.update();
    } catch {
      // オフラインなどで確かめられなかったときは、次の機会にもう一度
    }
  }

  async function apply() {
    if (!waiting || reloading) return;
    try {
      await beforeReload?.();
    } finally {
      waiting.postMessage('skip-waiting');
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastCheck > MIN_CHECK_GAP) check();
  });
  setInterval(check, CHECK_INTERVAL);

  return {
    check,
    apply,
    get ready() {
      return waiting !== null;
    },
  };
}
