import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setup, ready } from './helpers/archive-api-fixture.mjs'
import { makePdf, makeXlsx } from './helpers/archive-fixtures.mjs'
import { defaultPolicy } from '../apps/api/src/operations/policy.mjs'
import { encryptConfig } from '../apps/api/src/operations/security.mjs'
const filing = await import('../apps/api/src/archive/filing.mjs').catch(() => ({}))
const url = (id) => `/archive/documents/${id}/filing`
const modelAnswer = (body) => {
  const source = JSON.parse(body.messages.at(-1).content).sources[0]
  return JSON.stringify({
    title: '资料借阅制度',
    department: '资料室',
    category: '制度流程',
    tags: ['借阅', '归档'],
    reason: '规定资料借阅和归还流程。',
    needsReview: false,
    citations: [{ sourceId: source.sourceId, quote: source.text }],
  })
}
test('filing contract rejects fabricated evidence/metadata and builds safe server-owned paths', () => {
  assert.equal(typeof filing.buildFilingContext, 'function')
  const doc = {
    fileId: randomUUID(),
    name: '原始.docx',
    extractionId: randomUUID(),
    sha256: 'a'.repeat(64),
    parserVersion: '1',
    kind: 'docx',
    ocr: false,
    blocks: [{ id: 'p1', location: '段落 1', text: '资料借阅须登记。' }],
    warnings: ['正文范围限制'],
  }
  const ctx = filing.buildFilingContext(doc)
  const valid = JSON.parse(modelAnswer({ messages: [{ content: ctx.content }] }))
  const result = filing.validateFilingResponse(JSON.stringify(valid), ctx)
  assert.equal(result.citations[0].fileId, doc.fileId)
  assert.equal(result.citations[0].quote, doc.blocks[0].text)
  for (const bad of [
    { ...valid, citations: [{ sourceId: 'other', quote: '伪造' }] },
    { ...valid, archiveNumber: 'FAKE' },
    { ...valid, department: '../../x' },
    { ...valid, category: '未知类别' },
    { ...valid, tags: ['x'.repeat(21)] },
  ])
    assert.throws(() => filing.validateFilingResponse(JSON.stringify(bad), ctx))
  const built = filing.buildFilingResult(
    { ...result, title: '../CON:<x>\\a\u0000 .' },
    doc,
    'ZL-2026-000001',
    '2026',
  )
  assert.equal(built.directory, '资料室/制度流程/2026')
  assert.ok(!/[<>:"\\|?*\x00-\x1f]/.test(built.recommendedName))
  assert.ok(!built.recommendedName.includes('/'))
  assert.match(built.recommendedName, /_ZL-2026-000001\.docx$/)
  assert.equal(built.relativePath, `${built.directory}/${built.recommendedName}`)
  assert.ok(built.warnings.includes('正文范围限制'))
  const many = {
    ...doc,
    ocr: true,
    blocks: Array.from({ length: 50 }, (_, i) => ({
      id: `b${i}`,
      location: `第${i + 1}页`,
      text: '甲'.repeat(1000),
      method: 'ocr',
      page: i + 1,
    })),
  }
  const bounded = filing.buildFilingContext(many)
  assert.ok(bounded.sources.length <= 32)
  assert.ok(bounded.sources.reduce((n, s) => n + s.text.length, 0) <= 24000)
  assert.match(bounded.documentCoverage, /部分/)
  assert.match(bounded.documentCoverage, /OCR/)
})
test('filing API saves grounded stable recommendations, cached reload and private identity', async () => {
  const h = await setup()
  try {
    const id = await ready(h, '制度.docx', ['资料借阅须登记。'])
    h.setAnswer(modelAnswer)
    assert.equal((await h.request('GET', url(id))).json().suggestion, null)
    const first = await h.request('POST', url(id), {})
    assert.equal(first.statusCode, 200, first.body)
    const s = first.json().suggestion
    assert.equal(s.state, 'ready')
    assert.match(s.archiveNumber, /^ZL-\d{4}-\d{6,}$/)
    assert.equal(s.result.category, '制度流程')
    assert.equal(s.result.citations[0].fileId, id)
    assert.equal(s.source.fileId, id)
    assert.match(s.result.recommendedName, /\.docx$/)
    assert.deepEqual((await h.request('GET', url(id))).json().suggestion, s)
    assert.deepEqual((await h.request('POST', url(id), {})).json().suggestion, s)
    assert.equal(h.requests.length, 1)
    assert.equal((await h.request('GET', url(id), undefined, h.bob)).statusCode, 404)
    assert.equal((await h.request('POST', url(id), {}, h.bob)).statusCode, 404)
    assert.equal((await h.request('GET', `/api/tenants/${h.other}${url(id)}`)).statusCode, 404)
    assert.equal((await h.request('POST', url(id), { archiveNumber: 'fake' })).statusCode, 400)
    await assert.rejects(
      h.query("UPDATE archive_filing_suggestions SET result='{}' WHERE id=$1", [s.id]),
      /immutable/i,
    )
    await assert.rejects(
      h.query('DELETE FROM archive_filing_suggestions WHERE id=$1', [s.id]),
      /immutable/i,
    )
    assert.equal(
      (await h.query('SELECT name FROM workspace_files WHERE id=$1', [id])).rows[0].name,
      '制度.docx',
    )
  } finally {
    await h.close()
  }
})
test('filing uses PDF/XLSX extracted locations, never reparses or renames originals', async () => {
  const h = await setup()
  try {
    h.setAnswer(modelAnswer)
    for (const [name, bytes] of [
      ['说明.pdf', makePdf({ pages: ['资料借阅须登记。'] })],
      [
        '清单.xlsx',
        await makeXlsx({ sheets: [{ name: '资料', cells: { A1: '资料借阅须登记。' } }] }),
      ],
    ]) {
      const id = await h.upload(name, bytes)
      await h.request('POST', `/archive/documents/${id}/parse`, {})
      const r = await h.request('POST', url(id), {})
      assert.equal(r.statusCode, 200, r.body)
      assert.ok(r.json().suggestion.result.citations[0].location)
      assert.equal(r.json().suggestion.source.name, name)
    }
    assert.equal(h.requests.length, 2)
  } finally {
    await h.close()
  }
})
test('filing concurrent requests share lease; known failure manual retry retains number', async () => {
  const h = await setup()
  try {
    const id = await ready(h, '并发.docx', ['资料借阅须登记。'])
    let release, entered
    const signal = new Promise((r) => (entered = r))
    const wait = new Promise((r) => (release = r))
    h.setAnswer(async (body) => {
      entered()
      await wait
      return modelAnswer(body)
    })
    const first = h.request('POST', url(id), {})
    await Promise.race([signal, first.then((r) => assert.equal(r.statusCode, 200, r.body))])
    const second = await h.request('POST', url(id), {})
    assert.equal(second.statusCode, 200, second.body)
    const running = second.json().suggestion
    assert.equal(running.state, 'processing')
    assert.equal(h.requests.length, 1)
    release()
    const complete = (await first).json().suggestion
    assert.equal(complete.archiveNumber, running.archiveNumber)
    assert.equal(complete.state, 'ready')
    const bad = await ready(h, '失败.docx', ['资料借阅须登记。'])
    h.setAnswer(() => '{"fake":true}')
    const failure = await h.request('POST', url(bad), {})
    assert.equal(failure.statusCode, 502)
    const failed = (await h.request('GET', url(bad))).json().suggestion
    assert.equal(failed.state, 'failed')
    h.setAnswer(modelAnswer)
    const retried = (await h.request('POST', url(bad), {})).json().suggestion
    assert.equal(retried.state, 'ready')
    assert.equal(retried.archiveNumber, failed.archiveNumber)
  } finally {
    await h.close()
  }
})
test('filing lease recovery fences old attempt and stale source cannot enter results', async () => {
  const h = await setup()
  try {
    const id = await ready(h, '租约.docx', ['资料借阅须登记。'])
    let release, entered
    const signal = new Promise((r) => (entered = r))
    const wait = new Promise((r) => (release = r))
    h.setAnswer(async (body) => {
      entered()
      await wait
      return modelAnswer(body)
    })
    const first = h.request('POST', url(id), {})
    await Promise.race([signal, first.then((r) => assert.equal(r.statusCode, 200, r.body))])
    await h.query(
      "UPDATE archive_filing_suggestions SET lease_until=now()-interval '1 second' WHERE extraction_id=(SELECT id FROM archive_documents WHERE file_id=$1)",
      [id],
    )
    assert.equal((await h.request('GET', url(id))).json().suggestion.state, 'failed')
    h.setAnswer(modelAnswer)
    const newer = (await h.request('POST', url(id), {})).json().suggestion
    assert.equal(newer.state, 'ready')
    release()
    assert.equal((await first).statusCode, 409)
    assert.deepEqual((await h.request('GET', url(id))).json().suggestion, newer)
    const changed = await ready(h, '漂移.docx', ['资料借阅须登记。'])
    h.setAnswer(async (body) => {
      await h.query('UPDATE workspace_files SET data=$2 WHERE id=$1', [
        changed,
        Buffer.from('drift'),
      ])
      return modelAnswer(body)
    })
    assert.equal((await h.request('POST', url(changed), {})).statusCode, 409)
    assert.equal(
      (
        await h.query(
          'SELECT state FROM archive_filing_suggestions WHERE extraction_id=(SELECT id FROM archive_documents WHERE file_id=$1)',
          [changed],
        )
      ).rows[0].state,
      'failed',
    )
  } finally {
    await h.close()
  }
})
test('filing requires ready sources and enforced RLS, private FK and server identity', async () => {
  const h = await setup()
  try {
    const raw = await h.upload('unparsed.pdf', makePdf())
    assert.equal((await h.request('POST', url(raw), {})).statusCode, 409)
    assert.equal(h.requests.length, 0)
    const id = await ready(h, '私有.docx', ['资料借阅须登记。'])
    h.setAnswer(modelAnswer)
    const response = await h.request('POST', url(id), {})
    assert.equal(response.statusCode, 200, response.body)
    const saved = response.json().suggestion
    await h.query('CREATE ROLE filing_reader')
    await h.query('GRANT SELECT ON archive_filing_suggestions TO filing_reader')
    await h.query('SET ROLE filing_reader')
    assert.equal((await h.query('SELECT * FROM archive_filing_suggestions')).rows.length, 0)
    await h.query(
      "SELECT set_config('app.tenant_id',$1,false),set_config('app.user_id',$2,false)",
      [h.tenant, h.bob],
    )
    assert.equal((await h.query('SELECT * FROM archive_filing_suggestions')).rows.length, 0)
    await h.query("SELECT set_config('app.user_id',$1,false)", [h.alice])
    assert.equal((await h.query('SELECT * FROM archive_filing_suggestions')).rows.length, 1)
    await h.query('RESET ROLE')
    const fresh = await ready(h, '未生成.docx', ['资料借阅须登记。'])
    const extraction = (await h.query('SELECT id FROM archive_documents WHERE file_id=$1', [fresh]))
      .rows[0].id
    await assert.rejects(
      h.query(
        "INSERT INTO archive_filing_suggestions(id,tenant_id,user_id,extraction_id,source) VALUES($1,$2,$3,$4,'{}')",
        [randomUUID(), h.tenant, h.bob, extraction],
      ),
      /foreign key/i,
    )
  } finally {
    await h.close()
  }
})
test('filing provider failure is saved with no fallback model call and private source drift blocks cached reads', async () => {
  const h = await setup()
  try {
    const id = await ready(h, '服务故障.docx', ['资料借阅须登记。'])
    const policy = defaultPolicy()
    policy.tiers.fast = 'primary'
    policy.tiers.strong = 'fallback'
    policy.departments.archive.enabled = true
    policy.departments.archive.tier = 'fast'
    policy.departments.archive.fallback = 'strong'
    await h.query('UPDATE operations_settings SET encrypted_config=$2 WHERE tenant_id=$1', [
      h.tenant,
      encryptConfig(
        { ...policy, credentials: { ai: 'synthetic-key' } },
        Buffer.alloc(32, 9),
        h.tenant,
      ),
    ])
    h.setAnswer(
      () =>
        new Response(JSON.stringify({ error: 'unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const bad = await h.request('POST', url(id), {})
    assert.ok(bad.statusCode >= 400)
    assert.equal(h.requests.length, 1)
    assert.equal((await h.request('GET', url(id))).json().suggestion.state, 'failed')
    h.setAnswer(modelAnswer)
    const good = await h.request('POST', url(id), {})
    assert.equal(good.statusCode, 200, good.body)
    const oldNumber = good.json().suggestion.archiveNumber
    await h.query('UPDATE workspace_files SET data=$2 WHERE id=$1', [id, Buffer.from('changed')])
    assert.equal((await h.request('GET', url(id))).statusCode, 409)
    assert.equal((await h.request('POST', url(id), {})).statusCode, 409)
    assert.equal(h.requests.length, 2)
    assert.ok(oldNumber)
  } finally {
    await h.close()
  }
})
