// かんたんモードの段階と、スマホの「戻る」操作をつなぐ（UI層）
//
// ブラウザの履歴を、いつも「番兵 → ① → … → 今の段階」の並びに保つ。
// - 先の段階へ進むときは、間の段階も含めて履歴に積む（①→③なら ② と ③ を積む）
// - 前の段階へ戻るときは、履歴もその分だけ戻す（③→①なら2つ戻す）
// こうすると、Android の戻るボタンや iPhone の画面左端からのスワイプで、
// いつも「③保存 → ②確認 → ①撮る・選ぶ」の順に戻る。
// カメラや補正画面などが開いているときの「戻る」は、まずその画面を閉じる。
// 履歴のいちばん最初の「番兵」は、①でカメラを開いているときの「戻る」で
// アプリごと閉じてしまわないためのもの（①で何も開いていなければ、もう一度「戻る」で閉じる）。

export const STEPS = Object.freeze(['capture', 'confirm', 'save']);

const entry = (step) => ({ relapdf: true, step });
const GUARD = { relapdf: true, step: null, guard: true };
const indexOf = (state) => (state?.relapdf && !state.guard ? STEPS.indexOf(state.step) : -1);

/**
 * @param {object} options
 * @param {(step: string) => void} options.onNavigate 「戻る」「進む」で段階が変わったとき
 * @param {() => boolean} options.closeOverlay 開いている画面があれば閉じて true を返す
 */
export function createStepHistory({ onNavigate, closeOverlay }) {
  let position = -1; // 今いる履歴の位置（-1 は番兵、0〜2 は STEPS の位置）
  let ownPops = 0; // 自分で history.go() したぶんの popstate は無視する

  window.addEventListener('popstate', (event) => {
    const index = indexOf(event.state);
    if (ownPops > 0) {
      ownPops -= 1;
      position = index;
      return;
    }
    if (closeOverlay()) {
      // 画面を閉じただけなので、段階はそのまま（消えた履歴を積み直す）
      if (position >= 0) history.pushState(entry(STEPS[position]), '');
      return;
    }
    position = index;
    if (index >= 0) onNavigate(STEPS[index]);
  });

  return {
    /** 起動したとき：今の段階までの履歴を作っておく（再開したときも「戻る」で前の段階へ戻れるように） */
    seed(step) {
      history.replaceState(GUARD, '');
      position = -1;
      this.sync(step);
    },
    /** 画面の段階に合わせて、履歴の並びを整える */
    sync(step) {
      const target = STEPS.indexOf(step);
      if (target === position || target < 0) return;
      if (target > position) {
        for (let i = position + 1; i <= target; i++) history.pushState(entry(STEPS[i]), '');
      } else {
        ownPops += 1;
        history.go(target - position);
      }
      position = target;
    },
  };
}
