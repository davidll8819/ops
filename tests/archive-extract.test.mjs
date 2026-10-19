import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { extractDocument } from '../apps/api/src/archive/extract.mjs';
import { makeDocx, makePdf, makeXlsx, makeZip } from './helpers/archive-fixtures.mjs';

const rejectCode = (promise, code) => assert.rejects(promise, (error) => error.code === code && error.message.length > 3 && !error.message.includes('node_modules'));

test('DOCX retains body paragraph and table-row locations, with deterministic block IDs', async () => {
  const bytes = await makeDocx({ paragraphs: ['采购制度', '十万元以上需审批'], tables: [[['项目', '金额'], ['设备', '120000']]] });
  const result = await extractDocument({ name: 'policy.docx', bytes });
  assert.equal(result.kind, 'docx');
  assert.deepEqual(result.blocks.map(({ location, text }) => ({ location, text })), [
    { location: '段落 1', text: '采购制度' }, { location: '段落 2', text: '十万元以上需审批' },
    { location: '表格 1，第 1 行', text: '项目\t金额' }, { location: '表格 1，第 2 行', text: '设备\t120000' },
  ]);
  assert.deepEqual((await extractDocument({ name: 'policy.docx', bytes })).blocks, result.blocks);
  assert.match(result.warnings.join(' '), /页眉|页脚|图片/);
});

test('text PDFs retain actual page numbers', async () => {
  const result = await extractDocument({ name: 'minutes.pdf', bytes: makePdf({ pages: ['First page approval', 'Second page budget 2400'] }) });
  assert.deepEqual(result.blocks.map(({ location, text }) => ({ location, text })), [{ location: '第 1 页', text: 'First page approval' }, { location: '第 2 页', text: 'Second page budget 2400' }]);
});

test('Unicode PDF CMaps preserve Chinese source excerpts on each page', async () => {
  const result = await extractDocument({ name: '采购.pdf', bytes: makePdf({ pages: ['采购上限十万元', '预算2400元'] }) });
  assert.deepEqual(result.blocks.map(({ location, text }) => ({ location, text })), [{ location: '第 1 页', text: '采购上限十万元' }, { location: '第 2 页', text: '预算2400元' }]);
});

test('XLSX preserves discontiguous row and cell positions, multiple sheets and cached formula results', async () => {
  const bytes = await makeXlsx({ sheets: [{ name: '预算', cells: { A1: '部门', C1: '金额', C7: 2400, D7: { formula: '1200*2', result: 2400 } } }, { name: 'Q2', cells: { B3: 'approved' } }] });
  const result = await extractDocument({ name: 'budget.xlsx', bytes });
  assert.deepEqual(result.blocks.map(({ location, text }) => ({ location, text })), [
    { location: '工作表「预算」· A1', text: 'A1: 部门' }, { location: '工作表「预算」· C1', text: 'C1: 金额' },
    { location: '工作表「预算」· C7:D7', text: 'C7: 2400\tD7: 2400' }, { location: '工作表「Q2」· B3', text: 'B3: approved' },
  ]);
  assert.match(result.warnings.join(' '), /不重新计算/);
});

test('long locations split into bounded blocks without losing any source text', async () => {
  const text = '字'.repeat(4500);
  const result = await extractDocument({ name: 'long.docx', bytes: await makeDocx({ paragraphs: [text] }) });
  assert.equal(result.blocks.length, 3);
  assert.equal(result.blocks.map((block) => block.text).join(''), text);
  assert.ok(result.blocks.every((block) => block.text.length <= 2000 && block.location === '段落 1'));
  assert.equal(new Set(result.blocks.map((block) => block.id)).size, 3);
});

test('block boundaries preserve supplementary characters through independent UTF-8 and JSON serialization', async () => {
  const text = '字'.repeat(1999) + '😀末';
  const result = await extractDocument({ name: 'unicode-boundary.docx', bytes: await makeDocx({ paragraphs: [text] }) });
  assert.equal(result.blocks.length, 2);
  const utf8Blocks = [];
  const jsonBlocks = [];
  for (const block of result.blocks) {
    assert.ok(block.text.length <= 2000);
    assert.equal(block.location, '段落 1');
    const utf8 = Buffer.from(block.text, 'utf8').toString('utf8');
    const json = JSON.parse(Buffer.from(JSON.stringify(block), 'utf8').toString('utf8')).text;
    assert.equal(utf8, block.text, 'each source block must survive its own UTF-8 encoding');
    assert.equal(json, block.text, 'each source block must survive its own JSON roundtrip');
    assert.ok(block.text.isWellFormed(), 'source blocks must contain no lone surrogates');
    utf8Blocks.push(utf8);
    jsonBlocks.push(json);
  }
  assert.equal(utf8Blocks.join(''), text);
  assert.equal(jsonBlocks.join(''), text);
  assert.equal(result.blocks.map((block) => block.text).join(''), text);
});

test('unsupported legacy formats offer conversion feedback', async () => {
  await assert.rejects(extractDocument({ name: 'old.doc', bytes: Buffer.from('old') }), (error) => error.code === 'UNSUPPORTED_FORMAT' && /DOCX|docx/.test(error.message));
});

test('source size limit rejects oversized bytes before parsing', async () => {
  await rejectCode(extractDocument({ name: 'large.pdf', bytes: Buffer.alloc(6 * 1024 * 1024 + 1) }), 'SOURCE_LIMIT');
});

test('corrupt ZIP and format-signature mismatch fail safely', async () => {
  await rejectCode(extractDocument({ name: 'bad.docx', bytes: Buffer.from('not a zip') }), 'INVALID_DOCUMENT');
  await rejectCode(extractDocument({ name: 'bad.pdf', bytes: await makeDocx() }), 'INVALID_DOCUMENT');
});

test('DTD and entity declarations are rejected before XML parsing', async () => {
  const bytes = await makeZip({ 'word/document.xml': '<!DOCTYPE x [<!ENTITY malicious SYSTEM "file:///etc/passwd">]><w:document><w:body><w:p><w:r><w:t>&malicious;</w:t></w:r></w:p></w:body></w:document>' });
  await rejectCode(extractDocument({ name: 'entity.docx', bytes }), 'UNSAFE_XML');
});

test('ZIP expansion and entry limits reject compressed bombs without truncating', async () => {
  await rejectCode(extractDocument({ name: 'bomb.docx', bytes: await makeZip({ 'word/document.xml': 'x'.repeat(30 * 1024 * 1024 + 1) }) }), 'ZIP_LIMIT');
  const entries = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`entry${i}.xml`, '<x/>']));
  await rejectCode(extractDocument({ name: 'entries.docx', bytes: await makeZip(entries) }), 'ZIP_LIMIT');
});

test('empty PDFs fail clearly after OCR with rescan guidance', async () => {
  await assert.rejects(extractDocument({ name: 'scan.pdf', bytes: makePdf({ pages: [''] }) }), (error) => error.code === 'NO_TEXT' && /OCR/.test(error.message));
});

test('PDF page limit rejects the whole document', async () => {
  await rejectCode(extractDocument({ name: 'pages.pdf', bytes: makePdf({ pages: Array(121).fill('page') }) }), 'PAGE_LIMIT');
});

test('extracted character and block limits reject whole documents', async () => {
  await rejectCode(extractDocument({ name: 'chars.docx', bytes: await makeDocx({ paragraphs: ['字'.repeat(200001)] }) }), 'TEXT_LIMIT');
  await rejectCode(extractDocument({ name: 'blocks.docx', bytes: await makeDocx({ paragraphs: Array(2001).fill('一') }) }), 'BLOCK_LIMIT');
});

test('spreadsheet populated cell limit rejects the whole workbook', async () => {
  const cells = Object.fromEntries(Array.from({ length: 20001 }, (_, i) => [`${String.fromCharCode(65 + i % 26)}${1 + Math.floor(i / 26)}`, 'x']));
  await rejectCode(extractDocument({ name: 'cells.xlsx', bytes: await makeXlsx({ sheets: [{ name: 'limit', cells }] }) }), 'CELL_LIMIT');
});

test('password-protected Office files offer password removal feedback', async () => {
  // Office encryption uses the compound container, not an ordinary OOXML ZIP.
  await rejectCode(extractDocument({ name: 'locked.docx', bytes: Buffer.from('d0cf11e0a1b11ae100000000', 'hex') }), 'ENCRYPTED_DOCUMENT');
  const bytes = await makeDocx();
  // Mark local and central ZIP headers encrypted; no reader may consume the payload.
  for (let i = 0; i < bytes.length - 10; i += 1) {
    const signature = bytes.readUInt32LE(i);
    if (signature === 0x04034b50) bytes.writeUInt16LE(bytes.readUInt16LE(i + 6) | 1, i + 6);
    if (signature === 0x02014b50) bytes.writeUInt16LE(bytes.readUInt16LE(i + 8) | 1, i + 8);
  }
  await rejectCode(extractDocument({ name: 'locked.docx', bytes }), 'ENCRYPTED_DOCUMENT');
});

test('CRC damage fails rather than silently changing extracted source text', async () => {
  const bytes = await makeDocx();
  for (let i = 0; i < bytes.length - 20; i += 1) {
    if (bytes.readUInt32LE(i) === 0x02014b50) { bytes.writeUInt32LE(0, i + 16); break; }
  }
  await rejectCode(extractDocument({ name: 'corrupt.docx', bytes }), 'INVALID_DOCUMENT');
});

test('DTD declarations in non-body Office parts are rejected too', async () => {
  const bytes = await makeZip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>safe body</w:t></w:r></w:p></w:body></w:document>', 'word/footer1.xml': '<!DOCTYPE footer><footer>hidden</footer>' });
  await rejectCode(extractDocument({ name: 'footer.docx', bytes }), 'UNSAFE_XML');
});

test('missing formula caches are disclosed instead of evaluated', async () => {
  const bytes = await makeXlsx({ sheets: [{ name: 'cache', cells: { A1: 'visible', A2: { formula: '1+2' } } }] });
  const result = await extractDocument({ name: 'cache.xlsx', bytes });
  assert.deepEqual(result.blocks.map(({ text }) => text), ['A1: visible']);
  assert.match(result.warnings.join(' '), /没有保存的计算结果/);
});

test('encrypted PDFs offer password removal feedback', async () => {
  await rejectCode(extractDocument({ name: 'locked.pdf', bytes: makePdf({ pages: ['Secret budget'], password: 'fixture-password' }) }), 'ENCRYPTED_DOCUMENT');
});

test('corrupt PDFs fail without exposing parser internals', async () => {
  await rejectCode(extractDocument({ name: 'broken.pdf', bytes: Buffer.from('%PDF-1.7\nbroken') }), 'INVALID_DOCUMENT');
});

test('external Office relationships and formulas are never fetched or evaluated', async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests += 1; response.end('not document evidence'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/external`;
    const docx = await makeDocx({ paragraphs: ['Only saved body'], extraEntries: { 'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" TargetMode="External" Target="${url}"/></Relationships>`, 'word/vbaProject.bin': 'not executed' } });
    const result = await extractDocument({ name: 'linked.docx', bytes: docx });
    assert.deepEqual(result.blocks.map(({ text }) => text), ['Only saved body']);
    const xlsx = await makeXlsx({ sheets: [{ name: 'cached', cells: { A1: { formula: `WEBSERVICE("${url}")`, result: 'saved result' }, A2: { text: 'saved hyperlink label', hyperlink: url } } }] });
    const sheet = await extractDocument({ name: 'linked.xlsx', bytes: xlsx });
    assert.deepEqual(sheet.blocks.map(({ text }) => text), ['A1: saved result', 'A2: saved hyperlink label']);
    assert.equal(requests, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('UTF-16 XML declarations cannot bypass the DTD guard', async () => {
  const xml = '<!DOCTYPE w:document><w:document><w:body/></w:document>';
  const bytes = await makeDocx({ extraEntries: { 'word/document.xml': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]) } });
  await rejectCode(extractDocument({ name: 'utf16.docx', bytes }), 'UNSAFE_XML');
});

test('arbitrary ZIP files cannot impersonate an Office package', async () => {
  const bytes = await makeZip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>not an OPC package</w:t></w:r></w:p></w:body></w:document>' });
  await rejectCode(extractDocument({ name: 'fake.docx', bytes }), 'INVALID_DOCUMENT');
});
