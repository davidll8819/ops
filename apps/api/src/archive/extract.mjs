import path from 'node:path';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import ExcelJS from 'exceljs';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { newRaster, rasterizeImage, renderSize, pdfImageCoverage, assertPdfImagesResolved } from './raster.mjs';
import { OCR_CAUTION, ocrSession } from './ocr.mjs';

const MAX_SOURCE = 6 * 1024 * 1024;
const MAX_EXPANDED = 30 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_TEXT = 200000;
const MAX_BLOCKS = 2000;
const MAX_BLOCK = 2000;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function decodeXml(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function checkXml(bytes) {
  const xml = decodeXml(bytes);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) fail('UNSAFE_XML', '文档包含不安全的 XML 声明，请另存为普通文档后重试。');
  if (XMLValidator.validate(xml) !== true) fail('INVALID_DOCUMENT', '文档 XML 已损坏，请重新保存后上传。');
  return xml;
}

/** Inspect all ZIP entries before an Office reader sees them. Never extract files to disk. */
async function inspectOffice(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(error);
      let count = 0;
      let expanded = 0;
      let actual = 0;
      let settled = false;
      const entries = new Map();
      const abort = (reason) => { if (!settled) { settled = true; zip.close(); reject(reason); } };
      zip.on('error', abort);
      zip.on('end', () => { if (!settled) { settled = true; resolve(entries); } });
      zip.on('entry', (entry) => {
        try {
          count += 1;
          expanded += entry.uncompressedSize;
          if (count > MAX_ENTRIES || expanded > MAX_EXPANDED) fail('ZIP_LIMIT', '压缩文档超过安全限制（最多 2,000 项、展开后 30 MiB），请拆分文件。');
          if (entry.generalPurposeBitFlag & 1) fail('ENCRYPTED_DOCUMENT', '文档受密码保护，请移除密码后重试。');
          if (entries.has(entry.fileName)) fail('INVALID_DOCUMENT', '压缩文档包含重复条目，请重新保存后上传。');
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return abort(streamError);
            const chunks = [];
            let checksum = 0;
            stream.on('data', (chunk) => {
              actual += chunk.length;
              if (actual > MAX_EXPANDED) {
                stream.destroy();
                const limitError = new Error('压缩文档展开后超过 30 MiB，请拆分文件。');
                limitError.code = 'ZIP_LIMIT';
                return abort(limitError);
              }
              checksum = crc32(chunk, checksum);
              chunks.push(chunk);
            });
            stream.on('error', abort);
            stream.on('end', () => {
              try {
                if (checksum !== entry.crc32) fail('INVALID_DOCUMENT', '压缩文档校验失败，请重新保存后上传。');
                const content = Buffer.concat(chunks);
                if (/\.(?:xml|rels)$/i.test(entry.fileName)) checkXml(content);
                entries.set(entry.fileName, content);
                if (!settled) zip.readEntry();
              } catch (reason) { abort(reason); }
            });
          });
        } catch (reason) { abort(reason); }
      });
      zip.readEntry();
    });
  });
}

function checkOfficePackage(entries, kind) {
  const types = entries.get('[Content_Types].xml');
  const relationships = entries.get('_rels/.rels');
  if (!types || !relationships) fail('INVALID_DOCUMENT', '文件不是完整的 Office 文档，请重新保存为 DOCX/XLSX 后上传。');
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, isArray: (name) => name === 'Override' || name === 'Relationship' });
  const declarations = parser.parse(checkXml(types))?.Types?.Override ?? [];
  const links = parser.parse(checkXml(relationships))?.Relationships?.Relationship ?? [];
  const mainPath = kind === 'docx' ? 'word/document.xml' : 'xl/workbook.xml';
  const mainType = kind === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
  const declared = declarations.some((part) => part['@_PartName'] === `/${mainPath}` && part['@_ContentType'] === mainType);
  const linked = links.some((link) => /\/officeDocument$/.test(link['@_Type'] ?? '') && link['@_TargetMode'] !== 'External' && String(link['@_Target'] ?? '').replace(/^\//, '') === mainPath);
  if (!declared || !linked || !entries.has(mainPath)) fail('INVALID_DOCUMENT', 'Office 主文档类型或结构无效，请重新保存为 DOCX/XLSX 后上传。');
}

function collector() {
  const blocks = [];
  let characters = 0;
  return {
    blocks,
    add(location, value, metadata = {}) {
      const text = String(value).replaceAll('\u0000', '').trim();
      if (!text) return;
      characters += text.length;
      if (characters > MAX_TEXT) fail('TEXT_LIMIT', '提取文字超过 200,000 字符，请拆分文件后重试。');
      for (let start = 0; start < text.length;) {
        if (blocks.length >= MAX_BLOCKS) fail('BLOCK_LIMIT', '文档内容超过 2,000 个文字块，请拆分文件后重试。');
        let end = Math.min(start + MAX_BLOCK, text.length);
        const previous = text.charCodeAt(end - 1);
        const next = text.charCodeAt(end);
        if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
        blocks.push({ id: `b${blocks.length + 1}`, location, text: text.slice(start, end), ...metadata });
        start = end;
      }
    },
    stats(extra) { return { ...extra, characters, blocks: blocks.length }; },
  };
}

const nodeKey = (node) => Object.keys(node).find((key) => key !== ':@');
const localName = (key) => key?.split(':').at(-1);
function children(node) { return node[nodeKey(node)] ?? []; }
function wordText(nodes) {
  let text = '';
  for (const node of nodes) {
    const name = localName(nodeKey(node));
    if (name === '#text') text += node['#text'];
    else if (name === 'tab') text += '\t';
    else if (name === 'br' || name === 'cr') text += '\n';
    else if (name !== 'instrText' && name !== 'del' && name !== 'drawing' && name !== 'pict') text += wordText(children(node));
  }
  return text;
}

function extractDocx(entries, output) {
  const bytes = entries.get('word/document.xml');
  if (!bytes) fail('INVALID_DOCUMENT', '文件不是有效的 DOCX 文档，请用 Word 重新保存为 .docx。');
  const xml = checkXml(bytes);
  const parsed = new XMLParser({ preserveOrder: true, ignoreAttributes: false, trimValues: false, parseTagValue: false }).parse(xml);
  const document = parsed.find((node) => localName(nodeKey(node)) === 'document');
  const body = document && children(document).find((node) => localName(nodeKey(node)) === 'body');
  if (!body) fail('INVALID_DOCUMENT', 'DOCX 缺少正文，请重新保存后上传。');
  let paragraphs = 0;
  let tables = 0;
  for (const node of children(body)) {
    const name = localName(nodeKey(node));
    if (name === 'p') output.add(`段落 ${++paragraphs}`, wordText(children(node)));
    if (name === 'tbl') {
      tables += 1;
      let rowNumber = 0;
      for (const row of children(node).filter((child) => localName(nodeKey(child)) === 'tr')) {
        rowNumber += 1;
        const cells = children(row).filter((child) => localName(nodeKey(child)) === 'tc');
        const text = cells.map((cell) => children(cell).filter((child) => localName(nodeKey(child)) === 'p').map((p) => wordText(children(p))).join('\n')).join('\t');
        output.add(`表格 ${tables}，第 ${rowNumber} 行`, text);
      }
    }
  }
  return { warnings: ['仅读取 Word 正文段落和表格；复杂布局、页眉、页脚及图片中的文字未提取，段落编号不代表页码。'], stats: output.stats({ paragraphs, tables }) };
}

function cellText(cell) {
  let value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) value = value.result;
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((run) => run.text).join('');
    return String(value.text ?? value.error ?? '');
  }
  return String(value);
}

async function extractXlsx(bytes, entries, output) {
  if (!entries.has('xl/workbook.xml')) fail('INVALID_DOCUMENT', '文件不是有效的 XLSX 工作簿，请用 Excel 重新保存为 .xlsx。');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  let populatedCells = 0;
  let missingFormulaResults = false;
  for (const sheet of workbook.worksheets) {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      let run = [];
      const flush = () => {
        if (!run.length) return;
        const first = run[0].address;
        const last = run.at(-1).address;
        output.add(`工作表「${sheet.name}」· ${first}${first === last ? '' : `:${last}`}`, run.map(({ address, text }) => `${address}: ${text}`).join('\t'));
        run = [];
      };
      row.eachCell({ includeEmpty: false }, (cell, column) => {
        if (cell.type === ExcelJS.ValueType.Merge) return;
        populatedCells += 1;
        if (populatedCells > 20000) fail('CELL_LIMIT', '工作簿超过 20,000 个非空单元格，请拆分工作簿。');
        const text = cellText(cell);
        if (cell.value && typeof cell.value === 'object' && ('formula' in cell.value || 'sharedFormula' in cell.value) && cell.value.result === undefined) missingFormulaResults = true;
        if (!text.trim()) { flush(); return; }
        if (run.length && run.at(-1).column + 1 !== column) flush();
        run.push({ address: cell.address, column, text });
      });
      flush();
    });
  }
  const warnings = ['公式仅使用文件中保存的计算结果，不重新计算；不执行宏、外部链接或脚本。'];
  if (missingFormulaResults) warnings.push('部分公式没有保存的计算结果，相关单元格无法提取，请在 Excel 中计算并保存后重试。');
  return { warnings, stats: output.stats({ sheets: workbook.worksheets.length, populatedCells }) };
}

async function extractPdf(bytes, output, session, onProgress) {
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) fail('INVALID_DOCUMENT', '文件不是有效的 PDF，请重新导出后上传。');
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true, isEvalSupported: false, enableXfa: false, stopAtErrors: true, maxImageSize: 12000000, verbosity: 0 });
  let pdf;
  const warnings = ['PDF 复杂排版的阅读顺序可能有差异；较小的嵌入图片可能未执行 OCR。'];
  let ocrPages = 0; let rasterPixels = 0;
  try {
    pdf = await loading.promise;
    if (pdf.numPages > 120) fail('PAGE_LIMIT', 'PDF 超过 120 页，请拆分文件后重试。');
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      try {
      await onProgress?.({ stage: 'extracting', page: number, totalPages: pdf.numPages });
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        text += item.str + (item.hasEOL ? '\n' : ' ');
      }
      output.add(`第 ${number} 页`, text);
      const operators = await page.getOperatorList();
      const coverage = pdfImageCoverage(operators, OPS, page.view);
      if (!text.trim() || coverage.images > 0 && (text.replace(/\s/g, '').length < 40 || coverage.ratio >= 0.25)) {
        ocrPages += 1;
        if (ocrPages > 10) fail('OCR_LIMIT', 'PDF 需要 OCR 的页数超过 10 页，请拆分文件或重新扫描后重试。');
        const viewport = page.getViewport({ scale: 1 });
        const size = renderSize(viewport.width, viewport.height, 2);
        rasterPixels += size.width * size.height;
        if (rasterPixels > 50000000) fail('OCR_LIMIT', 'PDF OCR 栅格总量超过 5,000 万像素，请拆分文件或重新扫描后重试。');
        await onProgress?.({ stage: 'ocr', page: number, totalPages: pdf.numPages });
        const raster = newRaster(size.width, size.height);
        let scan;
        try {
          await page.render({ canvasContext: raster.context, viewport: page.getViewport({ scale: size.scale }), background: 'rgb(255,255,255)' }).promise;
          assertPdfImagesResolved(operators, OPS, page);
          scan = raster.canvas.toBuffer('image/png');
        } catch { fail('OCR_FAILED', `第 ${number} 页 OCR 渲染失败，请重新扫描或拆分文件后重试。`); }
        finally { raster.close(); }
        const recognized = await session.recognize(scan, number, `第 ${number} 页（OCR）`, warnings);
        if (!recognized.trim()) warnings.push(`第 ${number} 页未识别到文字，请核对空白或模糊原件。`);
        else if (recognized.replace(/\s/g, '') !== text.replace(/\s/g, '')) output.add(`第 ${number} 页（OCR）`, recognized, { method: 'ocr', page: number });
      } else if (coverage.images) warnings.push(`第 ${number} 页较小的嵌入图片未执行 OCR，请核对原件。`);
      } finally { page.cleanup(); }
    }
    if (!output.blocks.length) fail('NO_TEXT', 'PDF 经 OCR 后仍未识别到文字，请重新扫描清晰原件后上传。');
    if (session.stats) warnings.push(OCR_CAUTION);
    return { warnings, stats: output.stats({ pages: pdf.numPages, ...(session.stats ? { ocr: session.stats } : {}) }) };
  } catch (error) {
    if (error.name === 'PasswordException') fail('ENCRYPTED_DOCUMENT', 'PDF 受密码保护，请移除密码后重试。');
    throw error;
  } finally {
    await loading.destroy();
  }
}

/** Pure bounded extraction: no database, model, network, macros or formula evaluation. */
export async function extractDocument({ name, bytes, onProgress }, { createRecognizer } = {}) {
  const extension = path.extname(String(name ?? '')).slice(1).toLowerCase();
  const kind = ['png', 'jpg', 'jpeg', 'webp'].includes(extension) ? 'image' : extension;
  if (!['docx', 'pdf', 'xlsx', 'image'].includes(kind)) fail('UNSUPPORTED_FORMAT', '仅支持 DOCX、PDF、XLSX、PNG、JPEG 和 WebP；旧版 DOC/XLS 请另存为 DOCX/XLSX 后上传。');
  if (!(bytes instanceof Uint8Array) || !bytes.length) fail('INVALID_DOCUMENT', '文件内容为空或无效，请重新上传。');
  if (bytes.length > MAX_SOURCE) fail('SOURCE_LIMIT', '文件超过 6 MiB，请压缩或拆分后上传。');
  bytes = Buffer.from(bytes);
  if (kind !== 'pdf' && bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) fail('ENCRYPTED_DOCUMENT', 'Office 文档受密码保护或为旧版格式，请移除密码并另存为 DOCX/XLSX。');
  const output = collector();
  const session = ocrSession(createRecognizer);
  try {
    let result;
    if (kind === 'pdf') result = await extractPdf(bytes, output, session, onProgress);
    else if (kind === 'image') {
      await onProgress?.({ stage: 'extracting', page: 1, totalPages: 1 });
      const raster = await rasterizeImage(bytes, extension);
      await onProgress?.({ stage: 'ocr', page: 1, totalPages: 1 });
      const warnings = [OCR_CAUTION];
      output.add('图片第 1 页（OCR）', await session.recognize(raster, 1, '图片第 1 页（OCR）', warnings), { method: 'ocr', page: 1 });
      result = { warnings, stats: output.stats({ pages: 1, ocr: session.stats }) };
    }
    else {
      await onProgress?.({ stage: 'extracting', page: 1, totalPages: 1 });
      const entries = await inspectOffice(bytes);
      checkOfficePackage(entries, kind);
      result = kind === 'docx' ? extractDocx(entries, output) : await extractXlsx(bytes, entries, output);
    }
    if (!output.blocks.length) fail('NO_TEXT', '文档没有可提取或 OCR 识别的文字，请检查内容或重新扫描清晰原件后重试。');
    return { kind, blocks: output.blocks, warnings: result.warnings, stats: result.stats };
  } catch (error) {
    if (typeof error.code === 'string' && ['ZIP_LIMIT', 'ENCRYPTED_DOCUMENT', 'INVALID_DOCUMENT', 'UNSAFE_XML', 'TEXT_LIMIT', 'BLOCK_LIMIT', 'CELL_LIMIT', 'PAGE_LIMIT', 'NO_TEXT', 'IMAGE_LIMIT', 'ANIMATED_IMAGE', 'OCR_FAILED', 'OCR_LIMIT'].includes(error.code)) throw error;
    fail('INVALID_DOCUMENT', '文档已损坏或格式不受支持，请重新保存为 DOCX、PDF、XLSX 或静态图片后重试。');
  } finally { await session.close(); }
}
