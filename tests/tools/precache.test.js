import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildManifest } from '../../scripts/precache.js';

test('Service Worker のキャッシュ一覧が最新になっている', async () => {
  const current = await readFile(new URL('../../precache-manifest.js', import.meta.url), 'utf8');
  assert.equal(current, await buildManifest(), 'node scripts/precache.js を実行して一覧を作り直してください');
});
