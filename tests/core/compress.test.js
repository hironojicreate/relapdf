import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFRawStream } from '../../vendor/pdf-lib/pdf-lib.esm.min.js';
import { zlibSync } from '../../vendor/fflate/fflate.mjs';
import { compressImages, decodeFlate, downscale, imageInfo, unpredictPng } from '../../src/core/compress.js';

const N = (name) => PDFName.of(name);

/** なめらかなグラデーションのRGB画素 */
function gradient(width, height) {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      data[i] = (x * 255) / width;
      data[i + 1] = (y * 255) / height;
      data[i + 2] = 128;
    }
  }
  return data;
}

/** PNGの予測（Up：上の行との差）をかける */
function predictUp(data, rowBytes, height) {
  const out = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    out[y * (rowBytes + 1)] = 2;
    for (let x = 0; x < rowBytes; x++) {
      const up = y > 0 ? data[(y - 1) * rowBytes + x] : 0;
      out[y * (rowBytes + 1) + 1 + x] = (data[y * rowBytes + x] - up) & 0xff;
    }
  }
  return out;
}

async function pdfWithImages() {
  const pdf = await PDFDocument.create();
  const { context } = pdf;
  const add = (dict, bytes) => context.register(PDFRawStream.of(context.obj(dict), bytes));
  const big = gradient(3000, 2000);
  const refs = {
    flate: add({ Type: 'XObject', Subtype: 'Image', Width: 3000, Height: 2000, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode' }, zlibSync(big)),
    predicted: add(
      {
        Type: 'XObject', Subtype: 'Image', Width: 3000, Height: 2000, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode',
        DecodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: 3000 },
      },
      zlibSync(predictUp(big, 9000, 2000)),
    ),
    small: add({ Type: 'XObject', Subtype: 'Image', Width: 100, Height: 50, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode' }, zlibSync(gradient(100, 50))),
    jpeg: add({ Type: 'XObject', Subtype: 'Image', Width: 4000, Height: 3000, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'DCTDecode' }, new Uint8Array(500_000)),
    cmyk: add({ Type: 'XObject', Subtype: 'Image', Width: 4000, Height: 3000, BitsPerComponent: 8, ColorSpace: 'DeviceCMYK', Filter: 'DCTDecode' }, new Uint8Array(500_000)),
    mask: add({ Type: 'XObject', Subtype: 'Image', Width: 3000, Height: 2000, BitsPerComponent: 1, ImageMask: true, Filter: 'FlateDecode' }, zlibSync(new Uint8Array(750_000))),
  };
  return { pdf, refs };
}

test('PNGの予測を元に戻す', () => {
  const data = gradient(7, 5);
  assert.deepEqual(unpredictPng(predictUp(data, 21, 5), 21, 5, 3), data);
});

test('面積の平均で縮小する', () => {
  const px = new Uint8Array([0, 100, 200, 255]); // 2×2 の白黒
  assert.deepEqual([...downscale(px, 2, 2, 1, 1, 1)], [139]);
});

test('圧縮できる画像だけを見分ける', async () => {
  const { pdf, refs } = await pdfWithImages();
  const info = (ref) => imageInfo(pdf.context, pdf.context.lookup(ref).dict);
  assert.equal(info(refs.flate).filter, 'FlateDecode');
  assert.equal(info(refs.predicted).predictor, 15);
  assert.equal(info(refs.jpeg).filter, 'DCTDecode');
  assert.equal(info(refs.cmyk), null, 'CMYKは触らない');
  assert.equal(info(refs.mask), null, 'マスク画像は触らない');
});

test('大きな画像を縮小し、小さくなったものだけ置き換える', async () => {
  const { pdf, refs } = await pdfWithImages();
  const calls = [];
  const result = await compressImages(pdf, 'standard', {
    recompressJpeg: async (input) => {
      calls.push(input);
      return { bytes: new Uint8Array(100_000), width: input.targetWidth, height: input.targetHeight };
    },
  });
  assert.equal(result.count, 3, 'Flate 2枚とJPEG 1枚');
  assert.ok(result.after < result.before);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].targetWidth, calls[0].targetHeight], [2000, 1500]);

  const get = (ref) => pdf.context.lookup(ref);
  for (const key of ['flate', 'predicted']) {
    const dict = get(refs[key]).dict;
    assert.equal(dict.get(N('Width')).asNumber(), 2000);
    assert.equal(dict.get(N('Height')).asNumber(), 1333);
    // 作り直した画像も、展開すると正しい大きさの画素になる
    const info = imageInfo(pdf.context, dict);
    assert.equal(decodeFlate(get(refs[key]).contents, info).length, 2000 * 1333 * 3);
  }
  assert.equal(get(refs.jpeg).dict.get(N('Width')).asNumber(), 2000);
  assert.equal(get(refs.small).dict.get(N('Width')).asNumber(), 100, '小さい画像はそのまま');
  assert.equal(get(refs.cmyk).dict.get(N('Width')).asNumber(), 4000);
  // 保存して、読み込み直せる
  const reloaded = await PDFDocument.load(await pdf.save());
  assert.ok(reloaded);
});

test('強めの圧縮では、小さいJPEGも画質を下げて作り直す。大きくなるときは置き換えない', async () => {
  const pdf = await PDFDocument.create();
  const ref = pdf.context.register(
    PDFRawStream.of(pdf.context.obj({ Subtype: 'Image', Width: 800, Height: 600, BitsPerComponent: 8, ColorSpace: 'DeviceGray', Filter: 'DCTDecode' }), new Uint8Array(1000)),
  );
  let called = 0;
  const result = await compressImages(pdf, 'strong', {
    recompressJpeg: async (input) => {
      called += 1;
      return { bytes: new Uint8Array(2000), width: input.targetWidth, height: input.targetHeight };
    },
  });
  assert.equal(called, 1);
  assert.equal(result.count, 0);
  assert.equal(pdf.context.lookup(ref).contents.length, 1000);
});
