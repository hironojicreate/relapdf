// PDFのパスワード（暗号化）をかける・外す（ブラウザ側）
//
// pdf-lib は暗号化に対応していないので、qpdf（Apache 2.0）を WebAssembly にしたものを使う。
// 約1.3MBあるので、パスワードを使うときに初めて読み込む（オフライン用のキャッシュには入っている）。

/** パスワードが違う（または必要な）ときのエラー */
export class WrongPasswordError extends Error {
  constructor() {
    super('パスワードが違います');
    this.name = 'WrongPasswordError';
  }
}

let modulePromise = null;

function load() {
  modulePromise ??= import('../../vendor/qpdf/qpdf.mjs')
    .then(({ default: createModule }) =>
      createModule({ locateFile: () => new URL('../../vendor/qpdf/qpdf.wasm', import.meta.url).href }),
    )
    .catch((error) => {
      modulePromise = null; // 次にもう一度試せるように
      throw error;
    });
  return modulePromise;
}

/** qpdf をコマンドのように動かし、終わりの番号を返す（0：成功、3：注意つきで成功、2：失敗） */
function call(qpdf, args) {
  try {
    return qpdf.callMain(args);
  } catch (error) {
    // qpdf が終了の合図を投げたとき（exit）
    return typeof error?.status === 'number' ? error.status : 2;
  }
}

/**
 * qpdf で /in.pdf を処理して /out.pdf を返す。入出力は WebAssembly の中の仮のファイル。
 * この qpdf はエラーの文を受け取れないので、失敗したことだけが分かる（理由は呼び出し側で見分ける）。
 */
async function run(input, args, ErrorType = Error) {
  const qpdf = await load();
  qpdf.FS.writeFile('/in.pdf', input);
  try {
    const code = call(qpdf, args);
    if (code !== 0 && code !== 3) throw new ErrorType('PDFを処理できませんでした');
    return qpdf.FS.readFile('/out.pdf');
  } finally {
    for (const path of ['/in.pdf', '/out.pdf']) {
      try {
        qpdf.FS.unlink(path);
      } catch {
        // ないときは何もしない
      }
    }
  }
}

/**
 * パスワードを外す。パスワードなしで開けるPDF（編集などの制限だけのもの）は、password を空にする。
 * 暗号化の情報が正しいことは、呼び出し側で確かめておく（pdf-export.js の hasValidEncryption）。
 * @throws {WrongPasswordError} 開けなかったとき（パスワードが違う）
 */
export function decryptPdf(bytes, password = '') {
  return run(bytes, [`--password=${password}`, '--decrypt', '/in.pdf', '/out.pdf'], WrongPasswordError);
}

/**
 * 開くときのパスワードをかける（AES-256）。編集などの制限はかけない。
 * 制限の解除用のパスワード（オーナーパスワード）は、使わないので、毎回ちがう長いものにする。
 */
export function encryptPdf(bytes, password) {
  const owner = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
  return run(bytes, ['/in.pdf', '--encrypt', password, owner, '256', '--', '/out.pdf']);
}
