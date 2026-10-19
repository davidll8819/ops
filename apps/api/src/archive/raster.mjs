import { createCanvas, loadImage } from '@napi-rs/canvas';

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
const invalid = () => fail('INVALID_DOCUMENT', '图片签名或内容无效，请重新保存为 PNG、JPEG 或 WebP 后上传。');
const animated = () => fail('ANIMATED_IMAGE', '不支持动画或多页图片，请拆分为单张静态图片后上传。');

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) invalid();
  if (width > 12000 || height > 12000 || width * height > 12000000) fail('IMAGE_LIMIT', '图片超过 12,000 像素单边或 1,200 万像素限制，请缩小图片或拆分扫描后上传。');
  return { width, height };
}

function exifOrientation(tiff) {
  if (tiff.length < 8) return 1;
  const endian = tiff.toString('ascii', 0, 2);
  if (endian !== 'II' && endian !== 'MM') return 1;
  const short = (offset) => endian === 'II' ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
  const long = (offset) => endian === 'II' ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
  if (short(2) !== 42) return 1;
  const directory = long(4);
  if (directory > tiff.length - 2) return 1;
  const entries = short(directory);
  for (let index = 0; index < entries; index += 1) {
    const entry = directory + 2 + index * 12;
    if (entry > tiff.length - 12) return 1;
    if (short(entry) === 0x112 && short(entry + 2) === 3 && long(entry + 4) === 1) {
      const value = short(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/** Read dimensions and animation markers before the native image decoder allocates. */
export function inspectRaster(bytes, extension) {
  let size;
  if (extension === 'png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13) invalid();
    size = dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    let offset = 8; let ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset); const kind = bytes.toString('ascii', offset + 4, offset + 8);
      if (offset + length + 12 > bytes.length) invalid();
      if (kind === 'acTL' || kind === 'fcTL' || kind === 'fdAT') animated();
      offset += length + 12;
      if (kind === 'IEND') { ended = true; break; }
    }
    if (!ended) invalid();
  } else if (extension === 'jpg' || extension === 'jpeg') {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) invalid();
    let offset = 2; let orientation = 1;
    while (offset + 1 < bytes.length) {
      if (bytes[offset++] !== 255) invalid();
      while (bytes[offset] === 255) offset += 1;
      const marker = bytes[offset++];
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) invalid();
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) invalid();
      if (marker === 226 && bytes.toString('ascii', offset + 2, offset + 6) === 'MPF\u0000') animated();
      if (marker === 225 && bytes.subarray(offset + 2, offset + 8).equals(Buffer.from('Exif\u0000\u0000'))) orientation = exifOrientation(bytes.subarray(offset + 8, offset + length));
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) invalid();
        size = dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      }
      offset += length;
    }
    // The native decoder applies EXIF before returning dimensions. Header limits
    // above still apply to encoded pixels; only orientations 5–8 swap the axes.
    if (size && orientation >= 5) size = { width: size.height, height: size.width };
  } else if (extension === 'webp') {
    if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.toString('ascii', offset, offset + 4); const length = bytes.readUInt32LE(offset + 4); const start = offset + 8;
      if (start + length > bytes.length) invalid();
      if (kind === 'ANIM' || kind === 'ANMF') animated();
      if (kind === 'VP8X') {
        if (length < 10) invalid();
        if (bytes[start] & 2) animated();
        size = dimensions(1 + bytes.readUIntLE(start + 4, 3), 1 + bytes.readUIntLE(start + 7, 3));
      } else if (kind === 'VP8 ' && !size) {
        if (length < 10 || !bytes.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42]))) invalid();
        size = dimensions(bytes.readUInt16LE(start + 6) & 16383, bytes.readUInt16LE(start + 8) & 16383);
      } else if (kind === 'VP8L' && !size) {
        if (length < 5 || bytes[start] !== 47) invalid();
        const bits = bytes.readUInt32LE(start + 1);
        size = dimensions(1 + (bits & 16383), 1 + (bits >>> 14 & 16383));
      }
      offset = start + length + (length & 1);
    }
  } else invalid();
  if (!size) invalid();
  return size;
}

export function renderSize(width, height, preferredScale = 1) {
  if (![width, height, preferredScale].every(Number.isFinite) || width <= 0 || height <= 0 || preferredScale <= 0) invalid();
  const scale = Math.min(preferredScale, 3000 / width, 3000 / height, Math.sqrt(5000000 / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale };
}

export function newRaster(width, height) {
  const canvas = createCanvas(width, height); const context = canvas.getContext('2d');
  context.fillStyle = 'white'; context.fillRect(0, 0, width, height);
  return { canvas, context, close() { canvas.width = 1; canvas.height = 1; } };
}

export async function rasterizeImage(bytes, extension) {
  const expected = inspectRaster(bytes, extension);
  const image = await loadImage(bytes);
  dimensions(image.width, image.height);
  if (image.width !== expected.width || image.height !== expected.height) invalid();
  const size = renderSize(image.width, image.height);
  const raster = newRaster(size.width, size.height);
  try { raster.context.drawImage(image, 0, 0, size.width, size.height); return raster.canvas.toBuffer('image/png'); }
  finally { raster.close(); }
}

const multiply = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];

// Clip the painted unit-square polygon to the visible PDF page, including rotation/skew.
function paintedArea(matrix, view) {
  let polygon = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]);
  for (const [axis, boundary, sign] of [[0, view[0], 1], [0, view[2], -1], [1, view[1], 1], [1, view[3], -1]]) {
    const clipped = [];
    for (let i = 0; i < polygon.length; i += 1) {
      const a = polygon[i]; const b = polygon[(i + 1) % polygon.length];
      const aInside = (a[axis] - boundary) * sign >= 0; const bInside = (b[axis] - boundary) * sign >= 0;
      if (aInside) clipped.push(a);
      if (aInside !== bInside) { const t = (boundary - a[axis]) / (b[axis] - a[axis]); clipped.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); }
    }
    polygon = clipped;
  }
  return Math.abs(polygon.reduce((sum, a, i) => { const b = polygon[(i + 1) % polygon.length]; return sum + a[0] * b[1] - a[1] * b[0]; }, 0)) / 2;
}

export function pdfImageCoverage(operators, OPS, view) {
  let current = [1, 0, 0, 1, 0, 0]; const stack = []; let images = 0; let maximumArea = 0;
  const paint = (transform = current) => { images += 1; maximumArea = Math.max(maximumArea, paintedArea(transform, view)); };
  for (let i = 0; i < operators.fnArray.length; i += 1) {
    const op = operators.fnArray[i]; const args = operators.argsArray[i];
    if (op === OPS.save) stack.push(current.slice());
    else if (op === OPS.restore) current = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (op === OPS.paintFormXObjectBegin) { stack.push(current.slice()); if (args[0]) current = multiply(current, args[0]); }
    else if (op === OPS.paintFormXObjectEnd) current = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (op === OPS.transform) current = multiply(current, args);
    else if ([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintSolidColorImageMask].includes(op)) paint();
    else if (op === OPS.paintImageXObjectRepeat) { for (let j = 0; j < args[3].length; j += 2) paint(multiply(current, [args[1], 0, 0, args[2], args[3][j], args[3][j + 1]])); }
    else if (op === OPS.paintImageMaskXObjectRepeat) { for (let j = 0; j < args[5].length; j += 2) paint(multiply(current, [args[1], args[2], args[3], args[4], args[5][j], args[5][j + 1]])); }
    else if (op === OPS.paintImageMaskXObjectGroup) { for (const image of args[0]) paint(multiply(current, image.transform)); }
    else if (op === OPS.paintInlineImageXObjectGroup) { for (const image of args[1]) paint(multiply(current, image.transform)); }
  }
  return { images, ratio: maximumArea / ((view[2] - view[0]) * (view[3] - view[1])) };
}

/** PDF.js can resolve a failed image decode to null and still complete rendering. */
export function assertPdfImagesResolved(operators, OPS, page) {
  const check = (value) => {
    if (typeof value === 'string') {
      const objects = value.startsWith('g_') ? page.commonObjs : page.objs;
      value = objects.has(value) ? objects.get(value) : null;
    }
    if (!value) fail('OCR_FAILED', 'PDF 图片解码失败，请重新扫描或拆分文件后重试。');
    if (typeof value.data === 'string') check(value.data);
  };
  for (let index = 0; index < operators.fnArray.length; index += 1) {
    const operation = operators.fnArray[index]; const args = operators.argsArray[index];
    if ([OPS.paintImageXObject, OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectRepeat].includes(operation)) check(args[0]);
    else if (operation === OPS.paintImageMaskXObjectGroup) for (const image of args[0]) check(image);
  }
}
