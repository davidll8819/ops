import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDocumentContext, validateGroundedAnswer } from '../apps/api/src/archive/context.mjs'
const doc = (id, blocks) => ({
  fileId: id,
  name: `${id}.docx`,
  extractionId: `ex-${id}`,
  sha256: 'a'.repeat(64),
  blocks,
})
const block = (id, text) => ({ id, location: `正文段落 ${id}`, text })
test('short selected documents retain all excerpts and server source identities', () => {
  const context = buildDocumentContext(
    [doc('a', [block('1', '销售金额为 180 万元。')]), doc('b', [block('2', '交货日期为十月。')])],
    { question: '金额' },
  )
  assert.equal(context.sources.length, 2)
  assert.equal(context.documentCoverage, undefined)
  const answer = validateGroundedAnswer(
    JSON.stringify({
      claims: [
        {
          text: '销售金额为180万元。',
          citations: [{ sourceId: context.sources[0].sourceId, quote: '销售金额为 180 万元。' }],
        },
      ],
      notFound: false,
    }),
    context,
  )
  assert.equal(answer.citations[0].filename, 'a.docx')
  assert.equal(answer.citations[0].location, '正文段落 1')
  assert.equal(answer.citations[0].id, '1')
  assert.match(answer.text, /\[1\]/)
})
test('long Chinese follow-up retrieval balances files within 24000 characters and 32 blocks', () => {
  const docs = ['a', 'b', 'c', 'd'].map((id) =>
    doc(
      id,
      Array.from({ length: 40 }, (_, i) =>
        block(
          String(i),
          i === 39
            ? '蓝海项目的金额为900万元。' + '资'.repeat(1800)
            : '常规记录。' + '料'.repeat(1800),
        ),
      ),
    ),
  )
  const context = buildDocumentContext(docs, {
    question: '它的金额呢？',
    history: [{ role: 'user', text: '蓝海项目的情况' }],
  })
  assert.ok(context.documentCoverage)
  assert.ok(context.sources.reduce((n, s) => n + s.text.length, 0) <= 24000)
  assert.ok(context.sources.length <= 32)
  for (const id of ['a', 'b', 'c', 'd'])
    assert.ok(context.sources.some((s) => s.fileId === id && s.text.includes('蓝海')))
})
test('fabricated quotes, source identities, uncited claims and malformed answers fail closed', () => {
  const context = buildDocumentContext([doc('a', [block('1', '金额为180万元。')])], {
    question: '金额',
  })
  for (const value of [
    {
      claims: [{ text: '金额', citations: [{ sourceId: 'fake', quote: '金额' }] }],
      notFound: false,
    },
    {
      claims: [
        { text: '金额', citations: [{ sourceId: context.sources[0].sourceId, quote: '900万元' }] },
      ],
      notFound: false,
    },
    { claims: [{ text: '金额', citations: [] }], notFound: false },
    { claims: [], notFound: false },
    { claims: [], notFound: true, extra: 'fake' },
  ])
    assert.throws(() => validateGroundedAnswer(JSON.stringify(value), context), { statusCode: 502 })
  assert.throws(() => validateGroundedAnswer('```json\n{}\n```', context), { statusCode: 502 })
})
test('notFound emits only a fixed honest excerpt-limited reply; normalized quotes save original excerpt', () => {
  const context = buildDocumentContext([doc('a', [block('1', '销售金额为  180\n万元。')])], {
    question: '金额',
  })
  const missing = validateGroundedAnswer('{"claims":[],"notFound":true}', context)
  assert.equal(
    missing.text,
    '在本轮提供的文档摘录中未找到答案。你可以换个问法，或查看原文后缩小问题范围。',
  )
  assert.deepEqual(missing.citations, [])
  const answer = validateGroundedAnswer(
    JSON.stringify({
      claims: [
        { text: '金额', citations: [{ sourceId: context.sources[0].sourceId, quote: '180 万元' }] },
      ],
      notFound: false,
    }),
    context,
  )
  assert.equal(answer.citations[0].quote, '180\n万元')
})

test('one enclosing JSON Markdown fence preserves validated claim citations', () => {
  const context = buildDocumentContext([doc('a', [block('1', '预算为180万元。')])], {
    question: '预算',
  })
  const payload = JSON.stringify({
    claims: [{ text: '预算为180万元。', citations: [{ sourceId: 'd1b1', quote: '180万元' }] }],
    notFound: false,
  })
  for (const response of [
    payload,
    '```json\n' + payload + '\n```',
    ' \n```json\r\n' + payload + '\r\n```\n ',
  ]) {
    const answer = validateGroundedAnswer(response, context)
    assert.equal(answer.text, '预算为180万元。 [1]')
    assert.equal(answer.citations.length, 1)
    assert.equal(answer.citations[0].fileId, 'a')
    assert.equal(answer.citations[0].quote, '180万元')
    assert.equal(answer.citations[0].location, '正文段落 1')
  }
})

test('JSON fencing never permits prose extraction, multiple fences or unverified evidence', () => {
  const context = buildDocumentContext([doc('a', [block('1', '预算为180万元。')])], {
    question: '预算',
  })
  const missing = '{"claims":[],"notFound":true}'
  const fenced = '```json\n' + missing + '\n```'
  for (const response of [
    '以下是回答：\n' + fenced,
    fenced + '\n回答结束。',
    fenced + '\n' + fenced,
    '```\n' + missing + '\n```',
    '```text\n' + missing + '\n```',
    '```json\n' + missing + '\n',
    '```json\n{"claims":[],"notFound":true,"extra":"unsafe"}\n```',
    '```json\n' +
      JSON.stringify({
        claims: [{ text: '预算', citations: [{ sourceId: 'fake', quote: '180万元' }] }],
        notFound: false,
      }) +
      '\n```',
    '```json\n' +
      JSON.stringify({
        claims: [{ text: '预算', citations: [{ sourceId: 'd1b1', quote: '999万元' }] }],
        notFound: false,
      }) +
      '\n```',
    '```json\n' +
      JSON.stringify({ claims: [{ text: '预算', citations: [] }], notFound: false }) +
      '\n```',
  ]) {
    assert.throws(() => validateGroundedAnswer(response, context), { statusCode: 502 })
  }
})
