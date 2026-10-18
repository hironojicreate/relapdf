import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentMode, detectMode, saveMode } from '../../src/web/mode.js';

test('タッチ中心の端末はかんたんモード、PCは詳細モード', () => {
  assert.equal(detectMode({ width: 390, coarsePointer: true }), 'easy'); // iPhone
  assert.equal(detectMode({ width: 1024, coarsePointer: true }), 'easy'); // タブレット
  assert.equal(detectMode({ width: 1440, coarsePointer: false }), 'detail'); // PC
  assert.equal(detectMode({ width: 500, coarsePointer: false }), 'easy'); // 幅の狭いウィンドウ
});

function fakeWindow({ width = 1440, coarse = false, saved = null, broken = false } = {}) {
  const data = new Map(saved ? [['relapdf:mode', saved]] : []);
  const localStorage = {
    getItem: (k) => {
      if (broken) throw new Error('blocked');
      return data.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (broken) throw new Error('blocked');
      data.set(k, v);
    },
  };
  return { innerWidth: width, matchMedia: () => ({ matches: coarse }), localStorage, data };
}

test('手動で選んだモードを優先し、記憶する', () => {
  const win = fakeWindow({ width: 1440 });
  assert.equal(currentMode(win), 'detail');
  saveMode('easy', win);
  assert.equal(win.data.get('relapdf:mode'), 'easy');
  assert.equal(currentMode(win), 'easy');
  assert.equal(currentMode(fakeWindow({ saved: 'unknown' })), 'detail', '不正な値は無視する');
  assert.throws(() => saveMode('pro', win), /モード/);
});

test('保存できない環境でも動く', () => {
  const win = fakeWindow({ coarse: true, broken: true });
  assert.equal(currentMode(win), 'easy');
  assert.doesNotThrow(() => saveMode('detail', win));
});
