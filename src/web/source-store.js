// 元データ（PDF・画像の中身）の置き場所（ブラウザ側）
//
// M1ではメモリ上に置く。M2で端末内（IndexedDB）への自動保存に置き換える。
// ページリストには中身を持たせず、sourceId でここから引く。

export function createSourceStore() {
  const blobs = new Map();
  return {
    put(sourceId, blob) {
      blobs.set(sourceId, blob);
    },
    get(sourceId) {
      const blob = blobs.get(sourceId);
      if (!blob) throw new Error(`元データの中身が見つかりません: ${sourceId}`);
      return blob;
    },
    async bytes(sourceId) {
      return new Uint8Array(await this.get(sourceId).arrayBuffer());
    },
    delete(sourceId) {
      blobs.delete(sourceId);
    },
  };
}
