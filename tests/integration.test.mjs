import { createDepartmentEngine } from '../apps/api/src/department-engine.mjs'
import { createOperationsTasks } from '../apps/api/src/operations/task-service.mjs'
import { createResearchEngine } from '../apps/api/src/research/engine.mjs'
import { createModelWebTools } from '../apps/api/src/research/model-web.mjs'
import { createModelGateway } from '../apps/api/src/operations/gateway.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { migrate } from '../database/migrate.mjs'
import { buildApp } from '../apps/api/src/app.mjs'
import { signBridge } from '../apps/api/src/operations/security.mjs'
import { defaultPolicy, secretNames, gatewayToken } from '../apps/api/src/operations/policy.mjs'
import { reserveTokens, settleTokens, budgetDay } from '../apps/api/src/operations/budget.mjs'
import { deliverReminders } from '../apps/api/src/reminders.mjs'
import { hash } from '../apps/api/src/auth.mjs'
import { SLOW_RESPONSE_TYPE } from '../apps/api/src/slow-response.mjs'
// Real PostgreSQL engine compiled to WASM; Redis is replaced only in this isolated test suite.
class TestCache {
  values = new Map()
  async get(k) {
    return this.values.get(k) || null
  }
  async getDel(k) {
    const v = await this.get(k)
    this.values.delete(k)
    return v
  }
  async set(k, v, opts = {}) {
    if (opts.NX && this.values.has(k)) return null
    this.values.set(k, v)
    return 'OK'
  }
  async del(k) {
    return Number(this.values.delete(k))
  }
  async ping() {
    return 'PONG'
  }
  async eval(script, { keys, arguments: args }) {
    if (script.includes('INCR')) {
      const n = Number((await this.get(keys[0])) || 0) + 1
      await this.set(keys[0], String(n))
      return n
    }
    if ((await this.get(keys[0])) === args[0]) return this.del(keys[0])
    return 0
  }
}
await test('authenticated multi-tenant API and PostgreSQL isolation', async (t) => {
  const pg = new PGlite()
  await pg.waitReady
  let release = Promise.resolve()
  const query = async (sql, params) => {
    if (!params) {
      const r = await pg.exec(sql)
      return { ...r.at(-1), rowCount: r.at(-1)?.affectedRows || 0 }
    }
    const r = await pg.query(sql, params)
    return { ...r, rowCount: r.affectedRows || 0 }
  }
  const pool = {
    query,
    connect: async () => {
      const prev = release
      let unlock
      release = new Promise((r) => (unlock = r))
      await prev
      return { query, release: unlock }
    },
  }
  await migrate(pool)
  const cache = new TestCache()
  let calls = 0
  const agentDriver = {
    models: ['test-model'],
    rates: { 'test-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 8 } },
    invoke: async () => {
      calls++
      return {
        text: 'verified mock transport response',
        usage: { inputTokens: 100, outputTokens: 10 },
      }
    },
    generate: async () => ({ profile, usage: { inputTokens: 10, outputTokens: 20 } }),
  }
  const profile = {
    name: '测试助手',
    systemPrompt: '这是用于验证隔离的助手配置',
    modelId: 'test-model',
    maxTokens: 2048,
    temperature: 0.4,
    memory: true,
  }
  const env = {
    APP_ORIGIN: 'https://example.test',
    NODE_ENV: 'test',
    BUILDER_MODEL_ID: 'test-model',
    LOG_LEVEL: 'silent',
    OPERATIONS_CONFIG_KEY: Buffer.alloc(32, 7).toString('base64'),
  }
  let publishCalls = 0,
    uncertainPublish = false,
    runtimeUnavailable = false
  let operationsTaskState = 'running',
    operationsStarts = 0
  const operationsDriver = {
    binding: async (tenantId) => ({ tenantId, bridgeSecret: 'test-bridge-secret' }),
    ready: async (tenantId) => {
      if (runtimeUnavailable) throw new Error('offline')
      return { tenantId, bridgeSecret: 'test-bridge-secret' }
    },
    request: async (entry, service, path, options) => {
      if (path === '/v2/channels/publish/flows') {
        publishCalls++
        if (uncertainPublish) throw new Error('timeout after provider accepted')
        return { flowId: options.body.flowId }
      }
      if (path === '/agent/tasks/0123456789abcdef01234567')
        return { status: operationsTaskState, messages: [] }
      if (options?.stream) operationsStarts++
      if (options?.stream)
        return new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                'data: {"type":"init","taskId":"0123456789abcdef01234567"}\n\n',
              ),
            )
            c.close()
          },
        })
      return { list: [] }
    },
  }
  const modelCalls = []
  let modelFailure = false,
    streamModel = false,
    modelReply = 'fixture'
  let imageResponse
  let duringModel
  const modelFetch = async (url, options) => {
    modelCalls.push({
      url,
      body:
        options.body instanceof FormData
          ? {
              model: options.body.get('model'),
              prompt: options.body.get('prompt'),
              imageSize: options.body.get('image')?.size,
            }
          : options.body
            ? JSON.parse(options.body)
            : null,
      authorization: options.headers.authorization,
    })
    if (url.endsWith('/models'))
      return Response.json({
        data: [
          { id: 'test-agent', type: 'chat' },
          { id: 'test-cheap', output_modalities: ['text'] },
          { id: 'gpt-image-1', type: 'image' },
          { id: 'sora-2', model_type: 'video' },
        ],
      })
    if (url.endsWith('/images/generations') && imageResponse) return Response.json(imageResponse)
    if (modelFailure) {
      modelFailure = false
      return new Response('{}', { status: 503 })
    }
    if (streamModel)
      return new Response(
        'data: {"usage":{"prompt_tokens":90,"completion_tokens":10}}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    if (duringModel) {
      const hook = duringModel
      duringModel = undefined
      await hook()
    }
    return Response.json({
      choices: [{ message: { content: modelReply } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    })
  }
  async function finishDepartment(tenantId, userId, taskId) {
    // Place this fixture first; unrelated test fixtures keep their existing queue entries.
    await query("UPDATE task_jobs SET updated_at='2000-01-01' WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3", [tenantId, userId, taskId])
    await createDepartmentEngine({ pool, env, fetcher: modelFetch, operations: createOperationsTasks({ pool, env, driver: operationsDriver }) }).tick()
    return (await query('SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2', [tenantId, userId])).rows[0].board.tasks.find(t => t.id === taskId)
  }
  const app = await buildApp({
    modelFetch,
    operationsDriver,
    pool,
    cache,
    agents: agentDriver,
    env,
    staticRoot: null,
    catalogInstaller: async (id) => {
      if (!['a'.repeat(24), 'b'.repeat(24)].includes(id))
        throw Object.assign(new Error('技能目录中没有这一项'), { statusCode: 404 })
      return {
        name: 'same-name',
        description: 'Catalog fixture',
        version: 'snapshot',
        kind: 'capability',
        filename: 'same-name.zip',
        format: 'zip',
        sha256: 'f'.repeat(64),
        skillFile: 'SKILL.md',
        fileCount: 1,
        expandedBytes: 3,
        buffer: Buffer.from('zip'),
        catalogId: id,
        catalogSource: id[0] + '/publisher',
        provenance: { historical: false },
      }
    },
    skillCatalog: async () => ({
      items: [
        {
          id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
          name: 'fixture-skill',
          download: { status: 'downloaded' },
        },
      ],
    }),
  })
  await app.ready()
  const alice = randomUUID(),
    bob = randomUUID(),
    outsider = randomUUID()
  for (const [id, email] of [
    [alice, 'alice@example.test'],
    [bob, 'bob@example.test'],
    [outsider, 'outside@example.test'],
  ]) {
    await query('INSERT INTO users VALUES($1,$2,$3,now())', [id, id, email])
    await cache.set(`session:${hash(id)}`, JSON.stringify({ userId: id, email, csrf: id }))
  }
  const request = (user, method, url, payload) =>
    app.inject({
      method,
      url,
      headers: {
        cookie: `office_session=${user}`,
        origin: env.APP_ORIGIN,
        'x-csrf-token': user,
        accept: SLOW_RESPONSE_TYPE,
      },
      payload,
    })
  let a, b, agent, conversation
  await t.test('anonymous requests are denied', async () =>
    assert.equal((await app.inject('/api/me')).statusCode, 401),
  )
  await t.test('CSRF mismatch is denied', async () =>
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/tenants',
          headers: { cookie: `office_session=${alice}` },
          payload: { name: 'Bad' },
        })
      ).statusCode,
      403,
    ),
  )
  await t.test('one user owns and switches between two tenants', async () => {
    a = (await request(alice, 'POST', '/api/tenants', { name: '企业甲' })).json().id
    b = (await request(alice, 'POST', '/api/tenants', { name: '企业乙' })).json().id
    assert.ok(a && b)
    assert.equal((await request(alice, 'GET', '/api/me')).json().tenants.length, 2)
  })
  await t.test(
    'slow-response negotiation cannot bypass authentication, CSRF or tenant access',
    async () => {
      const url = `/api/tenants/${a}/secretary/chat`,
        before = modelCalls.length
      for (const [headers, status] of [
        [{ accept: SLOW_RESPONSE_TYPE }, 401],
        [
          {
            accept: SLOW_RESPONSE_TYPE,
            cookie: `office_session=${alice}`,
            origin: env.APP_ORIGIN,
            'x-csrf-token': 'incorrect',
          },
          403,
        ],
        [
          {
            accept: SLOW_RESPONSE_TYPE,
            cookie: `office_session=${outsider}`,
            origin: env.APP_ORIGIN,
            'x-csrf-token': outsider,
          },
          403,
        ],
      ]) {
        const response = await app.inject({
          method: 'POST',
          url,
          headers,
          payload: { text: 'private task' },
        })
        assert.equal(response.statusCode, status)
        assert.match(response.headers['content-type'], /application\/json/)
      }
      assert.equal(modelCalls.length, before)
    },
  )
  await t.test(
    'operations uses tenant credentials and requires approval before submitting each publication exactly once',
    async () => {
      const path = `/api/tenants/${a}/operations`,
        other = `/api/tenants/${b}/operations`
      assert.equal((await request(outsider, 'GET', `${path}/settings`)).statusCode, 403)
      const input = defaultPolicy()
      input.tiers.fast = 'test-agent'
      env[secretNames(a).ai] = 'tenant-a-secret'
      env[secretNames(a).relay] = 'tenant-relay-secret'
      assert.equal((await request(alice, 'PUT', `${path}/settings`, input)).statusCode, 200)
      const view = await request(alice, 'GET', `${path}/settings`)
      assert.equal(view.json().aiKeySet, true)
      assert.ok(!view.body.includes('tenant-a-secret'))
      assert.ok(!view.body.includes('tenant-relay-secret'))
      const stored = (
        await query('SELECT encrypted_config FROM operations_settings WHERE tenant_id=$1', [a])
      ).rows[0].encrypted_config
      assert.ok(!stored.includes('tenant-a-secret'))
      assert.equal((await request(alice, 'GET', `${other}/settings`)).json().configured, false)
      assert.equal(
        (await request(alice, 'POST', `${other}/tasks`, { prompt: 'video' })).statusCode,
        409,
      )
      const stream = await request(alice, 'POST', `${path}/tasks`, { prompt: 'video' })
      assert.equal(stream.statusCode, 200, stream.body)
      assert.match(stream.headers['content-type'], /event-stream/)
      const payload = {
        content: {
          title: 'Review me',
          body: 'Brief',
          media: [{ url: 'https://assets.example.test/video.mp4' }],
        },
        publishAt: '2026-10-11T12:00:00Z',
        items: [{ accountId: 'account-a', platform: 'youtube' }],
      }
      const first = (await request(alice, 'POST', `${path}/publications`, payload)).json()
      assert.equal(first.state, 'pending')
      assert.equal(publishCalls, 0)
      assert.equal(
        (await request(alice, 'POST', `${path}/publications`, payload)).json().id,
        first.id,
      )
      assert.equal((await request(alice, 'GET', `${other}/publications`)).json().items.length, 0)
      assert.equal(
        (await request(alice, 'POST', `${other}/publications/${first.id}/approve`, {})).statusCode,
        409,
      )
      const approved = await request(alice, 'POST', `${path}/publications/${first.id}/approve`, {})
      assert.equal(approved.statusCode, 200, approved.body)
      assert.equal(publishCalls, 1)
      assert.equal(
        (await request(alice, 'POST', `${path}/publications/${first.id}/approve`, {})).statusCode,
        409,
      )
      assert.equal(publishCalls, 1)
      uncertainPublish = true
      const second = (
        await request(alice, 'POST', `${path}/publications`, {
          ...payload,
          publishAt: '2026-10-12T12:00:00Z',
        })
      ).json()
      assert.equal(second.state, 'pending')
      assert.equal(
        (await request(alice, 'POST', `${path}/publications/${second.id}/approve`, {})).json()
          .state,
        'uncertain',
      )
      assert.equal(
        (await request(alice, 'POST', `${path}/publications/${second.id}/approve`, {})).statusCode,
        409,
      )
      assert.equal(publishCalls, 2)
      uncertainPublish = false
      const hook = `/integrations/aitoearn/${a}/publications`
      assert.equal((await app.inject({ method: 'POST', url: hook, payload })).statusCode, 403)
      const fromAgent = await app.inject({
        method: 'POST',
        url: hook,
        payload,
        headers: signBridge('test-bridge-secret', 'POST', hook, payload),
      })
      assert.equal(fromAgent.statusCode, 200, fromAgent.body)
      assert.equal(publishCalls, 2)
    },
  )
  await t.test(
    'model policy enforces tiers, tenant secrets, quotas, and runtime authentication',
    async () => {
      const path = `/api/tenants/${a}/operations`
      const policy = defaultPolicy()
      policy.tiers.fast = 'test-agent'
      policy.tiers.cheap = 'test-cheap'
      policy.gateway.base_url += '/models'
      assert.equal((await request(alice, 'PUT', `${path}/settings`, policy)).statusCode, 200)
      const settings = (await request(alice, 'GET', `${path}/settings`)).json()
      assert.equal(settings.policy.gateway.base_url, 'https://app.4yi.ai/api/v1')
      const discovered = (await request(alice, 'GET', `${path}/models`)).json()
      assert.equal(discovered.models.length, 4)
      assert.deepEqual(discovered.catalog.find((m) => m.id === 'gpt-image-1').kinds, ['image'])
      assert.deepEqual(discovered.catalog.find((m) => m.id === 'sora-2').kinds, ['video'])
      assert.equal(
        (
          await request(alice, 'PUT', `${path}/settings`, {
            ...policy,
            gateway: { ...policy.gateway, api_key: 'raw' },
          })
        ).statusCode,
        400,
      )
      const message = `/api/tenants/${a}/departments/secretary/messages`
      assert.equal((await request(outsider, 'POST', message, { prompt: 'Hello' })).statusCode, 403)
      const result = await request(alice, 'POST', message, { prompt: 'Hello' })
      assert.equal(result.statusCode, 200, result.body)
      assert.equal(modelCalls.at(-1).body.model, 'test-agent')
      assert.equal(
        (
          await request(alice, 'POST', `/api/tenants/${a}/departments/compliance/messages`, {
            prompt: 'Hi',
          })
        ).statusCode,
        409,
      )
      modelFailure = true
      assert.equal((await request(alice, 'POST', message, { prompt: 'Fallback' })).statusCode, 200)
      assert.equal(modelCalls.at(-1).body.model, 'test-cheap')
      const privatePath = `/integrations/model-gateway/${a}/api/v1/chat/completions`
      assert.equal(
        (await app.inject({ method: 'POST', url: privatePath, payload: { messages: [] } }))
          .statusCode,
        403,
      )
      const headers = { authorization: `Bearer ${gatewayToken('test-bridge-secret', a)}` }
      streamModel = true
      const stream = await app.inject({
        method: 'POST',
        url: privatePath,
        headers,
        payload: { model: 'bypass-model', messages: [], stream: true },
      })
      assert.equal(stream.statusCode, 200, stream.body)
      assert.match(stream.body, /DONE/)
      assert.equal(modelCalls.at(-1).body.model, 'test-agent')
      streamModel = false
      const report = (await request(alice, 'GET', `${path}/settings`)).json().budget
      assert.equal(report.used, 340)
      assert.ok(report.reserved > 0)
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: privatePath.replace(a, b),
            headers,
            payload: { messages: [] },
          })
        ).statusCode,
        403,
      )
      policy.budget.daily_token_limit = 1000
      await request(alice, 'PUT', `${path}/settings`, policy)
      const before = modelCalls.length
      assert.equal(
        (await request(alice, 'POST', message, { prompt: 'Too expensive' })).statusCode,
        429,
      )
      assert.equal(modelCalls.length, before)
      policy.budget.daily_token_limit = 2000000
      await request(alice, 'PUT', `${path}/settings`, policy)
    },
  )
  await t.test(
    'companies can save and rotate API keys without exposing them or sharing credentials',
    async () => {
      const path = `/api/tenants/${a}/operations`,
        other = `/api/tenants/${b}/operations`
      const policy = (await request(alice, 'GET', `${path}/settings`)).json().policy
      const keys = { aiKey: 'saved-company-a-key', relayKey: 'saved-company-a-relay' }
      assert.equal(
        (await request(alice, 'PUT', `${path}/settings`, { policy, ...keys })).statusCode,
        200,
      )
      const view = await request(alice, 'GET', `${path}/settings`)
      assert.equal(view.json().aiKeySet, true)
      assert.equal(view.json().relayKeySet, true)
      assert.ok(!view.body.includes(keys.aiKey))
      assert.ok(!view.body.includes(keys.relayKey))
      assert.ok(!view.json().policy.credentials)
      const ciphertext = (
        await query('SELECT encrypted_config FROM operations_settings WHERE tenant_id=$1', [a])
      ).rows[0].encrypted_config
      assert.ok(!ciphertext.includes(keys.aiKey))
      assert.ok(!ciphertext.includes(keys.relayKey))
      await request(alice, 'GET', `${path}/models`)
      assert.equal(modelCalls.at(-1).authorization, `Bearer ${keys.aiKey}`)
      assert.equal(
        (await request(alice, 'PUT', `${path}/settings`, { policy, aiKey: '', relayKey: '' }))
          .statusCode,
        200,
      )
      await request(alice, 'GET', `${path}/models`)
      assert.equal(modelCalls.at(-1).authorization, `Bearer ${keys.aiKey}`)
      assert.equal((await request(alice, 'GET', `${other}/settings`)).json().aiKeySet, false)
      assert.equal((await request(alice, 'GET', `${other}/models`)).statusCode, 409)
      await request(alice, 'PUT', `${path}/settings`, { policy, aiKey: 'rotated-company-a-key' })
      await request(alice, 'GET', `${path}/models`)
      assert.equal(modelCalls.at(-1).authorization, 'Bearer rotated-company-a-key')
      const privateUrl = `/integrations/aitoearn/${a}/relay-config`
      assert.equal((await app.inject(privateUrl)).statusCode, 403)
      const getRelay = () =>
        app.inject({
          url: privateUrl,
          headers: signBridge('test-bridge-secret', 'GET', privateUrl, null),
        })
      assert.equal((await getRelay()).json().apiKey, keys.relayKey)
      await request(alice, 'PUT', `${path}/settings`, { policy, relayKey: 'rotated-company-relay' })
      assert.equal((await getRelay()).json().apiKey, 'rotated-company-relay')
    },
  )
  await t.test(
    'original workflow cannot publish before approval; unknown outcomes never duplicate',
    async () => {
      const hook = `/integrations/aitoearn/${a}/publications`
      const payload = {
        content: {
          title: 'Automatic production',
          media: [{ url: 'https://assets.example.test/auto.mp4' }],
        },
        publishAt: '2026-10-13T12:00:00Z',
        items: [{ accountId: 'account-a', platform: 'youtube' }],
      }
      const invoke = (body) =>
        app.inject({
          method: 'POST',
          url: hook,
          payload: body,
          headers: signBridge('test-bridge-secret', 'POST', hook, body),
        })
      const before = publishCalls
      const results = await Promise.all([invoke(payload), invoke(payload)])
      for (const r of results) assert.equal(r.statusCode, 200, r.body)
      assert.equal(results[0].json().id, results[1].json().id)
      assert.equal(publishCalls, before)
      const again = (await invoke(payload)).json()
      assert.equal(again.state, 'pending')
      assert.equal(again.execution_mode, 'manual')
      assert.equal(again.approved_by, null)
      assert.equal(publishCalls, before)
      assert.equal(
        (
          await request(
            alice,
            'POST',
            `/api/tenants/${a}/operations/publications/${again.id}/approve`,
            {},
          )
        ).json().state,
        'submitted',
      )
      assert.equal(publishCalls, before + 1)
      uncertainPublish = true
      const uncertainPayload = { ...payload, publishAt: '2026-10-14T12:00:00Z' }
      const unknown = (await invoke(uncertainPayload)).json()
      assert.equal(unknown.state, 'pending')
      assert.equal(
        (
          await request(
            alice,
            'POST',
            `/api/tenants/${a}/operations/publications/${unknown.id}/approve`,
            {},
          )
        ).json().state,
        'uncertain',
      )
      assert.equal((await invoke(uncertainPayload)).json().state, 'uncertain')
      assert.equal(publishCalls, before + 2)
      uncertainPublish = false
      assert.equal(
        (
          await request(
            alice,
            'POST',
            `/api/tenants/${a}/operations/publications/${unknown.id}/resume`,
            {},
          )
        ).statusCode,
        409,
      )
      runtimeUnavailable = true
      const offlinePayload = { ...payload, publishAt: '2026-10-15T12:00:00Z' }
      const offline = (await invoke(offlinePayload)).json()
      assert.equal(offline.state, 'pending')
      assert.equal(publishCalls, before + 2)
      runtimeUnavailable = false
      assert.equal((await invoke(offlinePayload)).json().state, 'pending')
      assert.equal(
        (
          await request(
            alice,
            'POST',
            `/api/tenants/${a}/operations/publications/${offline.id}/approve`,
            {},
          )
        ).json().state,
        'submitted',
      )
      assert.equal(publishCalls, before + 3)
    },
  )
  await t.test(
    'concurrent token reservations cannot overdraw and settlements are idempotent',
    async () => {
      const ctx = { tenantId: b, userId: '' },
        options = { department: 'archive', model: 'fixture', limit: 1000, tokens: 600 }
      const reservations = await Promise.allSettled([
        reserveTokens(pool, ctx, options),
        reserveTokens(pool, ctx, options),
      ])
      assert.equal(reservations.filter((r) => r.status === 'fulfilled').length, 1)
      assert.equal(reservations.filter((r) => r.status === 'rejected')[0].reason.statusCode, 429)
      const id = reservations.find((r) => r.status === 'fulfilled').value
      await settleTokens(pool, ctx, id, 'completed', { input: 100, output: 10 })
      await settleTokens(pool, ctx, id, 'completed', { input: 100, output: 10 })
      const row = (
        await query('SELECT * FROM model_daily_usage WHERE tenant_id=$1 AND day=$2', [
          b,
          budgetDay(),
        ])
      ).rows[0]
      assert.equal(Number(row.used_tokens), 110)
      assert.equal(Number(row.reserved_tokens), 0)
      const unknown = await reserveTokens(pool, ctx, options)
      await settleTokens(pool, ctx, unknown, 'completed', undefined)
      assert.equal(
        (await query('SELECT state FROM model_requests WHERE id=$1', [unknown])).rows[0].state,
        'unknown',
      )
    },
  )
  await t.test('personal plans reject extra members', async () =>
    assert.equal(
      (await request(alice, 'POST', `/api/tenants/${a}/invitations`, { email: 'bob@example.test' }))
        .statusCode,
      402,
    ),
  )
  await t.test(
    'secretary tasks are private, persistent and require explicit dispatch',
    async () => {
      const path = `/api/tenants/${a}/secretary`
      assert.equal((await app.inject(path)).statusCode, 401)
      assert.equal((await request(outsider, 'GET', path)).statusCode, 403)
      const initial = (await request(alice, 'GET', path)).json()
      assert.equal(initial.revision, 0)
      const payload = {
        revision: 0,
        today: '2026-10-11',
        action: { type: 'send', text: '制作并发布视频', intent: 'plan', language: 'zh' },
      }
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: path,
            headers: { cookie: `office_session=${alice}` },
            payload,
          })
        ).statusCode,
        403,
      )
      const response = await request(alice, 'POST', path, payload)
      assert.equal(response.statusCode, 200, response.body)
      const draft = response.json()
      assert.equal(draft.board.tasks.length, 3)
      assert.ok(draft.board.tasks.every((t) => t.status === 'draft'))
      assert.equal((await request(alice, 'GET', path)).json().revision, 1)
      assert.equal(
        (await request(alice, 'GET', `/api/tenants/${b}/secretary`)).json().board.tasks.length,
        0,
      )
      assert.equal((await request(alice, 'POST', path, payload)).statusCode, 409)
      const sent = await request(alice, 'POST', path, {
        revision: 1,
        today: '2026-10-11',
        action: { type: 'dispatch', batchId: draft.board.batches[0].id },
      })
      assert.equal(sent.statusCode, 200, sent.body)
      assert.ok(sent.json().board.tasks.every((t) => t.status === 'queued'))
      const invalid = await request(alice, 'POST', path, {
        revision: 2,
        today: '2026-10-11',
        action: { type: 'approve', taskId: draft.board.tasks[0].id },
      })
      assert.equal(invalid.statusCode, 409)
      assert.equal((await request(alice, 'GET', path)).json().revision, 2)
    },
  )
  await t.test(
    'secretary preferences persist per user and reach the metered company model',
    async () => {
      const path = `/api/tenants/${a}/secretary`
      const initial = (await request(alice, 'GET', path)).json()
      const prefs = {
        ...initial.preferences,
        gender: 'male',
        name: '林助理',
        address: '林总',
        tone: 'professional',
        detail: 'concise',
        habits: '先说结论，尽量用清单。',
      }
      assert.equal((await request(alice, 'PUT', `${path}/preferences`, prefs)).statusCode, 200)
      assert.equal((await request(outsider, 'PUT', `${path}/preferences`, prefs)).statusCode, 403)
      assert.equal(
        (await request(alice, 'PUT', `${path}/preferences`, { ...prefs, tone: 'invalid' }))
          .statusCode,
        400,
      )
      assert.equal((await request(alice, 'GET', path)).json().preferences.name, '林助理')
      assert.equal(
        (await request(alice, 'GET', `/api/tenants/${b}/secretary`)).json().preferences.name,
        '李婉儿',
      )
      const result = await request(alice, 'POST', `${path}/chat`, {
        revision: initial.revision,
        text: '你好，请介绍你的说话方式',
        intent: 'plan',
        language: 'zh',
      })
      assert.equal(result.statusCode, 200, result.body)
      assert.equal(result.json().board.messages.at(-1).text, 'fixture')
      assert.equal(modelCalls.at(-1).body.model, 'test-agent')
      const system = modelCalls.at(-1).body.messages[0].content
      assert.match(system, /林助理/)
      assert.match(system, /林总/)
      assert.match(system, /专业干练/)
      assert.match(system, /先说结论/)
      const count = modelCalls.length
      assert.equal(
        (
          await request(alice, 'POST', `${path}/chat`, {
            revision: initial.revision,
            text: 'stale',
            intent: 'plan',
            language: 'zh',
          })
        ).statusCode,
        409,
      )
      assert.equal(modelCalls.length, count)
      await request(alice, 'PUT', `${path}/preferences`, {
        ...prefs,
        gender: 'female',
        name: '李婉儿',
        tone: 'warm',
      })
      const next = await request(alice, 'POST', `${path}/chat`, {
        revision: result.json().revision,
        text: 'Hello',
        intent: 'report',
        language: 'en',
      })
      assert.equal(next.statusCode, 200, next.body)
      assert.match(modelCalls.at(-1).body.messages[0].content, /温和体贴/)
      assert.match(modelCalls.at(-1).body.messages[0].content, /英文/)
      assert.equal((await request(alice, 'GET', path)).json().board.messages.at(-1).text, 'fixture')
      modelReply = JSON.stringify({
        reply: '林总，已整理成草稿。',
        tasks: [
          {
            title: '梳理竞品',
            dept: 'review-agent',
            due: '2026-10-12',
            brief: '分析三个产品的价格与受众，交付对比报告',
          },
        ],
      })
      const planned = await request(alice, 'POST', `${path}/chat`, {
        revision: next.json().revision,
        text: '把调研工作拆成任务',
        intent: 'plan',
        language: 'zh',
      })
      assert.equal(planned.statusCode, 200, planned.body)
      assert.equal(planned.json().board.tasks.at(-2).title, '梳理竞品')
      assert.equal(planned.json().board.tasks.at(-2).status, 'draft')
      assert.equal(
        planned.json().board.tasks.at(-2).summary,
        '分析三个产品的价格与受众，交付对比报告',
      )
      assert.equal(
        planned.json().board.messages.at(-1).batchId,
        planned.json().board.tasks.at(-2).batchId,
      )
      modelReply = JSON.stringify({
        reply: 'invalid',
        tasks: [{ title: 'bad', dept: 'other-company', due: '2026-10-12' }],
      })
      assert.equal(
        (
          await request(alice, 'POST', `${path}/chat`, {
            revision: planned.json().revision,
            text: 'invalid fixture',
            intent: 'plan',
            language: 'zh',
          })
        ).statusCode,
        502,
      )
      const failedDraft = (await request(alice, 'GET', path)).json()
      assert.equal(failedDraft.revision, planned.json().revision + 1)
      assert.equal(failedDraft.board.lastReplyError.requestText, 'invalid fixture')
      assert.match(failedDraft.board.messages.at(-1).text, /任务尚未创建/)
      modelReply = '已安排林幼薇开始设计'
      const invalidPlan = await request(alice, 'POST', `${path}/chat`, {
        revision: failedDraft.revision,
        text: '确认分工',
        intent: 'plan',
        language: 'zh',
        requireTasks: true,
      })
      assert.equal(invalidPlan.statusCode, 502)
      const clarification = await request(alice, 'POST', `${path}/chat`, {
        revision: (await request(alice, 'GET', path)).json().revision,
        text: '是否已安排？',
        intent: 'report',
        language: 'zh',
      })
      assert.equal(clarification.statusCode, 200, clarification.body)
      assert.match(clarification.json().board.messages.at(-1).text, /这条回复没有创建或派发任务/)
      assert.equal(clarification.json().board.tasks.length, planned.json().board.tasks.length)
      modelReply = 'fixture'
    },
  )
  await t.test(
    'secretary task replies tolerate prose and harmless quotes while concurrent progress never discards paid results',
    async () => {
      const path = `/api/tenants/${a}/secretary`
      let snap = (await request(alice, 'GET', path)).json()
      const lastUserMessageId =
        snap.board.messages.filter((m) => m.role === 'user').at(-1)?.id || ''
      // Simulate a worker update after the browser read its revision.
      await query(
        'UPDATE secretary_workspaces SET revision=revision+1 WHERE tenant_id=$1 AND user_id=$2',
        [a, alice],
      )
      modelReply =
        '收到，分工如下：\n```json\n{"reply":"按"全面调研"安排，请确认","tasks":[{"title":""一人公司"调研","dept":"review-agent","due":"2026-10-11","brief":"研究"一人公司"的商业模式","dependsOn":null,"displayColor":"purple"}]}\n```'
      // Another worker update while the paid response is in flight.
      duringModel = () =>
        query(
          'UPDATE secretary_workspaces SET revision=revision+1 WHERE tenant_id=$1 AND user_id=$2',
          [a, alice],
        )
      const result = await request(alice, 'POST', `${path}/chat`, {
        revision: snap.revision,
        lastUserMessageId,
        requireTasks: true,
        text: '调研一人公司',
        intent: 'plan',
        language: 'zh',
      })
      assert.equal(result.statusCode, 200, result.body)
      snap = result.json()
      assert.equal(snap.board.lastReplyError, undefined)
      assert.equal(snap.board.tasks.at(-2).title, '"一人公司"调研')
      assert.equal(snap.board.tasks.at(-2).status, 'draft')
      assert.equal(snap.board.tasks.at(-1).dept, 'file-agent')
      assert.equal((await query('SELECT * FROM task_jobs WHERE task_id=$1', [snap.board.tasks.at(-2).id])).rows.length, 0)
      modelReply = 'fixture'
    },
  )
  await t.test(
    'company image and video selections drive actual JSON and multipart requests',
    async () => {
      const path = `/api/tenants/${a}/operations/settings`
      const policy = (await request(alice, 'GET', path)).json().policy
      policy.tiers.image = 'gpt-image-1'
      policy.tiers.video = 'sora-2'
      await request(alice, 'PUT', path, policy)
      const prefix = `/integrations/model-gateway/${a}/api/v1`
      const headers = { authorization: `Bearer ${gatewayToken('test-bridge-secret', a)}` }
      const image = await app.inject({
        method: 'POST',
        url: `${prefix}/images/generations`,
        headers,
        payload: { model: 'wrong-model', prompt: 'fixture' },
      })
      assert.equal(image.statusCode, 200, image.body)
      assert.equal(modelCalls.at(-1).body.model, 'gpt-image-1')
      const video = await app.inject({
        method: 'POST',
        url: `${prefix}/videos/generations`,
        headers,
        payload: { model: 'wrong-model', prompt: 'fixture', duration_seconds: 5 },
      })
      assert.equal(video.statusCode, 200, video.body)
      assert.equal(modelCalls.at(-1).body.model, 'sora-2')
      assert.equal(modelCalls.at(-1).body.duration_seconds, 5)
      const form = new FormData()
      form.set('model', 'wrong-model')
      form.set('prompt', 'edit fixture')
      form.set('image', new Blob(['fixture'], { type: 'image/png' }), 'image.png')
      const body = new Request('http://localhost', { method: 'POST', body: form })
      const edit = await app.inject({
        method: 'POST',
        url: `${prefix}/images/edits`,
        headers: { ...headers, 'content-type': body.headers.get('content-type') },
        payload: Buffer.from(await body.arrayBuffer()),
      })
      assert.equal(edit.statusCode, 200, edit.body)
      assert.equal(modelCalls.at(-1).body.model, 'gpt-image-1')
      assert.equal(modelCalls.at(-1).body.imageSize, 7)
      policy.tiers.video = ''
      await request(alice, 'PUT', path, policy)
      const count = modelCalls.length
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `${prefix}/videos/generations`,
            headers,
            payload: { model: 'bypass', prompt: 'fixture' },
          })
        ).statusCode,
        409,
      )
      assert.equal(modelCalls.length, count)
    },
  )
  await t.test('skill catalog requires tenant access', async () => {
    assert.equal((await app.inject(`/api/tenants/${a}/skills/catalog`)).statusCode, 401)
    assert.equal(
      (await request(outsider, 'GET', `/api/tenants/${a}/skills/catalog`)).statusCode,
      403,
    )
    const result = await request(alice, 'GET', `/api/tenants/${a}/skills/catalog`)
    assert.equal(result.statusCode, 200)
    assert.equal(result.json().items[0].download.status, 'downloaded')
  })
  await t.test('invite is email bound and single-use', async () => {
    await query("UPDATE tenants SET plan='enterprise',subscription_status='manual' WHERE id=$1", [
      a,
    ])
    const r = await request(alice, 'POST', `/api/tenants/${a}/invitations`, {
      email: 'bob@example.test',
    })
    assert.equal(r.statusCode, 200, r.body)
    const token = new URL(r.json().url).searchParams.get('invite')
    assert.equal(
      (await request(outsider, 'POST', '/api/invitations/accept', { token })).statusCode,
      403,
    )
    assert.equal((await request(bob, 'POST', '/api/invitations/accept', { token })).statusCode, 200)
    assert.equal(
      (await request(bob, 'GET', `/api/tenants/${a}/secretary`)).json().preferences.address,
      '老板',
    )
    assert.equal((await request(bob, 'POST', '/api/invitations/accept', { token })).statusCode, 403)
  })
  await t.test('members cannot read or replace company keys or approve publications', async () => {
    const before = publishCalls
    const path = `/api/tenants/${a}/operations`
    assert.equal((await request(bob, 'GET', `${path}/settings`)).statusCode, 403)
    assert.equal((await request(bob, 'PUT', `${path}/settings`, {})).statusCode, 403)
    const records = (await request(bob, 'GET', `${path}/publications`)).json().items
    assert.ok(records.length)
    assert.equal(
      (await request(bob, 'POST', `${path}/publications/${records[0].id}/approve`, {})).statusCode,
      403,
    )
    assert.equal(
      (await request(bob, 'POST', `${path}/publications/${records[0].id}/reject`, {})).statusCode,
      403,
    )
    assert.equal(publishCalls, before)
  })
  await t.test(
    'members cannot mutate secretary queues or see another users conversation',
    async () => {
      const path = `/api/tenants/${a}/secretary`
      assert.equal((await request(bob, 'GET', path)).json().board.tasks.length, 0)
      assert.equal(
        (
          await request(bob, 'POST', path, {
            revision: 0,
            today: '2026-10-11',
            action: { type: 'send', text: '测试', intent: 'plan', language: 'zh' },
          })
        ).statusCode,
        403,
      )
    },
  )
  await t.test(
    'skill uploads persist tenant packages, reject duplicates and enforce roles',
    async () => {
      const content =
        '---\nname: tenant-upload\ndescription: Tenant skill fixture\nversion: "1.0"\n---\n\nRead a document.\n'
      const payload = {
        filename: 'SKILL.md',
        kind: 'capability',
        contentBase64: Buffer.from(content).toString('base64'),
      }
      const url = `/api/tenants/${a}/skills/uploads`
      assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 401)
      assert.equal((await request(outsider, 'POST', url, payload)).statusCode, 403)
      assert.equal((await request(bob, 'POST', url, payload)).statusCode, 403)
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { cookie: `office_session=${alice}` },
            payload,
          })
        ).statusCode,
        403,
      )
      const installed = await request(alice, 'POST', url, payload)
      assert.equal(installed.statusCode, 201, installed.body)
      assert.equal(installed.json().skill.status, 'installed')
      assert.equal(installed.json().skill.runtimeReady, false)
      assert.equal((await request(alice, 'POST', url, payload)).statusCode, 409)
      const original = await query('SELECT package_data FROM installed_skills WHERE id=$1', [
        installed.json().skill.id,
      ])
      assert.equal(Buffer.from(original.rows[0].package_data).toString(), content)
      const listed = (await request(bob, 'GET', `/api/tenants/${a}/skills/installed`)).json()
      assert.equal(listed.items.length, 1)
      assert.equal(listed.items[0].name, 'tenant-upload')
      assert.equal(listed.items[0].package_data, undefined)
      assert.equal(
        (await request(outsider, 'GET', `/api/tenants/${a}/skills/installed`)).statusCode,
        403,
      )
      assert.equal(
        (await request(alice, 'GET', `/api/tenants/${b}/skills/installed`)).json().items.length,
        0,
      )
      assert.equal(
        (await request(alice, 'POST', `/api/tenants/${b}/skills/uploads`, payload)).statusCode,
        201,
      )
      const malformed = await request(alice, 'POST', url, {
        ...payload,
        contentBase64: Buffer.from('invalid file').toString('base64'),
      })
      assert.equal(malformed.statusCode, 400)
      assert.equal(
        (await request(alice, 'GET', `/api/tenants/${a}/skills/installed`)).json().items.length,
        1,
      )
    },
  )
  await t.test('upload accepts a package larger than the default API body limit', async () => {
    const text =
      '---\nname: large-upload\ndescription: Long instruction fixture\n---\n' +
      'instruction text. '.repeat(6000)
    const uploaded = await request(alice, 'POST', `/api/tenants/${a}/skills/uploads`, {
      filename: 'SKILL.md',
      kind: 'capability',
      contentBase64: Buffer.from(text).toString('base64'),
    })
    assert.equal(uploaded.statusCode, 201, uploaded.body)
    assert.equal(uploaded.json().skill.package_bytes, Buffer.byteLength(text))
  })
  await t.test(
    'catalog installs are tenant scoped, idempotent and distinguish publishers',
    async () => {
      const url = `/api/tenants/${a}/skills/install`,
        payload = { id: 'a'.repeat(24) }
      assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 401)
      assert.equal((await request(bob, 'POST', url, payload)).statusCode, 403)
      assert.equal((await request(outsider, 'POST', url, payload)).statusCode, 403)
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url,
            headers: { cookie: `office_session=${alice}` },
            payload,
          })
        ).statusCode,
        403,
      )
      const installed = await request(alice, 'POST', url, payload)
      assert.equal(installed.statusCode, 201, installed.body)
      assert.equal(installed.json().skill.catalog_source, 'a/publisher')
      const again = await request(alice, 'POST', url, payload)
      assert.equal(again.statusCode, 200)
      assert.equal(again.json().skill.id, installed.json().skill.id)
      const sameName = await request(alice, 'POST', url, { id: 'b'.repeat(24) })
      assert.equal(sameName.statusCode, 201, sameName.body)
      assert.notEqual(sameName.json().skill.id, installed.json().skill.id)
      const catalogA = (await request(alice, 'GET', `/api/tenants/${a}/skills/catalog`)).json()
      const catalogB = (await request(alice, 'GET', `/api/tenants/${b}/skills/catalog`)).json()
      assert.equal(catalogA.items[0].installedId, installed.json().skill.id)
      assert.equal(catalogB.items[0].installedId, null)
      assert.equal((await request(alice, 'POST', url, { id: 'c'.repeat(24) })).statusCode, 404)
      assert.equal((await request(alice, 'POST', url, { id: '../file' })).statusCode, 400)
    },
  )
  await t.test('members cannot author agents, outsiders cannot list them', async () => {
    assert.equal((await request(bob, 'POST', `/api/tenants/${a}/agents`, profile)).statusCode, 403)
    assert.equal((await request(outsider, 'GET', `/api/tenants/${a}/agents`)).statusCode, 403)
    const r = await request(alice, 'POST', `/api/tenants/${a}/agents`, profile)
    assert.equal(r.statusCode, 201, r.body)
    agent = r.json().id
    assert.equal((await request(alice, 'GET', `/api/tenants/${b}/agents`)).json().agents.length, 0)
  })
  await t.test('replayed request records usage once and does not reinvoke provider', async () => {
    const payload = { prompt: 'Hello', requestId: randomUUID() }
    const r = await request(alice, 'POST', `/api/tenants/${a}/agents/${agent}/messages`, payload)
    assert.equal(r.statusCode, 200, r.body)
    conversation = r.json().conversationId
    const r2 = await request(alice, 'POST', `/api/tenants/${a}/agents/${agent}/messages`, payload)
    assert.deepEqual(r2.json(), r.json())
    assert.equal(calls, 1)
    const usage = (await request(alice, 'GET', `/api/tenants/${a}/usage`)).json()
    assert.equal(usage.usage[0].charge_microusd, '280')
    assert.equal(usage.usage[0].requests, 1)
  })
  await t.test('users cannot reuse another user conversation or another tenant agent', async () => {
    assert.equal(
      (
        await request(bob, 'POST', `/api/tenants/${a}/agents/${agent}/messages`, {
          prompt: 'steal',
          requestId: randomUUID(),
          conversationId: conversation,
        })
      ).statusCode,
      404,
    )
    assert.equal(
      (
        await request(alice, 'POST', `/api/tenants/${b}/agents/${agent}/messages`, {
          prompt: 'steal',
          requestId: randomUUID(),
        })
      ).statusCode,
      404,
    )
    assert.equal(calls, 1)
  })
  await t.test('members see only their own billing usage', async () =>
    assert.equal((await request(bob, 'GET', `/api/tenants/${a}/usage`)).json().usage.length, 0),
  )
  await t.test('office event cursors broadcast independently and isolate tenants', async () => {
    const accepted = await request(alice, 'POST', `/api/tenants/${a}/actions`, {
      type: 'set_state',
      rosterNo: 9,
      state: 'thinking',
    })
    assert.equal(accepted.statusCode, 200)
    assert.equal(
      (
        await request(alice, 'POST', `/api/tenants/${a}/actions`, {
          type: 'set_state',
          rosterNo: 10,
          state: 'thinking',
        })
      ).statusCode,
      400,
    )
    const r = (await request(bob, 'GET', `/api/tenants/${a}/actions`)).json()
    assert.equal(r.actions.length, 1)
    assert.equal(
      (await request(alice, 'GET', `/api/tenants/${a}/actions`)).json().actions.length,
      1,
    )
    assert.equal(
      (await request(alice, 'GET', `/api/tenants/${b}/actions`)).json().actions.length,
      0,
    )
    assert.equal(
      (await request(bob, 'GET', `/api/tenants/${a}/actions?after=${r.cursor}`)).json().actions
        .length,
      0,
    )
  })
  await cache.del(`api-rate:${alice}`) // Separate the extended feature suite from the preceding minute's requests.
  await t.test(
    'department chats use assigned skills and retain private, versioned history',
    async () => {
      const root = `/api/tenants/${a}`,
        other = `/api/tenants/${b}`
      const skill = (await request(alice, 'GET', `${root}/skills/installed`))
        .json()
        .items.find((s) => s.name === 'tenant-upload')
      const detail = await request(alice, 'GET', `${root}/skills/${skill.id}/detail`)
      assert.equal(detail.statusCode, 200, detail.body)
      assert.match(detail.json().content, /tenant-upload/)
      assert.equal(
        (await request(alice, 'GET', `${other}/skills/${skill.id}/detail`)).statusCode,
        404,
      )
      assert.equal(
        (
          await request(bob, 'PUT', `${root}/skills/${skill.id}/assignments`, {
            departments: ['archive'],
          })
        ).statusCode,
        403,
      )
      assert.equal(
        (
          await request(alice, 'PUT', `${root}/skills/${skill.id}/assignments`, {
            departments: ['archive'],
          })
        ).statusCode,
        200,
      )
      const path = `${root}/departments/archive`
      modelReply = '整理结果：合同与账目已经按类型列出。'
      const r = await request(alice, 'POST', `${path}/chat`, { revision: 0, text: '整理给定材料' })
      assert.equal(r.statusCode, 200, r.body)
      assert.equal(r.json().revision, 1)
      assert.equal(r.json().messages.at(-1).text, modelReply)
      assert.match(modelCalls.at(-1).body.messages[0].content, /tenant-upload/)
      const before = modelCalls.length
      assert.equal(
        (await request(alice, 'POST', `${path}/chat`, { revision: 0, text: '重复' })).statusCode,
        409,
      )
      assert.equal(modelCalls.length, before)
      assert.equal((await request(bob, 'GET', `${path}/conversation`)).json().messages.length, 0)
      assert.equal(
        (await request(alice, 'GET', `${other}/departments/archive/conversation`)).json().messages
          .length,
        0,
      )
      assert.equal((await request(outsider, 'GET', `${path}/conversation`)).statusCode, 403)
      const image = await request(alice, 'POST', `${path}/chat`, {
        revision: 1,
        text: '识别',
        image: 'data:image/png;base64,aGVsbG8=',
      })
      assert.equal(image.statusCode, 200, image.body)
      assert.equal(modelCalls.at(-1).body.messages.at(-1).content[1].type, 'image_url')
      modelReply = 'fixture'
    },
  )
  await t.test('private files persist exact bytes and deny another member or tenant', async () => {
    const root = `/api/tenants/${a}/files`
    const r = await request(alice, 'POST', root, {
      name: '联通测试.txt',
      mime: 'text/plain',
      content: Buffer.from('saved bytes').toString('base64'),
    })
    assert.equal(r.statusCode, 200, r.body)
    assert.equal((await request(alice, 'GET', root)).json().items[0].name, '联通测试.txt')
    const file = await request(alice, 'GET', `${root}/${r.json().id}/download`)
    assert.equal(file.body, 'saved bytes')
    assert.match(file.headers['content-disposition'], /^attachment;/)
    assert.equal((await request(bob, 'GET', `${root}/${r.json().id}/download`)).statusCode, 404)
    assert.equal(
      (await request(alice, 'GET', `/api/tenants/${b}/files/${r.json().id}/download`)).statusCode,
      404,
    )
    assert.equal(
      (
        await request(alice, 'POST', root, {
          name: '../escape',
          mime: 'text/plain',
          content: 'aGk=',
        })
      ).statusCode,
      400,
    )
  })
  await t.test(
    'dispatched department work executes once, records output and shows blocked failures',
    async () => {
      const path = `/api/tenants/${a}/secretary`
      let snap = (await request(alice, 'GET', path)).json()
      const design = snap.board.tasks.find((t) => t.dept === 'new-agent-7' && t.status === 'queued')
      assert.ok(design)
      assert.equal(
        (await request(bob, 'POST', `${path}/tasks/${design.id}/run`, {})).statusCode,
        403,
      )
      modelReply = '真实测试交付内容'
      const result = await request(alice, 'POST', `${path}/tasks/${design.id}/run`, {})
      assert.equal(result.statusCode, 200, result.body)
      assert.equal(result.json().board.tasks.find((t) => t.id === design.id).status, 'queued')
      const designResult = await finishDepartment(a, alice, design.id)
      assert.equal(designResult.status, 'completed')
      assert.equal(designResult.summary, modelReply)
      const before = modelCalls.length
      assert.equal(
        (await request(alice, 'POST', `${path}/tasks/${design.id}/run`, {})).statusCode,
        409,
      )
      assert.equal(modelCalls.length, before)
      snap = (await request(alice, 'GET', path)).json()
      const compliance = snap.board.tasks.find(
        (t) => t.dept === 'data-agent' && t.status === 'queued',
      )
      const blocked = await request(alice, 'POST', `${path}/tasks/${compliance.id}/run`, {})
      assert.equal(blocked.statusCode, 200, blocked.body)
      assert.equal(blocked.json().board.tasks.find((t) => t.id === compliance.id).status, 'queued')
      assert.equal((await finishDepartment(a, alice, compliance.id)).status, 'blocked')
      const ops = snap.board.tasks.find((t) => t.dept === 'app-agent' && t.status === 'queued')
      assert.equal(
        (await request(alice, 'POST', `${path}/tasks/${ops.id}/run`, {})).statusCode,
        200,
      )
      const usage = (await request(alice, 'GET', `/api/tenants/${a}/usage`)).json()
      assert.ok(
        usage.modelUsage.some((u) => u.operation === 'design' && Number(u.input_tokens) > 0),
      )
      assert.equal(
        (await request(bob, 'GET', `/api/tenants/${a}/usage`)).json().modelUsage.length,
        0,
      )
      modelReply = 'fixture'
    },
  )
  await t.test(
    'image task saves real asset, protects preview and rejects empty media without false completion',
    async () => {
      const root = `/api/tenants/${a}`,
        path = `${root}/secretary`
      let snap = (await request(alice, 'GET', path)).json()
      const id = randomUUID(),
        bad = randomUUID()
      const original = {
        id,
        title: '制作冒热气的咖啡静态图片',
        request: '一杯咖啡',
        dept: 'new-agent-7',
        status: 'completed',
        summary: '旧设计说明',
        executionNote: '文字结果已生成',
        due: '2026-10-11',
      }
      snap.board.tasks.push(original, { ...original, id: bad, status: 'queued' })
      await query('UPDATE secretary_workspaces SET board=$3 WHERE tenant_id=$1 AND user_id=$2', [
        a,
        alice,
        JSON.stringify(snap.board),
      ])
      modelReply = 'A steaming coffee in a white cup'
      imageResponse = {
        data: [
          {
            b64_json:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=',
          },
        ],
      }
      const result = await request(alice, 'POST', `${path}/tasks/${id}/run`, {
        regenerateImage: true,
      })
      assert.equal(result.statusCode, 200, result.body)
      const task = result.json().board.tasks.find((t) => t.id === id)
      assert.equal(task.status, 'completed')
      assert.equal(task.previousTextResult, '旧设计说明')
      assert.equal(task.images.length, 1)
      assert.equal(modelCalls.at(-1).body.model, 'gpt-image-1')
      const preview = await request(alice, 'GET', `${root}/files/${task.images[0].fileId}/preview`)
      assert.equal(preview.statusCode, 200)
      assert.match(preview.headers['content-type'], /image\/png/)
      assert.equal(preview.rawPayload.subarray(1, 4).toString(), 'PNG')
      assert.equal(
        (await request(bob, 'GET', `${root}/files/${task.images[0].fileId}/preview`)).statusCode,
        404,
      )
      const n = modelCalls.length
      assert.equal(
        (await request(alice, 'POST', `${path}/tasks/${id}/run`, { regenerateImage: true }))
          .statusCode,
        409,
      )
      assert.equal(modelCalls.length, n)
      imageResponse = { choices: [{ message: { content: '没有生成图片' } }] }
      const failed = await request(alice, 'POST', `${path}/tasks/${bad}/run`, {})
      const failedTask = failed.json().board.tasks.find((t) => t.id === bad)
      assert.equal(failedTask.status, 'blocked')
      assert.equal(failedTask.images, undefined)
      imageResponse = undefined
      modelReply = 'fixture'
    },
  )
  await t.test('persisted reminders deliver once, recur, cancel and remain private', async () => {
    const root = `/api/tenants/${a}/secretary`,
      start = Date.now() + 60000
    const payload = {
      title: '检查今日部门进度',
      nextAt: new Date(start).toISOString(),
      repeatDaily: false,
    }
    assert.equal((await request(bob, 'POST', `${root}/reminders`, payload)).statusCode, 403)
    const one = await request(alice, 'POST', `${root}/reminders`, payload)
    assert.equal(one.statusCode, 200, one.body)
    const daily = await request(alice, 'POST', `${root}/reminders`, {
      ...payload,
      title: '每天提醒',
      repeatDaily: true,
    })
    const canceled = await request(alice, 'POST', `${root}/reminders`, {
      ...payload,
      title: '不应发送',
    })
    await request(alice, 'POST', `${root}/reminders/${canceled.json().id}/cancel`, {})
    const before = (await request(alice, 'GET', root)).json()
    await deliverReminders(pool, new Date(start + 1000))
    let after = (await request(alice, 'GET', root)).json()
    assert.equal(after.board.messages.length, before.board.messages.length + 2)
    assert.ok(after.board.messages.some((m) => m.text === '定时提醒：每天提醒'))
    await deliverReminders(pool, new Date(start + 1000))
    assert.equal((await request(alice, 'GET', root)).json().revision, after.revision)
    await deliverReminders(pool, new Date(start + 86401000))
    assert.equal(
      (await request(alice, 'GET', root)).json().board.messages.length,
      after.board.messages.length + 1,
    )
    assert.equal((await request(bob, 'GET', `${root}/reminders`)).json().items.length, 0)
    assert.equal(
      (await request(alice, 'GET', `/api/tenants/${b}/secretary/reminders`)).json().items.length,
      0,
    )
    await request(alice, 'POST', `${root}/reminders/${daily.json().id}/cancel`, {})
  })
  await t.test(
    'platform binding rejects unauthorized roles and malformed platform paths',
    async () => {
      const root = `/api/tenants/${a}/operations`
      assert.equal(
        (await request(bob, 'POST', `${root}/accounts/connect`, { platform: 'douyin' })).statusCode,
        403,
      )
      assert.equal(
        (await request(alice, 'POST', `${root}/accounts/connect`, { platform: '../settings' }))
          .statusCode,
        400,
      )
      assert.equal(
        (await request(alice, 'POST', `${root}/accounts/connect`, { platform: 'douyin' }))
          .statusCode,
        200,
      )
      assert.equal(
        (await request(outsider, 'GET', `${root}/accounts/auth/douyin/session-id`)).statusCode,
        403,
      )
    },
  )
  await cache.del(`api-rate:${alice}`)
  await t.test(
    'linked operations tasks persist real runtime identity, never finish on stream close and reject duplicate starts',
    async () => {
      const root = `/api/tenants/${a}`,
        snap = (await request(alice, 'GET', `${root}/secretary`)).json()
      const task = snap.board.tasks.find((t) => t.dept === 'app-agent' && t.status === 'queued')
      const payload = { prompt: '制作已派发的视频', secretaryTaskId: task.id }
      assert.equal(
        (await request(bob, 'POST', `${root}/operations/tasks`, payload)).statusCode,
        403,
      )
      assert.equal(
        (await request(alice, 'POST', `/api/tenants/${b}/operations/tasks`, payload)).statusCode,
        404,
      )
      runtimeUnavailable = true
      assert.ok(
        (await request(alice, 'POST', `${root}/operations/tasks`, payload)).statusCode >= 400,
      )
      let saved = (await request(alice, 'GET', `${root}/secretary`))
        .json()
        .board.tasks.find((t) => t.id === task.id)
      assert.equal(saved.status, 'blocked')
      assert.equal(saved.runtimeTaskId, undefined)
      runtimeUnavailable = false
      const before = operationsStarts
      const started = await request(alice, 'POST', `${root}/operations/tasks`, payload)
      assert.equal(started.statusCode, 200, started.body)
      saved = (await request(alice, 'GET', `${root}/secretary`))
        .json()
        .board.tasks.find((t) => t.id === task.id)
      assert.equal(saved.status, 'working')
      assert.equal(saved.runtimeTaskId, '0123456789abcdef01234567')
      assert.equal(
        (await request(alice, 'POST', `${root}/operations/tasks`, payload)).statusCode,
        409,
      )
      assert.equal(operationsStarts, before + 1)
      operationsTaskState = 'requires_action'
      await request(alice, 'GET', `${root}/operations/tasks/${saved.runtimeTaskId}`)
      saved = (await request(alice, 'GET', `${root}/secretary`))
        .json()
        .board.tasks.find((t) => t.id === task.id)
      assert.equal(saved.status, 'blocked')
      assert.match(saved.executionNote, /补充信息/)
      operationsTaskState = 'completed'
      await request(alice, 'GET', `${root}/operations/tasks/${saved.runtimeTaskId}`)
      saved = (await request(alice, 'GET', `${root}/secretary`))
        .json()
        .board.tasks.find((t) => t.id === task.id)
      assert.equal(saved.status, 'completed')
      assert.ok(saved.finishedAt)
      assert.match(saved.executionNote, /回执/)
    },
  )
  await cache.del(`api-rate:${alice}`)
  await t.test(
    'model gateway reports unsupported built-in search and never retries its disabled fallback',
    async () => {
      const policy = (await request(alice, 'GET', `/api/tenants/${a}/operations/settings`)).json()
        .policy
      policy.tiers.strong = 'claude-haiku-4.5'
      policy.tiers.fast = 'fallback-must-not-run'
      policy.departments.market_research = {
        ...policy.departments.market_research,
        enabled: true,
        tier: 'strong',
        fallback: 'fast',
      }
      const requests = []
      let responseStatus = 400
      const call = createModelGateway({
        pool,
        env,
        fetcher: async (url, options) => {
          requests.push({ url, model: JSON.parse(options.body).model })
          return Response.json(
            { error: { message: 'Unsupported server tool: web_search_20250305' } },
            { status: responseStatus },
          )
        },
      })
      const invoke = () =>
        call({
          ctx: { tenantId: a, userId: alice },
          policy,
          department: 'market_research',
          path: '/api/anthropic/v1/messages',
          allowFallback: false,
          body: {
            messages: [{ role: 'user', content: 'Search public evidence' }],
            max_tokens: 2048,
            tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
          },
        })
      await assert.rejects(invoke(), (error) => {
        assert.equal(error.statusCode, 409)
        assert.equal(error.expose, true)
        assert.match(error.message, /中转通道未开放内置联网搜索/)
        assert.doesNotMatch(error.message, /Tavily|Brave|搜索.*(?:密钥|API Key)/i)
        return true
      })
      assert.equal(requests.length, 1)
      // 503 would normally trigger the configured fallback; tool searches explicitly opt out.
      responseStatus = 503
      await assert.rejects(invoke(), /模型服务未完成请求/)
      assert.equal(requests.length, 2)
      assert.ok(
        requests.every((item) => item.url === 'https://app.4yi.ai/api/anthropic/v1/messages'),
      )
      assert.ok(requests.every((item) => item.model === 'claude-haiku-4.5'))
    },
  )
  await t.test(
    'confirmed research uses only the existing model gateway, persists its outline, archives and isolates results',
    async () => {
      const root = `/api/tenants/${a}`
      const configuration = (await request(alice, 'GET', `${root}/operations/settings`)).json()
        .policy
      configuration.tiers.strong = 'test-research'
      configuration.tiers.search = 'test-research'
      configuration.tiers.cheap = 'test-archive'
      await request(alice, 'PUT', `${root}/operations/settings`, { policy: configuration })
      let snapshot = (await request(alice, 'GET', `${root}/secretary`)).json()
      modelReply = JSON.stringify({
        reply: '请确认调研与归档分工',
        tasks: [
          {
            title: 'Research isolated fixture',
            dept: 'review-agent',
            due: '2026-10-11',
            brief: 'Compare public fixture evidence',
            dependsOn: [],
            requiresConfirmation: true,
          },
        ],
      })
      snapshot = (
        await request(alice, 'POST', `${root}/secretary/chat`, {
          revision: snapshot.revision,
          text: '安排联网调研测试',
          intent: 'plan',
          language: 'zh',
          requireTasks: true,
        })
      ).json()
      const research = snapshot.board.tasks.at(-2),
        archive = snapshot.board.tasks.at(-1)
      assert.deepEqual(archive.dependsOn, [research.id])
      assert.equal((await query('SELECT * FROM task_jobs WHERE task_id=$1', [research.id])).rows.length, 0)
      assert.equal(
        (await request(alice, 'POST', `${root}/secretary/tasks/${research.id}/run`, {})).statusCode,
        409,
      )
      let modelRound = 0,
        searches = 0,
        archives = 0,
        persistedOutline = false
      const gatewayRequests = [],
        reads = []
      const replies = [
        {
          sections: [
            {
              title: 'Public evidence',
              questions: ['What does the public evidence show?'],
              query: 'Public fixture',
            },
          ],
        },
        {
          summary: 'Conclusion [S1]',
          findings: 'Public evidence\nFacts [S1]',
          analysis: 'Analysis [S1]',
          recommendations: 'Advice',
          limitations: 'One source fixture',
        },
      ]
      const options = {
        pool,
        env,
        fetcher: async (url, opt) => {
          const body = JSON.parse(opt.body)
          gatewayRequests.push(url)
          assert.equal(url, 'https://app.4yi.ai/api/v1/chat/completions')
          if (body.web_search_options) {
            searches++
            assert.equal(body.model, 'test-research')
            assert.deepEqual(body.web_search_options, { search_context_size: 'low' })
            const stored = (
              await query(
                'SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2',
                [a, alice],
              )
            ).rows[0].board
            const outline = stored.tasks.find((task) => task.id === research.id).researchOutline
            assert.equal(outline[0].title, 'Public evidence')
            assert.equal(outline[0].status, 'searching')
            persistedOutline = true
            const content = 'Fixture snippet'
            return Response.json({
              choices: [
                {
                  message: {
                    content,
                    annotations: [
                      {
                        type: 'url_citation',
                        url_citation: {
                          url: 'https://example.com/report',
                          title: 'Fixture source',
                          start_index: 0,
                          end_index: content.length,
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 50 },
            })
          }
          let content
          if (body.model === 'test-archive') {
            archives++
            content = 'Archived summary'
          } else {
            assert.equal(body.model, 'test-research')
            assert.ok(modelRound < replies.length, 'unexpected duplicate model invocation')
            content = JSON.stringify(replies[modelRound++])
          }
          return Response.json({
            choices: [{ message: { content } }],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          })
        },
        webFactory: (args) =>
          createModelWebTools({
            ...args,
            reader: async (url) => {
              reads.push(url)
              return { url, text: 'Fixture full page evidence' }
            },
          }),
      }
      assert.equal((await query('SELECT * FROM research_settings')).rows.length, 0)
      assert.equal(await createResearchEngine(options).tick(), false)
      assert.equal(gatewayRequests.length, 0)
      snapshot = (
        await request(alice, 'POST', `${root}/secretary`, {
          revision: snapshot.revision,
          today: '2026-10-11',
          action: { type: 'dispatch', batchId: research.batchId },
        })
      ).json()
      assert.equal(snapshot.board.tasks.find((t) => t.id === research.id).status, 'queued')
      // Distinct workers compete. Only one claim invokes the configured model search.
      await Promise.all([
        createResearchEngine(options).tick(),
        createResearchEngine(options).tick(),
      ])
      snapshot = (await request(alice, 'GET', `${root}/secretary`)).json()
      assert.equal(snapshot.board.tasks.find((t) => t.id === research.id).status, 'completed')
      assert.equal(snapshot.board.tasks.find((t) => t.id === archive.id).status, 'queued')
      const completed = snapshot.board.tasks.find((task) => task.id === research.id)
      assert.equal(completed.researchOutline[0].title, 'Public evidence')
      assert.equal(completed.researchOutline[0].status, 'completed')
      assert.deepEqual(completed.researchOutline[0].sourceIds, ['S1'])
      assert.equal(persistedOutline, true)
      assert.equal(modelRound, 2)
      assert.equal(searches, 1)
      assert.deepEqual(reads, ['https://example.com/report'])
      await createResearchEngine(options).tick()
      snapshot = (await request(alice, 'GET', `${root}/secretary`)).json()
      const saved = snapshot.board.tasks.find((t) => t.id === archive.id)
      assert.equal(saved.status, 'completed')
      assert.ok(saved.archiveFileId)
      assert.match(saved.archiveName, /市场调研/)
      const report = await request(alice, 'GET', `${root}/files/${saved.archiveFileId}/download`)
      assert.equal(report.statusCode, 200)
      assert.match(report.body, /Fixture source/)
      assert.match(report.body, /Conclusion/)
      assert.match(report.body, /Public evidence/)
      assert.equal(
        (await request(bob, 'GET', `${root}/files/${saved.archiveFileId}/download`)).statusCode,
        404,
      )
      assert.equal(await createResearchEngine(options).tick(), false)
      assert.equal(searches, 1)
      assert.equal(archives, 1)
      assert.equal(gatewayRequests.length, 4)
      assert.ok(gatewayRequests.every((url) => new URL(url).hostname === 'app.4yi.ai'))
      assert.equal((await query('SELECT * FROM research_settings')).rows.length, 0)
      // An expired lease becomes blocked, never silently replays a possibly charged call.
      await query(
        "UPDATE task_jobs SET state='running',lease_until=now()-interval '1 second' WHERE task_id=$1",
        [research.id],
      )
      await createResearchEngine(options).tick()
      const recovered = (await request(alice, 'GET', `${root}/secretary`))
        .json()
        .board.tasks.find((t) => t.id === research.id)
      assert.equal(recovered.status, 'blocked')
      assert.match(recovered.executionNote, /执行中断/)
      assert.equal(searches, 1)
      assert.equal(gatewayRequests.length, 4)
      modelReply = 'fixture'
    },
  )
  await t.test(
    'intern can chat, receive an editable secretary plan, execute after dispatch and archive the result',
    async () => {
      const root = `/api/tenants/${a}`
      const path = `${root}/secretary`
      const settingsPath = `${root}/operations/settings`
      const originalPolicy = (await request(alice, 'GET', settingsPath)).json().policy
      const policy = structuredClone(originalPolicy)
      policy.departments.intern = {
        ...policy.departments.intern,
        enabled: true,
        tier: 'fast',
        fallback: 'cheap',
      }
      const skill = (await request(alice, 'GET', `${root}/skills/installed`))
        .json()
        .items.find((item) => item.name === 'tenant-upload')
      const assignmentPath = `${root}/skills/${skill.id}/assignments`
      const originalAssignments = (
        await request(alice, 'GET', `${root}/skills/${skill.id}/detail`)
      ).json().departments
      try {
        assert.equal((await request(alice, 'PUT', settingsPath, { policy })).statusCode, 200)
        assert.equal(
          (
            await request(alice, 'PUT', assignmentPath, {
              departments: [...originalAssignments, 'intern'],
            })
          ).statusCode,
          200,
        )
        const ready = (await request(alice, 'GET', `${root}/workspace/status`))
          .json()
          .departments.find((d) => d.id === 'intern')
        assert.equal(ready.ready, true)
        assert.equal(ready.active, false)

        modelReply = '我会协助整理会议要点。'
        let observedActiveChat = false
        duringModel = async () => {
          const own = (await request(alice, 'GET', `${root}/workspace/status`)).json()
          assert.equal(own.departments.find((d) => d.id === 'intern').active, true)
          assert.equal(own.departments.find((d) => d.id === 'design').active, false)
          const otherUser = (await request(bob, 'GET', `${root}/workspace/status`)).json()
          assert.equal(otherUser.departments.find((d) => d.id === 'intern').active, false)
          const otherTenant = (
            await request(alice, 'GET', `/api/tenants/${b}/workspace/status`)
          ).json()
          assert.equal(otherTenant.departments.find((d) => d.id === 'intern').active, false)
          observedActiveChat = true
        }
        const chat = await request(alice, 'POST', `${root}/departments/intern/chat`, {
          revision: 0,
          text: '介绍你能协助的日常文字工作',
        })
        assert.equal(chat.statusCode, 200, chat.body)
        assert.equal(observedActiveChat, true)
        assert.equal(
          (await request(alice, 'GET', `${root}/workspace/status`))
            .json()
            .departments.find((d) => d.id === 'intern').active,
          false,
        )
        assert.equal(chat.json().messages.at(-1).text, modelReply)
        assert.equal(modelCalls.at(-1).body.model, policy.tiers.fast)
        assert.match(modelCalls.at(-1).body.messages[0].content, /实习生/)
        assert.match(modelCalls.at(-1).body.messages[0].content, /tenant-upload/)
        assert.equal(
          (await request(bob, 'GET', `${root}/departments/intern/conversation`)).json().messages
            .length,
          0,
        )

        let snapshot = (await request(alice, 'GET', path)).json()
        modelReply = JSON.stringify({
          reply: '已为实习生准备任务，确认后开始。',
          tasks: [
            {
              title: '编写会议摘要',
              dept: 'new-agent-9',
              due: '2026-10-11',
              brief: '根据给定会议要点输出完整摘要。',
              dependsOn: [],
              requiresConfirmation: true,
            },
          ],
        })
        const planned = await request(alice, 'POST', `${path}/chat`, {
          revision: snapshot.revision,
          text: '请实习生根据会议要点编写摘要：本周先整理产品反馈，再检查资料分类。',
          requireTasks: true,
          intent: 'plan',
          language: 'zh',
        })
        assert.equal(planned.statusCode, 200, planned.body)
        assert.match(modelCalls.at(-1).body.messages[0].content, /"id":"new-agent-9"/)
        snapshot = planned.json()
        const task = snapshot.board.tasks.at(-1)
        assert.equal(task.dept, 'new-agent-9')
        assert.equal(task.status, 'draft')

        const edited = await request(alice, 'POST', path, {
          revision: snapshot.revision,
          today: '2026-10-11',
          action: {
            type: 'edit',
            batchId: task.batchId,
            tasks: [{ id: task.id, title: '实习生会议摘要', dept: 'new-agent-9', due: task.due }],
          },
        })
        assert.equal(edited.statusCode, 200, edited.body)
        const beforeDispatch = modelCalls.length
        assert.equal(
          (await request(alice, 'POST', `${path}/tasks/${task.id}/run`, {})).statusCode,
          409,
        )
        assert.equal(modelCalls.length, beforeDispatch)
        const dispatched = await request(alice, 'POST', path, {
          revision: edited.json().revision,
          today: '2026-10-11',
          action: { type: 'dispatch', batchId: task.batchId },
        })
        assert.equal(dispatched.statusCode, 200, dispatched.body)
        assert.equal(
          dispatched.json().board.tasks.find((item) => item.id === task.id).status,
          'queued',
        )
        assert.equal(
          (await request(bob, 'POST', `${path}/tasks/${task.id}/run`, {})).statusCode,
          403,
        )

        modelReply = '会议摘要：本周先汇总产品反馈，再按部门检查资料分类。'
        let observedActiveTask = false
        duringModel = async () => {
          const status = (await request(alice, 'GET', `${root}/workspace/status`)).json()
          assert.equal(status.departments.find((d) => d.id === 'intern').active, true)
          observedActiveTask = true
        }
        const executed = await request(alice, 'POST', `${path}/tasks/${task.id}/run`, {})
        assert.equal(executed.statusCode, 200, executed.body)
        const result = await finishDepartment(a, alice, task.id)
        assert.equal(observedActiveTask, true)
        assert.equal(
          (await request(alice, 'GET', `${root}/workspace/status`))
            .json()
            .departments.find((d) => d.id === 'intern').active,
          false,
        )
        assert.equal(result.status, 'completed')
        assert.equal(result.summary, modelReply)
        assert.equal(modelCalls.at(-1).body.model, policy.tiers.fast)
        assert.match(modelCalls.at(-1).body.messages[0].content, /实习生/)
        assert.match(modelCalls.at(-1).body.messages[0].content, /tenant-upload/)
        assert.ok(result.archiveFileId)
        assert.ok(result.archivedAt)
        const file = await request(alice, 'GET', `${root}/files/${result.archiveFileId}/download`)
        assert.equal(file.statusCode, 200, file.body)
        assert.match(file.body, /本周先汇总产品反馈/)
        assert.equal(
          (await request(bob, 'GET', `${root}/files/${result.archiveFileId}/download`)).statusCode,
          404,
        )
        assert.equal(
          (await request(alice, 'GET', `/api/tenants/${b}/files/${result.archiveFileId}/download`))
            .statusCode,
          404,
        )
        const afterExecution = modelCalls.length
        assert.equal(
          (await request(alice, 'POST', `${path}/tasks/${task.id}/run`, {})).statusCode,
          409,
        )
        assert.equal(modelCalls.length, afterExecution)
      } finally {
        duringModel = undefined
        modelReply = 'fixture'
        await request(alice, 'PUT', assignmentPath, { departments: originalAssignments })
        await request(alice, 'PUT', settingsPath, { policy: originalPolicy })
      }
    },
  )
  await t.test(
    'department activity ignores expired and settled requests and stays scoped to tenant and user',
    async () => {
      const fixtures = [
        { tenant: a, user: alice, state: 'pending', age: 11 },
        { tenant: a, user: alice, state: 'completed', age: 0 },
        { tenant: a, user: alice, state: 'unknown', age: 0 },
        { tenant: a, user: alice, state: 'rejected', age: 0 },
        { tenant: a, user: bob, state: 'pending', age: 0 },
        { tenant: b, user: alice, state: 'pending', age: 0 },
      ].map((item) => ({ ...item, id: randomUUID() }))
      try {
        for (const item of fixtures)
          await query(
            "INSERT INTO model_requests(id,tenant_id,user_id,day,department,model,reserved_tokens,state,created_at) VALUES($1,$2,$3,current_date,'intern','activity-fixture',1,$4,now()-($5 * interval '1 minute'))",
            [item.id, item.tenant, item.user, item.state, item.age],
          )
        const active = async (user, tenant) => {
          const response = await request(user, 'GET', `/api/tenants/${tenant}/workspace/status`)
          assert.equal(response.statusCode, 200, response.body)
          return response.json().departments.find((d) => d.id === 'intern').active
        }
        assert.equal(await active(alice, a), false)
        assert.equal(await active(bob, a), true)
        assert.equal(await active(alice, b), true)
        assert.equal(
          (await request(outsider, 'GET', `/api/tenants/${a}/workspace/status`)).statusCode,
          403,
        )
      } finally {
        for (const item of fixtures)
          await query('DELETE FROM model_requests WHERE id=$1', [item.id])
      }
    },
  )
  await t.test('membership revocation takes effect even with cached agents', async () => {
    await request(bob, 'GET', `/api/tenants/${a}/agents`)
    await request(alice, 'DELETE', `/api/tenants/${a}/members/${bob}`)
    assert.equal((await request(bob, 'GET', `/api/tenants/${a}/agents`)).statusCode, 403)
  })
  await cache.del(`api-rate:${alice}`)
  await t.test(
    'secretary attachment bytes reach the model and task, archived results stay private',
    async () => {
      const root = `/api/tenants/${a}`
      const uploaded = await request(alice, 'POST', `${root}/files`, {
        name: 'attachment-test.txt',
        mime: 'text/plain',
        content: Buffer.from('产品主题：蓝色咖啡杯').toString('base64'),
      })
      assert.equal(uploaded.statusCode, 200, uploaded.body)
      const id = uploaded.json().id
      let snap = (await request(alice, 'GET', `${root}/secretary`)).json()
      modelReply = JSON.stringify({
        reply: '分工准备完成',
        tasks: [
          {
            title: '编写设计说明',
            dept: 'new-agent-7',
            due: '2026-10-11',
            brief: '只输出文字设计说明',
            dependsOn: [],
            requiresConfirmation: true,
          },
        ],
      })
      const answer = await request(alice, 'POST', `${root}/secretary/chat`, {
        revision: snap.revision,
        text: '按附件编写文字设计说明',
        intent: 'plan',
        language: 'zh',
        requireTasks: true,
        attachmentIds: [id],
      })
      assert.equal(answer.statusCode, 200, answer.body)
      assert.match(JSON.stringify(modelCalls.at(-1).body.messages.at(-1)), /蓝色咖啡杯/)
      snap = answer.json()
      const task = snap.board.tasks.at(-1)
      assert.deepEqual(task.attachmentIds, [id])
      snap = (
        await request(alice, 'POST', `${root}/secretary`, {
          revision: snap.revision,
          action: { type: 'dispatch', batchId: task.batchId },
          today: '2026-10-11',
        })
      ).json()
      modelReply = '蓝色咖啡杯的完整文字设计说明'
      const run = await request(alice, 'POST', `${root}/secretary/tasks/${task.id}/run`, {})
      assert.equal(run.statusCode, 200, run.body)
      const done = await finishDepartment(a, alice, task.id)
      assert.match(JSON.stringify(modelCalls.at(-1).body.messages.at(-1)), /蓝色咖啡杯/)
      assert.equal(done.status, 'completed')
      assert.ok(done.archiveFileId)
      const content = await request(alice, 'GET', `${root}/files/${done.archiveFileId}/download`)
      assert.match(content.body, /蓝色咖啡杯的完整文字设计说明/)
      const privateResponse = await request(bob, 'GET', `${root}/deliverables`)
      assert.ok([200, 403].includes(privateResponse.statusCode), privateResponse.body)
      if (privateResponse.statusCode === 200)
        assert.ok(
          !privateResponse.json().files.some((f) => f.id === done.archiveFileId || f.id === id),
        )
      await request(alice, 'POST', `${root}/deliverables/sync`, {})
      const second = await request(alice, 'POST', `${root}/deliverables/sync`, {})
      assert.equal(second.json().archived, 0)
      modelReply = 'fixture'
    },
  )
  await t.test(
    'database RLS blocks unscoped and cross-tenant reads for non-owner role',
    async () => {
      await query('CREATE ROLE rls_test NOSUPERUSER NOBYPASSRLS')
      await query('GRANT USAGE ON SCHEMA public TO rls_test')
      await query(
        'GRANT SELECT ON agents,installed_skills,secretary_workspaces,operations_settings,operations_publications,model_daily_usage,model_requests,workspace_files,department_conversations,skill_assignments,secretary_reminders,task_jobs,research_settings TO rls_test',
      )
      await query('SET ROLE rls_test')
      for (const name of [
        'task_jobs',
        'research_settings',
        'workspace_files',
        'department_conversations',
        'skill_assignments',
        'secretary_reminders',
      ])
        assert.equal((await query(`SELECT * FROM ${name}`)).rows.length, 0)
      assert.equal((await query('SELECT * FROM agents')).rows.length, 0)
      assert.equal((await query('SELECT * FROM operations_settings')).rows.length, 0)
      assert.equal((await query('SELECT * FROM operations_publications')).rows.length, 0)
      assert.equal((await query('SELECT * FROM installed_skills')).rows.length, 0)
      assert.equal((await query('SELECT * FROM secretary_workspaces')).rows.length, 0)
      await query('BEGIN')
      await query("SELECT set_config('app.tenant_id',$1,true)", [b])
      const privateSkills = (await query('SELECT tenant_id FROM installed_skills')).rows
      assert.equal(privateSkills.length, 1)
      assert.equal(privateSkills[0].tenant_id, b)
      assert.equal(
        (await query('SELECT * FROM installed_skills WHERE tenant_id=$1', [a])).rows.length,
        0,
      )
      assert.equal((await query('SELECT * FROM agents')).rows.length, 0)
      assert.equal((await query('SELECT * FROM operations_settings')).rows.length, 0)
      assert.equal((await query('SELECT * FROM operations_publications')).rows.length, 0)
      await query('ROLLBACK')
      await query('BEGIN')
      await query("SELECT set_config('app.tenant_id',$1,true)", [a])
      assert.equal((await query('SELECT * FROM agents')).rows.length, 1)
      await query("SELECT set_config('app.user_id',$1,true)", [bob])
      assert.equal((await query('SELECT * FROM secretary_workspaces')).rows.length, 0)
      await query("SELECT set_config('app.user_id',$1,true)", [alice])
      assert.equal((await query('SELECT * FROM secretary_workspaces')).rows.length, 1)
      await query('ROLLBACK')
      assert.equal(
        (await query('SELECT * FROM model_requests WHERE tenant_id=$1', [b])).rows.length,
        0,
      )
      await query('RESET ROLE')
    },
  )
  await app.close()
  await pg.close()
})
