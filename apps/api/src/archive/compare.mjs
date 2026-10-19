const MAX_BLOCKS = 2000;
const MAX_BLOCK_TEXT = 2000;
const MAX_TEXT = 200000;
const MAX_BYTES = 6 * 1024 * 1024;
const INLINE_CELLS = 2000000;
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

const invalid = () => fail('INVALID_COMPARISON_SOURCE', '比对文字块格式无效，请重新上传并提取文档后重试。');
const limit = () => fail('COMPARISON_LIMIT', '文档比对超过安全限制，请拆分文件后重试。');
const plain = (value) => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));

// Accept data, never evaluate getters while validating untrusted stored input.
function data(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value')) invalid();
  return descriptor?.value;
}

function sourceBlocks(document) {
  if (!plain(document)) invalid();
  const blocks = data(document, 'blocks');
  if (!Array.isArray(blocks)) invalid();
  if (blocks.length > MAX_BLOCKS) limit();
  const ids = new Set();
  const sides = [];
  let characters = 0;
  let bytes = 2;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = data(blocks, String(index));
    if (!plain(block)) invalid();
    const id = data(block, 'id');
    const location = data(block, 'location');
    const text = data(block, 'text');
    const method = data(block, 'method');
    const page = data(block, 'page');
    if (typeof id !== 'string' || !id || typeof location !== 'string' || typeof text !== 'string'
      || (method !== undefined && method !== 'ocr')
      || (page !== undefined && (!Number.isSafeInteger(page) || page < 1)) || ids.has(id)) invalid();
    characters += text.length;
    if (text.length > MAX_BLOCK_TEXT || characters > MAX_TEXT || id.length > MAX_BYTES || location.length > MAX_BYTES) limit();
    const side = { blockId: id, location, text };
    if (method !== undefined) side.method = method;
    if (page !== undefined) side.page = page;
    bytes += Buffer.byteLength(JSON.stringify(side), 'utf8') + 1;
    if (bytes > MAX_BYTES) limit();
    ids.add(id);
    sides.push(side);
  }
  return sides;
}

// Exactly rows*columns cells, with implicit zero-valued bottom/right borders.
// Integer IDs keep block equality checks independent of text length.
function lcsTable(oldTokens, newTokens) {
  const rows = oldTokens.length;
  const columns = newTokens.length;
  const table = new Uint16Array(rows * columns);
  for (let oldIndex = rows - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = columns - 1; newIndex >= 0; newIndex -= 1) {
      const offset = oldIndex * columns + newIndex;
      const down = oldIndex + 1 < rows ? table[offset + columns] : 0;
      const right = newIndex + 1 < columns ? table[offset + 1] : 0;
      const diagonal = oldIndex + 1 < rows && newIndex + 1 < columns ? table[offset + columns + 1] : 0;
      table[offset] = oldTokens[oldIndex] === newTokens[newIndex] ? diagonal + 1 : Math.max(down, right);
    }
  }
  return table;
}

function matchedPairs(oldTokens, newTokens) {
  const columns = newTokens.length;
  const table = lcsTable(oldTokens, newTokens);
  const pairs = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldTokens.length && newIndex < columns) {
    if (oldTokens[oldIndex] === newTokens[newIndex]) {
      pairs.push([oldIndex, newIndex]);
      oldIndex += 1;
      newIndex += 1;
    } else {
      const down = oldIndex + 1 < oldTokens.length ? table[(oldIndex + 1) * columns + newIndex] : 0;
      const right = newIndex + 1 < columns ? table[oldIndex * columns + newIndex + 1] : 0;
      // Stable ties consume the old side first, for both block and inline LCS.
      if (down >= right) oldIndex += 1;
      else newIndex += 1;
    }
  }
  return pairs;
}

function append(segments, text, changed) {
  if (!text) return;
  if (segments.at(-1)?.changed === changed) segments.at(-1).text += text;
  else segments.push({ text, changed });
}

function inlineSegments(oldText, newText, budget) {
  const oldTokens = Array.from(graphemes.segment(oldText), ({ segment }) => segment);
  const newTokens = Array.from(graphemes.segment(newText), ({ segment }) => segment);
  let prefix = 0;
  while (prefix < oldTokens.length && prefix < newTokens.length && oldTokens[prefix] === newTokens[prefix]) prefix += 1;
  let oldEnd = oldTokens.length;
  let newEnd = newTokens.length;
  while (oldEnd > prefix && newEnd > prefix && oldTokens[oldEnd - 1] === newTokens[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
  const cells = (oldEnd - prefix) * (newEnd - prefix);
  if (cells > budget.remaining) {
    budget.fallback = true;
    return { granularity: 'block', oldSegments: [{ text: oldText, changed: true }], newSegments: [{ text: newText, changed: true }] };
  }
  budget.remaining -= cells;
  const oldMiddle = oldTokens.slice(prefix, oldEnd);
  const newMiddle = newTokens.slice(prefix, newEnd);
  const matches = matchedPairs(oldMiddle, newMiddle);
  const oldSegments = [];
  const newSegments = [];
  append(oldSegments, oldTokens.slice(0, prefix).join(''), false);
  append(newSegments, newTokens.slice(0, prefix).join(''), false);
  let oldStart = 0;
  let newStart = 0;
  for (const [oldIndex, newIndex] of matches) {
    append(oldSegments, oldMiddle.slice(oldStart, oldIndex).join(''), true);
    append(newSegments, newMiddle.slice(newStart, newIndex).join(''), true);
    append(oldSegments, oldMiddle[oldIndex], false);
    append(newSegments, newMiddle[newIndex], false);
    oldStart = oldIndex + 1;
    newStart = newIndex + 1;
  }
  append(oldSegments, oldMiddle.slice(oldStart).join(''), true);
  append(newSegments, newMiddle.slice(newStart).join(''), true);
  append(oldSegments, oldTokens.slice(oldEnd).join(''), false);
  append(newSegments, newTokens.slice(newEnd).join(''), false);
  return { granularity: 'inline', oldSegments, newSegments };
}

/** Pure bounded diff of complete ready extraction blocks; no storage or model calls. */
export function compareDocumentText(oldDocument, newDocument) {
  // Validate both complete inputs before allocating either LCS matrix.
  const oldBlocks = sourceBlocks(oldDocument);
  const newBlocks = sourceBlocks(newDocument);
  const tokenIds = new Map();
  const token = ({ text }) => {
    if (!tokenIds.has(text)) tokenIds.set(text, tokenIds.size + 1);
    return tokenIds.get(text);
  };
  const matches = matchedPairs(oldBlocks.map(token), newBlocks.map(token));
  const hunks = [];
  const stats = { added: 0, removed: 0, modified: 0, unchanged: 0 };
  const budget = { remaining: INLINE_CELLS, fallback: false };
  function add(type, old, next) {
    const segments = type === 'modified' ? inlineSegments(old.text, next.text, budget) : {
      granularity: type === 'equal' ? 'inline' : 'block',
      oldSegments: old?.text ? [{ text: old.text, changed: type !== 'equal' }] : [],
      newSegments: next?.text ? [{ text: next.text, changed: type !== 'equal' }] : [],
    };
    hunks.push({ id: `h${hunks.length + 1}`, type, ...segments, old, new: next });
    stats[type === 'equal' ? 'unchanged' : type] += 1;
  }
  function unmatched(oldStart, oldEnd, newStart, newEnd) {
    while (oldStart < oldEnd && newStart < newEnd) add('modified', oldBlocks[oldStart++], newBlocks[newStart++]);
    while (oldStart < oldEnd) add('removed', oldBlocks[oldStart++], null);
    while (newStart < newEnd) add('added', null, newBlocks[newStart++]);
  }
  let oldStart = 0;
  let newStart = 0;
  for (const [oldIndex, newIndex] of matches) {
    unmatched(oldStart, oldIndex, newStart, newIndex);
    add('equal', oldBlocks[oldIndex], newBlocks[newIndex]);
    oldStart = oldIndex + 1;
    newStart = newIndex + 1;
  }
  unmatched(oldStart, oldBlocks.length, newStart, newBlocks.length);
  const result = {
    algorithmVersion: 'text-diff-1', stats,
    overview: stats.added + stats.removed + stats.modified === 0 ? '已提取文字未发现变化' : `新增 ${stats.added} 块，删除 ${stats.removed} 块，修改 ${stats.modified} 对，未变化 ${stats.unchanged} 块`,
    warnings: budget.fallback ? ['部分文字超过行内比对预算，已使用整块替换高亮；全部提取文字均已保留。'] : [],
    hunks,
  };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_BYTES) limit();
  return result;
}
