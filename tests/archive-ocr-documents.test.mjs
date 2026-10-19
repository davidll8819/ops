import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID, createHash } from 'node:crypto'
import { readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import Fastify from 'fastify'
import { registerArchiveRoutes } from '../apps/api/src/archive/routes.mjs'
import { migrate } from '../database/migrate.mjs'
import { buildApp } from '../apps/api/src/app.mjs'
import { hash } from '../apps/api/src/auth.mjs'
import { defaultPolicy } from '../apps/api/src/operations/policy.mjs'
import { encryptConfig } from '../apps/api/src/operations/security.mjs'
import { makeDocx, makePdf, makeXlsx } from './helpers/archive-fixtures.mjs'
import { rasterFixture, scanPdf } from './helpers/archive-ocr-fixtures.mjs'
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
const ocrResult = (kind = 'image') => ({
  kind,
  blocks: [
    {
      id: 'b1',
      location: kind === 'image' ? '图片第 1 页（OCR）' : '第 2 页（OCR）',
      text: '合同金额为180万元。',
      method: 'ocr',
      page: kind === 'image' ? 1 : 2,
    },
  ],
  warnings: ['OCR 识别可能有误，请核对原件。'],
  stats: {
    ocr: {
      engine: 'tesseract.js',
      version: '7.0.0',
      languages: ['chi_sim', 'eng'],
      pages: 1,
      lowConfidencePages: [],
    },
  },
})
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('OCR progress is visible before parse completes, ordered, bounded and fenced after readiness', async () => {
  const entered = deferred(),
    release = deferred()
  let callback
  const parser = async (_input, { onProgress } = {}) => {
    callback = onProgress
    entered.resolve()
    onProgress({ stage: 'extracting', page: 1, totalPages: 2 })
    onProgress({ stage: 'ocr', page: 2, totalPages: 2 })
    await release.promise
    return ocrResult('pdf')
  }
  const h = await setup(parser)
  let pending
  try {
    const id = await h.upload('scan.pdf', makePdf())
    pending = h.request('POST', `/archive/documents/${id}/parse`, {})
    await entered.promise
    // The read is queued behind both short progress transactions.
    await callback({ stage: 'ocr', page: 2, totalPages: 2 })
    const listed = (await h.request('GET', '/archive/documents')).json().items[0]
    assert.deepEqual(listed.progress, { stage: 'ocr', page: 2, totalPages: 2 })
    assert.equal('blocks' in listed, false)
    await callback({ stage: 'ocr', page: 999999, totalPages: 2, secret: 'no' })
    const row = (await h.query('SELECT * FROM archive_documents WHERE file_id=$1', [id])).rows[0]
    assert.ok(new Date(row.lease_until) - new Date(row.updated_at) > 350000)
    release.resolve()
    assert.equal((await pending).json().document.ocr, true)
    const ready = (await h.query('SELECT * FROM archive_documents WHERE file_id=$1', [id])).rows[0]
    await callback({ stage: 'extracting', page: 1, totalPages: 2 })
    assert.deepEqual(
      (await h.query('SELECT * FROM archive_documents WHERE file_id=$1', [id])).rows[0],
      ready,
    )
    assert.equal(
      (await h.request('GET', `/archive/documents/${id}`)).json().document.progress,
      undefined,
    )
  } finally {
    release.resolve()
    if (pending) await pending
    await h.close()
  }
})

test('migration retries archive-1 failures with archive-2, image kind and immutable old ready rows', async () => {
  const h = await setup(async () => ocrResult())
  try {
    const id = await h.upload('scan.PNG', Buffer.from('original raster bytes'))
    const extractionId = randomUUID(),
      attempt = randomUUID()
    await h.query(
      "INSERT INTO archive_documents(id,file_id,tenant_id,user_id,sha256,parser_version,state,attempt_id,error) VALUES($1,$2,$3,$4,$5,'archive-1','failed',$6,'old parser')",
      [extractionId, id, h.tenant, h.alice, 'a'.repeat(64), attempt],
    )
    const response = await h.request('POST', `/archive/documents/${id}/parse`, {})
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().document.state, 'ready', response.body)
    assert.equal(response.json().document.kind, 'image')
    const row = (await h.query('SELECT * FROM archive_documents WHERE file_id=$1', [id])).rows[0]
    assert.equal(row.parser_version, 'archive-2')
    assert.equal(row.id, extractionId)
    await assert.rejects(
      h.query("UPDATE archive_documents SET parser_version='archive-3' WHERE file_id=$1", [id]),
      /immutable/,
    )
    await assert.rejects(
      h.query('UPDATE archive_documents SET sha256=$2 WHERE file_id=$1', [id, 'b'.repeat(64)]),
      /immutable/,
    )
    assert.equal((await h.request('GET', `/files/${id}/download`)).body, 'original raster bytes')
    const oldId = await h.upload('old-ready.pdf', makePdf())
    await h.query(
      "INSERT INTO archive_documents(id,file_id,tenant_id,user_id,sha256,parser_version,kind,state,attempt_id,blocks) VALUES($1,$2,$3,$4,$5,'archive-1','pdf','ready',$6,$7)",
      [
        randomUUID(),
        oldId,
        h.tenant,
        h.alice,
        'c'.repeat(64),
        randomUUID(),
        JSON.stringify([{ id: 'old', location: '第 1 页', text: '旧的不可变来源' }]),
      ],
    )
    const oldReady = (await h.query('SELECT * FROM archive_documents WHERE file_id=$1', [oldId]))
      .rows[0]
    assert.equal(
      (await h.request('POST', `/archive/documents/${oldId}/parse`, {})).json().document.ocr,
      false,
    )
    assert.deepEqual(
      (await h.query('SELECT * FROM archive_documents WHERE file_id=$1', [oldId])).rows[0],
      oldReady,
    )
  } finally {
    await h.close()
  }
})

test('private OCR image and PDF chat persists server-owned source labels and caution after reload', async () => {
  const h = await setup(async ({ name }) => ocrResult(name.endsWith('.pdf') ? 'pdf' : 'image'))
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
    const image = await h.upload('receipt.png', png),
      pdf = await h.upload('scan.pdf', makePdf())
    for (const id of [image, pdf])
      assert.equal(
        (await h.request('POST', `/archive/documents/${id}/parse`, {})).json().document.state,
        'ready',
      )
    h.setAnswer((body) => {
      const source = sources(body)
      assert.equal(source.length, 2)
      assert.match(
        body.messages.find((m) => m.role === 'system' && m.content.includes('最终约束')).content,
        /OCR.*数字/,
      )
      return JSON.stringify({
        claims: source.map((s) => ({
          text: '金额为180万元。',
          citations: [{ sourceId: s.sourceId, quote: '金额为180万元' }],
        })),
        notFound: false,
      })
    })
    const response = await h.request('POST', '/departments/archive/chat', {
      text: '金额？',
      revision: 0,
      fileIds: [image, pdf],
    })
    assert.equal(response.statusCode, 200, response.body)
    const saved = response.json(),
      answer = saved.messages.at(-1)
    assert.deepEqual(
      answer.citations.map((c) => [c.method, c.page]),
      [
        ['ocr', 1],
        ['ocr', 2],
      ],
    )
    assert.match(answer.documentCoverage, /OCR.*识别文字摘录.*数字/)
    assert.deepEqual((await h.request('GET', '/departments/archive/conversation')).json(), saved)
    assert.equal(
      (await h.request('GET', `/files/${image}/preview`)).headers['content-type'],
      'image/png',
    )
    for (const id of [image, pdf]) {
      assert.equal(
        (await h.request('GET', `/archive/documents/${id}`, undefined, h.bob)).statusCode,
        404,
      )
      assert.equal(
        (await h.request('GET', `/api/tenants/${h.other}/archive/documents/${id}`)).statusCode,
        404,
      )
    }
    assert.equal(
      (await h.request('GET', `/files/${image}/preview`, undefined, h.bob)).statusCode,
      404,
    )
    const blocked = await h.request(
      'POST',
      '/departments/archive/chat',
      { text: '金额？', revision: 1, fileIds: [image] },
      h.bob,
    )
    assert.equal(blocked.statusCode, 404)
  } finally {
    await h.close()
  }
})

test('owned parser close kills actual children, rejects active work, frees global capacity and forbids restart', async () => {
  const { createDocumentParser } = await import('../apps/api/src/archive/worker.mjs')
  const parser = createDocumentParser({ timeoutMs: 30000 }),
    other = createDocumentParser()
  const input = { name: 'close.docx', bytes: await makeDocx({ paragraphs: ['close worker'] }) }
  const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('archive-ocr-parser-')))
  const first = parser(input),
    second = parser(input)
  const outcomes = Promise.allSettled([first, second])
  try {
    await assert.rejects(other(input), { statusCode: 429 })
    const children = process
      ._getActiveHandles()
      .filter((h) => h.constructor.name === 'ChildProcess')
    assert.equal(children.length, 2)
    const temporary = readdirSync(tmpdir()).filter(
      (n) => n.startsWith('archive-ocr-parser-') && !before.has(n),
    )
    assert.equal(temporary.length, 2)
    assert.equal(typeof parser.close, 'function')
    await parser.close()
    assert.ok(temporary.every((name) => !existsSync(join(tmpdir(), name))))
    for (const child of children) {
      assert.ok(child.exitCode !== null || child.signalCode !== null)
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
    }
    assert.ok((await outcomes).every((r) => r.status === 'rejected'))
    await assert.rejects(parser(input), /关闭/)
    assert.equal((await other(input)).kind, 'docx')
  } finally {
    await parser.close?.()
    await other.close?.()
    await outcomes
  }
})

test('OCR timeout override applies independently of ordinary timeout and permits retry with actual children', async () => {
  const { createDocumentParser } = await import('../apps/api/src/archive/worker.mjs')
  const parser = createDocumentParser({ timeoutMs: 30000, ocrTimeoutMs: 1 })
  try {
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('archive-ocr-parser-')))
    const timeout = parser({ name: 'deadline.pdf', bytes: makePdf() })
    const temporary = readdirSync(tmpdir()).filter(
      (n) => n.startsWith('archive-ocr-parser-') && !before.has(n),
    )
    assert.equal(temporary.length, 1)
    await assert.rejects(timeout, { statusCode: 408 })
    assert.ok(temporary.every((name) => !existsSync(join(tmpdir(), name))))
    assert.equal((await parser({ name: 'retry.docx', bytes: await makeDocx() })).kind, 'docx')
  } finally {
    await parser.close?.()
  }
})

test(
  'deadline cancels a received actual child result while progress is stalled and releases capacity',
  { timeout: 12000 },
  async () => {
    const { createDocumentParser } = await import('../apps/api/src/archive/worker.mjs')
    const parser = createDocumentParser({ timeoutMs: 3000 }),
      held = deferred(),
      entered = deferred()
    let released = false
    const input = { name: 'stalled-deadline.docx', bytes: await makeDocx() }
    const started = Date.now()
    const pending = parser(input, {
      onProgress: () => {
        entered.resolve()
        return held.promise
      },
    })
    const outcome = pending.then(
      (result) => ({ result }),
      (error) => ({ error }),
    )
    const child = process._getActiveHandles().find((h) => h.constructor.name === 'ChildProcess')
    const fallback = setTimeout(() => {
      released = true
      held.resolve()
    }, 4000)
    try {
      await entered.promise
      const result = await outcome
      assert.equal(result.error?.statusCode, 408)
      assert.equal(released, false)
      assert.ok(Date.now() - started < 3700)
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
      const retry = createDocumentParser()
      try {
        assert.equal((await retry(input)).kind, 'docx')
      } finally {
        await retry.close()
      }
    } finally {
      clearTimeout(fallback)
      held.resolve()
      await outcome
      await parser.close()
    }
  },
)

test(
  'close cancels a received actual result without waiting for held progress or starting queued callbacks',
  { timeout: 12000 },
  async () => {
    const { createDocumentParser } = await import('../apps/api/src/archive/worker.mjs')
    const parser = createDocumentParser(),
      held = deferred(),
      entered = deferred()
    let calls = 0
    const pending = parser(
      {
        name: 'stalled-close.pdf',
        bytes: makePdf({
          pages: ['First page with extracted text', 'Second page with extracted text'],
        }),
      },
      {
        onProgress: () => {
          calls++
          entered.resolve()
          return held.promise
        },
      },
    )
    const outcome = pending.then(
      (result) => ({ result }),
      (error) => ({ error }),
    )
    const child = process._getActiveHandles().find((h) => h.constructor.name === 'ChildProcess')
    const exited = once(child, 'exit')
    let closing
    const fallback = setTimeout(() => held.resolve(), 4000)
    try {
      await entered.promise
      await exited // Success result has arrived, but its first progress write is still held.
      closing = parser.close()
      const closed = await Promise.race([
        closing.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 500)),
      ])
      assert.equal(closed, true)
      assert.equal((await outcome).error?.statusCode, 503)
      assert.equal(calls, 1)
      held.resolve()
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(calls, 1)
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
    } finally {
      clearTimeout(fallback)
      held.resolve()
      await outcome
      if (closing) await closing
      await parser.close()
    }
  },
)

test(
  'parse route persists deadline failure without reawaiting a stalled progress callback',
  { timeout: 12000 },
  async () => {
    const { createDocumentParser } = await import('../apps/api/src/archive/worker.mjs')
    const h = await setup(),
      app = Fastify({ logger: false }),
      held = deferred(),
      entered = deferred(),
      flushed = deferred()
    let released = false
    const parser = createDocumentParser({ timeoutMs: 3000 })
    registerArchiveRoutes(app, {
      documentParser: parser,
      scoped: (_req, fn) =>
        fn(
          {
            query: async (sql, params) => {
              if (sql.startsWith('UPDATE archive_documents SET progress=')) {
                entered.resolve()
                await held.promise
                try {
                  return await h.query(sql, params)
                } finally {
                  flushed.resolve()
                }
              }
              return h.query(sql, params)
            },
          },
          null,
          { tenantId: h.tenant, userId: h.alice },
        ),
    })
    const fallback = setTimeout(() => {
      released = true
      held.resolve()
    }, 4000)
    try {
      const id = await h.upload('route-stalled.docx', await makeDocx())
      const pending = app.inject({
        method: 'POST',
        url: `${h.base}/archive/documents/${id}/parse`,
        payload: {},
      })
      await entered.promise
      const response = await pending
      assert.equal(response.json().document.state, 'failed', response.body)
      assert.equal(released, false)
      const failed = (await h.query('SELECT * FROM archive_documents WHERE file_id=$1', [id]))
        .rows[0]
      held.resolve()
      await flushed.promise
      assert.deepEqual(
        (await h.query('SELECT * FROM archive_documents WHERE file_id=$1', [id])).rows[0],
        failed,
      )
    } finally {
      clearTimeout(fallback)
      held.resolve()
      await app.close()
      await h.close()
    }
  },
)

test(
  'forced close during actual OCR removes staged language resources and all child capacity',
  { timeout: 30000 },
  async () => {
    const { createDocumentParser } = await import('../apps/api/src/archive/worker.mjs')
    const parser = createDocumentParser(),
      stage = deferred()
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('archive-ocr-parser-')))
    const pending = parser(
      { name: 'interrupt.png', bytes: await rasterFixture('png') },
      {
        onProgress: (value) => {
          if (value.stage === 'ocr') stage.resolve()
        },
      },
    )
    const outcome = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    try {
      await Promise.race([
        stage.promise,
        outcome.then(() => {
          throw new Error('OCR never started')
        }),
      ])
      const temporary = readdirSync(tmpdir()).filter(
        (n) => n.startsWith('archive-ocr-parser-') && !before.has(n),
      )
      assert.equal(temporary.length, 1)
      const directory = join(tmpdir(), temporary[0])
      let staged = false
      for (let attempt = 0; attempt < 100; attempt++) {
        staged = readdirSync(directory).some(
          (n) =>
            n.startsWith('archive-ocr-') &&
            readdirSync(join(directory, n)).filter((f) => f.endsWith('.traineddata.gz')).length ===
              2,
        )
        if (staged) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(staged, true)
      const child = process._getActiveHandles().find((h) => h.constructor.name === 'ChildProcess')
      assert.ok(child)
      await parser.close()
      assert.equal((await outcome).error.statusCode, 503)
      assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
      assert.equal(existsSync(directory), false)
      const retry = createDocumentParser()
      try {
        assert.equal(
          (await retry({ name: 'after-close.docx', bytes: await makeDocx() })).kind,
          'docx',
        )
      } finally {
        await retry.close()
      }
    } finally {
      await parser.close()
      await outcome
    }
  },
)

test('expired and superseded progress cannot change another attempt even while both parsers run', async () => {
  const starts = [deferred(), deferred()],
    holds = [deferred(), deferred()],
    callbacks = []
  const h = await setup(async (_input, { onProgress }) => {
    const index = callbacks.length
    callbacks.push(onProgress)
    starts[index].resolve()
    await holds[index].promise
    return ocrResult('pdf')
  })
  let first, second
  try {
    const id = await h.upload('fence.pdf', makePdf())
    first = h.request('POST', `/archive/documents/${id}/parse`, {})
    await starts[0].promise
    await callbacks[0]({ stage: 'extracting', page: 1, totalPages: 2 })
    await h.query(
      "UPDATE archive_documents SET lease_until=now()-interval '1 second' WHERE file_id=$1",
      [id],
    )
    await callbacks[0]({ stage: 'ocr', page: 2, totalPages: 2 })
    assert.deepEqual(
      (await h.query('SELECT progress FROM archive_documents WHERE file_id=$1', [id])).rows[0]
        .progress,
      { stage: 'extracting', page: 1, totalPages: 2 },
    )
    second = h.request('POST', `/archive/documents/${id}/parse`, {})
    await starts[1].promise
    await callbacks[1]({ stage: 'extracting', page: 1, totalPages: 2 })
    await callbacks[0]({ stage: 'ocr', page: 2, totalPages: 2 })
    assert.deepEqual(
      (await h.request('GET', `/archive/documents/${id}`)).json().document.progress,
      { stage: 'extracting', page: 1, totalPages: 2 },
    )
    holds[1].resolve()
    assert.equal((await second).json().document.state, 'ready')
    const ready = (await h.query('SELECT * FROM archive_documents WHERE file_id=$1', [id])).rows[0]
    holds[0].resolve()
    await first
    assert.deepEqual(
      (await h.query('SELECT * FROM archive_documents WHERE file_id=$1', [id])).rows[0],
      ready,
    )
  } finally {
    for (const hold of holds) hold.resolve()
    await Promise.all([first, second].filter(Boolean))
    await h.close()
  }
})

test('app close cancels its active actual parser before waiting for HTTP handlers', async () => {
  const { createDocumentParser } = await import('../apps/api/src/archive/worker.mjs')
  const parser = createDocumentParser(),
    entered = deferred()
  const injected = (input, options) => {
    const work = parser(input, options)
    entered.resolve()
    return work
  }
  injected.close = () => parser.close()
  const h = await setup(injected)
  let pending, closed
  try {
    const id = await h.upload('closing.pdf', makePdf())
    pending = h.request('POST', `/archive/documents/${id}/parse`, {})
    await entered.promise
    closed = h.app.close()
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('app close waited for parser')), 1000),
      ),
    ])
    assert.equal((await pending).json().document.state, 'failed')
  } finally {
    await parser.close()
    if (pending) await pending
    if (closed) await closed
    await h.close()
  }
})

test('app close releases an active network parse without waiting for the parse result', async () => {
  const entered = deferred(),
    release = deferred()
  const parser = async () => {
    entered.resolve()
    await release.promise
    return ocrResult('pdf')
  }
  parser.close = () => {
    release.resolve()
  }
  const h = await setup(parser)
  let pending, closing
  try {
    const id = await h.upload('network-close.pdf', makePdf())
    await h.app.listen({ host: '127.0.0.1', port: 0 })
    pending = fetch(
      `http://127.0.0.1:${h.app.server.address().port}${h.base}/archive/documents/${id}/parse`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `office_session=${h.alice}`,
          origin: 'https://archive.test',
          'x-csrf-token': h.alice,
        },
        body: '{}',
      },
    )
    await Promise.race([
      entered.promise,
      pending.then(async (r) => {
        throw new Error(await r.text())
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('parse never entered')), 3000)),
    ])
    closing = h.app.close()
    await Promise.race([
      closing,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('app close waited for active network parse')), 1000),
      ),
    ])
    assert.equal((await pending).status, 200)
  } finally {
    release.resolve()
    if (pending) await pending
    if (closing) await closing
    await h.close()
  }
})

test(
  'actual child OCR of Chinese image and mixed PDF persists verified sources using the configured text model',
  { timeout: 120000 },
  async () => {
    const h = await setup()
    try {
      const bytes = await rasterFixture('png')
      const image = await h.upload('actual-receipt.png', bytes)
      const pdf = await h.upload(
        'actual-mixed.pdf',
        await scanPdf({
          pages: [
            { text: 'Project terms remain subject to the original signed agreement and schedule.' },
            { image: true, text: 'Scanned appendix' },
          ],
        }),
      )
      for (const id of [image, pdf]) {
        const parsed = await h.request('POST', `/archive/documents/${id}/parse`, {})
        assert.equal(parsed.json().document.state, 'ready', parsed.body)
        assert.equal(parsed.json().document.ocr, true)
      }
      const original = (await h.request('GET', `/files/${image}/download`)).rawPayload
      assert.deepEqual(original, bytes)
      h.setAnswer((body) => {
        assert.ok(body.messages.every((m) => typeof m.content === 'string'))
        const ocrSources = sources(body).filter((s) => s.method === 'ocr')
        assert.equal(ocrSources.length, 2)
        assert.ok(ocrSources.every((s) => s.text.includes('2400')))
        return JSON.stringify({
          claims: ocrSources.map((s) => ({
            text: '采购预算为2400元。',
            citations: [{ sourceId: s.sourceId, quote: '2400' }],
          })),
          notFound: false,
        })
      })
      const answer = await h.request('POST', '/departments/archive/chat', {
        text: '两份资料的采购预算？',
        revision: 0,
        fileIds: [image, pdf],
      })
      assert.equal(answer.statusCode, 200, answer.body)
      assert.deepEqual(
        answer
          .json()
          .messages.at(-1)
          .citations.map((c) => [c.method, c.page]),
        [
          ['ocr', 1],
          ['ocr', 2],
        ],
      )
      assert.equal(h.requests.at(-1).model, 'archive-test-model')
      assert.deepEqual(
        (await h.request('GET', '/departments/archive/conversation')).json(),
        answer.json(),
      )
    } finally {
      await h.close()
    }
  },
)

test(
  'ready padded JPEG previews original bytes only for matching private extraction identity',
  { timeout: 30000 },
  async () => {
    const h = await setup()
    try {
      const bytes = Buffer.concat([await rasterFixture('jpg'), Buffer.from([0])])
      const id = await h.upload('padded-original.JPEG', bytes)
      assert.equal((await h.request('GET', `/files/${id}/preview`)).statusCode, 502)
      const parsed = await h.request('POST', `/archive/documents/${id}/parse`, {})
      assert.equal(parsed.json().document.state, 'ready', parsed.body)
      const preview = await h.request('GET', `/files/${id}/preview`)
      assert.equal(preview.statusCode, 200, preview.body)
      assert.equal(preview.headers['content-type'], 'image/jpeg')
      assert.equal(preview.headers['x-content-type-options'], 'nosniff')
      assert.equal(preview.headers['cache-control'], 'private, no-store')
      assert.deepEqual(preview.rawPayload, bytes)
      assert.equal(
        (await h.request('GET', `/files/${id}/preview`, undefined, h.bob)).statusCode,
        404,
      )
      assert.equal(
        (await h.request('GET', `/api/tenants/${h.other}/files/${id}/preview`)).statusCode,
        404,
      )
      await h.query('UPDATE workspace_files SET data=$2 WHERE id=$1', [
        id,
        Buffer.concat([bytes, Buffer.from([0])]),
      ])
      assert.equal((await h.request('GET', `/files/${id}/preview`)).statusCode, 502)
      const failed = await h.upload('failed-padded.jpg', bytes)
      await h.query(
        "INSERT INTO archive_documents(id,file_id,tenant_id,user_id,sha256,parser_version,kind,state,attempt_id,error) VALUES($1,$2,$3,$4,$5,'archive-2','image','failed',$6,'test failure')",
        [
          randomUUID(),
          failed,
          h.tenant,
          h.alice,
          createHash('sha256').update(bytes).digest('hex'),
          randomUUID(),
        ],
      )
      assert.equal((await h.request('GET', `/files/${failed}/preview`)).statusCode, 502)
    } finally {
      await h.close()
    }
  },
)
