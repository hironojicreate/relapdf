// ページリスト（Core層）
//
// 読み込んだPDF・画像をすべて「ページの並び」として扱うためのデータ構造と操作。
// - DOMやブラウザAPIには触らない（Node.jsでそのままテストできる）
// - すべての操作は元のオブジェクトを変更せず、新しい状態を返す（元に戻す機能を作りやすくするため）
// - 状態はJSONに変換できる形だけで持つ。ファイルの中身（バイナリ）は持たず、sourceIdで外部の保存先から引く
//
// 詳しい仕様は docs/page-list.md を参照。

import { normalizeMarks } from './marks.js';

export const SCHEMA_VERSION = 1;

/** ユーザーが指定できる回転角度 */
export const ROTATIONS = Object.freeze([0, 90, 180, 270]);

/** 色補正の種類。'document' は書類モード（背景を白く・文字をくっきり） */
export const FILTERS = Object.freeze(['none', 'document']);

/** 4点補正の比率。'free' は四隅の位置から自然な比率、'a4' はA4比率に合わせる */
export const ASPECTS = Object.freeze(['free', 'a4']);

/**
 * 4点補正の四隅を、写真の外にどこまで出せるか（写真の幅・高さに対する割合）。
 * 書類の端が写真からはみ出していても補正できるようにするため。はみ出した部分は白になる。
 */
export const PERSPECTIVE_MARGIN = 0.25;

/** 元データの種類 */
export const SOURCE_KINDS = Object.freeze(['pdf', 'image']);

/** 用紙サイズ（ポイント。1pt = 1/72インチ） */
export const PAPER_SIZES = Object.freeze({
  A4: Object.freeze({ width: 595.28, height: 841.89 }),
});

let fallbackCounter = 0;

/** 重ならないIDを作る。テストでは決まったIDを渡せるよう、各操作はIDを引数でも受け取れる */
export function newId(prefix = 'id') {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}_${uuid}`;
  fallbackCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${fallbackCounter.toString(36)}`;
}

/** 空のページリストを作る */
export function createDocument() {
  return { version: SCHEMA_VERSION, sources: {}, pages: [] };
}

/**
 * 元データ（PDFまたは画像）を登録する。
 * 中身のバイナリは呼び出し側が sourceId をキーにして別に保存する。
 */
export function addSource(doc, source) {
  assertDocument(doc);
  const id = source.id ?? newId('src');
  if (doc.sources[id]) throw new Error(`同じIDの元データがすでにあります: ${id}`);
  if (!SOURCE_KINDS.includes(source.kind)) throw new Error(`元データの種類が不正です: ${source.kind}`);

  const normalized = {
    id,
    kind: source.kind,
    name: source.name ?? '',
    mimeType: source.mimeType ?? '',
    byteLength: source.byteLength ?? 0,
    // PDFはページ数、画像は常に1
    pageCount: source.kind === 'image' ? 1 : source.pageCount,
  };
  if (source.kind === 'image') {
    // 画像の幅・高さは、写真の回転情報（EXIF）を反映したあとの値
    normalized.width = source.width;
    normalized.height = source.height;
  }
  if (!Number.isInteger(normalized.pageCount) || normalized.pageCount < 1) {
    throw new Error(`ページ数が不正です: ${normalized.pageCount}`);
  }

  return { ...doc, sources: { ...doc.sources, [id]: normalized } };
}

/** 元データ1ページ分のページを作る（まだ並びには入れない） */
export function createSourcePage(doc, sourceId, pageIndex = 0, id = newId('page')) {
  const source = doc.sources[sourceId];
  if (!source) throw new Error(`元データが見つかりません: ${sourceId}`);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= source.pageCount) {
    throw new Error(`ページ番号が範囲外です: ${pageIndex}`);
  }
  return {
    id,
    content: { type: source.kind, sourceId, pageIndex },
    rotation: 0,
    perspective: null,
    filter: 'none',
  };
}

/** 白紙ページを作る（まだ並びには入れない） */
export function createBlankPage(size = PAPER_SIZES.A4, id = newId('page')) {
  if (!(size.width > 0 && size.height > 0)) throw new Error('白紙ページのサイズが不正です');
  return {
    id,
    content: { type: 'blank', width: size.width, height: size.height },
    rotation: 0,
    perspective: null,
    filter: 'none',
  };
}

/**
 * 元データの全ページを並びに追加する。
 * @param {object} [options]
 * @param {number} [options.at] 挿入位置（省略時は末尾）
 * @param {string[]} [options.ids] 作るページのID（テスト用）
 */
export function appendSourcePages(doc, sourceId, options = {}) {
  const source = doc.sources[sourceId];
  if (!source) throw new Error(`元データが見つかりません: ${sourceId}`);
  const pages = [];
  for (let i = 0; i < source.pageCount; i++) {
    pages.push(createSourcePage(doc, sourceId, i, options.ids?.[i]));
  }
  return insertPages(doc, pages, options.at ?? doc.pages.length);
}

/** ページを指定位置に挿入する */
export function insertPages(doc, pages, at = doc.pages.length) {
  assertDocument(doc);
  if (!Number.isInteger(at) || at < 0 || at > doc.pages.length) {
    throw new Error(`挿入位置が範囲外です: ${at}`);
  }
  const existing = new Set(doc.pages.map((p) => p.id));
  for (const page of pages) {
    if (existing.has(page.id)) throw new Error(`同じIDのページがすでにあります: ${page.id}`);
    existing.add(page.id);
    const { content } = page;
    if (content.type !== 'blank' && !doc.sources[content.sourceId]) {
      throw new Error(`元データが見つかりません: ${content.sourceId}`);
    }
  }
  const next = doc.pages.slice();
  next.splice(at, 0, ...pages);
  return { ...doc, pages: next };
}

/**
 * 選んだページをまとめて移動する。
 * toIndex は「移動するページを取り除いたあとの並び」での挿入位置。
 * 選んだページ同士の順番は、もとの並びの順番を保つ。
 */
export function movePages(doc, pageIds, toIndex) {
  const ids = toIdSet(doc, pageIds);
  const moving = doc.pages.filter((p) => ids.has(p.id));
  const rest = doc.pages.filter((p) => !ids.has(p.id));
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex > rest.length) {
    throw new Error(`移動先が範囲外です: ${toIndex}`);
  }
  rest.splice(toIndex, 0, ...moving);
  return { ...doc, pages: rest };
}

/**
 * 選んだページをまとめて、insertBefore 番目のページの前に移動する（ドラッグで離した位置）。
 * insertBefore は今の並びでの位置（0〜ページ数）。選んだページ同士の順番は保つ。
 */
export function movePagesBefore(doc, pageIds, insertBefore) {
  const ids = toIdSet(doc, pageIds);
  if (!Number.isInteger(insertBefore) || insertBefore < 0 || insertBefore > doc.pages.length) {
    throw new Error(`移動先が範囲外です: ${insertBefore}`);
  }
  // 移動するページを取り除いた並びで、何番目に入れるか
  const to = doc.pages.slice(0, insertBefore).filter((p) => !ids.has(p.id)).length;
  return movePages(doc, [...ids], to);
}

/** ページを削除する。使われなくなった元データは pruneSources で片付ける */
export function removePages(doc, pageIds) {
  const ids = toIdSet(doc, pageIds);
  return { ...doc, pages: doc.pages.filter((p) => !ids.has(p.id)) };
}

/** ページを回転する。delta は90の倍数（負の値は左回り） */
export function rotatePages(doc, pageIds, delta) {
  if (!Number.isInteger(delta) || delta % 90 !== 0) {
    throw new Error(`回転角度は90の倍数で指定してください: ${delta}`);
  }
  const ids = toIdSet(doc, pageIds);
  return mapPages(doc, ids, (page) => ({ ...page, rotation: normalizeRotation(page.rotation + delta) }));
}

/**
 * 4点補正を設定する。null で補正を外す。
 * corners は [左上, 右上, 右下, 左下] の順で、元画像に対する割合（0〜1。写真の外は PERSPECTIVE_MARGIN まで）。
 * 元画像は「写真の回転情報を反映したあと・ユーザーの回転をかける前」の向き。
 */
export function setPerspective(doc, pageId, perspective) {
  const page = findPage(doc, pageId);
  if (page.content.type !== 'image') throw new Error('4点補正は画像のページだけに使えます');
  const value = perspective === null ? null : normalizePerspective(perspective);
  return mapPages(doc, new Set([pageId]), (p) => ({ ...p, perspective: value }));
}

/**
 * 書き込み（ページ番号・ヘッダー/フッター・透かし・スタンプ）を設定する。null で外す。
 * 書き込みはPDFを書き出すときに、すべてのページにかける（marks.js）。
 */
export function setMarks(doc, marks) {
  assertDocument(doc);
  return { ...doc, marks: marks === null ? null : normalizeMarks(marks) };
}

/** 色補正を設定する */
export function setFilter(doc, pageIds, filter) {
  if (!FILTERS.includes(filter)) throw new Error(`色補正の種類が不正です: ${filter}`);
  const ids = toIdSet(doc, pageIds);
  return mapPages(doc, ids, (page) => ({ ...page, filter }));
}

/** どのページからも使われていない元データを取り除く。取り除いたIDも返す（バイナリの削除に使う） */
export function pruneSources(doc) {
  const used = new Set();
  for (const page of doc.pages) {
    if (page.content.type !== 'blank') used.add(page.content.sourceId);
  }
  const sources = {};
  const removed = [];
  for (const [id, source] of Object.entries(doc.sources)) {
    if (used.has(id)) sources[id] = source;
    else removed.push(id);
  }
  return { doc: { ...doc, sources }, removedSourceIds: removed };
}

/** 選んだページだけを、並びの順番のまま新しいページリストとして取り出す */
export function extractPages(doc, pageIds) {
  const ids = toIdSet(doc, pageIds);
  const pages = doc.pages.filter((p) => ids.has(p.id));
  return pruneSources({ ...doc, pages }).doc;
}

/**
 * 指定したページの手前で区切って、複数のページリストに分ける。
 * splitBefore は区切る位置（0始まりのページ番号）。例：[2, 5] → 0-1 / 2-4 / 5-最後
 */
export function splitDocument(doc, splitBefore) {
  assertDocument(doc);
  const cuts = [...new Set(splitBefore)].sort((a, b) => a - b);
  for (const cut of cuts) {
    if (!Number.isInteger(cut) || cut <= 0 || cut >= doc.pages.length) {
      throw new Error(`区切る位置が範囲外です: ${cut}`);
    }
  }
  const bounds = [0, ...cuts, doc.pages.length];
  const parts = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const pages = doc.pages.slice(bounds[i], bounds[i + 1]);
    parts.push(pruneSources({ ...doc, pages }).doc);
  }
  return parts;
}

/** 自動保存などのために文字列にする */
export function serializeDocument(doc) {
  assertDocument(doc);
  return JSON.stringify(doc);
}

/** 保存した文字列から戻す。形が壊れていればエラーにする */
export function deserializeDocument(text) {
  const doc = JSON.parse(text);
  validateDocument(doc);
  return doc;
}

/** ページリストの形が正しいか調べる。問題があればエラーを投げる */
export function validateDocument(doc) {
  assertDocument(doc);
  if (doc.version !== SCHEMA_VERSION) throw new Error(`対応していない形式のバージョンです: ${doc.version}`);
  if (doc.marks != null) normalizeMarks(doc.marks);
  for (const [id, source] of Object.entries(doc.sources)) {
    if (source.id !== id) throw new Error(`元データのIDが一致しません: ${id}`);
    if (!SOURCE_KINDS.includes(source.kind)) throw new Error(`元データの種類が不正です: ${source.kind}`);
  }
  const seen = new Set();
  for (const page of doc.pages) {
    if (seen.has(page.id)) throw new Error(`ページIDが重複しています: ${page.id}`);
    seen.add(page.id);
    if (!ROTATIONS.includes(page.rotation)) throw new Error(`回転角度が不正です: ${page.rotation}`);
    if (!FILTERS.includes(page.filter)) throw new Error(`色補正の種類が不正です: ${page.filter}`);
    const { content } = page;
    if (content.type === 'blank') {
      if (!(content.width > 0 && content.height > 0)) throw new Error('白紙ページのサイズが不正です');
    } else {
      const source = doc.sources[content.sourceId];
      if (!source) throw new Error(`元データが見つかりません: ${content.sourceId}`);
      if (source.kind !== content.type) throw new Error(`ページと元データの種類が一致しません: ${page.id}`);
      if (!(content.pageIndex >= 0 && content.pageIndex < source.pageCount)) {
        throw new Error(`ページ番号が範囲外です: ${page.id}`);
      }
    }
    if (page.perspective !== null) {
      if (content.type !== 'image') throw new Error('4点補正は画像のページだけに使えます');
      normalizePerspective(page.perspective);
    }
  }
  return true;
}

/** 回転を 0/90/180/270 にそろえる */
export function normalizeRotation(deg) {
  return ((deg % 360) + 360) % 360;
}

// ---- 内部で使う小さな関数 ----

function assertDocument(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.pages) || !doc.sources || typeof doc.sources !== 'object') {
    throw new Error('ページリストの形が正しくありません');
  }
}

function findPage(doc, pageId) {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) throw new Error(`ページが見つかりません: ${pageId}`);
  return page;
}

function toIdSet(doc, pageIds) {
  assertDocument(doc);
  const ids = new Set(pageIds);
  const known = new Set(doc.pages.map((p) => p.id));
  for (const id of ids) {
    if (!known.has(id)) throw new Error(`ページが見つかりません: ${id}`);
  }
  return ids;
}

function mapPages(doc, ids, fn) {
  return { ...doc, pages: doc.pages.map((p) => (ids.has(p.id) ? fn(p) : p)) };
}

function normalizePerspective(perspective) {
  const { corners, aspect = 'free' } = perspective ?? {};
  if (!Array.isArray(corners) || corners.length !== 4) throw new Error('4点補正の四隅は4つ必要です');
  if (!ASPECTS.includes(aspect)) throw new Error(`4点補正の比率が不正です: ${aspect}`);
  const normalized = corners.map((c) => {
    const min = -PERSPECTIVE_MARGIN;
    const max = 1 + PERSPECTIVE_MARGIN;
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y) || c.x < min || c.x > max || c.y < min || c.y > max) {
      throw new Error(`4点補正の座標は${min}〜${max}の範囲で指定してください`);
    }
    return { x: c.x, y: c.y };
  });
  return { corners: normalized, aspect };
}
