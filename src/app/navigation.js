// かんたんモードの段階と、スマホの「戻る」操作をつなぐ（UI層）
//
// 段階を移るたびにブラウザの履歴に1つ積むので、Android の戻るボタンや
// iPhone の画面左端からのスワイプで「③保存 → ②確認 → ①撮る・選ぶ」と戻れる。
// カメラや補正画面などが開いているときの「戻る」は、まずその画面を閉じる。
// 履歴のいちばん最初には「番兵」を1つ置き、①でカメラを開いているときの「戻る」で
// アプリごと閉じてしまわないようにする（①で何も開いていなければ、もう一度「戻る」で閉じる）。

export const STEPS = Object.freeze(['capture', 'confirm', 'save']);

const entry = (step) => ({ relapdf: true, step });
const GUARD = { relapdf: true, step: null, guard: true };

/**
 * @param {object} options
 * @param {() => string} options.getStep 今の段階
 * @param {(step: string) => void} options.onNavigate 「戻る」「進む」で段階が変わったとき
 * @param {() => boolean} options.closeOverlay 開いている画面があれば閉じて true を返す
 */
export function createStepHistory({ getStep, onNavigate, closeOverlay }) {
  window.addEventListener('popstate', (event) => {
    if (closeOverlay()) {
      // 画面を閉じただけなので、段階はそのまま（消えた履歴を積み直す）
      history.pushState(entry(getStep()), '');
      return;
    }
    const step = event.state?.relapdf ? event.state.step : null;
    if (STEPS.includes(step)) onNavigate(step);
  });

  return {
    /** 起動したとき：今の段階までの履歴を作っておく（再開したときも「戻る」で前の段階へ戻れるように） */
    seed(step) {
      history.replaceState(GUARD, '');
      for (const s of STEPS.slice(0, STEPS.indexOf(step) + 1)) history.pushState(entry(s), '');
    },
    /** 段階を移ったとき */
    push(step) {
      if (history.state?.relapdf && history.state.step === step) return;
      history.pushState(entry(step), '');
    },
  };
}
