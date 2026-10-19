import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setup, ready } from './helpers/archive-api-fixture.mjs'
const search = await import('../apps/api/src/archive/search.mjs').catch(() => ({}))
const chat = '/departments/archive/chat'
async function archive(
  h,
  {
    name = '内部手册.docx',
    paragraphs = ['借阅期限为9天。', '保密资料须经部门主管批准。'],
    archived = true,
  } = {},
) {
  const fileId = await ready(h, name, paragraphs)
  h.setAnswer((body) => {
    const s = JSON.parse(body.messages.at(-1).content).sources[0]
    return JSON.stringify({
      title: '内部操作手册',
      department: '资料室',
      category: '制度流程',
      tags: ['内部'],
      reason: '规定内部流程。',
      needsReview: false,
      citations: [{ sourceId: s.sourceId, quote: s.text }],
    })
  })
  const s = (await h.request('POST', `/archive/documents/${fileId}/filing`, {})).json().suggestion
  assert.ok(s)
  const draft = await h.request('POST', `/archive/filings/${s.id}/record`, {
    revision: 0,
    metadata: {
      title: '内部操作手册',
      department: '资料室',
      category: '制度流程',
      tags: ['内部'],
      note: '',
    },
  })
  assert.equal(draft.statusCode, 200, draft.body)
  const r = draft.json().record
  if (archived) {
    const c = await h.request('POST', `/archive/records/${r.id}/confirm`, { revision: 1 })
    assert.equal(c.statusCode, 200, c.body)
  }
  return { ...r, fileId }
}
function answer(body) {
  const content = JSON.parse(body.messages.at(-1).content),
    s = content.sources.find((s) => s.text.includes('9天')) || content.sources[0]
  return JSON.stringify({
    claims: [{ text: '借阅期限为9天。', citations: [{ sourceId: s.sourceId, quote: s.text }] }],
    notFound: false,
  })
}
test('archived context has bounded keywords and server archival citation identity, partial/OCR scope', () => {
  assert.equal(typeof search.archiveQueryTerms, 'function')
  assert.ok(
    search
      .archiveQueryTerms('请帮我查询已归档资料借阅期限 ZL-2026-000002')
      .includes('zl-2026-000002'),
  )
  assert.ok(search.archiveQueryTerms('借阅期限'.repeat(2000)).length <= 32)
  assert.deepEqual(search.archiveQueryTerms('%_'), [])
  const documents = [
    {
      fileId: randomUUID(),
      name: '扫描.pdf',
      extractionId: randomUUID(),
      sha256: 'a'.repeat(64),
      kind: 'pdf',
      ocr: true,
      blocks: Array.from({ length: 40 }, (_, i) => ({
        id: 'p' + i,
        location: '第' + (i + 1) + '页',
        text: '借阅期限为9天。',
        method: 'ocr',
        page: i + 1,
      })),
      warnings: ['OCR需要核对原件。'],
      archive: { id: randomUUID(), archiveNumber: 'ZL-2026-000002', filename: '正式扫描.pdf' },
    },
  ]
  const context = search.buildArchivedContext({
    documents,
    reference: { query: '借阅期限', matchedCount: 7, records: [] },
  })
  assert.ok(context.sources.length <= 32)
  assert.match(context.documentCoverage, /7/)
  assert.match(context.documentCoverage, /OCR/)
  assert.match(context.documentCoverage, /部分/)
  assert.equal(context.sources[0].archiveNumber, 'ZL-2026-000002')
})
test('archive chat retrieves body-only keywords in formal private documents and saves verifiable archival citations', async () => {
  const h = await setup()
  try {
    const r = await archive(h)
    await archive(h, { name: '未确认.docx', paragraphs: ['借阅期限为99天。'], archived: false })
    await ready(h, '未归档.docx', ['借阅期限为999天。'])
    h.setAnswer(answer)
    const before = h.requests.length
    const response = await h.request('POST', chat, {
      text: '借阅期限是多少？',
      revision: 0,
      archiveSearch: true,
    })
    assert.equal(response.statusCode, 200, response.body)
    const saved = response.json()
    assert.equal(saved.revision, 1)
    const a = saved.messages.at(-1),
      u = saved.messages.at(-2)
    assert.match(a.text, /9天/)
    assert.equal(a.archiveSearch.records.length, 1)
    assert.equal(u.archiveSearch.records[0].id, r.id)
    assert.equal(a.citations[0].archiveRecordId, r.id)
    assert.equal(a.citations[0].archiveNumber, r.archiveNumber)
    assert.equal(a.citations[0].fileId, r.fileId)
    assert.equal(a.citations[0].quote, '借阅期限为9天。')
    assert.equal(u.files, undefined)
    assert.equal(h.requests.length, before + 1)
    const payload = JSON.parse(h.requests.at(-1).messages.at(-1).content)
    assert.equal(payload.sources.length, 2)
    assert.ok(payload.sources.every((s) => s.archiveNumber === r.archiveNumber))
    assert.ok(!JSON.stringify(payload).includes('99天'))
    assert.deepEqual((await h.request('GET', '/departments/archive/conversation')).json(), saved)
  } finally {
    await h.close()
  }
})
test('no-hit and other users/tenants never call model, drafts or previous answers cannot fabricate sources', async () => {
  const h = await setup()
  try {
    await archive(h)
    h.setAnswer(answer)
    assert.equal(
      (await h.request('POST', chat, { text: '借阅期限', revision: 0, archiveSearch: true }))
        .statusCode,
      200,
    )
    const before = h.requests.length
    await h.query('DELETE FROM operations_settings WHERE tenant_id=$1', [h.tenant])
    for (const [text, revision, user] of [
      ['火星轨道ZXQ889', 1, h.alice],
      ['借阅期限', 0, h.bob],
      ['%_', 2, h.alice],
    ]) {
      const r = await h.request('POST', chat, { text, revision, archiveSearch: true }, user)
      assert.equal(r.statusCode, 200, r.body)
      assert.equal(r.json().messages.at(-1).archiveSearch.records.length, 0)
      assert.equal(r.json().messages.at(-1).citations.length, 0)
      assert.match(r.json().messages.at(-1).text, /未找到/)
    }
    const other = await h.request('POST', `/api/tenants/${h.other}${chat}`, {
      text: '借阅期限',
      revision: 0,
      archiveSearch: true,
    })
    assert.equal(other.statusCode, 200, other.body)
    assert.equal(other.json().messages.at(-1).archiveSearch.records.length, 0)
    assert.equal(h.requests.length, before)
  } finally {
    await h.close()
  }
})
test('archive scope rejects incompatible requests, forged quotes and post-provider source drift without saved false answer', async () => {
  const h = await setup()
  try {
    const r = await archive(h),
      before = h.requests.length
    for (const extra of [
      { fileIds: [] },
      { comparisonId: randomUUID() },
      { projectId: randomUUID() },
      { execute: true },
      { image: 'data:image/png;base64,QQ==' },
    ])
      assert.equal(
        (
          await h.request('POST', chat, {
            text: '借阅期限',
            revision: 0,
            archiveSearch: true,
            ...extra,
          })
        ).statusCode,
        400,
      )
    assert.equal(
      (
        await h.request('POST', '/departments/design/chat', {
          text: '借阅期限',
          revision: 0,
          archiveSearch: true,
        })
      ).statusCode,
      400,
    )
    assert.equal(h.requests.length, before)
    h.setAnswer(() =>
      JSON.stringify({
        claims: [{ text: '伪造判断', citations: [{ sourceId: 'd1b1', quote: '伪造引文' }] }],
        notFound: false,
      }),
    )
    assert.equal(
      (await h.request('POST', chat, { text: '借阅期限', revision: 0, archiveSearch: true }))
        .statusCode,
      502,
    )
    assert.equal((await h.request('GET', '/departments/archive/conversation')).json().revision, 0)
    h.setAnswer(async (body) => {
      await h.query('UPDATE workspace_files SET data=$2 WHERE id=$1', [
        r.fileId,
        Buffer.from('changed'),
      ])
      return answer(body)
    })
    assert.equal(
      (await h.request('POST', chat, { text: '借阅期限', revision: 0, archiveSearch: true }))
        .statusCode,
      409,
    )
    assert.equal((await h.request('GET', '/departments/archive/conversation')).json().revision, 0)
    assert.equal(
      (await h.request('POST', chat, { text: '借阅期限', revision: 0, archiveSearch: true }))
        .statusCode,
      409,
    )
  } finally {
    await h.close()
  }
})
test('retrieval limits matches to four documents with honest count and rejects obsolete conversation revision before provider', async () => {
  const h = await setup()
  try {
    const records = []
    for (let i = 0; i < 5; i++) records.push(await archive(h, { name: `手册${i}.docx` }))
    h.setAnswer(answer)
    const before = h.requests.length
    const r = await h.request('POST', chat, { text: '借阅期限', revision: 0, archiveSearch: true })
    assert.equal(r.statusCode, 200, r.body)
    const a = r.json().messages.at(-1)
    assert.equal(a.archiveSearch.matchedCount, 5)
    assert.equal(a.archiveSearch.records.length, 4)
    assert.match(a.documentCoverage, /4/)
    assert.match(a.documentCoverage, /5/)
    assert.equal(
      (await h.request('POST', chat, { text: '借阅期限', revision: 0, archiveSearch: true }))
        .statusCode,
      409,
    )
    assert.equal(h.requests.length, before + 1)
    const exact = await h.request('POST', chat, {
      text: `请从档案 ${records[1].archiveNumber} 回答借阅期限`,
      revision: 1,
      archiveSearch: true,
    })
    assert.equal(exact.statusCode, 200, exact.body)
    assert.equal(exact.json().messages.at(-1).archiveSearch.records.length, 1)
    assert.equal(exact.json().messages.at(-1).archiveSearch.records[0].id, records[1].id)
  } finally {
    await h.close()
  }
})
