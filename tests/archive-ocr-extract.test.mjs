import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { extractDocument } from '../apps/api/src/archive/extract.mjs';
import { rasterFixture, scanPdf, recognizerResult, withExifOrientation } from './helpers/archive-ocr-fixtures.mjs';
import { rasterizeImage } from '../apps/api/src/archive/raster.mjs';

const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code && !error.message.includes('node_modules'));
const joined = (result) => result.blocks.map((block) => block.text).join('\n').replace(/\s/g, '');

for (const orientation of [5, 6, 7, 8]) {
  test(`JPEG EXIF orientation ${orientation} accepts the decoder's legitimate swapped dimensions`, async () => {
    for (const littleEndian of [true, false]) {
      const bytes = withExifOrientation(await rasterFixture('jpg'), orientation, littleEndian);
      const raster = await rasterizeImage(bytes, 'jpg');
      assert.equal(raster.readUInt32BE(16), 500);
      assert.equal(raster.readUInt32BE(20), 1400);
    }
  });
}

test('non-swapping JPEG EXIF orientations retain encoded dimensions and rotated inputs retain header bounds', async () => {
  for (const orientation of [1, 2, 3, 4]) {
    const raster = await rasterizeImage(withExifOrientation(await rasterFixture('jpg'), orientation), 'jpeg');
    assert.equal(raster.readUInt32BE(16), 1400); assert.equal(raster.readUInt32BE(20), 500);
  }
  const oversized = Buffer.from(await rasterFixture('jpg'));
  for (let offset = 2; offset < oversized.length - 10; offset += 1) {
    if (oversized[offset] === 255 && [192, 194].includes(oversized[offset + 1])) { oversized.writeUInt16BE(12001, offset + 7); break; }
  }
  await rejects(extractDocument({ name: 'rotated-large.jpg', bytes: withExifOrientation(oversized, 6) }), 'IMAGE_LIMIT');
});

test('real offline Chinese and English OCR reads PNG, JPEG and WebP with inspectable metadata', async () => {
  for (const extension of ['png', 'jpg', 'webp']) {
    const progress = [];
    const result = await extractDocument({ name: `budget.${extension}`, bytes: await rasterFixture(extension), onProgress: (event) => progress.push(event) });
    assert.equal(result.kind, 'image');
    assert.match(joined(result), /采购预算2400元/);
    assert.match(joined(result), /APPROVEDBUDGET2400/i);
    assert.ok(result.blocks.every((block) => block.method === 'ocr' && block.page === 1 && block.location === '图片第 1 页（OCR）'));
    assert.deepEqual(result.stats.ocr, { engine: 'tesseract.js', version: '7.0.0', languages: ['chi_sim', 'eng'], pages: 1, lowConfidencePages: [] });
    assert.deepEqual(progress, [{ stage: 'extracting', page: 1, totalPages: 1 }, { stage: 'ocr', page: 1, totalPages: 1 }]);
    assert.match(result.warnings.join(' '), /OCR.*数字/);
  }
});

test('real mixed PDF OCR retains actual page numbers and detects dominant scans despite long text header', async () => {
  const text = 'This text page already has useful readable information about ordinary policies.';
  const bytes = await scanPdf({ pages: [{ text }, { image: true }, { text: 'This is a long machine readable document header with more than forty characters.', image: true }] });
  const progress = [];
  const result = await extractDocument({ name: 'mixed.pdf', bytes, onProgress: (event) => progress.push(event) });
  assert.equal(result.blocks[0].text, text);
  assert.equal(result.blocks[0].method, undefined);
  for (const number of [2, 3]) {
    const blocks = result.blocks.filter((block) => block.method === 'ocr' && block.page === number);
    assert.match(joined({ blocks }), /采购预算2400元/);
    assert.ok(blocks.every((block) => block.location === `第 ${number} 页（OCR）`));
  }
  assert.equal(result.stats.ocr.pages, 2);
  assert.deepEqual(progress.filter((event) => event.stage === 'ocr'), [{ stage: 'ocr', page: 2, totalPages: 3 }, { stage: 'ocr', page: 3, totalPages: 3 }]);
});

test('a corrupt embedded PDF scan fails the whole extraction instead of becoming a blank-page warning', async () => {
  const bytes = await scanPdf({ pages: [{ text: 'The real text page remains readable' }, { image: true }] });
  const jpeg = await rasterFixture('jpg');
  const start = bytes.indexOf(jpeg);
  assert.ok(start > 0);
  bytes.fill(0, start, start + jpeg.length);
  await rejects(extractDocument({ name: 'broken-scan.pdf', bytes }, { createRecognizer: recognizerResult('') }), 'OCR_FAILED');
});

test('small scanned footer with short text still receives OCR; ordinary small illustration is disclosed', async () => {
  const pages = [{ text: 'Header', image: true, imageWidth: 70, imageHeight: 25 }, { text: 'This page has a long useful text paragraph and a small decorative image.', image: true, imageWidth: 70, imageHeight: 25 }];
  const result = await extractDocument({ name: 'small.pdf', bytes: await scanPdf({ pages }) }, { createRecognizer: recognizerResult() });
  assert.deepEqual(result.blocks.filter((block) => block.method === 'ocr').map((block) => block.page), [1]);
  assert.match(result.warnings.join(' '), /第 2 页.*小.*图片/);
});

test('PDF form image transforms decide actual painted coverage despite long extractable text', async () => {
  const text = 'A long extractable header must not hide a dominant scan inside a transformed PDF form.';
  const result = await extractDocument({ name: 'form.pdf', bytes: await scanPdf({ pages: [{ text, image: true, form: true }] }) }, { createRecognizer: recognizerResult('Scan body inside transformed form') });
  assert.equal(result.blocks.find((block) => block.method === 'ocr')?.text, 'Scan body inside transformed form');
});

test('raster signatures, malformed bytes and animation fail before recognition', async () => {
  await rejects(extractDocument({ name: 'spoof.png', bytes: await rasterFixture('jpg') }), 'INVALID_DOCUMENT');
  for (const extension of ['png', 'jpg', 'webp']) await rejects(extractDocument({ name: `bad.${extension}`, bytes: Buffer.from('broken') }), 'INVALID_DOCUMENT');
  const png = await rasterFixture();
  const animated = Buffer.concat([png.subarray(0, 33), Buffer.from('000000086163544c000000020000000000000000', 'hex'), png.subarray(33)]);
  await rejects(extractDocument({ name: 'animated.png', bytes: animated }), 'ANIMATED_IMAGE');
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8); webp.writeUInt32LE(10, 16); webp[20] = 2;
  await rejects(extractDocument({ name: 'animated.webp', bytes: webp }), 'ANIMATED_IMAGE');
  await rejects(extractDocument({ name: 'empty.jpg', bytes: Buffer.alloc(0) }), 'INVALID_DOCUMENT');
});

test('header raster pixel and side limits reject before a forged image can decode', async () => {
  for (const [width, height] of [[12001, 1], [4000, 3001], [0, 200]]) {
    const png = Buffer.from(await rasterFixture()); png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20);
    await rejects(extractDocument({ name: 'large.png', bytes: png }), width ? 'IMAGE_LIMIT' : 'INVALID_DOCUMENT');
  }
  await rejects(extractDocument({ name: 'large.png', bytes: Buffer.alloc(6 * 1024 * 1024 + 1) }), 'SOURCE_LIMIT');
});

test('JPEG and WebP dimensions and multiple JPEG frames cannot bypass input guards', async () => {
  const jpeg = Buffer.from(await rasterFixture('jpg'));
  for (let offset = 2; offset < jpeg.length - 10; offset += 1) {
    if (jpeg[offset] === 255 && [192, 194].includes(jpeg[offset + 1])) { jpeg.writeUInt16BE(12001, offset + 7); break; }
  }
  await rejects(extractDocument({ name: 'oversize.jpeg', bytes: jpeg }), 'IMAGE_LIMIT');
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8); webp.writeUInt32LE(10, 16); webp.writeUIntLE(3999, 24, 3); webp.writeUIntLE(3000, 27, 3);
  await rejects(extractDocument({ name: 'oversize.webp', bytes: webp }), 'IMAGE_LIMIT');
  const ordinary = await rasterFixture('jpg');
  const multipage = Buffer.concat([ordinary.subarray(0, 2), Buffer.from([255, 226, 0, 6, 77, 80, 70, 0]), ordinary.subarray(2)]);
  await rejects(extractDocument({ name: 'multiple.jpg', bytes: multipage }), 'ANIMATED_IMAGE');
});

test('signed but corrupt raster payloads fail rather than becoming recognized sources', async () => {
  const png = await rasterFixture();
  const damaged = Buffer.concat([png.subarray(0, 33), png.subarray(png.length - 12)]);
  await rejects(extractDocument({ name: 'corrupt.png', bytes: damaged }), 'INVALID_DOCUMENT');
  const jpeg = await rasterFixture('jpg');
  await rejects(extractDocument({ name: 'corrupt.jpg', bytes: jpeg.subarray(0, 100) }), 'INVALID_DOCUMENT');
  const webp = Buffer.from(await rasterFixture('webp')); webp.fill(0, 35);
  await rejects(extractDocument({ name: 'corrupt.webp', bytes: webp }), 'INVALID_DOCUMENT');
});

test('local OCR resource staging is removed after recognition in a parent-owned private directory', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'archive-ocr-test-'));
  const prior = process.env.ARCHIVE_OCR_TMPDIR;
  process.env.ARCHIVE_OCR_TMPDIR = base;
  try {
    const result = await extractDocument({ name: 'cleanup.png', bytes: await rasterFixture() });
    assert.match(joined(result), /采购预算2400元/);
    assert.deepEqual(await readdir(base), []);
  } finally {
    if (prior === undefined) delete process.env.ARCHIVE_OCR_TMPDIR; else process.env.ARCHIVE_OCR_TMPDIR = prior;
    assert.equal(path.dirname(path.resolve(base)), path.resolve(tmpdir()));
    assert.ok(path.basename(base).startsWith('archive-ocr-test-'));
    await rm(base, { recursive: true });
  }
});

test('large source raster is rescaled within render pixel and side limits before recognition', async () => {
  const canvas = createCanvas(6000, 2000); const context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, 6000, 2000);
  const createRecognizer = async () => ({ recognize: async (bytes) => { assert.ok(bytes.readUInt32BE(16) <= 3000); assert.ok(bytes.readUInt32BE(20) <= 3000); assert.ok(bytes.readUInt32BE(16) * bytes.readUInt32BE(20) <= 5000000); return { data: { text: 'Rescaled scan', confidence: 90 } }; }, terminate: async () => {} });
  const result = await extractDocument({ name: 'rescale.png', bytes: canvas.toBuffer('image/png') }, { createRecognizer });
  assert.equal(result.blocks[0].text, 'Rescaled scan');
});

test('real blank raster fails clearly rather than producing a ready empty extraction', async () => {
  const canvas = createCanvas(400, 200); const context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, 400, 200);
  await rejects(extractDocument({ name: 'blank.png', bytes: canvas.toBuffer('image/png') }), 'NO_TEXT');
});

test('recognizer confidence, Unicode boundaries, text limits and blank PDF page warnings remain explicit', async () => {
  const image = await rasterFixture();
  const text = '字'.repeat(1999) + '😀末';
  const low = await extractDocument({ name: 'low.png', bytes: image }, { createRecognizer: recognizerResult(text, 40) });
  assert.equal(low.blocks.map((block) => block.text).join(''), text);
  assert.ok(low.blocks.every((block) => block.text.length <= 2000 && block.text.isWellFormed()));
  assert.deepEqual(low.stats.ocr.lowConfidencePages, [1]);
  assert.match(low.warnings.join(' '), /图片第 1 页.*置信/);
  await rejects(extractDocument({ name: 'long.png', bytes: image }, { createRecognizer: recognizerResult('字'.repeat(200001)) }), 'TEXT_LIMIT');
  const blank = await extractDocument({ name: 'blank-page.pdf', bytes: await scanPdf({ pages: [{ text: 'Readable ordinary text' }, {}] }) }, { createRecognizer: recognizerResult('') });
  assert.match(blank.warnings.join(' '), /第 2 页.*未识别/);
  assert.equal(blank.blocks.length, 1);
});

test('OCR failures never silently skip a page and release the file worker on every exit', async () => {
  let terminated = 0;
  const createRecognizer = async () => ({ recognize: async () => { throw new Error('private engine detail'); }, terminate: async () => { terminated += 1; } });
  await rejects(extractDocument({ name: 'bad.png', bytes: await rasterFixture() }, { createRecognizer }), 'OCR_FAILED');
  assert.equal(terminated, 1);
  await rejects(extractDocument({ name: 'bad.pdf', bytes: await scanPdf() }, { createRecognizer }), 'OCR_FAILED');
  assert.equal(terminated, 2);
});

test('a failed OCR cleanup rejects the whole extraction without leaking engine internals', async () => {
  const createRecognizer = async () => ({ recognize: async () => ({ data: { text: 'Potential source', confidence: 90 } }), terminate: async () => { throw new Error('private resource path'); } });
  await assert.rejects(extractDocument({ name: 'cleanup.png', bytes: await rasterFixture() }, { createRecognizer }), (error) => error.code === 'OCR_FAILED' && !error.message.includes('private resource'));
});

test('PDF OCR page limit fails the entire file and sequential pages reuse one bounded recognizer', async () => {
  let created = 0; let terminated = 0; let maximum = 0; let active = 0;
  const createRecognizer = async () => { created += 1; return { recognize: async (bytes) => { active += 1; maximum = Math.max(maximum, active); assert.ok(bytes.length > 100); await new Promise((resolve) => setImmediate(resolve)); active -= 1; return { data: { text: 'Recognized page', confidence: 90 } }; }, terminate: async () => { terminated += 1; } }; };
  await rejects(extractDocument({ name: 'eleven.pdf', bytes: await scanPdf({ pages: Array.from({ length: 11 }, () => ({ image: true })) }) }, { createRecognizer }), 'OCR_LIMIT');
  assert.equal(created, 1); assert.equal(terminated, 1); assert.equal(maximum, 1);
});
