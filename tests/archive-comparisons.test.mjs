import { setup, ready } from './helpers/archive-api-fixture.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { defaultPolicy } from '../apps/api/src/operations/policy.mjs'
import { encryptConfig } from '../apps/api/src/operations/security.mjs'
import { makeDocx, makePdf, makeXlsx } from './helpers/archive-fixtures.mjs'
async function create(h, oldFileId, newFileId) {
  const response = await h.request('POST', '/archive/comparisons', { oldFileId, newFileId })
  assert.equal(response.statusCode, 200, response.body)
  return response.json().comparison
}
const payload = (body) => JSON.parse(body.messages.at(-1).content)
const answer = (sources) =>
  JSON.stringify({
    claims: [
      {
        text: '预算从180万元改为200万元。',
        citations: sources.map((s) => ({ sourceId: s.sourceId, quote: s.text })),
      },
    ],
    notFound: false,
  })

test('private comparison API persists an ordered pair and reopens full immutable history', async () => {
  const h = await setup()
  try {
    const oldId = await ready(h, '旧版.docx', ['预算180万元。', '交付十月。'])
    const newId = await ready(h, '新版.docx', ['预算200万元。', '交付十月。'])
    const comparison = await create(h, oldId, newId)
    assert.deepEqual(comparison.stats, { added: 0, removed: 0, modified: 1, unchanged: 1 })
    assert.equal(comparison.oldVersion.name, '旧版.docx')
    assert.equal(comparison.newVersion.fileId, newId)
    assert.equal(comparison.algorithmVersion, 'text-diff-1')
    assert.equal(comparison.hunks[0].old.text, '预算180万元。')
    assert.equal(comparison.hunks[0].new.text, '预算200万元。')
    const concurrent = await Promise.all([create(h, oldId, newId), create(h, oldId, newId)])
    assert.ok(concurrent.every((c) => c.id === comparison.id))
    const reversed = await create(h, newId, oldId)
    assert.notEqual(reversed.id, comparison.id)
    assert.equal(reversed.hunks[0].old.text, '预算200万元。')
    const detail = await h.request('GET', `/archive/comparisons/${comparison.id}`)
    assert.deepEqual(detail.json().comparison, comparison)
    const list = (await h.request('GET', '/archive/comparisons')).json().items
    assert.equal(list.length, 2)
    assert.equal(list[0].id, reversed.id)
    assert.equal(list[0].hunks, undefined)
    assert.equal(list[0].warnings, undefined)
    assert.equal(
      (await h.request('GET', `/archive/comparisons/${comparison.id}`, undefined, h.bob))
        .statusCode,
      404,
    )
    assert.equal(
      (await h.request('GET', `/api/tenants/${h.other}/archive/comparisons/${comparison.id}`))
        .statusCode,
      404,
    )
    assert.deepEqual(
      (await h.request('GET', '/archive/comparisons', undefined, h.bob)).json().items,
      [],
    )
    assert.equal((await h.query('SELECT count(*) n FROM archive_comparisons')).rows[0].n, 2)
    assert.equal(h.requests.length, 0)
  } finally {
    await h.close()
  }
})

test('comparison rejects same file, unready, private sources and source hash drift on create/detail/chat', async () => {
  const h = await setup()
  try {
    const a = await ready(h, 'a.docx', ['预算180万元。']),
      b = await ready(h, 'b.docx', ['预算200万元。'])
    const unready = await h.upload('unready.docx', await makeDocx())
    for (const [oldFileId, newFileId, user, status] of [
      [a, a, h.alice, 400],
      [a, unready, h.alice, 409],
      [a, b, h.bob, 404],
    ]) {
      const r = await h.request('POST', '/archive/comparisons', { oldFileId, newFileId }, user)
      assert.equal(r.statusCode, status, r.body)
    }
    const c = await create(h, a, b)
    await h.query('UPDATE workspace_files SET data=$2 WHERE id=$1', [
      a,
      Buffer.from('changed original'),
    ])
    for (const [method, path, body] of [
      ['GET', `/archive/comparisons/${c.id}`],
      ['POST', '/archive/comparisons', { oldFileId: a, newFileId: b }],
      ['POST', '/departments/archive/chat', { text: '总结', revision: 0, comparisonId: c.id }],
    ]) {
      const r = await h.request(method, path, body)
      assert.equal(r.statusCode, 409, r.body)
    }
    assert.equal(h.requests.length, 0)
    assert.equal((await h.request('GET', '/departments/archive/conversation')).json().revision, 0)
  } finally {
    await h.close()
  }
})

test('comparison migration enforces immutable rows, private composite FKs and FORCE RLS', async () => {
  const h = await setup()
  try {
    const a = await ready(h, 'a.docx', ['旧预算。']),
      b = await ready(h, 'b.docx', ['新预算。']),
      c = await create(h, a, b)
    assert.deepEqual(
      (
        await h.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='archive_comparisons'",
        )
      ).rows[0],
      { relrowsecurity: true, relforcerowsecurity: true },
    )
    await assert.rejects(
      h.query("UPDATE archive_comparisons SET result='{}' WHERE id=$1", [c.id]),
      /immutable/,
    )
    await assert.rejects(
      h.query('DELETE FROM archive_comparisons WHERE id=$1', [c.id]),
      /immutable/,
    )
    const row = (await h.query('SELECT * FROM archive_comparisons WHERE id=$1', [c.id])).rows[0]
    await assert.rejects(
      h.query(
        'INSERT INTO archive_comparisons(id,tenant_id,user_id,old_extraction_id,new_extraction_id,algorithm_version,sources,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          randomUUID(),
          h.tenant,
          h.bob,
          row.old_extraction_id,
          row.new_extraction_id,
          'foreign-test',
          JSON.stringify(row.sources),
          JSON.stringify(row.result),
        ],
      ),
      /foreign key/,
    )
    await assert.rejects(
      h.query('DELETE FROM archive_documents WHERE id=$1', [row.old_extraction_id]),
      /foreign key/,
    )
    await h.query(
      'CREATE ROLE comparison_reader NOLOGIN; GRANT SELECT ON archive_comparisons TO comparison_reader; SET ROLE comparison_reader',
    )
    try {
      assert.equal((await h.query('SELECT * FROM archive_comparisons')).rows.length, 0)
      for (const [tenant, user, count] of [
        [h.tenant, h.alice, 1],
        [h.tenant, h.bob, 0],
        [h.other, h.alice, 0],
      ]) {
        await h.query('BEGIN')
        await h.query(
          "SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
          [tenant, user],
        )
        assert.equal((await h.query('SELECT * FROM archive_comparisons')).rows.length, count)
        await h.query('COMMIT')
      }
    } finally {
      await h.query('RESET ROLE')
    }
  } finally {
    await h.close()
  }
})

test('comparison chat validates bilateral claims, persists server citation roles and uses revision CAS', async () => {
  const h = await setup()
  try {
    const a = await ready(h, 'a.docx', ['预算180万元。', '相同段落。']),
      b = await ready(h, 'b.docx', ['预算200万元。', '相同段落。']),
      c = await create(h, a, b)
    h.setAnswer((body) => {
      const data = payload(body)
      assert.equal(data.sources.length, 2)
      assert.ok(data.sources.every((s) => !s.text.includes('相同')))
      return answer(data.sources)
    })
    const r = await h.request('POST', '/departments/archive/chat', {
      text: '总结改动',
      revision: 0,
      comparisonId: c.id,
    })
    assert.equal(r.statusCode, 200, r.body)
    const saved = r.json()
    assert.equal(saved.messages[0].comparison.id, c.id)
    assert.equal(saved.messages[1].comparison.id, c.id)
    assert.equal(saved.messages[0].comparison.hunks, undefined)
    assert.equal(saved.messages[0].files, undefined)
    assert.deepEqual(
      saved.messages[1].citations.map((x) => x.side),
      ['old', 'new'],
    )
    assert.ok(
      saved.messages[1].citations.every((x) => x.comparisonId === c.id && x.changeId === 'h1'),
    )
    assert.equal(saved.messages[1].citations[0].sha256, c.oldVersion.sha256)
    assert.equal(saved.messages[1].citations[1].filename, 'b.docx')
    assert.deepEqual((await h.request('GET', '/departments/archive/conversation')).json(), saved)
    const count = h.requests.length
    assert.equal(
      (
        await h.request('POST', '/departments/archive/chat', {
          text: '总结',
          revision: 0,
          comparisonId: c.id,
        })
      ).statusCode,
      409,
    )
    assert.equal(h.requests.length, count)
    for (const invalid of [
      (ss) => answer(ss.slice(0, 1)),
      (ss) =>
        JSON.stringify({
          claims: [
            {
              text: '修改',
              citations: [
                { sourceId: ss[0].sourceId, quote: ss[1].text },
                { sourceId: ss[1].sourceId, quote: ss[1].text },
              ],
            },
          ],
          notFound: false,
        }),
      (ss) =>
        JSON.stringify({
          claims: [
            {
              text: '修改',
              citations: ss.map((s) => ({ sourceId: s.sourceId, quote: '伪造预算999万元。' })),
            },
          ],
          notFound: false,
        }),
      (ss) =>
        JSON.stringify({
          claims: [
            {
              text: '修改',
              citations: ss.map((s) => ({ sourceId: s.sourceId, quote: s.text, side: 'new' })),
            },
          ],
          notFound: false,
        }),
    ]) {
      h.setAnswer((body) => invalid(payload(body).sources))
      const failed = await h.request('POST', '/departments/archive/chat', {
        text: '还有改动？',
        revision: 1,
        comparisonId: c.id,
      })
      assert.equal(failed.statusCode, 502, failed.body)
    }
    assert.equal((await h.request('GET', '/departments/archive/conversation')).json().revision, 1)
    h.setAnswer(() => {
      throw new Error('synthetic provider outage')
    })
    assert.equal(
      (
        await h.request('POST', '/departments/archive/chat', {
          text: '再总结',
          revision: 1,
          comparisonId: c.id,
        })
      ).statusCode,
      502,
    )
    assert.equal(
      (await h.request('GET', `/archive/comparisons/${c.id}`)).json().comparison.id,
      c.id,
    )
    assert.equal((await h.request('GET', '/departments/archive/conversation')).json().revision, 1)
  } finally {
    await h.close()
  }
})

test('identical extracted text yields deterministic comparison answer with zero model requests', async () => {
  const h = await setup()
  try {
    const a = await ready(h, 'a.docx', ['未变文字。']),
      b = await ready(h, 'b.docx', ['未变文字。']),
      c = await create(h, a, b)
    await h.query('DELETE FROM operations_settings WHERE tenant_id=$1', [h.tenant])
    const r = await h.request('POST', '/departments/archive/chat', {
      text: '总结改动',
      revision: 0,
      comparisonId: c.id,
    })
    assert.equal(r.statusCode, 200, r.body)
    assert.match(r.json().messages.at(-1).text, /已提取文字未发现变化/)
    assert.equal(r.json().messages.at(-1).comparison.id, c.id)
    assert.deepEqual(r.json().messages.at(-1).citations, [])
    assert.equal(h.requests.length, 0)
    for (const extra of [
      { fileIds: [] },
      { image: 'data:image/png;base64,aGVsbG8=' },
      { projectId: randomUUID() },
    ])
      assert.equal(
        (
          await h.request('POST', '/departments/archive/chat', {
            text: '总结',
            revision: 1,
            comparisonId: c.id,
            ...extra,
          })
        ).statusCode,
        400,
      )
    assert.equal(
      (
        await h.request('POST', '/departments/dev/chat', {
          text: '总结',
          revision: 0,
          comparisonId: c.id,
        })
      ).statusCode,
      400,
    )
  } finally {
    await h.close()
  }
})

test('comparison context fits whole modified pairs within bounds and rejects mixed hunk claims', async () => {
  const module = await import('../apps/api/src/archive/comparison-context.mjs')
  const hunks = Array.from({ length: 20 }, (_, i) => ({
    id: `h${i + 1}`,
    type: 'modified',
    old: { blockId: `o${i}`, location: `段 ${i}`, text: '旧'.repeat(1000) },
    new: { blockId: `n${i}`, location: `段 ${i}`, text: '新'.repeat(1000) },
  }))
  const c = {
    id: 'comparison',
    oldVersion: { fileId: 'old', name: 'old.docx', extractionId: 'ex-old', sha256: 'a'.repeat(64) },
    newVersion: { fileId: 'new', name: 'new.docx', extractionId: 'ex-new', sha256: 'b'.repeat(64) },
    hunks,
    warnings: ['原文OCR警告'],
  }
  const context = module.buildComparisonContext(c)
  assert.equal(context.sources.length, 24)
  assert.equal(
    context.sources.reduce((n, s) => n + s.text.length, 0),
    24000,
  )
  assert.match(context.documentCoverage, /12.*20/)
  assert.match(context.documentCoverage, /部分/)
  assert.match(context.instructions, /原文OCR警告/)
  const { validateGroundedAnswer } = await import('../apps/api/src/archive/context.mjs')
  assert.throws(
    () => validateGroundedAnswer(answer([context.sources[0], context.sources[3]]), context),
    { statusCode: 502 },
  )
})

test('comparison provider rejection never automatically calls configured fallback', async () => {
  const h = await setup()
  try {
    const a = await ready(h, 'a.docx', ['旧预算。']),
      b = await ready(h, 'b.docx', ['新预算。']),
      c = await create(h, a, b)
    const p = defaultPolicy()
    p.tiers.fast = 'archive-test-model'
    p.tiers.cheap = 'synthetic-fallback'
    p.departments.archive = {
      ...p.departments.archive,
      enabled: true,
      tier: 'fast',
      fallback: 'cheap',
    }
    await h.query('UPDATE operations_settings SET encrypted_config=$2 WHERE tenant_id=$1', [
      h.tenant,
      encryptConfig({ ...p, credentials: { ai: 'synthetic-key' } }, Buffer.alloc(32, 9), h.tenant),
    ])
    h.setAnswer(
      () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }),
    )
    const r = await h.request('POST', '/departments/archive/chat', {
      text: '总结',
      revision: 0,
      comparisonId: c.id,
    })
    assert.equal(r.statusCode, 502, r.body)
    assert.equal(h.requests.length, 1)
    assert.equal((await h.request('GET', '/departments/archive/conversation')).json().revision, 0)
  } finally {
    await h.close()
  }
})

test('comparison keeps extraction caveats and differing parser versions', async () => {
  const { extractDocument } = await import('../apps/api/src/archive/extract.mjs')
  let h
  h = await setup(async (input) => {
    const result = await extractDocument(input)
    result.warnings = [`${input.name}提取警告`]
    await h.query("UPDATE archive_documents SET parser_version=$1 WHERE state='processing'", [
      input.name === 'a.docx' ? 'archive-old' : 'archive-new',
    ])
    return result
  })
  try {
    const a = await ready(h, 'a.docx', ['旧预算。']),
      b = await ready(h, 'b.docx', ['新预算。']),
      c = await create(h, a, b)
    assert.ok(c.warnings.some((w) => w.includes('a.docx提取警告')))
    assert.ok(c.warnings.some((w) => w.includes('b.docx提取警告')))
    assert.ok(c.warnings.some((w) => /解析.*版本|版本.*解析/.test(w)))
  } finally {
    await h.close()
  }
})

test('comparison diff runs outside transactions and final insert rechecks original identity', async () => {
  const h = await setup()
  const Fastify = (await import('fastify')).default
  const { transaction } = await import('../apps/api/src/db.mjs')
  const { registerComparisonRoutes } = await import('../apps/api/src/archive/comparison-routes.mjs')
  const { compareDocumentText } = await import('../apps/api/src/archive/compare.mjs')
  const isolated = Fastify()
  let active = 0,
    calls = 0,
    changed = false
  registerComparisonRoutes(isolated, {
    scoped: async (_req, fn) => {
      active++
      try {
        // Mutate between the read and insert, before opening the latter transaction.
        if (calls && !changed) {
          changed = true
          await h.query('UPDATE workspace_files SET data=$2 WHERE name=$1', [
            'a.docx',
            Buffer.from('drift'),
          ])
        }
        return await transaction(
          h.pool,
          (db) => fn(db, {}, { tenantId: h.tenant, userId: h.alice }),
          { tenantId: h.tenant, userId: h.alice },
        )
      } finally {
        active--
      }
    },
    compare: (...docs) => {
      assert.equal(active, 0)
      calls++
      return compareDocumentText(...docs)
    },
  })
  try {
    const a = await ready(h, 'a.docx', ['旧预算。']),
      b = await ready(h, 'b.docx', ['新预算。'])
    const r = await isolated.inject({
      method: 'POST',
      url: `/api/tenants/${h.tenant}/archive/comparisons`,
      payload: { oldFileId: a, newFileId: b },
    })
    assert.equal(calls, 1)
    assert.equal(r.statusCode, 409, r.body)
    assert.equal((await h.query('SELECT count(*) n FROM archive_comparisons')).rows[0].n, 0)
  } finally {
    await isolated.close()
    await h.close()
  }
})

test('late comparison replies lose revision CAS without holding a transaction or overwriting history', async () => {
  const h = await setup()
  let enter, release
  const entered = new Promise((resolve) => (enter = resolve)),
    held = new Promise((resolve) => (release = resolve))
  let pending
  try {
    const a = await ready(h, 'a.docx', ['预算180万元。']),
      b = await ready(h, 'b.docx', ['预算200万元。']),
      c = await create(h, a, b)
    h.setAnswer(async (body) => {
      if (body.messages.at(-1).content === '更新对话') return '新消息已保存'
      enter()
      await held
      return answer(payload(body).sources)
    })
    pending = h.request('POST', '/departments/archive/chat', {
      text: '总结',
      revision: 0,
      comparisonId: c.id,
    })
    await entered
    const next = await h.request('POST', '/departments/archive/chat', {
      text: '更新对话',
      revision: 0,
    })
    assert.equal(next.statusCode, 200, next.body)
    assert.equal(next.json().revision, 1)
    release()
    const late = await pending
    assert.equal(late.statusCode, 409, late.body)
    const saved = (await h.request('GET', '/departments/archive/conversation')).json()
    assert.equal(saved.messages.length, 2)
    assert.equal(saved.messages[0].text, '更新对话')
    assert.equal(saved.messages[1].comparison, undefined)
    assert.equal((await h.request('GET', `/archive/comparisons/${c.id}`)).statusCode, 200)
  } finally {
    release()
    if (pending) await pending
    await h.close()
  }
})

test('comparison history returns only newest twenty references', async () => {
  const h = await setup()
  try {
    const a = await ready(h, 'a.docx', ['旧预算。']),
      b = await ready(h, 'b.docx', ['新预算。']),
      c = await create(h, a, b)
    const row = (await h.query('SELECT * FROM archive_comparisons WHERE id=$1', [c.id])).rows[0]
    const ids = []
    for (let i = 0; i < 22; i++) {
      const id = randomUUID()
      ids.push(id)
      await h.query(
        'INSERT INTO archive_comparisons(id,tenant_id,user_id,old_extraction_id,new_extraction_id,algorithm_version,sources,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          id,
          h.tenant,
          h.alice,
          row.old_extraction_id,
          row.new_extraction_id,
          `historical-${i}`,
          JSON.stringify(row.sources),
          JSON.stringify(row.result),
          new Date(Date.UTC(2040, 0, i + 1)).toISOString(),
        ],
      )
    }
    const items = (await h.request('GET', '/archive/comparisons')).json().items
    assert.equal(items.length, 20)
    assert.deepEqual(
      items.map((x) => x.id),
      ids.slice(2).reverse(),
    )
    assert.ok(items.every((x) => !('hunks' in x) && !('warnings' in x)))
  } finally {
    await h.close()
  }
})

test('serialized oversized comparison cannot be persisted even if a calculator exceeds its contract', async () => {
  const h = await setup()
  const Fastify = (await import('fastify')).default
  const { transaction } = await import('../apps/api/src/db.mjs')
  const { registerComparisonRoutes } = await import('../apps/api/src/archive/comparison-routes.mjs')
  const isolated = Fastify()
  registerComparisonRoutes(isolated, {
    scoped: (_req, fn) =>
      transaction(h.pool, (db) => fn(db, {}, { tenantId: h.tenant, userId: h.alice }), {
        tenantId: h.tenant,
        userId: h.alice,
      }),
    compare: () => ({
      algorithmVersion: 'text-diff-1',
      stats: { added: 0, removed: 0, modified: 1, unchanged: 0 },
      overview: '修改',
      warnings: [],
      hunks: [{ text: 'x'.repeat(6 * 1024 * 1024) }],
    }),
  })
  try {
    const a = await ready(h, 'a.docx', ['旧预算。']),
      b = await ready(h, 'b.docx', ['新预算。'])
    const r = await isolated.inject({
      method: 'POST',
      url: `/api/tenants/${h.tenant}/archive/comparisons`,
      payload: { oldFileId: a, newFileId: b },
    })
    assert.equal(r.statusCode, 413, r.body)
    assert.match(r.json().message, /拆分/)
    assert.equal((await h.query('SELECT count(*) n FROM archive_comparisons')).rows[0].n, 0)
  } finally {
    await isolated.close()
    await h.close()
  }
})
