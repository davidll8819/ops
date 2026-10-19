import yazl from 'yazl';
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';

/** Build an in-memory ZIP from {path: string|Buffer}, without touching disk. */
export function makeZip(entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    for (const [name, value] of Object.entries(entries)) zip.addBuffer(Buffer.from(value), name);
    zip.end();
  });
}

const xmlEscape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const paragraph = (text) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;

/** Real DOCX: paragraphs: string[], tables: Array<Array<Array<string>>>, extraEntries: ZIP-part overrides. */
export async function makeDocx({ paragraphs = ['Synthetic policy'], tables = [], extraEntries = {} } = {}) {
  const body = paragraphs.map(paragraph).join('') + tables.map((table) => `<w:tbl>${table.map((row) => `<w:tr>${row.map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`).join('');
  return makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`,
    ...extraEntries,
  });
}

/** Real XLSX; cells are keyed by A1 address, values may be {formula, result}. */
export async function makeXlsx({ sheets = [{ name: 'Sheet1', cells: { A1: 'Synthetic policy' } }] } = {}) {
  const workbook = new ExcelJS.Workbook();
  for (const { name, cells } of sheets) {
    const sheet = workbook.addWorksheet(name);
    for (const [address, value] of Object.entries(cells)) sheet.getCell(address).value = value;
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const md5 = (data) => createHash('md5').update(data).digest();
function rc4(key, bytes) {
  const state = Uint8Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) { j = (j + state[i] + key[i % key.length]) & 255; [state[i], state[j]] = [state[j], state[i]]; }
  const output = Buffer.alloc(bytes.length);
  let i = 0;
  j = 0;
  for (let n = 0; n < bytes.length; n += 1) { i = (i + 1) & 255; j = (j + state[i]) & 255; [state[i], state[j]] = [state[j], state[i]]; output[n] = bytes[n] ^ state[(state[i] + state[j]) & 255]; }
  return output;
}

/** Real PDF: Unicode text maps through a Type0/CID font; optional password uses PDF R2 encryption. */
export function makePdf({ pages = ['Synthetic policy'], password } = {}) {
  const unicode = pages.some((text) => /[^\x00-\x7f]/.test(text));
  const descendantId = 4 + pages.length * 2;
  const cmapId = descendantId + 1;
  const descriptorId = descendantId + 2;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`, unicode ? `<< /Type /Font /Subtype /Type0 /BaseFont /Synthetic /Encoding /Identity-H /DescendantFonts [${descendantId} 0 R] /ToUnicode ${cmapId} 0 R >>` : '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const streams = new Map();
  for (const text of pages) {
    const escaped = String(text).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
    const hexText = Buffer.from(String(text), 'utf16le').swap16().toString('hex');
    const stream = text ? `BT /F1 12 Tf 50 700 Td ${unicode ? `<${hexText}>` : `(${escaped})`} Tj ET` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`);
    streams.set(objects.length + 1, Buffer.from(stream));
    objects.push(null);
  }
  if (unicode) {
    objects.push(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Synthetic /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /CIDToGIDMap /Identity /FontDescriptor ${descriptorId} 0 R >>`);
    const codes = [...new Set(pages.join('').split(''))].map((char) => char.charCodeAt(0).toString(16).padStart(4, '0'));
    const groups = [];
    for (let i = 0; i < codes.length; i += 100) { const group = codes.slice(i, i + 100); groups.push(`${group.length} beginbfchar\n${group.map((code) => `<${code}> <${code}>`).join('\n')}\nendbfchar`); }
    const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Synthetic-UCS def /CMapType 2 def 1 begincodespacerange <0000> <ffff> endcodespacerange\n${groups.join('\n')}\nendcmap CMapName currentdict /CMap defineresource pop end end`;
    streams.set(cmapId, Buffer.from(cmap));
    objects.push(null, '<< /Type /FontDescriptor /FontName /Synthetic /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>');
  }
  const fileId = md5(Buffer.from('archive-synthetic-pdf'));
  let encryptionKey;
  let encryptionId;
  if (password !== undefined) {
    const padding = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
    const padded = Buffer.concat([Buffer.from(password, 'latin1'), padding]).subarray(0, 32);
    const ownerKey = md5(Buffer.concat([Buffer.from('fixture-owner'), padding]).subarray(0, 32)).subarray(0, 5);
    const owner = rc4(ownerKey, padded);
    const permissions = Buffer.alloc(4); permissions.writeInt32LE(-4);
    encryptionKey = md5(Buffer.concat([padded, owner, permissions, fileId])).subarray(0, 5);
    const user = rc4(encryptionKey, padding);
    encryptionId = objects.length + 1;
    objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString('hex')}> /U <${user.toString('hex')}> /P -4 >>`);
  }
  for (const [id, stream] of streams) {
    const objectRef = Buffer.from([id & 255, (id >> 8) & 255, (id >> 16) & 255, 0, 0]);
    const data = encryptionKey ? rc4(md5(Buffer.concat([encryptionKey, objectRef])).subarray(0, 10), stream) : stream;
    objects[id - 1] = `<< /Length ${data.length} >>\nstream\n${data.toString('latin1')}\nendstream`;
  }
  let output = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output, 'latin1')); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output, 'latin1');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encryptionId ? `/Encrypt ${encryptionId} 0 R /ID [<${fileId.toString('hex')}> <${fileId.toString('hex')}>]` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, 'latin1');
}
