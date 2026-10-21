// Service Worker がキャッシュするファイルの一覧（precache-manifest.js）を作る
//   node scripts/precache.js          一覧を作り直す
//   node scripts/precache.js --check  一覧が最新か確かめる（古ければ失敗する）
//
// ファイルの中身からバージョンを計算するので、どれか1つでも変わるとバージョンが変わり、
// 利用者のブラウザが新しいファイルを取り直す。

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT = 'precache-manifest.js';

// キャッシュする場所（フォルダは中身をすべて含める）
const ENTRIES = ['index.html', 'manifest.webmanifest', 'icons', 'src', 'vendor'];
// キャッシュしないもの（ライセンス文や説明書きはアプリの動作に不要）
// 文字認識（OCR）の部品（約8MB）は、更新のたびに全員が取り直さなくてすむよう、ここには入れない。
// 初めて使ったときに Service Worker が別のキャッシュ（relapdf-ocr-…）に入れる（sw.js）
const EXCLUDE = [/(^|\/)(LICENSE[^/]*|README\.md)$/, /\.map$/, /(^|\/)\./, /^vendor\/tesseract\//];

async function walk(relative) {
  const full = path.join(ROOT, relative);
  const entries = await readdir(full, { withFileTypes: true }).catch(() => null);
  if (!entries) return [relative];
  const nested = await Promise.all(
    entries.map((e) => walk(path.posix.join(relative, e.name))),
  );
  return nested.flat();
}

export async function buildManifest() {
  const files = (await Promise.all(ENTRIES.map(walk)))
    .flat()
    .filter((f) => !EXCLUDE.some((re) => re.test(f)))
    .sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update(await readFile(path.join(ROOT, file)));
  }
  // sw.js 自体の変更でもバージョンを変える
  hash.update(await readFile(path.join(ROOT, 'sw.js')));
  const version = hash.digest('hex').slice(0, 12);
  const list = ['./', ...files.map((f) => `./${f}`)];
  return (
    '// このファイルは scripts/precache.js が自動で作ります。手で編集しないでください。\n' +
    `self.RELAPDF_PRECACHE = ${JSON.stringify({ version, files: list }, null, 2)};\n`
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const content = await buildManifest();
  const target = path.join(ROOT, OUTPUT);
  if (process.argv.includes('--check')) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current !== content) {
      console.error(`${OUTPUT} が古くなっています。node scripts/precache.js を実行してください`);
      process.exit(1);
    }
    console.log(`${OUTPUT} は最新です`);
  } else {
    await writeFile(target, content);
    console.log(`${OUTPUT} を作成しました`);
  }
}
