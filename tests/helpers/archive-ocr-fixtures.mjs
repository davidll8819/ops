import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

export const rasterFixture = (extension = 'png') => readFile(new URL(`../fixtures/archive-ocr/budget.${extension}`, import.meta.url));

export function withExifOrientation(jpeg, orientation, littleEndian = true) {
  const exif = Buffer.alloc(36);
  exif.set([255, 225, 0, 34, 69, 120, 105, 102, 0, 0]);
  exif.write(littleEndian ? 'II' : 'MM', 10);
  const short = (value, offset) => littleEndian ? exif.writeUInt16LE(value, offset) : exif.writeUInt16BE(value, offset);
  const long = (value, offset) => littleEndian ? exif.writeUInt32LE(value, offset) : exif.writeUInt32BE(value, offset);
  short(42, 12); long(8, 14); short(1, 18); short(0x112, 20); short(3, 22); long(1, 24); short(orientation, 28);
  return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
}

// Tiny actual PDF writer: image XObjects are JPEG bytes, text uses Helvetica.
export async function scanPdf({ pages = [{ image: true }], width = 700, height = 250 } = {}) {
  const image = await rasterFixture('jpg');
  const objects = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), null,
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1400 /Height 500 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')])];
  const ids = [];
  for (const { text = '', image: hasImage = false, imageWidth = width, imageHeight = height, repeats = 1, form = false } of pages) {
    let formId;
    if (form) {
      formId = objects.length + 1;
      const stream = 'q /Im1 Do Q';
      objects.push(Buffer.from(`<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Matrix [${imageWidth} 0 0 ${imageHeight} 0 0] /Resources << /XObject << /Im1 4 0 R >> >> /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
    }
    const content = (text ? `BT /F1 12 Tf 15 ${height - 18} Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET\n` : '') + (hasImage ? Array.from({ length: repeats }, () => form ? '/Fm1 Do' : `q ${imageWidth} 0 0 ${imageHeight} 0 0 cm /Im1 Do Q`).join('\n') : '');
    const stream = deflateSync(Buffer.from(content));
    const id = objects.length + 1;
    ids.push(id);
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R ${form ? `/Fm1 ${formId} 0 R` : ''} >> >> /Contents ${id + 1} 0 R >>`));
    objects.push(Buffer.concat([Buffer.from(`<< /Filter /FlateDecode /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('\nendstream')]));
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${pages.length} /Kids [${ids.map((id) => `${id} 0 R`).join(' ')}] >>`);
  const parts = [Buffer.from('%PDF-1.7\n')];
  const offsets = [];
  let length = parts[0].length;
  objects.forEach((object, i) => { offsets.push(length); const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]); parts.push(part); length += part.length; });
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}

export function recognizerResult(text = 'Recognized budget 2400', confidence = 90) {
  return async () => ({ recognize: async () => ({ data: { text, confidence } }), terminate: async () => {} });
}
