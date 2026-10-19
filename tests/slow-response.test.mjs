import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { setTimeout as delay } from 'node:timers/promises'
import {
  registerSlowResponses,
  responseError,
  SLOW_RESPONSE_TYPE,
  slowResponseRoutes,
} from '../apps/api/src/slow-response.mjs'

const route = '/api/tenants/:tenantId/secretary/chat'
const path = '/api/tenants/example/secretary/chat'
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function fixture(t, handler, authorize = async () => {}, registeredRoute = route) {
  const app = Fastify({ logger: false })
  app.setErrorHandler((error, req, reply) => {
    const { status, data } = responseError(error, req, app)
    reply.code(status).send(data)
  })
  registerSlowResponses(app, { authorize, heartbeatMs: 15 })
  app.post(registeredRoute, handler)
  app.post('/ordinary', handler)
  await app.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => app.close())
  return { app, url: `http://127.0.0.1:${app.server.address().port}` }
}
const options = { method: 'POST', headers: { accept: SLOW_RESPONSE_TYPE } }
const frames = (text) => text.trim().split('\n').map(JSON.parse)

for (const action of ['parse', 'filing'])
  test(`archive ${action} heartbeat keeps the awaited JSON result until persistence`, async (t) => {
    const work = deferred()
    const { url } = await fixture(
      t,
      () => work.promise,
      undefined,
      `/api/tenants/:tenantId/archive/documents/:fileId/${action}`,
    )
    const response = await fetch(
      url + `/api/tenants/example/archive/documents/file/${action}`,
      options,
    )
    const reader = response.body.getReader()
    assert.equal(frames(new TextDecoder().decode((await reader.read()).value))[0].type, 'heartbeat')
    work.resolve({ document: { state: 'ready', ocr: true } })
    let text = ''
    while (true) {
      const next = await reader.read()
      if (next.done) break
      text += new TextDecoder().decode(next.value)
    }
    assert.deepEqual(frames(text).at(-1), {
      type: 'result',
      status: 200,
      data: { document: { state: 'ready', ocr: true } },
    })
  })

test(
  'slow response sends heartbeat before work completes and returns the persisted result once',
  { timeout: 5000 },
  async (t) => {
    const work = deferred()
    let calls = 0,
      persisted = false,
      authorized = false
    const { url } = await fixture(
      t,
      async () => {
        assert.equal(authorized, true)
        calls++
        const result = await work.promise
        persisted = true
        return result
      },
      async () => {
        authorized = true
      },
    )
    const response = await fetch(url + path, options)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/x-office-response\+ndjson/)
    assert.equal(response.headers.get('cache-control'), 'no-store, no-transform')
    const reader = response.body.getReader()
    assert.equal(frames(new TextDecoder().decode((await reader.read()).value))[0].type, 'heartbeat')
    assert.equal(persisted, false)
    work.resolve({ task: 'saved', text: '中文结果' })
    let text = ''
    while (true) {
      const next = await reader.read()
      if (next.done) break
      text += new TextDecoder().decode(next.value)
    }
    assert.deepEqual(frames(text).at(-1), {
      type: 'result',
      status: 200,
      data: { task: 'saved', text: '中文结果' },
    })
    assert.equal(persisted, true)
    assert.equal(calls, 1)
  },
)

test('slow exposed failures preserve their actual status and hidden failures do not leak internals', async (t) => {
  for (const exposed of [true, false]) {
    await t.test(String(exposed), async (t) => {
      const work = deferred()
      const { url } = await fixture(t, () => work.promise)
      const response = await fetch(url + path, options)
      work.reject(
        Object.assign(new Error(exposed ? '需要核对模型额度' : 'private-provider-key'), {
          statusCode: 502,
          expose: exposed,
        }),
      )
      const result = frames(await response.text()).at(-1)
      assert.equal(result.status, 502)
      assert.equal(result.data.error, exposed ? '需要核对模型额度' : '服务暂时不可用，请稍后重试')
      assert.ok(result.data.requestId)
    })
  }
})

test('fast requests and clients without explicit negotiation keep ordinary HTTP JSON', async (t) => {
  const { app } = await fixture(t, async (_req, reply) => {
    reply.code(201)
    return { saved: true }
  })
  for (const accept of [SLOW_RESPONSE_TYPE, 'application/json', `${SLOW_RESPONSE_TYPE};q=0`]) {
    const response = await app.inject({ method: 'POST', url: path, headers: { accept } })
    assert.equal(response.statusCode, 201)
    assert.match(response.headers['content-type'], /application\/json/)
    assert.deepEqual(response.json(), { saved: true })
  }
})

test('authorization is completed before any heartbeat or handler invocation', async (t) => {
  let calls = 0
  const { url } = await fixture(
    t,
    async () => {
      calls++
      return {}
    },
    async () => {
      await delay(40)
      throw Object.assign(new Error('没有企业访问权限'), { statusCode: 403 })
    },
  )
  const response = await fetch(url + path, options)
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error, '没有企业访问权限')
  assert.equal(calls, 0)
})

test(
  'browser disconnect does not restart or cancel work already accepted by the handler',
  { timeout: 5000 },
  async (t) => {
    const work = deferred(),
      saved = deferred()
    let calls = 0
    const { url } = await fixture(t, async () => {
      calls++
      await work.promise
      saved.resolve()
      return { saved: true }
    })
    const controller = new AbortController()
    const response = await fetch(url + path, { ...options, signal: controller.signal })
    await response.body.getReader().read()
    controller.abort()
    work.resolve()
    await saved.promise
    await delay(20)
    assert.equal(calls, 1)
  },
)

test('non-model routes are not converted even with the negotiation header', async (t) => {
  const { url } = await fixture(t, async () => {
    await delay(40)
    return { ordinary: true }
  })
  const response = await fetch(url + '/ordinary', options)
  assert.match(response.headers.get('content-type'), /application\/json/)
  assert.deepEqual(await response.json(), { ordinary: true })
})

test('all synchronous browser model entry points are covered without wrapping upstream SSE', () => {
  for (const suffix of [
    'secretary/chat',
    'secretary/brief',
    'secretary/tasks/:id/run',
    'departments/:department/chat',
    'departments/:department/messages',
    'agent-builder',
    'agents/:agentId/messages',
    'archive/documents/:fileId/parse',
  ])
    assert.ok(slowResponseRoutes.has(`/api/tenants/:tenantId/${suffix}`), suffix)
  assert.equal(slowResponseRoutes.has('/api/tenants/:tenantId/operations/tasks'), false)
})
