import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addSource,
  appendSourcePages,
  createBlankPage,
  createDocument,
  deserializeDocument,
  extractPages,
  insertPages,
  movePages,
  normalizeRotation,
  pruneSources,
  removePages,
  rotatePages,
  serializeDocument,
  setFilter,
  setPerspective,
  splitDocument,
  validateDocument,
} from '../../src/core/page-list.js';

// PDF（3ページ）と写真1枚を読み込んだ状態を作る
function sampleDoc() {
  let doc = createDocument();
  doc = addSource(doc, { id: 'pdf1', kind: 'pdf', name: 'a.pdf', pageCount: 3 });
  doc = addSource(doc, { id: 'img1', kind: 'image', name: 'photo.jpg', width: 3024, height: 4032 });
  doc = appendSourcePages(doc, 'pdf1', { ids: ['p1', 'p2', 'p3'] });
  doc = appendSourcePages(doc, 'img1', { ids: ['p4'] });
  return doc;
}

const ids = (doc) => doc.pages.map((p) => p.id);

test('元データを追加すると、その全ページが並びに入る', () => {
  const doc = sampleDoc();
  assert.deepEqual(ids(doc), ['p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(doc.pages[1].content, { type: 'pdf', sourceId: 'pdf1', pageIndex: 1 });
  assert.deepEqual(doc.pages[3].content, { type: 'image', sourceId: 'img1', pageIndex: 0 });
  assert.equal(doc.sources.img1.pageCount, 1);
  assert.equal(doc.pages[0].rotation, 0);
  assert.equal(doc.pages[0].filter, 'none');
  assert.equal(doc.pages[0].perspective, null);
});

test('操作は元の状態を変更しない', () => {
  const doc = sampleDoc();
  const before = structuredClone(doc);
  movePages(doc, ['p1'], 3);
  removePages(doc, ['p2']);
  rotatePages(doc, ['p3'], 90);
  setFilter(doc, ['p4'], 'document');
  assert.deepEqual(doc, before);
});

test('挿入位置を指定して追加できる', () => {
  let doc = sampleDoc();
  doc = insertPages(doc, [createBlankPage(undefined, 'blank1')], 1);
  assert.deepEqual(ids(doc), ['p1', 'blank1', 'p2', 'p3', 'p4']);
  assert.throws(() => insertPages(doc, [createBlankPage(undefined, 'x')], 99));
  assert.throws(() => insertPages(doc, [createBlankPage(undefined, 'p1')]), /同じIDのページ/);
});

test('同じIDの元データは追加できない', () => {
  const doc = sampleDoc();
  assert.throws(() => addSource(doc, { id: 'pdf1', kind: 'pdf', pageCount: 1 }), /同じIDの元データ/);
  assert.throws(() => addSource(doc, { kind: 'zip', pageCount: 1 }), /種類が不正/);
  assert.throws(() => addSource(doc, { kind: 'pdf', pageCount: 0 }), /ページ数が不正/);
});

test('並べ替え：1ページを移動する', () => {
  const doc = movePages(sampleDoc(), ['p1'], 3);
  assert.deepEqual(ids(doc), ['p2', 'p3', 'p4', 'p1']);
});

test('並べ替え：選んだ複数ページは元の順番のまま移動する', () => {
  const doc = movePages(sampleDoc(), ['p4', 'p2'], 0);
  assert.deepEqual(ids(doc), ['p2', 'p4', 'p1', 'p3']);
});

test('並べ替え：範囲外や存在しないページはエラー', () => {
  const doc = sampleDoc();
  assert.throws(() => movePages(doc, ['p1'], 4), /範囲外/);
  assert.throws(() => movePages(doc, ['nope'], 0), /見つかりません/);
});

test('削除したあと、使われなくなった元データを片付けられる', () => {
  let doc = removePages(sampleDoc(), ['p4']);
  assert.deepEqual(ids(doc), ['p1', 'p2', 'p3']);
  assert.ok(doc.sources.img1, '削除だけでは元データは残る');
  const result = pruneSources(doc);
  assert.deepEqual(result.removedSourceIds, ['img1']);
  assert.equal(result.doc.sources.img1, undefined);
  assert.ok(result.doc.sources.pdf1);
});

test('回転は90度単位で、0/90/180/270にそろう', () => {
  let doc = rotatePages(sampleDoc(), ['p1', 'p2'], 90);
  assert.equal(doc.pages[0].rotation, 90);
  assert.equal(doc.pages[1].rotation, 90);
  assert.equal(doc.pages[2].rotation, 0);
  doc = rotatePages(doc, ['p1'], -180);
  assert.equal(doc.pages[0].rotation, 270);
  doc = rotatePages(doc, ['p1'], 450);
  assert.equal(doc.pages[0].rotation, 0);
  assert.throws(() => rotatePages(doc, ['p1'], 45), /90の倍数/);
  assert.equal(normalizeRotation(-90), 270);
});

test('4点補正は画像ページだけに設定でき、外すこともできる', () => {
  const corners = [
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.12 },
    { x: 0.88, y: 0.9 },
    { x: 0.12, y: 0.92 },
  ];
  let doc = setPerspective(sampleDoc(), 'p4', { corners, aspect: 'a4' });
  assert.deepEqual(doc.pages[3].perspective, { corners, aspect: 'a4' });
  doc = setPerspective(doc, 'p4', { corners });
  assert.equal(doc.pages[3].perspective.aspect, 'free', '比率の省略時は free');
  doc = setPerspective(doc, 'p4', null);
  assert.equal(doc.pages[3].perspective, null);

  assert.throws(() => setPerspective(doc, 'p1', { corners }), /画像のページだけ/);
  assert.throws(() => setPerspective(doc, 'p4', { corners: corners.slice(0, 3) }), /4つ必要/);
  assert.throws(() => setPerspective(doc, 'p4', { corners: [...corners.slice(0, 3), { x: 1.2, y: 0 }] }), /0〜1/);
  assert.throws(() => setPerspective(doc, 'p4', { corners, aspect: 'letter' }), /比率が不正/);
});

test('色補正（書類モード）を設定できる', () => {
  const doc = setFilter(sampleDoc(), ['p4'], 'document');
  assert.equal(doc.pages[3].filter, 'document');
  assert.throws(() => setFilter(doc, ['p4'], 'sepia'), /種類が不正/);
});

test('抽出：選んだページを並びの順番で取り出し、使う元データだけ残す', () => {
  const doc = extractPages(movePages(sampleDoc(), ['p3'], 0), ['p1', 'p3']);
  assert.deepEqual(ids(doc), ['p3', 'p1']);
  assert.deepEqual(Object.keys(doc.sources), ['pdf1']);
});

test('分割：指定したページの手前で区切る', () => {
  const parts = splitDocument(sampleDoc(), [3, 1]);
  assert.deepEqual(parts.map(ids), [['p1'], ['p2', 'p3'], ['p4']]);
  assert.deepEqual(Object.keys(parts[2].sources), ['img1']);
  assert.throws(() => splitDocument(sampleDoc(), [0]), /範囲外/);
  assert.throws(() => splitDocument(sampleDoc(), [4]), /範囲外/);
});

test('白紙ページは元データなしで並びに入る', () => {
  const doc = insertPages(createDocument(), [createBlankPage({ width: 100, height: 200 }, 'b')]);
  assert.deepEqual(doc.pages[0].content, { type: 'blank', width: 100, height: 200 });
  assert.equal(pruneSources(doc).removedSourceIds.length, 0);
  assert.throws(() => createBlankPage({ width: 0, height: 100 }));
});

test('保存用の文字列にして、元に戻せる', () => {
  const doc = setPerspective(rotatePages(sampleDoc(), ['p2'], 90), 'p4', {
    corners: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
  });
  assert.deepEqual(deserializeDocument(serializeDocument(doc)), doc);
});

test('壊れた保存データは読み込まない', () => {
  const good = sampleDoc();
  const broken = (mutate) => {
    const doc = structuredClone(good);
    mutate(doc);
    return JSON.stringify(doc);
  };
  assert.throws(() => deserializeDocument(broken((d) => (d.version = 99))), /バージョン/);
  assert.throws(() => deserializeDocument(broken((d) => (d.pages[0].rotation = 45))), /回転角度/);
  assert.throws(() => deserializeDocument(broken((d) => (d.pages[1].id = 'p1'))), /重複/);
  assert.throws(() => deserializeDocument(broken((d) => delete d.sources.pdf1)), /見つかりません/);
  assert.throws(() => deserializeDocument(broken((d) => (d.pages[0].content.pageIndex = 3))), /範囲外/);
  assert.throws(() => deserializeDocument(broken((d) => (d.pages[0].content.type = 'image'))), /一致しません/);
  assert.throws(() => deserializeDocument('{}'), /形が正しくありません/);
  assert.equal(validateDocument(good), true);
});

test('IDを渡さなければ自動で重ならないIDが付く', () => {
  let doc = addSource(createDocument(), { kind: 'pdf', pageCount: 2 });
  const [sourceId] = Object.keys(doc.sources);
  doc = appendSourcePages(doc, sourceId);
  doc = appendSourcePages(doc, sourceId);
  assert.equal(new Set(ids(doc)).size, 4);
});
