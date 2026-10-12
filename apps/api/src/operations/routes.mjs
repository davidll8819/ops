import { createOperationsTasks } from './task-service.mjs'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { z } from 'zod'
import { transaction, fail } from '../db.mjs'
import { configKey, encryptConfig, decryptConfig, digest, verifyBridge } from './security.mjs'
import { createOperationsDriver } from './driver.mjs'
import { policySchema, toPolicy, secretNames, resolveDepartment } from './policy.mjs'
import { resolveSecrets } from './credentials.mjs'
import { budgetSnapshot } from './budget.mjs'
const admin = ['owner', 'admin']
const credentialInput = z.string().trim().max(4096).optional()
const settingsInput = z.union([
  z.object({ policy: policySchema, aiKey: credentialInput, relayKey: credentialInput }).strict(),
  policySchema.transform((policy) => ({ policy })),
])
const url = z.url().refine((v) => {
  const u = new URL(v)
  return u.protocol === 'https:' && !u.username && !u.password && !u.hash
}, 'HTTPS required')
const proposalSchema = z
  .object({
    content: z
      .object({
        title: z.string().max(500).optional(),
        body: z.string().max(20000).optional(),
        media: z.array(z.object({ url }).passthrough()).max(30).default([]),
        cover: z.object({ url }).passthrough().optional(),
      })
      .strict(),
    publishAt: z.iso.datetime({ offset: true }),
    items: z
      .array(
        z
          .object({
            accountId: z.string().min(1).max(150),
            platform: z.string().min(1).max(100),
            option: z.record(z.string(), z.unknown()).optional(),
            overrides: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    context: z
      .object({
        taskId: z.string().max(150).optional(),
        materialId: z.string().max(150).optional(),
        materialGroupId: z.string().max(150).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
export function registerOperations(
  app,
  { scoped, pool, env, driver = createOperationsDriver(env), tasks = createOperationsTasks({ pool, env, driver }) },
) {
  const root = '/api/tenants/:tenantId/operations'
  async function settings(db, ctx) {
    return (
      await db.query(
        'SELECT encrypted_config,revision FROM operations_settings WHERE tenant_id=$1',
        [ctx.tenantId],
      )
    ).rows[0]
  }
  async function runtime(req) {
    const info = await scoped(req, async (db, tenant, ctx) => ({
      ctx,
      row: await settings(db, ctx),
    }))
    if (!info.row) throw fail(409, '请先在设置中配置企业 AI 密钥')
    return driver.ready(info.ctx.tenantId, info.row.revision)
  }
  async function insertProposal(db, ctx, payload) {
    const hash = digest(payload)
    const id = randomUUID()
    const { rows } = await db.query(
      `INSERT INTO operations_publications(id,tenant_id,requested_by,payload,payload_hash,execution_mode) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,payload_hash) DO UPDATE SET payload_hash=EXCLUDED.payload_hash RETURNING *`,
      [
        id,
        ctx.tenantId,
        ctx.userId || null,
        { ...payload, flowId: id },
        hash,
        ctx.mode || 'manual',
      ],
    )
    return rows[0]
  }
  app.get(`${root}/settings`, (req) =>
    scoped(
      req,
      async (db, tenant, ctx) => {
        const row = await settings(db, ctx)
        const stored = row
          ? decryptConfig(row.encrypted_config, await configKey(env), ctx.tenantId)
          : null
        const policy = toPolicy(stored)
        const secrets = resolveSecrets(stored, env, ctx.tenantId)
        return {
          configured: !!row,
          revision: row?.revision || 0,
          policy,
          secretNames: secretNames(ctx.tenantId),
          aiKeySet: !!secrets.ai,
          relayKeySet: !!secrets.relay,
          budget: await budgetSnapshot(db, ctx.tenantId, policy.budget.daily_token_limit),
        }
      },
      admin,
    ),
  )
  app.put(`${root}/settings`, (req) =>
    scoped(
      req,
      async (db, tenant, ctx) => {
        const input = settingsInput.parse(req.body)
        await db.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [ctx.tenantId])
        const key = await configKey(env),
          old = await settings(db, ctx)
        const previous = old ? decryptConfig(old.encrypted_config, key, ctx.tenantId) : null
        const value = {
          ...input.policy,
          credentials: {
            ai: input.aiKey || previous?.credentials?.ai || previous?.aiKey || '',
            relay: input.relayKey || previous?.credentials?.relay || previous?.relayKey || '',
          },
        }
        const { rows } = await db.query(
          `INSERT INTO operations_settings(tenant_id,encrypted_config,updated_by) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET encrypted_config=EXCLUDED.encrypted_config,revision=operations_settings.revision+1,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING revision`,
          [ctx.tenantId, encryptConfig(value, key, ctx.tenantId), ctx.userId],
        )
        return { saved: true, revision: rows[0].revision, needsRuntimeSync: true }
      },
      admin,
    ),
  )
  app.get(`${root}/status`, async (req) => {
    const { ctx, row } = await scoped(req, async (db, tenant, ctx) => ({
      ctx,
      row: await settings(db, ctx),
    }))
    if (!row) return { ready: false, reason: '请先在设置中配置企业 AI 密钥' }
    try {
      const stored = decryptConfig(row.encrypted_config, await configKey(env), ctx.tenantId)
      if (!resolveSecrets(stored, env, ctx.tenantId).ai)
        return { ready: false, reason: '请先在设置中填写并保存企业 API Key' }
      resolveDepartment(
        toPolicy(decryptConfig(row.encrypted_config, await configKey(env), ctx.tenantId)),
        'content_ops',
      )
      await driver.ready(ctx.tenantId, row.revision)
      return { ready: true, reason: '运行服务已连接' }
    } catch (e) {
      return { ready: false, reason: e.expose ? e.message : '企业运行服务尚未部署或无法连接' }
    }
  })
  app.get(`${root}/tasks`, async (req) =>
    driver.request(await runtime(req), 'ai', '/agent/tasks?page=1&pageSize=30'),
  )
  app.get(`${root}/tasks/:id`, async (req) => {
    const id = z
      .string()
      .regex(/^[a-f0-9]{24}$/)
      .parse(req.params.id)
    const ctx = await scoped(req, async (db, tenant, ctx) => ctx)
    return tasks.syncRuntime(ctx, id)
  })

  app.post(`${root}/tasks/:id/abort`, async (req) => {
    await scoped(req, async () => null, admin)
    const id = z
      .string()
      .regex(/^[a-f0-9]{24}$/)
      .parse(req.params.id)
    await driver.request(await runtime(req), 'ai', `/agent/tasks/${id}/abort`, {
      method: 'POST',
      body: {},
    })
    return { requested: true }
  })
  app.get(`${root}/accounts`, async (req) =>
    driver.request(await runtime(req), 'server', '/v2/channels/accounts'),
  )
  app.get(`${root}/platforms`, async (req) =>
    driver.request(await runtime(req), 'server', '/v2/channels/platforms'),
  )
  const platform = z.enum([
    'douyin',
    'xhs',
    'wxSph',
    'KWAI',
    'youtube',
    'wxGzh',
    'bilibili',
    'twitter',
    'tiktok',
    'facebook',
    'instagram',
    'threads',
    'pinterest',
    'linkedin',
    'google_business',
  ])
  app.post(`${root}/accounts/connect`, async (req) => {
    await scoped(req, async () => null, admin)
    const { platform: name } = z.object({ platform }).strict().parse(req.body)
    return driver.request(await runtime(req), 'server', `/v2/channels/accounts/auth/${name}`)
  })
  app.get(`${root}/accounts/auth/:platform/:session`, async (req) => {
    const name = platform.parse(req.params.platform),
      session = z
        .string()
        .min(1)
        .max(160)
        .regex(/^[a-zA-Z0-9_-]+$/)
        .parse(req.params.session)
    return driver.request(
      await runtime(req),
      'server',
      `/v2/channels/accounts/auth/${name}/status/${session}`,
    )
  })
  app.get(`${root}/publications/:id/receipt`, async (req) => {
    const record = await scoped(
      req,
      async (db, tenant, ctx) =>
        (
          await db.query('SELECT * FROM operations_publications WHERE id=$1 AND tenant_id=$2', [
            z.uuid().parse(req.params.id),
            ctx.tenantId,
          ])
        ).rows[0],
    )
    if (!record) throw fail(404, '发布记录不存在')
    if (!['submitted', 'uncertain', 'submitting'].includes(record.state))
      throw fail(409, '该申请尚未提交发布')
    return driver.request(await runtime(req), 'server', `/v2/channels/publish/flows/${record.id}`)
  })
  app.post(`${root}/tasks`, async (req, reply) => {
    await scoped(req, async () => null, admin)
    const input = z
      .object({
        prompt: z.string().trim().min(1).max(20000),
        secretaryTaskId: z.string().min(1).max(80).optional(),
        taskId: z
          .string()
          .regex(/^[a-f0-9]{24}$/)
          .optional(),
      })
      .strict()
      .parse(req.body)
    const ctx = await scoped(req, async (db, t, ctx) => ctx, admin)
    const stream = await tasks.start(ctx, input)
    reply.header('content-type', 'text/event-stream').header('x-accel-buffering', 'no')
    return reply.send(Readable.from(stream))
  })

  app.get(`${root}/publications`, (req) =>
    scoped(req, async (db, tenant, ctx) => ({
      items: (
        await db.query(
          'SELECT * FROM operations_publications WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',
          [ctx.tenantId],
        )
      ).rows,
    })),
  )
  app.post(`${root}/publications`, async (req) => {
    await scoped(req, async () => null, admin)
    const record = await scoped(req, (db, tenant, ctx) =>
      insertProposal(db, { ...ctx, mode: 'manual' }, proposalSchema.parse(req.body)),
    )
    return record
  })
  app.post(`${root}/publications/:id/reject`, (req) =>
    scoped(
      req,
      async (db, tenant, ctx) => {
        const { rows } = await db.query(
          "UPDATE operations_publications SET state='rejected',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND state='pending' AND execution_mode='manual' RETURNING id",
          [z.uuid().parse(req.params.id), ctx.tenantId],
        )
        if (!rows.length) throw fail(409, '该发布申请已处理')
        return { rejected: true }
      },
      admin,
    ),
  )
  app.post(`${root}/publications/:id/approve`, async (req) => {
    // Authorize before touching any upstream, then atomically claim once. Never retry an uncertain publish.
    await scoped(req, async () => null, admin)
    const entry = await runtime(req)
    const record = await scoped(
      req,
      async (db, tenant, ctx) => {
        const { rows } = await db.query(
          "UPDATE operations_publications SET state='submitting',approved_by=$3,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND state='pending' AND execution_mode='manual' RETURNING *",
          [z.uuid().parse(req.params.id), ctx.tenantId, ctx.userId],
        )
        if (!rows.length) throw fail(409, '该发布申请已处理')
        return rows[0]
      },
      admin,
    )
    let result, state
    try {
      result = await driver.request(entry, 'server', '/v2/channels/publish/flows', {
        method: 'POST',
        body: record.payload,
        signed: true,
      })
      state = 'submitted'
    } catch {
      state = 'uncertain'
      result = { message: '结果待核对，请勿重复发布' }
    }
    await scoped(
      req,
      (db, tenant, ctx) =>
        db.query(
          'UPDATE operations_publications SET state=$3,result=$4,updated_at=now() WHERE id=$1 AND tenant_id=$2',
          [record.id, ctx.tenantId, state, result],
        ),
      admin,
    )
    return { state, result }
  })
  app.get('/integrations/aitoearn/:tenantId/relay-config', async (req) => {
    const tenantId = z.uuid().parse(req.params.tenantId),
      entry = await driver.binding(tenantId)
    if (!entry || !verifyBridge(entry.bridgeSecret, 'GET', req.url, null, req.headers))
      throw fail(403, '运行服务认证失败')
    return transaction(
      pool,
      async (db) => {
        const row = await settings(db, { tenantId })
        if (!row) throw fail(409, '请先保存企业模型配置')
        const stored = decryptConfig(row.encrypted_config, await configKey(env), tenantId),
          secrets = resolveSecrets(stored, env, tenantId)
        if (!secrets.relay) throw fail(409, '请先填写平台中转 API Key')
        return {
          serverUrl:
            toPolicy(stored).aitoearn.region === 'china'
              ? 'https://aitoearn.cn/api'
              : 'https://aitoearn.ai/api',
          apiKey: secrets.relay,
        }
      },
      { tenantId, userId: '' },
    )
  })
  app.post(`${root}/publications/:id/resume`, async (req) => {
    await scoped(req,async()=>null,admin)
    throw fail(409,'请先查看发布内容并点击通过发布')
  })
  // Private runtime can propose publication; only a signed-in owner/admin can authorize it.
  app.post('/integrations/aitoearn/:tenantId/publications', async (req) => {
    const tenantId = z.uuid().parse(req.params.tenantId),
      entry = await driver.binding(tenantId)
    if (!entry || !verifyBridge(entry.bridgeSecret, 'POST', req.url, req.body, req.headers))
      throw fail(403, '运行服务认证失败')
    const payload = proposalSchema.parse(req.body)
    const record = await transaction(
      pool,
      (db) => insertProposal(db, { tenantId, mode: 'manual' }, payload),
      { tenantId, userId: '' },
    )
    return record
  })
}
