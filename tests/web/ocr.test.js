import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tidyText } from '../../src/web/ocr.js';

test('読み取った文字の余計な空白を取る（日本語の間・数字の区切り）。英単語の間は残す', () => {
  assert.equal(tidyText('請 求 書'), '請求書');
  assert.equal(tidyText('合計 12, 000 円'), '合計12,000円');
  assert.equal(tidyText('期限  10 月 31 日'), '期限10月31日');
  assert.equal(tidyText('Page 1 of 3'), 'Page 1 of 3');
  assert.equal(tidyText('  RelaPDF は 便利 '), 'RelaPDF は便利');
});
