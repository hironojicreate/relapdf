import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installMethod } from '../../src/web/install.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

test('ホーム画面から開いているときは、案内を出さない', () => {
  assert.equal(installMethod({ standalone: true, canPrompt: true, userAgent: IPHONE, maxTouchPoints: 5 }), 'installed');
});

test('ブラウザのインストール画面を出せるなら、それを使う（Android・PCのChrome）', () => {
  assert.equal(installMethod({ standalone: false, canPrompt: true, userAgent: ANDROID, maxTouchPoints: 5 }), 'prompt');
});

test('iPhone・iPad は手順を案内する', () => {
  assert.equal(installMethod({ standalone: false, canPrompt: false, userAgent: IPHONE, maxTouchPoints: 5 }), 'ios');
  assert.equal(installMethod({ standalone: false, canPrompt: false, userAgent: IPAD, maxTouchPoints: 5 }), 'ios');
});

test('Mac や、インストールできないブラウザでは案内しない', () => {
  assert.equal(installMethod({ standalone: false, canPrompt: false, userAgent: IPAD, maxTouchPoints: 0 }), 'none');
  assert.equal(installMethod({ standalone: false, canPrompt: false, userAgent: ANDROID, maxTouchPoints: 5 }), 'none');
});
