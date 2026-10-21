// パスワードの画面（UI層）
//
// - 開くときのパスワードを聞く画面：パスワード付きのPDFを読み込むとき
// - 書き出すPDFにかけるパスワードを決める画面
// パスワードは端末に保存しない（作業途中の自動保存にも入れない）。

/**
 * パスワードを聞く画面。
 * @returns {{ ask: (fileName: string, wrong: boolean) => Promise<string|null> }} キャンセルしたら null
 */
export function createPasswordPrompt() {
  const dialog = document.querySelector('#password-dialog');
  const form = document.querySelector('#password-form');
  const input = document.querySelector('#password-input');
  const name = document.querySelector('#password-file');
  const error = document.querySelector('#password-error');
  let resolve = null;

  function ask(fileName, wrong = false) {
    name.textContent = fileName;
    error.textContent = wrong ? 'パスワードが違います。もう一度入れてください' : '';
    input.value = '';
    dialog.showModal();
    input.focus();
    return new Promise((r) => (resolve = r));
  }

  function finish(value) {
    const done = resolve;
    resolve = null;
    if (dialog.open) dialog.close();
    done?.(value);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (input.value) finish(input.value);
  });
  form.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="password-cancel"]')) finish(null);
  });
  // Esc などで閉じたときはキャンセル。ただし、聞き直すためにすぐ開き直したときの「閉じた」は無視する
  dialog.addEventListener('close', () => {
    if (!dialog.open) finish(null);
  });
  return { ask };
}

/**
 * 書き出すPDFにかけるパスワードを決める画面。
 * @param {object} deps
 * @param {() => string} deps.getPassword 今のパスワード（なければ空）
 * @param {(password: string) => void} deps.onApply 「決定」（空なら外す）
 */
export function createProtectDialog({ getPassword, onApply }) {
  const dialog = document.querySelector('#protect-dialog');
  const form = document.querySelector('#protect-form');
  const first = document.querySelector('#protect-password');
  const again = document.querySelector('#protect-again');
  const show = document.querySelector('#protect-show');
  const error = document.querySelector('#protect-error');

  function open() {
    first.value = getPassword();
    again.value = getPassword();
    show.checked = false;
    first.type = again.type = 'password';
    error.textContent = '';
    dialog.showModal();
    first.focus();
  }

  show.addEventListener('change', () => {
    first.type = again.type = show.checked ? 'text' : 'password';
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (first.value !== again.value) {
      error.textContent = '2つのパスワードが違います';
      return;
    }
    if (first.value && first.value.length < 4) {
      error.textContent = 'パスワードは4文字以上にしてください';
      return;
    }
    dialog.close();
    onApply(first.value);
  });
  form.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'protect-cancel') dialog.close();
    else if (action === 'protect-clear') {
      dialog.close();
      onApply('');
    }
  });
  return { open };
}
