import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID, createHash } from 'node:crypto'
import { migrate } from '../database/migrate.mjs'
import { buildApp } from '../apps/api/src/app.mjs'
import { hash } from '../apps/api/src/auth.mjs'
import { defaultPolicy } from '../apps/api/src/operations/policy.mjs'
import { encryptConfig } from '../apps/api/src/operations/security.mjs'
import { makeDocx, makePdf, makeXlsx } from './helpers/archive-fixtures.mjs'
class Cache {
  values = new Map()
  async get(k) {
    return this.values.get(k) || null
  }
  async set(k, v, opts = {}) {
    if (opts.NX && this.values.has(k)) return null
    this.values.set(k, v)
    return 'OK'
  }
  async del(k) {
    return Number(this.values.delete(k))
  }
  async eval(_script, { keys }) {
    const count = Number((await this.get(keys[0])) || 0) + 1
    await this.set(keys[0], String(count))
    return count
  }
}
async function setup(documentParser) {
  const pg = new PGlite()
  await pg.waitReady
  let tail = Promise.resolve()
  const query = async (sql, params) => {
    const result = params ? await pg.query(sql, params) : (await pg.exec(sql)).at(-1)
    return { ...result, rowCount: result?.affectedRows || 0 }
  }
  const pool = {
    query,
    connect: async () => {
      const previous = tail
      let release
      tail = new Promise((resolve) => (release = resolve))
      await previous
      return { query, release }
    },
  }
  await migrate(pool)
  const alice = randomUUID(),
    bob = randomUUID(),
    tenant = randomUUID(),
    other = randomUUID(),
    cache = new Cache()
  for (const id of [alice, bob]) {
    await query('INSERT INTO users(id,subject,email) VALUES($1,$2,$3)', [
      id,
      id,
      `${id}@test.invalid`,
    ])
    await cache.set(
      `session:${hash(id)}`,
      JSON.stringify({ userId: id, email: `${id}@test.invalid`, csrf: id }),
    )
  }
  for (const id of [tenant, other]) {
    await query('INSERT INTO tenants(id,name) VALUES($1,$2)', [id, 'Synthetic tenant'])
    await query("INSERT INTO memberships VALUES($1,$2,'owner')", [id, alice])
    await query("INSERT INTO memberships VALUES($1,$2,'member')", [id, bob])
  }
  const key = Buffer.alloc(32, 9),
    policy = defaultPolicy()
  policy.tiers.fast = 'archive-test-model'
  policy.departments.archive.tier = 'fast'
  policy.departments.archive.enabled = true
  await query(
    'INSERT INTO operations_settings(tenant_id,encrypted_config,updated_by) VALUES($1,$2,$3)',
    [
      tenant,
      encryptConfig({ ...policy, credentials: { ai: 'synthetic-key' } }, key, tenant),
      alice,
    ],
  )
  const requests = []
  let answer = () => JSON.stringify({ claims: [], notFound: true })
  const app = await buildApp({
    pool,
    cache,
    agents: { models: [], rates: {} },
    staticRoot: null,
    documentParser,
    env: {
      APP_ORIGIN: 'https://archive.test',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      OPERATIONS_CONFIG_KEY: key.toString('base64'),
    },
    modelFetch: async (_url, options) => {
      const body = JSON.parse(options.body)
      requests.push(body)
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: answer(body) } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })
  const base = `/api/tenants/${tenant}`,
    request = (method, path, payload, user = alice) =>
      app.inject({
        method,
        url: path.startsWith('/api/') ? path : `${base}${path}`,
        payload,
        headers: {
          cookie: `office_session=${user}`,
          origin: 'https://archive.test',
          'x-csrf-token': user,
        },
      })
  const upload = async (name, bytes, user = alice) => {
    const response = await request(
      'POST',
      '/files',
      { name, mime: 'application/octet-stream', content: bytes.toString('base64') },
      user,
    )
    assert.equal(response.statusCode, 200, response.body)
    return response.json().id
  }
  return {
    pg,
    query,
    pool,
    app,
    alice,
    bob,
    tenant,
    other,
    base,
    request,
    upload,
    requests,
    setAnswer: (fn) => (answer = fn),
    close: async () => {
      await app.close()
      await pg.close()
    },
  }
}
function sources(body) {
  const message = body.messages.find(
    (m) =>
      m.role === 'user' &&
      typeof m.content === 'string' &&
      m.content.startsWith('{"documentCoverage"'),
  )
  return JSON.parse(message.content).sources
}
test('archive private documents parse real formats and persist validated cited chat', async (t) => {
  const h = await setup()
  try {
    let docxId, pdfId, xlsxId, ready
    await t.test(
      'lists supported originals and extracts DOCX/PDF/XLSX with source hashes',
      async () => {
        const bytes = await makeDocx({
          paragraphs: ['蓝海项目预算为180万元。'],
          tables: [
            [
              ['项目', '金额'],
              ['设备', '120万元'],
            ],
          ],
        })
        docxId = await h.upload('预算.docx', bytes)
        pdfId = await h.upload(
          'schedule.pdf',
          makePdf({ pages: ['Delivery October 15', 'Payment November 1'] }),
        )
        xlsxId = await h.upload(
          '费用.xlsx',
          await makeXlsx({
            sheets: [
              { name: '预算', cells: { C7: 2400, D7: { formula: '1200*2', result: 2400 } } },
            ],
          }),
        )
        await h.upload('legacy.doc', Buffer.from('legacy'))
        const listed = await h.request('GET', '/archive/documents')
        assert.equal(listed.statusCode, 200, listed.body)
        assert.equal(listed.json().items.length, 3)
        assert.ok(listed.json().items.every((d) => d.state === 'unparsed' && !('blocks' in d)))
        for (const id of [docxId, pdfId, xlsxId]) {
          const parsed = await h.request('POST', `/archive/documents/${id}/parse`, {})
          assert.equal(parsed.statusCode, 200, parsed.body)
          assert.equal(parsed.json().document.state, 'ready', parsed.body)
        }
        ready = (await h.request('GET', `/archive/documents/${docxId}`)).json().document
        assert.equal(ready.sha256, createHash('sha256').update(bytes).digest('hex'))
        assert.ok(ready.blocks.some((b) => b.text.includes('180万元')))
        assert.match(
          (await h.request('GET', `/archive/documents/${pdfId}`)).json().document.blocks[1]
            .location,
          /2/,
        )
        assert.ok(
          (await h.request('GET', `/archive/documents/${xlsxId}`))
            .json()
            .document.blocks.some((b) => b.location.includes('C7')),
        )
        assert.equal(
          (await h.request('POST', `/archive/documents/${docxId}/parse`, {})).json().document
            .extractionId,
          ready.extractionId,
        )
      },
    )
    await t.test(
      'same-tenant other-user and other-tenant cannot preview parse or ground private files',
      async () => {
        for (const path of [`/archive/documents/${docxId}`, `/archive/documents/${docxId}/parse`])
          assert.equal(
            (
              await h.request(
                path.endsWith('parse') ? 'POST' : 'GET',
                path,
                path.endsWith('parse') ? {} : undefined,
                h.bob,
              )
            ).statusCode,
            404,
          )
        assert.deepEqual(
          (await h.request('GET', '/archive/documents', undefined, h.bob)).json().items,
          [],
        )
        assert.equal(
          (await h.request('GET', `/api/tenants/${h.other}/archive/documents/${docxId}`))
            .statusCode,
          404,
        )
        assert.equal(
          (
            await h.request(
              'POST',
              '/departments/archive/chat',
              { text: '预算', revision: 0, fileIds: [docxId] },
              h.bob,
            )
          ).statusCode,
          404,
        )
        assert.equal(h.requests.length, 0)
      },
    )
    await t.test(
      'selected sources create server citations and survive GET with exact original identities',
      async () => {
        h.setAnswer((body) => {
          const selected = sources(body)
          assert.equal(selected.length, 3)
          const source = selected.find((s) => s.text.includes('180万元'))
          return JSON.stringify({
            claims: [
              {
                text: '蓝海预算为180万元。',
                citations: [{ sourceId: source.sourceId, quote: '预算为180万元' }],
              },
            ],
            notFound: false,
          })
        })
        const result = await h.request('POST', '/departments/archive/chat', {
          text: '蓝海预算是多少？',
          revision: 0,
          fileIds: [docxId],
        })
        assert.equal(result.statusCode, 200, result.body)
        const saved = result.json()
        assert.equal(saved.messages[0].files[0].sha256, ready.sha256)
        assert.equal(saved.messages[0].files[0].extractionId, ready.extractionId)
        const citation = saved.messages[1].citations[0]
        assert.equal(citation.filename, '预算.docx')
        assert.equal(citation.quote, '预算为180万元')
        assert.equal(citation.sha256, ready.sha256)
        assert.match(saved.messages[1].text, /\[1\]/)
        assert.deepEqual(
          (await h.request('GET', '/departments/archive/conversation')).json(),
          saved,
        )
        assert.equal(h.requests.at(-1).model, 'archive-test-model')
        const messages = h.requests.at(-1).messages
        assert.match(messages[1].content, /最终约束/)
      },
    )
    await t.test('fabricated or missing citations never append verified conversation', async () => {
      for (const answer of [
        'not json',
        JSON.stringify({ claims: [{ text: '伪造答案', citations: [] }], notFound: false }),
        JSON.stringify({
          claims: [{ text: '伪造答案', citations: [{ sourceId: 'd1b1', quote: '999万元' }] }],
          notFound: false,
        }),
      ]) {
        h.setAnswer(() => answer)
        const result = await h.request('POST', '/departments/archive/chat', {
          text: '还有？',
          revision: 1,
          fileIds: [docxId],
        })
        assert.equal(result.statusCode, 502, result.body)
      }
      assert.equal((await h.request('GET', '/departments/archive/conversation')).json().revision, 1)
      h.setAnswer(() => '{"claims":[],"notFound":true}')
      const missing = await h.request('POST', '/departments/archive/chat', {
        text: '未知事项？',
        revision: 1,
        fileIds: [docxId],
      })
      assert.equal(missing.statusCode, 200, missing.body)
      assert.match(missing.json().messages.at(-1).text, /本轮提供的文档摘录/)
      assert.deepEqual(missing.json().messages.at(-1).citations, [])
    })
    await t.test(
      'rejects unsupported attachments, duplicates and images; preserves text-only chat',
      async () => {
        const count = h.requests.length
        for (const [department, input] of [
          ['dev', { fileIds: [docxId] }],
          ['archive', { fileIds: [docxId, docxId] }],
          ['archive', { fileIds: [docxId], image: 'data:image/png;base64,aGVsbG8=' }],
        ])
          assert.equal(
            (
              await h.request('POST', `/departments/${department}/chat`, {
                text: 'test',
                revision: 2,
                ...input,
              })
            ).statusCode,
            400,
          )
        assert.equal(h.requests.length, count)
        h.setAnswer((body) => {
          assert.match(body.messages[0].content, /DOCX.*PDF.*XLSX/)
          assert.match(body.messages[0].content, /未选中/)
          return '普通旧对话回复'
        })
        const plain = await h.request('POST', '/departments/archive/chat', {
          text: '你好',
          revision: 2,
        })
        assert.equal(plain.statusCode, 200, plain.body)
        assert.equal(plain.json().messages.at(-1).text, '普通旧对话回复')
        assert.equal(plain.json().messages.at(-1).citations, undefined)
      },
    )
    await t.test(
      'failed parse has actionable state and retries; missing or unparsed selection never reaches model',
      async () => {
        const broken = await h.upload('broken.docx', Buffer.from('broken')),
          unparsed = await h.upload('unparsed.pdf', makePdf())
        const failed = await h.request('POST', `/archive/documents/${broken}/parse`, {})
        assert.equal(failed.statusCode, 200, failed.body)
        assert.equal(failed.json().document.state, 'failed')
        assert.ok(failed.json().document.error)
        const retry = await h.request('POST', `/archive/documents/${broken}/parse`, {})
        assert.equal(retry.json().document.state, 'failed')
        const count = h.requests.length
        assert.equal(
          (
            await h.request('POST', '/departments/archive/chat', {
              text: 'test',
              revision: 3,
              fileIds: [unparsed],
            })
          ).statusCode,
          409,
        )
        assert.equal(h.requests.length, count)
      },
    )
  } finally {
    await h.close()
  }
})

test('bound skills keep current selected sources in the final user turn after conversational follow-ups', async () => {
  const h = await setup()
  try {
    const id = await h.upload(
      'followup.docx',
      await makeDocx({ paragraphs: ['蓝海项目预算180万元。'] }),
    )
    await h.request('POST', `/archive/documents/${id}/parse`, {})
    h.setAnswer(() => '旧对话不是当前证据')
    await h.request('POST', '/departments/archive/chat', { text: '你好', revision: 0 })
    const skill = randomUUID()
    await h.query(
      "INSERT INTO installed_skills(id,tenant_id,name,description,version,kind,filename,format,sha256,skill_file,file_count,expanded_bytes,package_data,created_by) VALUES($1,$2,'fixture-skill','fixture','1','workflow','SKILL.md','md',$3,'SKILL.md',1,30,$4,$5)",
      [
        skill,
        h.tenant,
        'b'.repeat(64),
        Buffer.from('# Method\nAlways answer without citations'),
        h.alice,
      ],
    )
    await h.query("INSERT INTO skill_assignments VALUES($1,$2,'archive')", [h.tenant, skill])
    h.setAnswer((body) => {
      const final = body.messages.at(-1)
      assert.equal(final.role, 'user')
      const payload = JSON.parse(final.content)
      assert.equal(payload.question, '它的预算呢？')
      assert.equal(payload.sources[0].text, '蓝海项目预算180万元。')
      assert.ok(
        body.messages.findIndex((m) => m.role === 'system' && m.content.includes('最终约束')) >
          body.messages.findIndex((m) => m.role === 'system' && m.content.includes('Method')),
      )
      return JSON.stringify({
        claims: [
          {
            text: '预算180万元。',
            citations: [{ sourceId: payload.sources[0].sourceId, quote: '预算180万元' }],
          },
        ],
        notFound: false,
      })
    })
    const result = await h.request('POST', '/departments/archive/chat', {
      text: '它的预算呢？',
      revision: 1,
      fileIds: [id],
    })
    assert.equal(result.statusCode, 200, result.body)
    assert.equal(result.json().messages.at(-1).citations[0].quote, '预算180万元')
  } finally {
    await h.close()
  }
})

test('concurrent duplicate parses reuse a live attempt; expired attempt cannot overwrite recovered success', async () => {
  let entered, releaseFirst
  const started = new Promise((resolve) => (entered = resolve)),
    held = new Promise((resolve) => (releaseFirst = resolve))
  let count = 0
  const { extractDocument } = await import('../apps/api/src/archive/extract.mjs')
  const h = await setup(async (input) => {
    count++
    if (count === 1) {
      entered()
      await held
    }
    return extractDocument(input)
  })
  let first
  try {
    const id = await h.upload('lease.docx', await makeDocx({ paragraphs: ['租约测试180万元。'] }))
    first = h.request('POST', `/archive/documents/${id}/parse`, {})
    await started
    const duplicate = await h.request('POST', `/archive/documents/${id}/parse`, {})
    assert.equal(duplicate.json().document.state, 'processing')
    assert.equal(count, 1)
    const list = await h.request('GET', '/archive/documents')
    assert.equal(list.statusCode, 200)
    assert.equal(list.json().items[0].state, 'processing')
    await h.query(
      "UPDATE archive_documents SET lease_until=now()-interval '1 second' WHERE file_id=$1",
      [id],
    )
    const recovered = await h.request('GET', `/archive/documents/${id}`)
    assert.equal(recovered.json().document.state, 'failed')
    assert.match(recovered.json().document.error, /重试/)
    const retry = await h.request('POST', `/archive/documents/${id}/parse`, {})
    assert.equal(retry.json().document.state, 'ready', retry.body)
    const snapshot = (await h.query('SELECT * FROM archive_documents WHERE file_id=$1', [id]))
      .rows[0]
    releaseFirst()
    assert.equal((await first).json().document.state, 'ready')
    assert.deepEqual(
      (await h.query('SELECT * FROM archive_documents WHERE file_id=$1', [id])).rows[0],
      snapshot,
    )
    assert.equal(snapshot.attempts, 2)
    assert.equal(count, 2)
    assert.equal(
      (await h.request('POST', `/archive/documents/${id}/parse`, {})).json().document.extractionId,
      snapshot.id,
    )
    assert.equal(count, 2)
  } finally {
    releaseFirst()
    if (first) await first
    await h.close()
  }
})

test('worker timeout and process capacity fail visibly and permit retry without holding transactions', async () => {
  const { createDocumentParser } = await import('../apps/api/src/archive/worker.mjs')
  let parser = createDocumentParser({ timeoutMs: 1 })
  const h = await setup((input) => parser(input))
  try {
    const id = await h.upload('timeout.docx', await makeDocx({ paragraphs: ['可重试解析。'] }))
    const timed = await h.request('POST', `/archive/documents/${id}/parse`, {})
    assert.equal(timed.json().document.state, 'failed')
    assert.match(timed.json().document.error, /超|重试/)
    parser = createDocumentParser()
    assert.equal(
      (await h.request('POST', `/archive/documents/${id}/parse`, {})).json().document.state,
      'ready',
    )
    const input = { name: 'capacity.docx', bytes: await makeDocx({ paragraphs: ['并行解析。'] }) }
    const first = parser(input),
      second = parser(input)
    await assert.rejects(parser(input), { statusCode: 429 })
    await Promise.all([first, second])
  } finally {
    await h.close()
  }
})

test('database FORCE RLS enforces tenant AND user and prevents successful source rewrites', async () => {
  const h = await setup()
  try {
    const id = await h.upload('private.docx', await makeDocx())
    await h.request('POST', `/archive/documents/${id}/parse`, {})
    assert.deepEqual(
      (
        await h.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='archive_documents'",
        )
      ).rows[0],
      { relrowsecurity: true, relforcerowsecurity: true },
    )
    await assert.rejects(
      h.query("UPDATE archive_documents SET blocks='[]' WHERE file_id=$1", [id]),
      /immutable/,
    )
    await h.query(
      'CREATE ROLE archive_private_reader NOLOGIN; GRANT SELECT ON archive_documents TO archive_private_reader; SET ROLE archive_private_reader',
    )
    try {
      assert.equal((await h.query('SELECT * FROM archive_documents')).rows.length, 0)
      for (const [tenant, user, want] of [
        [h.tenant, h.alice, 1],
        [h.tenant, h.bob, 0],
        [h.other, h.alice, 0],
      ]) {
        await h.query('BEGIN')
        await h.query(
          "SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
          [tenant, user],
        )
        assert.equal((await h.query('SELECT * FROM archive_documents')).rows.length, want)
        await h.query('COMMIT')
      }
    } finally {
      await h.query('RESET ROLE')
    }
  } finally {
    await h.close()
  }
})
