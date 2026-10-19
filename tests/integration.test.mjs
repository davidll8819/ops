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
  const modelMessages = []
  const executionCalls = []
  let executionAvailable = true
  let executionOutcome, duringExecution
  const versionTestCalls=[]
  let versionTestOutcome, duringVersionTest
  const passingVersionTest=()=>({counts:{tests:1,passed:1,failed:0,cancelled:0,skipped:0,todo:0},cases:[{name:'saved-version assertion',status:'passed',detail:''}],summaryComplete:true,success:true,exitCode:0,stdout:'real transport test fixture',stderr:'',timedOut:false,truncated:false})
  const executionDriver = {
    status: async () => ({
      available: executionAvailable,
      reason: executionAvailable ? '' : '执行镜像尚未准备',
      environment: 'Node.js 24 / Python 3',
    }),
    test: async (input) => {
      versionTestCalls.push(input)
      if(duringVersionTest){const hook=duringVersionTest;duringVersionTest=undefined;await hook(input)}
      if(versionTestOutcome){const outcome=versionTestOutcome;versionTestOutcome=undefined;return outcome(input)}
      return passingVersionTest()
    },
    execute: async (input) => {
      executionCalls.push(input)
      if (duringExecution) {
        const hook = duringExecution
        duringExecution = undefined
        await hook()
      }
      if (executionOutcome) {
        const result = executionOutcome
        executionOutcome = undefined
        return result(input)
      }
      return {
        files: input.files,
        exitCode: 0,
        stdout: 'tests: 1 passed',
        stderr: '',
        timedOut: false,
        truncated: false,
      }
    },
  }
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
      choices: [{ message: modelMessages.shift() || { content: modelReply } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    })
  }
  async function finishDepartment(tenantId, userId, taskId) {
    // Place this fixture first; unrelated test fixtures keep their existing queue entries.
    await query(
      "UPDATE task_jobs SET updated_at='2000-01-01' WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3",
      [tenantId, userId, taskId],
    )
    await createDepartmentEngine({
      pool,
      env,
      fetcher: modelFetch,
      operations: createOperationsTasks({ pool, env, driver: operationsDriver }),
    }).tick()
    return (
      await query('SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2', [
        tenantId,
        userId,
      ])
    ).rows[0].board.tasks.find((t) => t.id === taskId)
  }
  const app = await buildApp({
    executionDriver,
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
    'employee profiles preserve office identity and work before model configuration',
    async () => {
      const response = await request(alice, 'GET', `/api/tenants/${a}/employees`)
      assert.equal(response.statusCode, 200, response.body)
      const employees = response.json().employees
      assert.equal(employees.length, 9)
      assert.deepEqual(
        employees.map((e) => [e.id, e.rosterNo]),
        [
          ['marvis', 1],
          ['code-agent', 2],
          ['file-agent', 3],
          ['app-agent', 4],
          ['review-agent', 5],
          ['data-agent', 6],
          ['new-agent-7', 7],
          ['new-agent-8', 8],
          ['new-agent-9', 9],
        ],
      )
      const dragon = employees.find((e) => e.id === 'code-agent')
      assert.equal(dragon.name, '龙傲天')
      assert.equal(dragon.departmentKey, 'dev')
      assert.equal(dragon.color, 0x4a90d9)
      assert.equal(dragon.models.text.configured, false)
      assert.deepEqual(dragon.skills, [])
      assert.equal((await request(outsider, 'GET', `/api/tenants/${a}/employees`)).statusCode, 403)
    },
  )
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
      assert.equal(
        (await query('SELECT * FROM task_jobs WHERE task_id=$1', [snap.board.tasks.at(-2).id])).rows
          .length,
        0,
      )
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
    'employee skill editor enforces tenant, role, revision and preserves other employees',
    async () => {
      const root = `/api/tenants/${a}`
      const path = `${root}/employees/code-agent/skills`
      const skill = (await request(alice, 'GET', `${root}/skills/installed`))
        .json()
        .items.find((s) => s.name === 'tenant-upload')
      let r = await request(alice, 'GET', path)
      assert.equal(r.statusCode, 200, r.body)
      const original = r.json()
      assert.ok(original.items.some((s) => s.id === skill.id))
      assert.equal((await request(outsider, 'GET', path)).statusCode, 403)
      assert.equal(
        (await request(bob, 'PUT', path, { revision: original.revision, skillIds: [skill.id] }))
          .statusCode,
        403,
      )
      assert.equal(
        (
          await request(alice, 'PUT', `/api/tenants/${b}/employees/code-agent/skills`, {
            revision: original.revision,
            skillIds: [skill.id],
          })
        ).statusCode,
        404,
      )
      assert.equal(
        (await request(alice, 'GET', `${root}/employees/unknown/skills`)).statusCode,
        404,
      )
      r = await request(alice, 'PUT', path, { revision: original.revision, skillIds: [skill.id] })
      assert.equal(r.statusCode, 200, r.body)
      assert.deepEqual(r.json().skillIds, [skill.id])
      assert.equal(
        (await request(alice, 'PUT', path, { revision: original.revision, skillIds: [] }))
          .statusCode,
        409,
      )
      assert.equal(
        (
          await request(alice, 'PUT', path, {
            revision: r.json().revision,
            skillIds: Array.from({ length: 9 }, () => randomUUID()),
          })
        ).statusCode,
        400,
      )
      const otherBefore = (
        await request(alice, 'GET', `${root}/employees/file-agent/skills`)
      ).json()
      const install = `${path}/superpowers`
      assert.equal((await request(bob, 'POST', install, {})).statusCode, 403)
      r = await request(alice, 'POST', install, {})
      assert.equal(r.statusCode, 200, r.body)
      const installed = r.json()
      assert.equal(installed.skill.name, 'superpowers')
      assert.equal(installed.skill.provenance.commit.length, 40)
      assert.ok(installed.skillIds.includes(skill.id))
      assert.ok(installed.skillIds.includes(installed.skill.id))
      const again = await request(alice, 'POST', install, {})
      assert.equal(again.statusCode, 200, again.body)
      assert.equal(again.json().skill.id, installed.skill.id)
      assert.equal(again.json().skillIds.length, 2)
      const otherAfter = (await request(alice, 'GET', `${root}/employees/file-agent/skills`)).json()
      assert.deepEqual(otherAfter.skillIds, otherBefore.skillIds)
      assert.equal(otherAfter.revision, otherBefore.revision)
      assert.ok(
        !(await request(alice, 'GET', `/api/tenants/${b}/skills/installed`))
          .json()
          .items.some((s) => s.name === 'superpowers'),
      )
      const doc = `${installed.skill.id}/skills/systematic-debugging/SKILL.md`
      const priorPolicy = (await request(alice, 'GET', `${root}/operations/settings`)).json().policy
      const chatPolicy = structuredClone(priorPolicy)
      chatPolicy.departments.dev.model = 'test-agent'
      assert.equal(
        (await request(alice, 'PUT', `${root}/operations/settings`, chatPolicy)).statusCode,
        200,
      )
      modelMessages.push(
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'read-debug',
              type: 'function',
              function: { name: 'read_skill', arguments: JSON.stringify({ path: doc }) },
            },
          ],
        },
        { content: '先复现问题并查明根因。' },
      )
      const chat = await request(alice, 'POST', `${root}/departments/dev/chat`, {
        revision: 0,
        text: '帮我排查程序闪退，使用调试技能。',
      })
      assert.equal(chat.statusCode, 200, chat.body)
      assert.ok(
        chat
          .json()
          .messages.at(-1)
          .skillReads.some((r) => r.path === doc),
      )
      assert.equal(modelCalls.at(-1).body.messages.at(-1).role, 'tool')
      assert.match(modelCalls.at(-1).body.messages.at(-1).content, /Root Cause/)
      // Restore the original bindings so later existing department tests stay independent.
      r = await request(alice, 'PUT', path, {
        revision: again.json().revision,
        skillIds: original.skillIds,
      })
      assert.equal(r.statusCode, 200, r.body)
      const ordinary = await request(alice, 'POST', `${root}/departments/dev/chat`, {
        revision: 1,
        text: '你好',
      })
      assert.equal(ordinary.statusCode, 200, ordinary.body)
      assert.equal(modelCalls.at(-1).body.tools, undefined)
      assert.ok(!modelCalls.at(-1).body.messages[0].content.includes('superpowers'))
      await request(alice, 'PUT', `${root}/operations/settings`, priorPolicy)
    },
  )
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
      assert.match(modelCalls.at(-1).body.messages[0].content, /赵雅梦/)
      const employeeResponse = await request(bob, 'GET', `${root}/employees`)
      assert.equal(employeeResponse.statusCode, 200, employeeResponse.body)
      const employee = employeeResponse.json().employees.find((e) => e.id === 'file-agent')
      assert.equal(employee.models.text.model, modelCalls.at(-1).body.model)
      assert.equal(employee.models.text.configured, true)
      assert.ok(modelCalls.at(-1).body.messages[0].content.startsWith(employee.chatInstructions))
      assert.match(employee.chatInstructions, /赵雅梦/)
      assert.ok(employee.skills.some((s) => s.id === skill.id && s.name === 'tenant-upload'))
      assert.ok(!employeeResponse.body.includes('rotated-company-a-key'))
      assert.ok(!employeeResponse.body.includes('gateway'))
      const otherEmployees = (await request(alice, 'GET', `${other}/employees`)).json().employees
      assert.ok(otherEmployees.every((e) => e.skills.length === 0))
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
  await cache.del(`api-rate:${alice}`)
  await t.test(
    'Dragon execution persists files and real tool evidence with private role-scoped workspace',
    async () => {
      const root = `/api/tenants/${a}`
      const path = `${root}/employees/code-agent/workspace`
      let r = await request(alice, 'GET', path)
      assert.equal(r.statusCode, 200, r.body)
      assert.equal(r.json().workspace, null)
      assert.equal((await request(bob, 'POST', path, {})).statusCode, 403)
      assert.equal((await request(outsider, 'GET', path)).statusCode, 403)
      r = await request(alice, 'POST', path, {})
      assert.equal(r.statusCode, 200, r.body)
      const workspaceId = r.json().workspace.id
      assert.equal((await request(alice, 'POST', path, {})).json().workspace.id, workspaceId)
      assert.equal(
        (await request(alice, 'GET', `/api/tenants/${b}/employees/code-agent/workspace`)).json()
          .workspace,
        null,
      )
      assert.equal((await request(bob, 'GET', path)).json().workspace, null)
      const priorPolicy = (await request(alice, 'GET', `${root}/operations/settings`)).json().policy
      const policy = structuredClone(priorPolicy)
    policy.departments.dev.model = 'gpt-5.6-luna'
      await request(alice, 'PUT', `${root}/operations/settings`, policy)
      const chatPath = `${root}/departments/dev/chat`
      const old = (await request(alice, 'GET', `${root}/departments/dev/conversation`)).json()
      const toolCall = (id, name, args) => ({
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      })
      modelMessages.push(
        {
          content: null,
          tool_calls: [
            toolCall('write', 'workspace_write_file', {
              path: 'answer.mjs',
              content: 'export const answer = 42\n',
            }),
          ],
        },
        {
          content: null,
          tool_calls: [
            toolCall('test', 'workspace_run_command', { command: 'node --test', timeoutMs: 30000 }),
          ],
        },
        { content: '文件已创建，测试已通过。' },
      )
      duringModel = async () => {
        const duplicate = await request(alice, 'POST', chatPath, {
          execute: true,
          revision: old.revision,
          text: '重复执行',
        })
        assert.equal(duplicate.statusCode, 409, duplicate.body)
        const ordinary = await request(alice, 'POST', chatPath, {
          revision: old.revision + 1,
          text: '并发普通聊天',
        })
        assert.equal(ordinary.statusCode, 409, ordinary.body)
      }
      const beforeCalls = executionCalls.length
      r = await request(alice, 'POST', chatPath, {
        execute: true,
        revision: old.revision,
        text: '创建答案文件并运行测试',
      })
      assert.equal(r.statusCode, 200, r.body)
      assert.equal(executionCalls.length, beforeCalls + 1)
      const runId = r.json().messages.at(-1).runId
      assert.ok(runId)
      assert.equal(
        (await request(alice, 'GET', `${path}/file?path=answer.mjs`)).json().content,
        'export const answer = 42\n',
      )
      assert.equal((await request(alice, 'GET', `${path}/file?path=..%2F.env`)).statusCode, 400)
      const snapshot = (await request(alice, 'GET', path)).json()
      assert.equal(snapshot.workspace.activeRunId, null)
      const run = snapshot.runs.find((run) => run.id === runId)
      assert.equal(run.state, 'completed')
      assert.equal(
        run.steps.find((s) => s.tool === 'workspace_run_command').result.stdout,
        'tests: 1 passed',
      )
      assert.equal(modelCalls.at(-1).body.messages.at(-1).role, 'tool')
      assert.match(modelCalls.at(-1).body.messages.at(-1).content, /tests: 1 passed/)
    assert.equal(modelCalls.at(-1).body.reasoning_effort, 'none')
      const download = await request(alice, 'GET', `${path}/download`)
      assert.equal(download.statusCode, 200, download.body)
      const { zipFiles } = await import('../apps/api/src/skill-upload.mjs')
      assert.equal(
        (await zipFiles(download.rawPayload)).files.get('answer.mjs').toString(),
        'export const answer = 42\n',
      )
      assert.equal((await request(bob, 'GET', `${path}/file?path=answer.mjs`)).statusCode, 404)
      assert.equal(
        (await request(bob, 'POST', chatPath, { execute: true, revision: 0, text: '修改' }))
          .statusCode,
        403,
      )
      assert.equal(
        (
          await request(alice, 'POST', `${root}/departments/archive/chat`, {
            execute: true,
            revision: 0,
            text: '修改',
          })
        ).statusCode,
        400,
      )
      // A failed final model response must not discard earlier file modifications or the journal.
      modelMessages.push(
        {
          content: null,
          tool_calls: [
            toolCall('saved', 'workspace_write_file', {
              path: 'kept.txt',
              content: 'saved before failure',
            }),
          ],
        },
        { content: null },
      )
      const revision = r.json().revision
      r = await request(alice, 'POST', chatPath, {
        execute: true,
        revision,
        text: '写入后模拟模型中断',
      })
      assert.equal(r.statusCode, 200, r.body)
      assert.match(r.json().messages.at(-1).text, /未完成|失败/)
      assert.equal(
        (await request(alice, 'GET', `${path}/file?path=kept.txt`)).json().content,
        'saved before failure',
      )
      assert.equal((await request(alice, 'GET', path)).json().runs[0].state, 'failed')
      // A failed file write must not be labelled completed just because the model says so.
      modelMessages.push(
        {
          content: null,
          tool_calls: [
            toolCall('conflict', 'workspace_write_file', {
              path: 'README.md/child.txt',
              content: 'cannot exist below a file',
            }),
          ],
        },
        { content: '文件已创建。' },
      )
      r = await request(alice, 'POST', chatPath, {
        execute: true,
        revision: r.json().revision,
        text: '模拟文件冲突',
      })
      assert.equal(r.statusCode, 200, r.body)
      assert.equal((await request(alice, 'GET', path)).json().runs[0].state, 'failed')
      assert.match(r.json().messages.at(-1).text, /最近一次操作未成功/)
      // A nonzero command cannot be labelled completed even if the model says it passed.
      executionOutcome = (input) => ({
        files: input.files,
        exitCode: 7,
        stdout: '',
        stderr: 'test failure',
        timedOut: false,
        truncated: false,
      })
      modelMessages.push(
        {
          content: null,
          tool_calls: [toolCall('bad-test', 'workspace_run_command', { command: 'exit 7' })],
        },
        { content: '测试通过。' },
      )
      r = await request(alice, 'POST', chatPath, {
        execute: true,
        revision: r.json().revision,
        text: '模拟测试失败',
      })
      assert.equal(r.statusCode, 200, r.body)
      assert.match(r.json().messages.at(-1).text, /最近一次命令未成功/)
      assert.equal((await request(alice, 'GET', path)).json().runs[0].state, 'failed')
      // An invalid output snapshot must never replace the last valid project.
      executionOutcome = () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        snapshotError: 'Unsupported symlink',
      })
      const callsBeforeUncertain = executionCalls.length
      modelMessages.push({
        content: null,
        tool_calls: [
          toolCall('bad-snapshot', 'workspace_run_command', { command: 'ln -s /tmp bad' }),
          toolCall('unsafe-retry', 'workspace_run_command', { command: 'echo must not replay' }),
        ],
      })
      r = await request(alice, 'POST', chatPath, {
        execute: true,
        revision: r.json().revision,
        text: '模拟快照失败',
      })
      assert.equal(r.statusCode, 200, r.body)
      assert.equal(
        (await request(alice, 'GET', `${path}/file?path=kept.txt`)).json().content,
        'saved before failure',
      )
      const badSnapshot = (await request(alice, 'GET', path)).json().runs[0]
      assert.equal(executionCalls.length, callsBeforeUncertain + 1)
      assert.match(r.json().messages.at(-1).text, /不会自动重试/)
      assert.equal(badSnapshot.state, 'failed')
      assert.equal(badSnapshot.steps[0].result.saved, false)
      // Record an already accepted operation, then stop further tools on role revocation.
      duringExecution = () =>
        query("UPDATE memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2", [a, alice])
      executionOutcome = (input) => ({
        files: [
          ...input.files,
          { path: 'accepted.txt', contentBase64: Buffer.from('accepted').toString('base64') },
        ],
        exitCode: 0,
        stdout: 'accepted',
        stderr: '',
        timedOut: false,
        truncated: false,
      })
      modelMessages.push({
        content: null,
        tool_calls: [
          toolCall('accepted', 'workspace_run_command', { command: 'echo accepted' }),
          toolCall('revoked', 'workspace_write_file', {
            path: 'forbidden.txt',
            content: 'must not be saved',
          }),
        ],
      })
      r = await request(alice, 'POST', chatPath, {
        execute: true,
        revision: r.json().revision,
        text: '模拟执行中撤销权限',
      })
      assert.equal(r.statusCode, 200, r.body)
      assert.equal(
        (await request(alice, 'GET', `${path}/file?path=accepted.txt`)).json().content,
        'accepted',
      )
      assert.equal((await request(alice, 'GET', `${path}/file?path=forbidden.txt`)).statusCode, 404)
      const revoked = (await request(alice, 'GET', path)).json().runs[0]
      assert.equal(revoked.state, 'failed')
      assert.equal(revoked.steps.length, 1)
      assert.equal(revoked.steps[0].status, 'completed')
      await query("UPDATE memberships SET role='owner' WHERE tenant_id=$1 AND user_id=$2", [
        a,
        alice,
      ])
      // Recover an abandoned claim without replaying its command or discarding files.
      const callsBeforeRecovery = executionCalls.length
      duringModel = async () => {
        await query(
          "UPDATE employee_workspaces SET lease_until=now()-interval '1 second' WHERE id=$1",
          [workspaceId],
        )
        const recovered = (await request(alice, 'GET', path)).json()
        assert.equal(recovered.workspace.activeRunId, null)
        assert.equal(recovered.runs[0].state, 'interrupted')
      }
      modelMessages.push({
        content: null,
        tool_calls: [toolCall('stale', 'workspace_run_command', { command: 'echo must not run' })],
      })
      const expired = await request(alice, 'POST', chatPath, {
        execute: true,
        revision: r.json().revision,
        text: '模拟执行中断恢复',
      })
      assert.equal(expired.statusCode, 409, expired.body)
      assert.equal(executionCalls.length, callsBeforeRecovery)
      r = await request(alice, 'GET', `${root}/departments/dev/conversation`)
      assert.match(r.json().messages.at(-1).text, /上次执行已中断/)
      executionAvailable = false
      const countBeforeUnavailable = modelCalls.length
      const unavailable = await request(alice, 'POST', chatPath, {
        execute: true,
        revision: r.json().revision,
        text: '不应运行',
      })
      assert.equal(unavailable.statusCode, 409, unavailable.body)
      assert.equal(modelCalls.length, countBeforeUnavailable)
      executionAvailable = true
      await request(alice, 'PUT', `${root}/operations/settings`, priorPolicy)
    },
  )
  await cache.del(`api-rate:${alice}`)
  await t.test('web deliverables provide private frozen previews and finished ZIPs without exposing the office', async () => {
    const base = `/api/tenants/${a}/employees/code-agent/workspace/deliverables`
    const saved = (await query('SELECT * FROM employee_workspaces WHERE tenant_id=$1 AND user_id=$2', [a, alice])).rows[0]
    const file = (path, content) => ({path, contentBase64: Buffer.from(content).toString('base64')})
    const html = '<!doctype html><title>五子棋</title><script type="module" src="./游戏/main.mjs"></script><link rel="stylesheet" href="./style.css"><img src="./piece.png">'
    const fixture = [file('index.html', html), file('游戏/main.mjs', 'document.body.dataset.loaded="yes"'), file('style.css', 'body{color:green}'), file('piece.png', Buffer.from([0,1,127,128,255])), file('.env', 'not in delivery'), file('test/add.test.mjs', 'developer test')]
    try {
      await query('UPDATE employee_workspaces SET files=$3,revision=revision+1 WHERE tenant_id=$1 AND user_id=$2', [a,alice,JSON.stringify(fixture)])
      const metadata = await request(alice,'GET',base)
      assert.equal(metadata.statusCode,200,metadata.body)
      const revision = metadata.json().workspace.revision
      assert.deepEqual(metadata.json().entries.map(e=>[e.path,e.title]), [['index.html','五子棋']])
      assert.equal((await app.inject(base)).statusCode,401)
      assert.equal((await request(outsider,'GET',base)).statusCode,403)
      assert.equal((await request(bob,'GET',base)).json().workspace,null)
      assert.equal((await request(alice,'GET',base.replace(a,b))).json().workspace,null)
      assert.equal((await request(bob,'POST',`${base}/preview`,{entry:'index.html',revision})).statusCode,404)
      assert.equal((await app.inject({method:'POST',url:`${base}/preview`,headers:{cookie:`office_session=${alice}`},payload:{entry:'index.html',revision}})).statusCode,403)
      assert.equal((await request(alice,'POST',`${base}/preview`,{entry:'index.html',revision:revision-1})).statusCode,409)
      assert.equal((await request(alice,'POST',`${base}/preview`,{entry:'../.env',revision})).statusCode,400)
      const started = await request(alice,'POST',`${base}/preview`,{entry:'index.html',revision})
      assert.equal(started.statusCode,200,started.body)
      const url = started.json().url
      assert.match(url,/^\/project-preview\/[A-Za-z0-9_-]{43}\/index\.html$/)
      const page = await app.inject(url)
      assert.equal(page.statusCode,200,page.body)
      assert.equal(page.body,html)
      assert.match(page.headers['content-type'],/text\/html/)
      assert.match(page.headers['content-security-policy'],/sandbox allow-scripts(?:;|$)/)
      assert.doesNotMatch(page.headers['content-security-policy'],/allow-same-origin/)
      assert.match(page.headers['content-security-policy'],/connect-src 'none'/)
      assert.equal(page.headers['access-control-allow-origin'],'*')
      assert.equal(page.headers['access-control-allow-credentials'],undefined)
      assert.equal(page.headers['cache-control'],'no-store')
      assert.equal(page.headers['referrer-policy'],'no-referrer')
      const prefix = url.slice(0,-'index.html'.length)
      const module = await app.inject(`${prefix}%E6%B8%B8%E6%88%8F/main.mjs`)
      assert.equal(module.statusCode,200,module.body)
      assert.match(module.headers['content-type'],/javascript/)
      assert.equal(module.body,'document.body.dataset.loaded="yes"')
      assert.deepEqual((await app.inject(`${prefix}piece.png`)).rawPayload,Buffer.from([0,1,127,128,255]))
      assert.equal((await app.inject(`${prefix}.env`)).statusCode,404)
      assert.equal((await app.inject(`${prefix}%2e%2e%2f.env`)).statusCode,404)
      assert.equal((await app.inject('/project-preview/unknown/index.html')).statusCode,404)
      // Existing preview continues to serve its version after the workspace changes.
      await query('UPDATE employee_workspaces SET files=$3,revision=revision+1 WHERE tenant_id=$1 AND user_id=$2', [a,alice,JSON.stringify([file('index.html','<title>new version</title>')])])
      assert.equal((await app.inject(url)).body,html)
      assert.equal((await request(alice,'GET',`${base}/download?entry=index.html&revision=${revision}`)).statusCode,409)
      await query('UPDATE employee_workspaces SET files=$3,revision=$4 WHERE tenant_id=$1 AND user_id=$2', [a,alice,JSON.stringify(fixture),revision])
      const download = await request(alice,'GET',`${base}/download?entry=index.html&revision=${revision}`)
      assert.equal(download.statusCode,200,download.body)
      const {zipFiles} = await import('../apps/api/src/skill-upload.mjs')
      const packed = (await zipFiles(download.rawPayload)).files
      assert.equal(packed.get('website/index.html').toString(),html)
      assert.deepEqual(packed.get('website/piece.png'),Buffer.from([0,1,127,128,255]))
      assert.match(packed.get('打开作品.html').toString(),/website\/index\.html/)
      assert.ok(packed.get('使用说明.txt').length>0)
      assert.equal(packed.has('website/.env'),false)
      assert.equal(packed.has('website/test/add.test.mjs'),false)
      assert.equal((await request(bob,'GET',`${base}/download?entry=index.html&revision=${revision}`)).statusCode,404)
      await query('UPDATE employee_workspaces SET active_run_id=$3 WHERE tenant_id=$1 AND user_id=$2',[a,alice,randomUUID()])
      assert.equal((await request(alice,'POST',`${base}/preview`,{entry:'index.html',revision})).statusCode,409)
      assert.equal((await request(alice,'GET',`${base}/download?entry=index.html&revision=${revision}`)).statusCode,409)
      // A copied capability never outlives the issuing user's membership.
      await query('DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2',[a,alice])
      assert.equal((await app.inject(url)).statusCode,403)
      await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')",[a,alice])
      const main = await request(alice,'GET','/api/me')
      assert.doesNotMatch(main.headers['content-security-policy'],/script-src[^;]*unsafe-inline/)
    } finally {
      await query('UPDATE employee_workspaces SET files=$3,revision=$4,active_run_id=$5,lease_until=$6 WHERE tenant_id=$1 AND user_id=$2',[a,alice,JSON.stringify(saved.files),saved.revision,saved.active_run_id,saved.lease_until])
      await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING",[a,alice])
    }
  })
  await cache.del(`api-rate:${alice}`)
  await t.test('Dragon projects isolate conversations, files and runs, and restore immutable versions with a recoverable backup', async () => {
    await cache.del(`api-rate:${alice}`)
    const root = `/api/tenants/${a}`
    const projects = `${root}/employees/code-agent/projects`
    const original = (await request(alice, 'GET', `${root}/employees/code-agent/workspace`)).json()
    const originalPolicy = (await request(alice,'GET',`${root}/operations/settings`)).json().policy
    const projectPolicy = structuredClone(originalPolicy)
    projectPolicy.departments.dev.model = 'test-agent'
    const priorBobRequests = new Set((await query('SELECT id FROM model_requests WHERE tenant_id=$1 AND user_id=$2',[a,bob])).rows.map(row=>row.id))
    const created = []
    const get = async (path, user = alice) => request(user, 'GET', path)
    const post = async (path, body, user = alice) => request(user, 'POST', path, body)
    const conversation = async id => (await get(`${root}/departments/dev/conversation?projectId=${id}`)).json()
    const projectFile = (path, text) => ({path, contentBase64: Buffer.from(text).toString('base64')})
    const toolCall = (id, name, args) => ({id, type:'function', function:{name, arguments:JSON.stringify(args)}})
    try {
      assert.equal((await request(alice,'PUT',`${root}/operations/settings`,projectPolicy)).statusCode,200)
      const listed = await get(projects)
      assert.equal(listed.statusCode, 200, listed.body)
      assert.equal(listed.json().defaultProjectId, original.workspace.id)
      assert.equal((await post(projects, {name:'member forbidden'}, bob)).statusCode,403)
      assert.equal((await get(projects,outsider)).statusCode,403)
      assert.equal((await post(projects,{name:'   '})).statusCode,400)
      for (const name of ['五子棋项目 A','独立项目 B']) {
        const response = await post(projects,{name})
        assert.equal(response.statusCode,200,response.body)
        created.push(response.json().project.id)
      }
      const [alpha,beta] = created
      const pa = `${projects}/${alpha}`, pb = `${projects}/${beta}`
      assert.equal((await get(`${pa}/workspace`,bob)).statusCode,404)
      assert.equal((await get(pa.replace(a,b)+'/workspace')).statusCode,404)
      assert.equal((await get(`${projects}/${randomUUID()}/workspace`)).statusCode,404)
      assert.equal((await get(`${root}/employees/code-agent/workspace`)).json().workspace.id,original.workspace.id)
      assert.equal((await post(`${pa}/rename`,{name:'  五子棋 A 已命名  '})).json().project.name,'五子棋 A 已命名')
      assert.equal((await conversation(alpha)).messages.length,0)
      assert.equal((await conversation(beta)).messages.length,0)
      modelMessages.push({content:'只属于项目 A 的回复'})
      let reply = await post(`${root}/departments/dev/chat`,{projectId:alpha,revision:0,text:'只讨论项目 A'})
      assert.equal(reply.statusCode,200,reply.body)
      assert.equal(reply.json().projectId,alpha)
      assert.equal((await conversation(beta)).messages.length,0)
      const currentA = reply.json()
      modelMessages.push(
        {content:null,tool_calls:[toolCall('project-write','workspace_write_file',{path:'index.html',content:'<title>A v1</title><p>first version</p>'})]},
        {content:'项目 A 文件已保存'},
      )
      duringModel = async () => {
        assert.equal((await get(`${pb}/workspace`)).json().workspace.id,beta)
        assert.equal((await post(`${pa}/versions`,{label:'执行中禁止保存',revision:0})).statusCode,409)
      }
      reply = await post(`${root}/departments/dev/chat`,{projectId:alpha,revision:currentA.revision,text:'给项目 A 写网页',execute:true})
      assert.equal(reply.statusCode,200,reply.body)
      const runId = reply.json().messages.at(-1).runId
      const stateA = (await get(`${pa}/workspace`)).json()
      assert.ok(stateA.runs.some(run=>run.id===runId))
      assert.equal((await get(`${pb}/workspace`)).json().runs.length,0)
      assert.equal((await get(`${pb}/workspace/file?path=index.html`)).statusCode,404)
      assert.equal((await get(`${pa}/workspace/file?path=index.html`)).json().content,'<title>A v1</title><p>first version</p>')
      assert.equal((await get(`${pb}/workspace/deliverables`)).json().entries.length,0)
      assert.equal((await get(`${pa}/workspace/deliverables`)).json().entries[0].title,'A v1')
      const save = await post(`${pa}/versions`,{label:'可交付 v1',revision:stateA.workspace.revision})
      assert.equal(save.statusCode,200,save.body)
      const v1 = save.json().version.id
      const historyRoot = `${pa}/versions/${v1}/deliverables`
      const firstPreview = await post(`${historyRoot}/preview`,{entry:'index.html',revision:stateA.workspace.revision})
      assert.equal(firstPreview.statusCode,200,firstPreview.body)
      assert.equal((await app.inject(firstPreview.json().url)).body,'<title>A v1</title><p>first version</p>')
      const secondFiles = [projectFile('index.html','<title>A v2</title><p>second version</p>'),projectFile('test/kept.test.mjs','export const testMarker=2')]
      await query('UPDATE employee_workspaces SET files=$2,revision=revision+1 WHERE id=$1',[alpha,JSON.stringify(secondFiles)])
      const beforeRestore = (await get(`${pa}/workspace`)).json().workspace
      assert.equal((await get(historyRoot)).json().entries[0].title,'A v1')
      const historicalZip = await get(`${historyRoot}/download?entry=index.html&revision=${stateA.workspace.revision}`)
      assert.equal(historicalZip.statusCode,200,historicalZip.body)
      const {zipFiles} = await import('../apps/api/src/skill-upload.mjs')
      assert.equal((await zipFiles(historicalZip.rawPayload)).files.get('website/index.html').toString(),'<title>A v1</title><p>first version</p>')
      assert.equal((await post(`${pb}/versions/${v1}/restore`,{revision:0})).statusCode,404)
      assert.equal((await get(`${pa}/versions`,bob)).statusCode,404)
      assert.equal((await post(`${pa}/versions/${v1}/restore`,{revision:beforeRestore.revision-1})).statusCode,409)
      await query("UPDATE employee_workspaces SET active_run_id=$2,lease_until=now()+interval '1 minute' WHERE id=$1",[alpha,randomUUID()])
      assert.equal((await post(`${pa}/versions/${v1}/restore`,{revision:beforeRestore.revision})).statusCode,409)
      assert.equal((await post(`${pa}/versions`,{label:'busy',revision:beforeRestore.revision})).statusCode,409)
      await query('UPDATE employee_workspaces SET active_run_id=NULL,lease_until=NULL WHERE id=$1',[alpha])
      const restored = await post(`${pa}/versions/${v1}/restore`,{revision:beforeRestore.revision})
      assert.equal(restored.statusCode,200,restored.body)
      assert.equal(restored.json().revision,beforeRestore.revision+1)
      assert.ok(restored.json().backupVersionId)
      assert.equal((await get(`${pa}/workspace/file?path=index.html`)).json().content,'<title>A v1</title><p>first version</p>')
      const savedChat = await conversation(alpha)
      assert.ok(savedChat.messages.some(m=>m.text==='只讨论项目 A'))
      assert.match(savedChat.messages.at(-1).text,/恢复/)
      assert.ok((await get(`${pa}/workspace`)).json().runs.some(run=>run.id===runId))
      const undo = await post(`${pa}/versions/${restored.json().backupVersionId}/restore`,{revision:restored.json().revision})
      assert.equal(undo.statusCode,200,undo.body)
      assert.equal((await get(`${pa}/workspace/file?path=test%2Fkept.test.mjs`)).json().content,'export const testMarker=2')
      assert.equal((await get(`${pa}/workspace/file?path=index.html`)).json().content,'<title>A v2</title><p>second version</p>')
      // A model reply prepared before a restore must never commit into the changed conversation.
      const preChat = await conversation(alpha)
      duringModel = async () => {
        const result = await post(`${pa}/versions/${v1}/restore`,{revision:undo.json().revision})
        assert.equal(result.statusCode,200,result.body)
      }
      modelMessages.push({content:'此回复基于已过期文件'})
      const staleChat = await post(`${root}/departments/dev/chat`,{projectId:alpha,revision:preChat.revision,text:'恢复时仍在处理的旧请求'})
      assert.equal(staleChat.statusCode,409,staleChat.body)
      assert.equal((await conversation(alpha)).messages.some(m=>m.text==='此回复基于已过期文件'),false)
      modelMessages.push({content:'项目 B 独立回答'})
      reply = await post(`${root}/departments/dev/chat`,{projectId:beta,revision:0,text:'只讨论项目 B'})
      assert.equal(reply.statusCode,200,reply.body)
      assert.equal(modelCalls.at(-1).body.messages.some(m=>typeof m.content==='string'&&m.content.includes('只讨论项目 A')),false)
      assert.equal((await conversation(alpha)).messages.some(m=>m.text==='只讨论项目 B'),false)
      assert.equal((await post(`${root}/departments/archive/chat`,{projectId:alpha,revision:0,text:'wrong department'})).statusCode,400)
      // First-project adoption cannot silently strand an already pending legacy reply.
      let legacyBob=(await get(`${root}/departments/dev/conversation`,bob)).json()
      modelMessages.push({content:'成员仍可进行原有普通对话'})
      const memberLegacy=await post(`${root}/departments/dev/chat`,{revision:legacyBob.revision,text:'成员普通讨论，不创建项目'},bob)
      assert.equal(memberLegacy.statusCode,200,memberLegacy.body)
      legacyBob=memberLegacy.json()
      await query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2",[a,bob])
      duringModel=async()=>{
        const first=await post(projects,{name:'迁移竞态样本'},bob)
        assert.equal(first.statusCode,200,first.body)
        created.push(first.json().project.id)
      }
      modelMessages.push({content:'旧的无项目回复'})
      const adopted=await post(`${root}/departments/dev/chat`,{revision:legacyBob.revision,text:'创建项目时仍在等待的旧对话'},bob)
      assert.equal(adopted.statusCode,409,adopted.body)
      const imported=(await get(`${root}/departments/dev/conversation?projectId=${created.at(-1)}`,bob)).json()
      assert.deepEqual(imported.messages,legacyBob.messages)
      await query("UPDATE memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2",[a,bob])
      const beforeLimit = (await get(`${pa}/workspace`)).json().workspace
      const versionRow = (await query('SELECT * FROM employee_project_versions WHERE id=$1',[v1])).rows[0]
      const versionCount = (await query('SELECT count(*) FROM employee_project_versions WHERE workspace_id=$1',[alpha])).rows[0].count
      for(let i=Number(versionCount);i<100;i++) await query('INSERT INTO employee_project_versions(id,workspace_id,tenant_id,user_id,label,kind,source_revision,files) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),alpha,a,alice,`quota fixture ${i}`,'manual',versionRow.source_revision,JSON.stringify(versionRow.files)])
      assert.equal((await post(`${pa}/versions/${v1}/restore`,{revision:beforeLimit.revision})).statusCode,409)
      assert.equal((await get(`${pa}/workspace`)).json().workspace.revision,beforeLimit.revision)
      const untouched = (await get(`${root}/employees/code-agent/workspace`)).json()
      assert.deepEqual(untouched.workspace.files,original.workspace.files)
      assert.equal(untouched.workspace.revision,original.workspace.revision)
    } finally {
      duringModel=undefined
      modelMessages.length=0
      await query("UPDATE memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2",[a,bob])
      for(const row of (await query('SELECT id FROM model_requests WHERE tenant_id=$1 AND user_id=$2',[a,bob])).rows) {
        if(!priorBobRequests.has(row.id)) await query('DELETE FROM model_requests WHERE id=$1',[row.id])
      }
      for (const id of created) {
        await query('DELETE FROM employee_project_versions WHERE workspace_id=$1',[id])
        await query('DELETE FROM employee_runs WHERE workspace_id=$1',[id])
        await query('DELETE FROM employee_workspaces WHERE id=$1',[id])
      }
      await cache.del(`api-rate:${alice}`)
      await request(alice,'PUT',`${root}/operations/settings`,originalPolicy)
    }
  })
  await t.test('Dragon acceptance binds human and system evidence to an immutable formal delivery', async () => {
    await cache.del(`api-rate:${alice}`)
    const root = `/api/tenants/${a}/employees/code-agent/projects`
    const created = []
    const get = (path, user = alice) => request(user, 'GET', path)
    const post = (path, data, user = alice) => request(user, 'POST', path, data)
    const put = (path, data, user = alice) => request(user, 'PUT', path, data)
    const file = (path, content) => ({path,contentBase64:Buffer.from(content).toString('base64')})
    const oldHtml = '<!doctype html><title>已验收示例</title><h1>version one</h1>'
    const originalFiles = [file('index.html',oldHtml),file('other.html','<title>other entry</title>'),file('test/example.test.mjs',"import test from 'node:test'; test('example',()=>{});")]
    const saveBody = draft => ({revision:draft.revision,entry:draft.entry,items:draft.items,instructions:draft.instructions,limitations:draft.limitations})
    try {
      for (const name of ['交付验收项目','隔离交付项目']) {
        const response = await post(root,{name})
        assert.equal(response.statusCode,200,response.body)
        created.push(response.json().project.id)
      }
      const [projectId,otherId] = created
      const project = `${root}/${projectId}`, other = `${root}/${otherId}`
      await query('UPDATE employee_workspaces SET files=$2,revision=1,messages=$3 WHERE id=$1',[projectId,JSON.stringify(originalFiles),JSON.stringify([{role:'assistant',text:'模型声称全部测试通过',time:new Date().toISOString()}])])
      const version = (await post(`${project}/versions`,{label:'待验收 v1',revision:1})).json().version
      const acceptancePath = `${project}/versions/${version.id}/acceptance`
      const initial = await get(acceptancePath)
      assert.equal(initial.statusCode,200,initial.body)
      let draft = initial.json().acceptance
      assert.equal(draft.versionId,version.id)
      assert.equal(draft.revision,0)
      assert.ok(draft.items.length>0)
      assert.ok(draft.items.every(item=>item.status==='unchecked'))
      assert.equal(draft.systemCheck,null)
      assert.equal(draft.delivery,null)
      assert.equal((await query('SELECT count(*) FROM employee_project_acceptance WHERE version_id=$1',[version.id])).rows[0].count,0)
      assert.equal((await get(acceptancePath,bob)).statusCode,404)
      assert.equal((await get(acceptancePath,outsider)).statusCode,403)
      assert.equal((await get(acceptancePath.replace(a,b))).statusCode,404)
      assert.equal((await get(`${other}/versions/${version.id}/acceptance`)).statusCode,404)
      assert.equal((await put(acceptancePath,saveBody(draft),bob)).statusCode,403)
      assert.equal((await put(acceptancePath,{...saveBody(draft),systemCheck:{status:'passed'}})).statusCode,400)
      assert.equal((await put(acceptancePath,{...saveBody(draft),items:[]})).statusCode,400)
      assert.equal((await put(acceptancePath,{...saveBody(draft),items:[{...draft.items[0],status:'passed',note:''}]})).statusCode,400)
      draft.instructions='解压后双击打开作品.html；标题为 version one。'
      draft.limitations='仅静态演示，不含服务器。<script>never execute</script>'
      const saved = await put(acceptancePath,saveBody(draft))
      assert.equal(saved.statusCode,200,saved.body)
      draft=saved.json().acceptance
      assert.equal(draft.revision,1)
      assert.equal((await put(acceptancePath,{...saveBody(draft),revision:0})).statusCode,409)
      let formalTestId=randomUUID()
      const confirm = rev => post(`${project}/deliveries`,{versionId:version.id,acceptanceRevision:rev,label:'正式示例交付',testRunId:formalTestId})
      assert.equal((await confirm(draft.revision)).statusCode,409)
      // Inject an archive-library write failure; keep the real route, draft and DB transaction.
      const {default:yazl}=await import('yazl')
      const addBuffer=yazl.ZipFile.prototype.addBuffer
      try {
        yazl.ZipFile.prototype.addBuffer=function(){throw new Error('Injected archive output failure')}
        const failedCheck=await post(`${acceptancePath}/check`,{revision:draft.revision})
        assert.equal(failedCheck.statusCode,200,failedCheck.body)
        draft=failedCheck.json().acceptance
        assert.equal(draft.systemCheck.status,'failed')
        assert.equal(draft.systemCheck.packageBytes,0)
        assert.ok(draft.items.every(item=>item.status==='unchecked'))
        assert.equal((await get(acceptancePath)).json().acceptance.systemCheck.status,'failed')
        assert.equal((await confirm(draft.revision)).statusCode,409)
      } finally {yazl.ZipFile.prototype.addBuffer=addBuffer}
      const check = await post(`${acceptancePath}/check`,{revision:draft.revision})
      assert.equal(check.statusCode,200,check.body)
      draft=check.json().acceptance
      assert.equal(draft.systemCheck.status,'passed')
      assert.equal(draft.systemCheck.entry,'index.html')
      assert.match(draft.systemCheck.snapshotSha256,/^[a-f0-9]{64}$/)
      assert.ok(draft.systemCheck.fileCount>=1)
      assert.ok(draft.systemCheck.packageBytes>Buffer.byteLength(oldHtml))
      assert.ok(draft.systemCheck.checkedAt)
      assert.ok(draft.items.every(item=>item.status==='unchecked'))
      assert.equal((await confirm(draft.revision)).statusCode,409)
      const checkedHash = draft.systemCheck.snapshotSha256
      draft.entry='other.html'
      draft=(await put(acceptancePath,saveBody(draft))).json().acceptance
      assert.equal(draft.systemCheck,null)
      draft.entry='index.html'
      draft.items=draft.items.map((item,i)=>({...item,status:i===0?'failed':'passed',note:i===0?'标题不符合期望':'已实际查看页面和说明'}))
      draft=(await put(acceptancePath,saveBody(draft))).json().acceptance
      draft=(await post(`${acceptancePath}/check`,{revision:draft.revision})).json().acceptance
      assert.equal(draft.systemCheck.snapshotSha256,checkedHash)
      assert.equal((await confirm(draft.revision)).statusCode,409)
      draft.items=draft.items.map(item=>({...item,status:'passed',note:'已实际打开固定版本，核对标题和说明一致'}))
      draft=(await put(acceptancePath,saveBody(draft))).json().acceptance
      const instructions=draft.instructions, limitations=draft.limitations
      draft.instructions=''
      draft=(await put(acceptancePath,saveBody(draft))).json().acceptance
      assert.equal((await confirm(draft.revision)).statusCode,409)
      draft.instructions=instructions
      draft=(await put(acceptancePath,saveBody(draft))).json().acceptance
      assert.equal((await confirm(draft.revision-1)).statusCode,409)
      assert.equal((await post(`${project}/deliveries`,{versionId:version.id,acceptanceRevision:draft.revision,label:'member'},bob)).statusCode,403)
      assert.equal((await confirm(draft.revision)).statusCode,409,'package and manual acceptance alone do not satisfy automatic testing')
      const automatic=await post(`${acceptancePath}/tests`,{requestId:randomUUID()})
      assert.equal(automatic.statusCode,200,automatic.body)
      assert.equal(automatic.json().testRun.state,'passed')
      formalTestId=automatic.json().testRun.id
      versionTestOutcome=()=>({...passingVersionTest(),success:false,exitCode:1,counts:{tests:1,passed:0,failed:1,cancelled:0,skipped:0,todo:0},cases:[{name:'latest failure',status:'failed',detail:'failed assertion'}]})
      assert.equal((await post(`${acceptancePath}/tests`,{requestId:randomUUID()})).json().testRun.state,'failed')
      assert.equal((await confirm(draft.revision)).statusCode,409,'older passing run cannot hide a newer failure')
      const newest=await post(`${acceptancePath}/tests`,{requestId:randomUUID()})
      assert.equal(newest.json().testRun.state,'passed')
      assert.equal((await confirm(draft.revision)).statusCode,409,'must confirm the exact latest test record shown')
      formalTestId=newest.json().testRun.id
      const confirmed = await confirm(draft.revision)
      assert.equal(confirmed.statusCode,200,confirmed.body)
      const delivery=confirmed.json().delivery
      assert.equal(delivery.versionId,version.id)
      assert.equal(delivery.entry,'index.html')
      assert.equal(delivery.instructions,instructions)
      assert.equal(delivery.limitations,limitations)
      assert.equal(delivery.systemCheck.snapshotSha256,checkedHash)
      assert.equal(delivery.automatedTest.id,formalTestId)
      assert.equal(delivery.automatedTest.snapshotSha256,checkedHash)
      assert.ok(delivery.items.every(item=>item.status==='passed'))
      assert.equal((await confirm(draft.revision)).statusCode,409)
      assert.equal((await put(acceptancePath,{...saveBody(draft),instructions:'silently changed'})).statusCode,409)
      assert.equal((await post(`${acceptancePath}/check`,{revision:draft.revision})).statusCode,409)
      assert.equal((await post(`${acceptancePath}/tests`,{requestId:randomUUID()})).statusCode,409)
      assert.equal((await get(acceptancePath)).json().acceptance.delivery.id,delivery.id)
      assert.equal((await get(`${project}/deliveries`)).json().deliveries[0].id,delivery.id)
      assert.deepEqual((await get(`${other}/deliveries`)).json().deliveries,[])
      const deliveryRoot=`${project}/deliveries/${delivery.id}`
      for (const path of [deliveryRoot,`${deliveryRoot}/download`]) {
        assert.equal((await get(path,bob)).statusCode,404)
        assert.equal((await get(path.replace(a,b))).statusCode,404)
        assert.equal((await get(path.replace(projectId,otherId))).statusCode,404)
      }
      // Changing live files or running another task cannot change a delivered version.
      await query("UPDATE employee_workspaces SET files=$2,revision=2,active_run_id=$3,lease_until=now()+interval '1 minute' WHERE id=$1",[projectId,JSON.stringify([file('index.html','<title>UNACCEPTED NEW VERSION</title>')]),randomUUID()])
      const preview=await post(`${deliveryRoot}/preview`,{})
      assert.equal(preview.statusCode,200,preview.body)
      const page=await app.inject(preview.json().url)
      assert.equal(page.body,oldHtml)
      assert.match(page.headers['content-security-policy'],/sandbox allow-scripts/)
      const download=await get(`${deliveryRoot}/download`)
      assert.equal(download.statusCode,200,download.body)
      const {zipFiles}=await import('../apps/api/src/skill-upload.mjs')
      const packed=(await zipFiles(download.rawPayload)).files
      assert.equal(packed.get('website/index.html').toString(),oldHtml)
      assert.ok(packed.has('打开作品.html'))
      assert.match(packed.get('交付说明.txt').toString(),/正式示例交付/)
      assert.ok(packed.get('交付说明.txt').toString().includes(instructions))
      assert.ok(packed.get('交付说明.txt').toString().includes(limitations))
      const record=JSON.parse(packed.get('验收记录.json').toString())
      assert.equal(record.versionId,version.id)
      assert.equal(record.systemCheck.snapshotSha256,checkedHash)
      assert.equal(record.automatedTest.id,formalTestId)
      assert.deepEqual((await get(deliveryRoot)).json().delivery,delivery)
      await assert.rejects(query('UPDATE employee_project_deliveries SET label=$2 WHERE id=$1',[delivery.id,'tampered']),/immutable/i)
      // Source-only version cannot acquire passed package evidence or be delivered.
      const sourceVersion=(await post(`${other}/versions`,{label:'source only',revision:0})).json().version
      // Database ownership constraints also reject a version attached to another project.
      await assert.rejects(query('INSERT INTO employee_project_acceptance(version_id,workspace_id,tenant_id,user_id,revision,items) VALUES($1,$2,$3,$4,1,$5)',[sourceVersion.id,projectId,a,alice,JSON.stringify(draft.items)]),/foreign key/i)
      await assert.rejects(query('INSERT INTO employee_project_deliveries(id,version_id,workspace_id,tenant_id,user_id,version_label,source_revision,label,entry,items,system_check,instructions,limitations) SELECT $1,$2,workspace_id,tenant_id,user_id,version_label,source_revision,label,entry,items,system_check,instructions,limitations FROM employee_project_deliveries WHERE id=$3',[randomUUID(),sourceVersion.id,delivery.id]),/foreign key/i)
      const sourcePath=`${other}/versions/${sourceVersion.id}/acceptance`
      let sourceDraft=(await get(sourcePath)).json().acceptance
      sourceDraft.items=sourceDraft.items.map(item=>({...item,status:'passed',note:'手动检查'}))
      sourceDraft.instructions='使用源代码';sourceDraft.limitations='尚无网页成品'
      sourceDraft=(await put(sourcePath,saveBody(sourceDraft))).json().acceptance
      const sourceCheck=await post(`${sourcePath}/check`,{revision:sourceDraft.revision})
      if(sourceCheck.statusCode===200) assert.notEqual(sourceCheck.json().acceptance.systemCheck?.status,'passed')
      else assert.ok([400,404,409].includes(sourceCheck.statusCode),sourceCheck.body)
      assert.equal((await post(`${other}/deliveries`,{versionId:sourceVersion.id,acceptanceRevision:sourceDraft.revision,label:'不能交付',testRunId:formalTestId})).statusCode,409)
      await query('CREATE ROLE acceptance_reader')
      await query('GRANT SELECT ON employee_project_acceptance,employee_project_deliveries TO acceptance_reader')
      try {
        await query('SET ROLE acceptance_reader')
        for(const table of ['employee_project_acceptance','employee_project_deliveries']) assert.equal((await query(`SELECT * FROM ${table}`)).rows.length,0)
        await query('BEGIN')
        await query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",[a,alice])
        assert.equal((await query('SELECT id FROM employee_project_deliveries')).rows[0].id,delivery.id)
        assert.equal((await query('SELECT version_id FROM employee_project_acceptance')).rows.length,2)
        await query("SELECT set_config('app.user_id',$1,true)",[bob])
        for(const table of ['employee_project_acceptance','employee_project_deliveries']) assert.equal((await query(`SELECT * FROM ${table}`)).rows.length,0)
        await query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",[b,alice])
        for(const table of ['employee_project_acceptance','employee_project_deliveries']) assert.equal((await query(`SELECT * FROM ${table}`)).rows.length,0)
      } finally {
        await query('ROLLBACK')
        await query('RESET ROLE')
      }
    } finally {
      for(const id of created) {
        for(const table of ['employee_project_deliveries','employee_project_acceptance']) {
          if((await query('SELECT to_regclass($1) name',[table])).rows[0].name) await query(`DELETE FROM ${table} WHERE workspace_id=$1`,[id])
        }
        if((await query("SELECT to_regclass('employee_project_test_runs') name")).rows[0].name) await query('DELETE FROM employee_project_test_runs WHERE workspace_id=$1',[id])
        await query('DELETE FROM employee_project_versions WHERE workspace_id=$1',[id])
        await query('DELETE FROM employee_runs WHERE workspace_id=$1',[id])
        await query('DELETE FROM employee_workspaces WHERE id=$1',[id])
      }
      await cache.del(`api-rate:${alice}`)
    }
  })
  await t.test('saved-version automatic tests isolate evidence, reject fabricated success, recover and deduplicate execution', async () => {
    await cache.del(`api-rate:${alice}`)
    const root=`/api/tenants/${a}/employees/code-agent/projects`
    const created=await request(alice,'POST',root,{name:'版本测试项目'})
    assert.equal(created.statusCode,200,created.body)
    const id=created.json().project.id
    const project=`${root}/${id}`
    const get=(path,user=alice)=>request(user,'GET',path)
    const post=(path,body,user=alice)=>request(user,'POST',path,body)
    const file=(path,content)=>({path,contentBase64:Buffer.from(content).toString('base64')})
    let otherId
    try {
      const saved=await post(`${project}/versions`,{label:'无测试版本',revision:0})
      assert.equal(saved.statusCode,200,saved.body)
      const emptyVersion=saved.json().version.id
      const emptyPath=`${project}/versions/${emptyVersion}/acceptance/tests`
      const response=await get(emptyPath)
      assert.equal(response.statusCode,200,response.body)
      assert.deepEqual(response.json(),{testRuns:[],latestTest:null})
      assert.equal((await query('SELECT count(*) FROM employee_project_test_runs WHERE workspace_id=$1',[id])).rows[0].count,0)
      const callsBeforeEmpty=versionTestCalls.length
      const empty=await post(emptyPath,{requestId:randomUUID()})
      assert.equal(empty.statusCode,200,empty.body)
      assert.equal(empty.json().testRun.state,'no_tests')
      assert.equal(versionTestCalls.length,callsBeforeEmpty)

      const files=[file('index.html','<title>immutable v1</title>'),file('test/game.test.mjs',"import test from 'node:test'; test('game',()=>{})")]
      await query('UPDATE employee_workspaces SET files=$2,revision=1 WHERE id=$1',[id,JSON.stringify(files)])
      const version=(await post(`${project}/versions`,{label:'有测试 v1',revision:1})).json().version
      const path=`${project}/versions/${version.id}/acceptance/tests`
      const start=(requestId=randomUUID())=>post(path,{requestId})
      assert.equal((await get(path,bob)).statusCode,404)
      assert.equal((await get(path,outsider)).statusCode,403)
      assert.equal((await get(path.replace(a,b))).statusCode,404)
      assert.equal((await post(path,{requestId:randomUUID()},bob)).statusCode,403)
      assert.equal((await post(path,{requestId:randomUUID(),state:'passed',command:'echo passed'})).statusCode,400)
      assert.equal((await post(path,{requestId:'invalid'})).statusCode,400)
      otherId=(await post(root,{name:'其他测试项目'})).json().project.id
      assert.equal((await get(path.replace(id,otherId))).statusCode,404)
      assert.equal((await post(path.replace(id,otherId),{requestId:randomUUID()})).statusCode,404)

      // A running request is durably visible before the executor returns; duplicates cannot spawn again.
      let releaseTest,enteredTest
      const entered=new Promise(resolve=>{enteredTest=resolve})
      const held=new Promise(resolve=>{releaseTest=resolve})
      duringVersionTest=async()=>{enteredTest();await held}
      const requestId=randomUUID(),beforeCalls=versionTestCalls.length
      const pending=start(requestId)
      await entered
      try {
        const running=(await get(path)).json().latestTest
        assert.equal(running.state,'running')
        const same=await start(requestId)
        assert.equal(same.statusCode,200,same.body);assert.equal(same.json().testRun.id,running.id)
        assert.equal(versionTestCalls.length,beforeCalls+1)
        assert.equal((await start()).statusCode,409)
        assert.equal((await post(emptyPath,{requestId:randomUUID()})).statusCode,409,'only one version test per project')
        await query('UPDATE employee_workspaces SET files=$2,revision=2 WHERE id=$1',[id,JSON.stringify([file('index.html','<title>UNTESTED CURRENT FILES</title>')])])
      } finally {releaseTest()}
      const finished=await pending
      assert.equal(finished.statusCode,200,finished.body)
      const first=finished.json().testRun
      assert.equal(first.state,'passed');assert.equal(first.versionId,version.id)
      assert.match(first.snapshotSha256,/^[a-f0-9]{64}$/)
      assert.deepEqual(versionTestCalls.at(-1).files,files)
      assert.deepEqual(first.testFiles,['test/game.test.mjs'])
      assert.equal((await start(requestId)).json().testRun.id,first.id)
      assert.equal(versionTestCalls.length,beforeCalls+1)
      assert.equal((await post(emptyPath,{requestId})).statusCode,409)
      assert.equal((await get(path.replace('/tests',''))).json().acceptance.latestTest.id,first.id)
      await assert.rejects(query("UPDATE employee_project_test_runs SET state='failed' WHERE id=$1",[first.id]),/immutable/i)

      // Transport/result failures must never turn old passing evidence into a current green result.
      const cases=[
        ['failed',()=>({...passingVersionTest(),success:false,exitCode:1,counts:{tests:1,passed:0,failed:1,cancelled:0,skipped:0,todo:0},cases:[{name:'落子失败',status:'failed',detail:'expected black stone'}]})],
        ['no_tests',()=>({...passingVersionTest(),counts:{tests:0,passed:0,failed:0,cancelled:0,skipped:0,todo:0},cases:[]})],
        ['incomplete',()=>({...passingVersionTest(),counts:{tests:1,passed:0,failed:0,cancelled:0,skipped:1,todo:0},cases:[{name:'not executed',status:'skipped',detail:''}]})],
        ['timed_out',()=>({...passingVersionTest(),exitCode:null,timedOut:true,summaryComplete:false})],
        ['incomplete',()=>({...passingVersionTest(),truncated:true})],
        ['error',()=>({...passingVersionTest(),counts:null,summaryComplete:false,stdout:'tests 99 pass 99 ALL PASS'})],
        ['error',()=>{throw new Error('test engine unavailable')}],
      ]
      for(const [state,outcome] of cases){
        versionTestOutcome=outcome
        const run=await start();assert.equal(run.statusCode,200,run.body)
        assert.equal(run.json().testRun.state,state)
        assert.equal((await get(path)).json().latestTest.id,run.json().testRun.id)
        assert.equal(run.json().testRun.snapshotSha256,first.snapshotSha256)
      }

      // Expired work is interrupted and a late success cannot overwrite its terminal evidence.
      let expireRelease,expireEntered
      const expireHold=new Promise(resolve=>{expireRelease=resolve}),expireSeen=new Promise(resolve=>{expireEntered=resolve})
      duringVersionTest=async()=>{expireEntered();await expireHold}
      const late=start();await expireSeen
      let expired
      try {
        expired=(await get(path)).json().latestTest
        await query("UPDATE employee_project_test_runs SET lease_until=now()-interval '1 second' WHERE id=$1",[expired.id])
        const recovered=(await get(path)).json().latestTest
        assert.equal(recovered.state,'interrupted')
      } finally {expireRelease()}
      const lateResponse=await late
      assert.equal(lateResponse.statusCode,200,lateResponse.body)
      assert.equal(lateResponse.json().testRun.state,'interrupted')
      assert.equal((await query('SELECT state FROM employee_project_test_runs WHERE id=$1',[expired.id])).rows[0].state,'interrupted')

      // Revocation while executing cannot leave a passing record behind.
      duringVersionTest=async()=>{await query("UPDATE memberships SET role='member' WHERE tenant_id=$1 AND user_id=$2",[a,alice])}
      try {
        const revoked=await start()
        assert.ok([200,403].includes(revoked.statusCode),revoked.body)
        const record=(await query('SELECT state FROM employee_project_test_runs WHERE workspace_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1',[id])).rows[0]
        assert.notEqual(record.state,'passed')
      } finally {await query("UPDATE memberships SET role='owner' WHERE tenant_id=$1 AND user_id=$2",[a,alice])}

      const finalTest=(await start()).json().testRun
      assert.equal(finalTest.state,'passed')
      const v2=(await post(`${project}/versions`,{label:'当前无测试 v2',revision:2})).json().version
      const v2Path=`${project}/versions/${v2.id}/acceptance/tests`
      assert.equal((await get(v2Path)).json().latestTest,null)
      assert.equal((await post(v2Path,{requestId:randomUUID()})).json().testRun.state,'no_tests')
      assert.notEqual((await get(v2Path)).json().latestTest.snapshotSha256,finalTest.snapshotSha256)
      const workspace=(await query('SELECT files,revision FROM employee_workspaces WHERE id=$1',[id])).rows[0]
      assert.equal(workspace.revision,2)
      assert.equal(Buffer.from(workspace.files[0].contentBase64,'base64').toString(),'<title>UNTESTED CURRENT FILES</title>')

      await query('CREATE ROLE version_test_reader')
      await query('GRANT SELECT ON employee_project_test_runs TO version_test_reader')
      try {
        await query('SET ROLE version_test_reader')
        assert.equal((await query('SELECT * FROM employee_project_test_runs')).rows.length,0)
        await query('BEGIN')
        await query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",[a,alice])
        assert.ok((await query('SELECT id FROM employee_project_test_runs WHERE workspace_id=$1',[id])).rows.length>0)
        await query("SELECT set_config('app.user_id',$1,true)",[bob])
        assert.equal((await query('SELECT * FROM employee_project_test_runs')).rows.length,0)
        await query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",[b,alice])
        assert.equal((await query('SELECT * FROM employee_project_test_runs')).rows.length,0)
      } finally {await query('ROLLBACK');await query('RESET ROLE')}
      await assert.rejects(query('UPDATE employee_project_test_runs SET workspace_id=$1 WHERE id=$2',[otherId,first.id]),/immutable|foreign key/i)
    } finally {
      versionTestOutcome=undefined;duringVersionTest=undefined
      for(const projectId of [id,otherId].filter(Boolean)){
        if((await query("SELECT to_regclass('employee_project_test_runs') name")).rows[0].name)await query('DELETE FROM employee_project_test_runs WHERE workspace_id=$1',[projectId])
        await query('DELETE FROM employee_project_versions WHERE workspace_id=$1',[projectId])
        await query('DELETE FROM employee_workspaces WHERE id=$1',[projectId])
      }
      await cache.del(`api-rate:${alice}`)
    }
  })
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
      assert.equal(
        (await query('SELECT * FROM task_jobs WHERE task_id=$1', [research.id])).rows.length,
        0,
      )
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
        'GRANT SELECT ON agents,installed_skills,secretary_workspaces,operations_settings,operations_publications,model_daily_usage,model_requests,workspace_files,department_conversations,skill_assignments,secretary_reminders,task_jobs,research_settings,employee_workspaces,employee_runs TO rls_test',
      )
      await query('SET ROLE rls_test')
      for (const name of [
        'task_jobs',
        'research_settings',
        'workspace_files',
        'department_conversations',
        'skill_assignments',
        'secretary_reminders',
        'employee_workspaces',
        'employee_runs',
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
      assert.equal((await query('SELECT * FROM employee_workspaces')).rows.length, 1)
      assert.ok((await query('SELECT * FROM employee_runs')).rows.length > 0)
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
