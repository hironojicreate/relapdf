// 画面テスト用の小さなWebサーバー（外部パッケージを使わない）
//   node tests/e2e/server.js [port]
// テストの中から startServer() で別のポートに立てることもできる（自動アップデートのテスト用）
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.icc': 'application/vnd.iccprofile',
};

/**
 * サーバーを立てる。
 * @param {number} port 0 なら空いているポート
 * @param {{ transform?: (relativePath: string, body: Buffer) => Buffer|string }} [options] 返す中身を差し替える
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startServer(port, { transform } = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let file = path.join(ROOT, decodeURIComponent(url.pathname));
      if (!file.startsWith(ROOT)) throw new Error('forbidden');
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      let body = await readFile(file);
      if (transform) body = transform(path.relative(ROOT, file), body);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, () => {
      resolve({
        url: `http://localhost:${server.address().port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const { url } = await startServer(Number(process.argv[2] ?? process.env.PORT ?? 4173));
  console.log(url);
}
