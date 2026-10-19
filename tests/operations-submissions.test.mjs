import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setup } from './helpers/archive-api-fixture.mjs'
import { createOperationsTasks } from '../apps/api/src/operations/task-service.mjs'
const env = { OPERATIONS_CONFIG_KEY: Buffer.alloc(32, 9).toString('base64') }
const drain = async (s) => {
  for await (const _ of s) {
    /* drain */
  }
}

test('explicit null cancels an inherited video format at the runtime boundary', async () => {
  const h = await setup()
  let body
  try {
    const service = createOperationsTasks({
      pool: h.pool,
      env,
      driver: {
        ready: async () => ({}),
        request: async (_e, _s, _p, options) => {
          body = options.body
          return new ReadableStream({
            start(c) {
              c.close()
            },
          })
        },
      },
    })
    await drain(
      await service.start(
        { tenantId: h.tenant, userId: h.alice },
        { prompt: '取消规格', requestId: randomUUID(), videoFormat: null },
      ),
    )
    assert.equal(body.videoFormat, null)
  } finally {
    await h.close()
  }
})
test('private runtime tasks reject other members for list/detail/continue/abort', async () => {
  let requests = 0
  const id = 'd'.repeat(24),
    h = await setup(undefined, {
      operationsDriver: {
        ready: async () => ({}),
        request: async (_e, _s, path) => {
          requests++
          return path.includes('?')
            ? { list: [{ id, title: 'private plan' }] }
            : { status: 'completed', messages: [{ text: 'private secret' }] }
        },
      },
    })
  try {
    await h.query(
      "INSERT INTO operations_submissions(id,tenant_id,user_id,fingerprint,state,runtime_task_id) VALUES($1,$2,$3,'test','submitted',$4)",
      [randomUUID(), h.tenant, h.alice, id],
    )
    await h.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      h.tenant,
      h.bob,
    ])
    const owner = await h.request('GET', `/operations/tasks/${id}`)
    assert.equal(owner.statusCode, 200, owner.body)
    assert.equal(
      (await h.request('GET', `/operations/tasks/${id}`, undefined, h.bob)).statusCode,
      404,
    )
    assert.equal(
      (await h.request('POST', `/operations/tasks/${id}/abort`, {}, h.bob)).statusCode,
      404,
    )
    assert.equal(
      (await h.request('GET', '/operations/tasks', undefined, h.bob)).json().list.length,
      0,
    )
    const before = requests
    const continued = await h.request(
      'POST',
      '/operations/tasks',
      { prompt: 'continue', taskId: id, requestId: randomUUID() },
      h.bob,
    )
    assert.equal(continued.statusCode, 404, continued.body)
    assert.equal(requests, before)
  } finally {
    await h.close()
  }
})
test('submission is reserved before delayed readiness and known preflight failures are terminal', async () => {
  const h = await setup()
  let release, entered
  const started = new Promise((r) => (entered = r)),
    held = new Promise((r) => (release = r))
  try {
    const ctx = { tenantId: h.tenant, userId: h.alice },
      input = { prompt: 'preview', requestId: randomUUID() }
    let calls = 0
    const service = createOperationsTasks({
      pool: h.pool,
      env,
      driver: {
        ready: async () => {
          entered()
          await held
          throw new Error('not ready')
        },
        request: async () => {
          calls++
        },
      },
    })
    const pending = service.start(ctx, input)
    await started
    const row = (
      await h.query('SELECT state FROM operations_submissions WHERE id=$1', [input.requestId])
    ).rows[0]
    assert.equal(row?.state, 'reserved')
    release()
    await assert.rejects(pending, /not ready/)
    assert.equal(calls, 0)
    assert.equal(
      (await h.query('SELECT state FROM operations_submissions WHERE id=$1', [input.requestId]))
        .rows[0].state,
      'failed',
    )
  } finally {
    release?.()
    await h.close()
  }
})
test('direct operations reserves a private request once; SSE EOF is not completion and saved context reaches runtime', async () => {
  const h = await setup()
  try {
    const ctx = { tenantId: h.tenant, userId: h.alice },
      id = randomUUID(),
      messageId = randomUUID()
    await h.query(
      "INSERT INTO operations_briefs(id,tenant_id,user_id,source_message_id,source_revision,title,text,messages) VALUES($1,$2,$3,$4,1,'plan','30秒，不发布','[]')",
      [id, h.tenant, h.alice, messageId],
    )
    let calls = 0,
      body
    const service = createOperationsTasks({
      pool: h.pool,
      env,
      driver: {
        ready: async () => ({}),
        request: async (_e, _s, _p, o) => {
          calls++
          body = o.body
          return new ReadableStream({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  'data: ' + JSON.stringify({ taskId: 'a'.repeat(24), text: '制作中' }) + '\n\n',
                ),
              )
              c.close()
            },
          })
        },
      },
    })
    const input = {
      prompt: '改成15秒，只预览',
      briefId: id,
      requestId: randomUUID(),
      videoFormat: { ratio: '9:16', resolution: '720p' },
    }
    const stream = await service.start(ctx, input)
    await assert.rejects(service.start(ctx, input), (e) => e.statusCode === 409)
    await drain(stream)
    assert.equal(calls, 1)
    assert.match(JSON.stringify(body.prompt), /30秒，不发布/)
    assert.match(JSON.stringify(body.prompt), /15秒/)
    assert.deepEqual(body.videoFormat, { ratio: '9:16', resolution: '720p' })
    const row = (
      await h.query('SELECT * FROM operations_submissions WHERE id=$1', [input.requestId])
    ).rows[0]
    assert.equal(row.state, 'submitted')
    assert.equal(row.runtime_task_id, 'a'.repeat(24))
    await assert.rejects(
      service.start(ctx, { ...input, prompt: 'changed' }),
      (e) => e.statusCode === 409,
    )
    assert.equal(calls, 1)
    await assert.rejects(
      service.start({ ...ctx, userId: h.bob }, input),
      (e) => e.statusCode === 403,
    )
    await assert.rejects(service.start({ ...ctx, tenantId: h.other }, input), (e) =>
      [404, 409].includes(e.statusCode),
    )
  } finally {
    await h.close()
  }
})
test('simultaneous requests make one provider call and private recovery survives reopening', async () => {
  const h = await setup()
  try {
    let calls = 0
    const service = createOperationsTasks({
        pool: h.pool,
        env,
        driver: {
          ready: async () => ({}),
          request: async () => {
            calls++
            return new ReadableStream({
              start(c) {
                c.close()
              },
            })
          },
        },
      }),
      ctx = { tenantId: h.tenant, userId: h.alice },
      input = { prompt: '预览', requestId: randomUUID() }
    const results = await Promise.allSettled([service.start(ctx, input), service.start(ctx, input)])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal(calls, 1)
    await drain(results.find((r) => r.status === 'fulfilled').value)
    const status = await h.request('GET', `/operations/submissions/${input.requestId}`)
    assert.equal(status.statusCode, 200, status.body)
    assert.equal(status.json().submission.state, 'uncertain')
    assert.equal(
      (await h.request('GET', `/operations/submissions/${input.requestId}`, undefined, h.bob))
        .statusCode,
      404,
    )
    assert.equal(
      (await h.request('GET', `/api/tenants/${h.other}/operations/submissions/${input.requestId}`))
        .statusCode,
      404,
    )
    assert.equal((await h.request('GET', '/operations/submissions')).json().items.length, 1)
    assert.equal(
      (await h.request('GET', '/operations/submissions', undefined, h.bob)).json().items.length,
      0,
    )
  } finally {
    await h.close()
  }
})
test('unknown direct submission cannot be retried after transport failure or empty stream', async () => {
  const h = await setup()
  try {
    let calls = 0
    const service = createOperationsTasks({
        pool: h.pool,
        env,
        driver: {
          ready: async () => ({}),
          request: async () => {
            calls++
            throw new Error('transport failed')
          },
        },
      }),
      ctx = { tenantId: h.tenant, userId: h.alice },
      input = { prompt: '预览', requestId: randomUUID() }
    await assert.rejects(service.start(ctx, input), /transport failed/)
    await assert.rejects(service.start(ctx, input), (e) => e.statusCode === 409)
    assert.equal(calls, 1)
    assert.equal(
      (await h.query('SELECT state FROM operations_submissions WHERE id=$1', [input.requestId]))
        .rows[0].state,
      'uncertain',
    )
    const empty = createOperationsTasks({
        pool: h.pool,
        env,
        driver: {
          ready: async () => ({}),
          request: async () =>
            new ReadableStream({
              start(c) {
                c.close()
              },
            }),
        },
      }),
      next = { ...input, requestId: randomUUID() }
    await drain(await empty.start(ctx, next))
    assert.equal(
      (await h.query('SELECT state FROM operations_submissions WHERE id=$1', [next.requestId]))
        .rows[0].state,
      'uncertain',
    )
  } finally {
    await h.close()
  }
})
