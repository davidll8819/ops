import test from 'node:test';
import assert from 'node:assert/strict';

let compareDocumentText;
try { ({ compareDocumentText } = await import('../apps/api/src/archive/compare.mjs')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const document = (texts, prefix = 'b') => ({ blocks: texts.map((text, i) => ({ id: `${prefix}${i + 1}`, location: `段落 ${i + 1}`, text })) });
const reconstructed = (result, side) => result.hunks.flatMap((hunk) => hunk[side] ? [hunk[side].text] : []);
function assertSegments(result) {
  for (const hunk of result.hunks) {
    for (const side of ['old', 'new']) {
      assert.equal(hunk[`${side}Segments`].map(({ text }) => text).join(''), hunk[side]?.text ?? '');
      assert.ok(hunk[`${side}Segments`].every(({ text, changed }) => typeof text === 'string' && typeof changed === 'boolean'));
      if (!hunk[side]) assert.deepEqual(hunk[`${side}Segments`], []);
    }
  }
}

test('exports the document comparison entry point', () => {
  assert.equal(typeof compareDocumentText, 'function', 'compareDocumentText must be exported');
});

test('identical extracted text keeps actual identities and the precise no-change meaning', () => {
  const oldDocument = document(['采购制度', '金额 100 元']);
  const newDocument = document(['采购制度', '金额 100 元'], 'new');
  newDocument.blocks[0] = { ...newDocument.blocks[0], location: '第 3 页', method: 'ocr', page: 3 };
  const before = structuredClone([oldDocument, newDocument]);
  const result = compareDocumentText(oldDocument, newDocument);
  assert.equal(result.algorithmVersion, 'text-diff-1');
  assert.deepEqual(result.stats, { added: 0, removed: 0, modified: 0, unchanged: 2 });
  assert.equal(result.overview, '已提取文字未发现变化');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.hunks[0], {
    id: 'h1', type: 'equal', granularity: 'inline',
    old: { blockId: 'b1', location: '段落 1', text: '采购制度' },
    new: { blockId: 'new1', location: '第 3 页', text: '采购制度', method: 'ocr', page: 3 },
    oldSegments: [{ text: '采购制度', changed: false }], newSegments: [{ text: '采购制度', changed: false }],
  });
  assert.deepEqual([oldDocument, newDocument], before);
  assertSegments(result);
});

test('an inserted paragraph does not modify all later renumbered paragraphs', () => {
  const result = compareDocumentText(document(['第一段', '第二段', '第三段']), document(['插入段', '第一段', '第二段', '第三段']));
  assert.deepEqual(result.stats, { added: 1, removed: 0, modified: 0, unchanged: 3 });
  assert.deepEqual(result.hunks.map(({ type, old, new: next }) => [type, old?.blockId ?? null, next?.blockId ?? null]), [
    ['added', null, 'b1'], ['equal', 'b1', 'b2'], ['equal', 'b2', 'b3'], ['equal', 'b3', 'b4'],
  ]);
  assertSegments(result);
});

test('repeated paragraphs use stable exact LCS ties and retain every block', () => {
  const oldDocument = document(['A', 'B', 'A']);
  const newDocument = document(['B', 'A', 'B']);
  const result = compareDocumentText(oldDocument, newDocument);
  assert.deepEqual(result.hunks.map(({ type, old, new: next }) => [type, old?.blockId ?? null, next?.blockId ?? null]), [
    ['removed', 'b1', null], ['equal', 'b2', 'b1'], ['equal', 'b3', 'b2'], ['added', null, 'b3'],
  ]);
  assert.deepEqual(compareDocumentText(oldDocument, newDocument), result);
  assert.deepEqual(reconstructed(result, 'old'), ['A', 'B', 'A']);
  assert.deepEqual(reconstructed(result, 'new'), ['B', 'A', 'B']);
  assertSegments(result);
});

test('ordered unmatched runs become modifications then residual additions or removals', () => {
  const oldDocument = document(['keep', 'old one', 'old two', 'end']);
  const newDocument = document(['keep', 'new one', 'new two', 'extra', 'end']);
  const result = compareDocumentText(oldDocument, newDocument);
  assert.deepEqual(result.stats, { added: 1, removed: 0, modified: 2, unchanged: 2 });
  assert.deepEqual(result.hunks.map(({ id, type }) => [id, type]), [['h1', 'equal'], ['h2', 'modified'], ['h3', 'modified'], ['h4', 'added'], ['h5', 'equal']]);
  assert.match(result.overview, /新增.*1.*删除.*0.*修改.*2/);
  const reverse = compareDocumentText(newDocument, oldDocument);
  assert.deepEqual(reverse.stats, { added: 0, removed: 1, modified: 2, unchanged: 2 });
  assert.deepEqual(reconstructed(result, 'old'), oldDocument.blocks.map(({ text }) => text));
  assert.deepEqual(reconstructed(result, 'new'), newDocument.blocks.map(({ text }) => text));
  assertSegments(result);
  assertSegments(reverse);
});

test('empty documents and entirely added or removed blocks retain exact whitespace', () => {
  const empty = document([]);
  assert.deepEqual(compareDocumentText(empty, empty).stats, { added: 0, removed: 0, modified: 0, unchanged: 0 });
  const changed = document([' ', '\n\t', '']);
  for (const [oldDocument, newDocument, type, side] of [[empty, changed, 'added', 'new'], [changed, empty, 'removed', 'old']]) {
    const result = compareDocumentText(oldDocument, newDocument);
    assert.ok(result.hunks.every((hunk) => hunk.type === type));
    assert.deepEqual(reconstructed(result, side), [' ', '\n\t', '']);
    assertSegments(result);
  }
});

test('Chinese, emoji ZWJ sequences and combining marks are highlighted as whole graphemes', () => {
  const result = compareDocumentText(document(['甲👩‍💻e\u0301乙']), document(['甲👩‍🔬e\u0300乙']));
  assert.deepEqual(result.hunks[0].oldSegments, [{ text: '甲', changed: false }, { text: '👩‍💻e\u0301', changed: true }, { text: '乙', changed: false }]);
  assert.deepEqual(result.hunks[0].newSegments, [{ text: '甲', changed: false }, { text: '👩‍🔬e\u0300', changed: true }, { text: '乙', changed: false }]);
  assertSegments(result);
});

test('inline LCS preserves a shared interior and exact whitespace changes', () => {
  const result = compareDocumentText(document(['a X b\nold Z']), document(['a  Y b\nnew Z']));
  assert.equal(result.hunks[0].type, 'modified');
  assert.ok(result.hunks[0].oldSegments.some(({ text, changed }) => !changed && text.includes(' b\n')));
  assert.ok(result.hunks[0].newSegments.some(({ text, changed }) => changed && text.includes('Y')));
  assertSegments(result);
  assert.equal(compareDocumentText(document(['é']), document(['e\u0301'])).stats.modified, 1);
});

test('inline budget fallback retains long completely different paragraphs in full', () => {
  const result = compareDocumentText(document(['甲'.repeat(2000)]), document(['乙'.repeat(2000)]));
  const hunk = result.hunks[0];
  assert.equal(hunk.granularity, 'block');
  assert.deepEqual(hunk.oldSegments, [{ text: '甲'.repeat(2000), changed: true }]);
  assert.deepEqual(hunk.newSegments, [{ text: '乙'.repeat(2000), changed: true }]);
  assert.match(result.warnings.join(' '), /整块|块级/);
  assertSegments(result);
});

test('the inline cell budget is shared across the entire comparison', () => {
  const result = compareDocumentText(document(['甲'.repeat(1000), '丙'.repeat(1000), '戊'.repeat(1000)]), document(['乙'.repeat(1000), '丁'.repeat(1000), '己'.repeat(1000)]));
  assert.deepEqual(result.hunks.map(({ granularity }) => granularity), ['inline', 'inline', 'block']);
  assertSegments(result);
});

test('common prefix and suffix stripping avoids unnecessary inline fallback', () => {
  const result = compareDocumentText(document(['甲'.repeat(990) + '旧'.repeat(20) + '末'.repeat(990)]), document(['甲'.repeat(990) + '新'.repeat(20) + '末'.repeat(990)]));
  assert.equal(result.hunks[0].granularity, 'inline');
  assert.deepEqual(result.hunks[0].oldSegments.filter(({ changed }) => changed), [{ text: '旧'.repeat(20), changed: true }]);
  assert.deepEqual(result.warnings, []);
  assertSegments(result);
});

test('the full 2000 by 2000 block LCS preserves exact matches at the limits', () => {
  const texts = Array.from({ length: 2000 }, (_, i) => `段落${i}`);
  const result = compareDocumentText(document(texts), document(['插入', ...texts.slice(0, -1)]));
  assert.deepEqual(result.stats, { added: 1, removed: 1, modified: 0, unchanged: 1999 });
  assert.equal(result.hunks.length, 2001);
  assertSegments(result);
});

test('the full 200000 character source is accepted without truncation', () => {
  const source = document(Array(100).fill('字'.repeat(2000)));
  const result = compareDocumentText(source, source);
  assert.deepEqual(result.stats, { added: 0, removed: 0, modified: 0, unchanged: 100 });
  assert.equal(reconstructed(result, 'old').join('').length, 200000);
});

test('rejects malformed sources and bounds before allocating comparison matrices', () => {
  const valid = document(['safe']);
  const invalid = [null, {}, { blocks: {} }, { blocks: [null] }, { blocks: [{ id: 'x', location: 'p', text: 3 }] }, { blocks: [{ id: 'x', location: {}, text: 'x' }] }, { blocks: [{ id: 'x', location: 'p', text: 'x', method: 'guessed' }] }, { blocks: [{ id: 'x', location: 'p', text: 'x', page: 0 }] }, { blocks: [{ id: 'x', location: 'p', text: 'x' }, { id: 'x', location: 'p2', text: 'y' }] }];
  for (const bad of invalid) assert.throws(() => compareDocumentText(bad, valid), (error) => error.code === 'INVALID_COMPARISON_SOURCE' && error.message.length > 3);
  for (const bad of [document(Array(2001).fill('x')), document(['x'.repeat(2001)]), document([...Array(100).fill('x'.repeat(2000)), 'x']), { blocks: [{ id: 'x', location: 'p'.repeat(6 * 1024 * 1024 + 1), text: 'x' }] }]) {
    assert.throws(() => compareDocumentText(valid, bad), (error) => error.code === 'COMPARISON_LIMIT' && /拆分/.test(error.message));
  }
  let read = false;
  const getterBlock = { id: 'b1', location: 'p', get text() { read = true; return 'x'; } };
  assert.throws(() => compareDocumentText({ blocks: [getterBlock] }, valid), { code: 'INVALID_COMPARISON_SOURCE' });
  assert.equal(read, false, 'non-data source properties must be rejected without evaluating them');
});

test('oversized serialized comparison fails with split-file guidance instead of truncation', () => {
  const source = document(Array(100).fill('x'.repeat(1000)));
  source.blocks.forEach((block) => { block.location = 'p'.repeat(40000); });
  assert.throws(() => compareDocumentText(source, source), (error) => error.code === 'COMPARISON_LIMIT' && /拆分/.test(error.message));
});
