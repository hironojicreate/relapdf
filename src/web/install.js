// ホーム画面への追加（アプリとして使う）の案内（ブラウザ側）
//
// - Android の Chrome・PC の Chrome/Edge：ブラウザの「インストール」画面を、アプリのボタンから出せる
// - iPhone/iPad：アプリからは出せないので、共有ボタン →「ホーム画面に追加」の手順を案内する

/**
 * 端末の種類から、どの案内を出すかを決める（画面には触らない純粋な関数）。
 * @returns {'installed'|'prompt'|'ios'|'none'}
 */
export function installMethod({ standalone, canPrompt, userAgent, maxTouchPoints }) {
  if (standalone) return 'installed';
  if (canPrompt) return 'prompt';
  // iPadOS は Mac と同じ名前を名乗るので、タッチ操作できるかで見分ける
  const ios = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  return ios ? 'ios' : 'none';
}

/** ホーム画面から開いているか（アプリとして使っているか） */
export function isStandalone(win = globalThis) {
  return win.matchMedia?.('(display-mode: standalone)').matches || win.navigator?.standalone === true;
}

/**
 * インストールの案内を準備する。
 * @param {(method: string) => void} onChange 案内の種類が変わったとき
 */
export function setupInstall(onChange) {
  let deferred = null;

  const current = () =>
    installMethod({
      standalone: isStandalone(),
      canPrompt: deferred !== null,
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
    });

  window.addEventListener('beforeinstallprompt', (event) => {
    // ブラウザが自動で出す案内は止めて、アプリのボタンから出す
    event.preventDefault();
    deferred = event;
    onChange(current());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    onChange('installed');
  });

  return {
    get method() {
      return current();
    },
    /** ブラウザのインストール画面を出す。結果は 'accepted' | 'dismissed' */
    async prompt() {
      if (!deferred) return 'dismissed';
      const event = deferred;
      deferred = null;
      await event.prompt();
      const { outcome } = await event.userChoice;
      onChange(current());
      return outcome;
    },
  };
}
