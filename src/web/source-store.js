// 元データ（PDF・画像の中身）と作業中の状態の置き場所（ブラウザ側）
//
// 端末内のデータベース（IndexedDB）に保存し、ページを読み込み直しても続きから再開できるようにする。
// iPhoneはカメラから戻ったときなどに、ページを読み込み直すことがあるため。
// データは端末の外には出ない。IndexedDBが使えない環境では、メモリだけで動く（再開はできない）。
//
// ページリストには中身を持たせず、sourceId でここから引く。

const DB_NAME = 'relapdf';
const DB_VERSION = 1;
const SOURCES = 'sources'; // sourceId → { type, data: ArrayBuffer }
const STATE = 'state'; // 'current' → 作業中の状態
const STATE_KEY = 'current';

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB が使えません'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SOURCES)) db.createObjectStore(SOURCES);
      if (!db.objectStoreNames.contains(STATE)) db.createObjectStore(STATE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('データベースを開けませんでした'));
  });
}

/** IndexedDB の1回の操作を Promise にする */
function run(db, storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = operation(tx.objectStore(storeName));
    let result;
    if (request) request.onsuccess = () => (result = request.result);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('保存できませんでした'));
  });
}

/**
 * 置き場所を作る。
 * @returns {Promise<SourceStore>}
 */
export async function createSourceStore() {
  let db = null;
  try {
    db = await openDatabase();
  } catch (error) {
    console.warn('作業途中の自動保存は使えません', error);
  }
  const cache = new Map(); // sourceId → Blob（読み込んだものはメモリにも置いて速くする）

  // 書き込みに失敗したら（容量不足など）、以後はメモリだけで動く
  async function write(storeName, operation) {
    if (!db) return;
    try {
      await run(db, storeName, 'readwrite', operation);
    } catch (error) {
      console.warn('端末への保存に失敗しました', error);
      throw error;
    }
  }

  return {
    /** 端末に保存できているか（false ならメモリだけ） */
    get persistent() {
      return db !== null;
    },

    async put(sourceId, blob) {
      cache.set(sourceId, blob);
      // Blob のまま保存できないブラウザがあるため、中身の配列として保存する
      const record = { type: blob.type, data: await blob.arrayBuffer() };
      await write(SOURCES, (store) => store.put(record, sourceId));
    },

    async get(sourceId) {
      const cached = cache.get(sourceId);
      if (cached) return cached;
      const record = db ? await run(db, SOURCES, 'readonly', (store) => store.get(sourceId)) : undefined;
      if (!record) throw new Error(`元データの中身が見つかりません: ${sourceId}`);
      const blob = new Blob([record.data], { type: record.type });
      cache.set(sourceId, blob);
      return blob;
    },

    async bytes(sourceId) {
      return new Uint8Array(await (await this.get(sourceId)).arrayBuffer());
    },

    async delete(sourceId) {
      cache.delete(sourceId);
      await write(SOURCES, (store) => store.delete(sourceId)).catch(() => {});
    },

    /** 保存されている元データのID一覧 */
    async keys() {
      if (!db) return [...cache.keys()];
      return run(db, SOURCES, 'readonly', (store) => store.getAllKeys());
    },

    /** 作業中の状態（ページリストや設定）を保存する */
    async saveState(state) {
      await write(STATE, (store) => store.put(state, STATE_KEY));
    },

    async loadState() {
      if (!db) return null;
      return (await run(db, STATE, 'readonly', (store) => store.get(STATE_KEY))) ?? null;
    },

    /** すべて消す（「新しく作る」とき） */
    async clear() {
      cache.clear();
      await write(SOURCES, (store) => store.clear()).catch(() => {});
      await write(STATE, (store) => store.clear()).catch(() => {});
    },
  };
}
