import { registerDeliverables } from './task-assets.mjs'
import { registerDailyBrief } from './daily-brief.mjs'
import { registerSlowResponses, responseError } from './slow-response.mjs'
import { registerResearchEngine } from './research/engine.mjs'
import { registerDepartmentEngine } from './department-engine.mjs'
import { createOperationsTasks } from './operations/task-service.mjs'
import { registerSearchSettings } from './research/settings.mjs'
import { registerReminders } from './reminders.mjs'
import { registerSecretaryExecution } from './secretary-execution.mjs'
import { registerWorkspaceServices } from './workspace-services.mjs'
import { registerArchiveRoutes } from './archive/routes.mjs'
import { registerComparisonRoutes } from './archive/comparison-routes.mjs'
import { registerFilingRoutes } from './archive/filing-routes.mjs'
import { registerArchiveRecordRoutes } from './archive/record-routes.mjs'
import { registerEmployeeProfiles } from './employee-profiles.mjs'
import { registerEmployeeSkills } from './employee-skills.mjs'
import { createDockerExecution } from './execution/docker.mjs'
import { createExecutionService } from './execution/service.mjs'
import { registerExecutionRoutes } from './execution/routes.mjs'
import { registerDeliveryRoutes } from './execution/delivery-routes.mjs'
import { registerAcceptanceRoutes } from './execution/acceptance-routes.mjs'
import { registerVersionTestRoutes } from './execution/version-test-routes.mjs'
import Fastify from 'fastify'
import { registerModelGateway } from './operations/gateway.mjs'
import { registerOperations } from './operations/routes.mjs'
import { loadMediaOrigins } from './operations/media-origins.mjs'
import { registerSecretary } from './secretary.mjs'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import serveStatic from '@fastify/static'
import { randomUUID, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { authService, hash } from './auth.mjs'
import { transaction, tenantAccess, fail } from './db.mjs'
import { throttle } from './cache.mjs'
import { priceUsage } from './agents.mjs'
import { readSkillCatalog } from './skill-catalog.mjs'
import { prepareCatalogSkill } from './skill-install.mjs'
import { inspectSkillUpload, listInstalledSkills, installUploadedSkill } from './skill-upload.mjs'
import { compileProfile } from '../../runtime/harness.mjs'
import {
  agentProfile,
  messageInput,
  tenantInput,
  inviteInput,
} from '../../../packages/contracts/index.mjs'
const uuid = z.string().uuid()
export async function buildApp({
  pool,
  cache,
  agents,
  skillCatalog = readSkillCatalog,
  catalogInstaller = prepareCatalogSkill,
  operationsDriver,
  modelFetch,
  executionDriver,
  documentParser,
  env = process.env,
  staticRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url)),
}) {
  if (!env.APP_ORIGIN) throw new Error('APP_ORIGIN is required')
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL || 'info',
      redact: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.body',
        'res.headers.set-cookie',
      ],
    },
    disableRequestLogging: true,
    bodyLimit: 65536,
    trustProxy: false,
  })
  await app.register(cookie)
  const productionMediaOrigins = await loadMediaOrigins(env)
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', ...productionMediaOrigins],
        mediaSrc: ["'self'", ...productionMediaOrigins],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: env.NODE_ENV === 'production' ? [] : null,
      },
    },
  })
  const auth = authService({ pool, cache, env })
  app.setErrorHandler((err, req, reply) => {
    const { status, data } = responseError(err, req, app)
    reply.code(status).send(data)
  })
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (
      env.ORIGIN_VERIFY_SECRET &&
      req.url !== '/health/live' &&
      req.url !== '/health/ready' &&
      req.headers['x-origin-verify'] !== env.ORIGIN_VERIFY_SECRET
    )
      throw fail(403, '禁止直接访问源站')
    if (req.url.startsWith('/auth/')) {
      // CloudFront overwrites this header; local requests use the socket peer.
      const ip = env.ORIGIN_VERIFY_SECRET
        ? String(req.headers['cloudfront-viewer-address'] || 'unknown').replace(/:\d+$/, '')
        : req.ip
      if (!(await throttle(cache, `auth-rate:${hash(ip)}`, 30, 60)))
        throw fail(429, '登录请求过于频繁')
    }
    if (req.url.startsWith('/api/')) {
      req.identity = await auth.session(req)
      if (!['GET', 'HEAD'].includes(req.method)) auth.checkCsrf(req, req.identity)
      if (!(await throttle(cache, `api-rate:${req.identity.userId}`, 120, 60)))
        throw fail(429, '操作过于频繁，请稍后再试')
    }
  })
  auth.register(app)
  app.get('/health/live', () => ({ ok: true }))
  app.get('/health/ready', async () => {
    await pool.query('SELECT 1')
    await cache.ping()
    return { ok: true }
  })
  app.get('/public/config', () => ({
    authMode: env.AUTH_MODE === 'local' ? 'local' : 'cognito',
    paymentsEnabled: false,
    agentsReady: agents.ready !== false,
    agentRegion: env.AGENT_REGION || 'us-west-2',
  }))
  app.get('/api/me', async (req) => {
    const { rows: tenants } = await pool.query(
      'SELECT t.id,t.name,t.plan,m.role FROM tenants t JOIN memberships m ON t.id=m.tenant_id WHERE m.user_id=$1 ORDER BY t.created_at',
      [req.identity.userId],
    )
    return {
      user: { id: req.identity.userId, email: req.identity.email },
      csrf: req.identity.csrf,
      tenants,
    }
  })
  app.post('/api/tenants', async (req, reply) => {
    const { name } = tenantInput.parse(req.body),
      id = randomUUID()
    await transaction(pool, async (db) => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.identity.userId])
      const {
        rows: [count],
      } = await db.query(
        "SELECT count(*)::int n FROM memberships WHERE user_id=$1 AND role='owner'",
        [req.identity.userId],
      )
      if (count.n >= 10) throw fail(409, '每个账户最多创建 10 个工作空间')
      await db.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [id, name])
      await db.query("INSERT INTO memberships VALUES($1,$2,'owner')", [id, req.identity.userId])
    })
    reply.code(201)
    return { id, name, plan: 'personal', role: 'owner' }
  })
  const scope = (req) => ({
    tenantId: uuid.parse(req.params.tenantId),
    userId: req.identity.userId,
  })
  async function scoped(req, fn, roles) {
    const ctx = scope(req)
    return transaction(
      pool,
      async (db) => fn(db, await tenantAccess(db, ctx.userId, ctx.tenantId, roles), ctx),
      ctx,
    )
  }
  registerSlowResponses(app, { authorize: (req) => scoped(req, async () => {}) })
  const executionRuntime = executionDriver || createDockerExecution({ env })
  const execution = createExecutionService({
    pool,
    env,
    driver: executionRuntime,
    fetcher: modelFetch,
  })
  registerExecutionRoutes(app, { scoped, service: execution })
  const previews = registerDeliveryRoutes(app, { scoped, service: execution, pool, env })
  registerAcceptanceRoutes(app, { scoped, previews })
  registerVersionTestRoutes(app, { scoped, pool, driver: executionRuntime })
  registerWorkspaceServices(app, { scoped, pool, env, fetcher: modelFetch, execution })
  registerArchiveRoutes(app, { scoped, documentParser })
  registerComparisonRoutes(app, { scoped })
  registerFilingRoutes(app, { scoped, pool, env, fetcher: modelFetch })
  registerArchiveRecordRoutes(app, { scoped })
  registerEmployeeProfiles(app, { scoped, env })
  registerEmployeeSkills(app, { scoped })
  registerSecretaryExecution(app, { scoped, pool, env, fetcher: modelFetch })
  registerReminders(app, { scoped, pool, env })
  registerSearchSettings(app, { scoped, env })
  registerResearchEngine(app, { pool, env, fetcher: modelFetch })
  const operationsTasks = createOperationsTasks({ pool, env, driver: operationsDriver })
  registerDepartmentEngine(app, { pool, env, fetcher: modelFetch, operations: operationsTasks })
  registerDeliverables(app, { scoped })
  registerDailyBrief(app, { scoped, pool, env, fetcher: modelFetch, cache })
  registerSecretary(app, scoped, { pool, env, fetcher: modelFetch })
  registerModelGateway(app, { scoped, pool, env, driver: operationsDriver, fetcher: modelFetch })
  registerOperations(app, { scoped, pool, env, driver: operationsDriver, tasks: operationsTasks })
  app.get('/api/tenants/:tenantId/skills/catalog', (req) =>
    scoped(req, async (db, tenant, ctx) => {
      const catalog = await skillCatalog()
      const installed = await listInstalledSkills(db, ctx.tenantId)
      const ids = new Map(
        installed.items.filter((i) => i.catalog_id).map((i) => [i.catalog_id, i.id]),
      )
      return {
        ...catalog,
        items: catalog.items.map((i) => ({ ...i, installedId: ids.get(i.id) || null })),
      }
    }),
  )
  app.post('/api/tenants/:tenantId/skills/install', async (req, reply) => {
    const { id } = z
      .object({ id: z.string().regex(/^[a-f0-9]{24}$/) })
      .strict()
      .parse(req.body)
    const existing = await scoped(
      req,
      async (db, tenant, ctx) =>
        (await listInstalledSkills(db, ctx.tenantId)).items.find((i) => i.catalog_id === id),
      ['owner', 'admin'],
    )
    if (existing) return { skill: existing, alreadyInstalled: true }
    if (!(await throttle(cache, `skill-install:${req.identity.userId}`, 20, 60)))
      throw fail(429, '安装过于频繁，请稍后再试')
    const upload = await catalogInstaller(id)
    const result = await scoped(req, (db, tenant, ctx) => installUploadedSkill(db, ctx, upload), [
      'owner',
      'admin',
    ])
    reply.code(result.alreadyInstalled ? 200 : 201)
    return result
  })
  app.get('/api/tenants/:tenantId/skills/installed', (req) =>
    scoped(req, (db, tenant, ctx) => listInstalledSkills(db, ctx.tenantId)),
  )
  app.post(
    '/api/tenants/:tenantId/skills/uploads',
    { bodyLimit: 9 * 1024 * 1024 },
    async (req, reply) => {
      // Authorize before spending CPU inspecting untrusted package contents.
      await scoped(req, () => null, ['owner', 'admin'])
      if (!(await throttle(cache, `skill-upload:${req.identity.userId}`, 10, 60)))
        throw fail(429, '上传过于频繁，请稍后再试')
      const upload = await inspectSkillUpload(req.body)
      const result = await scoped(req, (db, tenant, ctx) => installUploadedSkill(db, ctx, upload), [
        'owner',
        'admin',
      ])
      reply.code(201)
      return result
    },
  )
  app.get('/api/tenants/:tenantId/members', (req) =>
    scoped(req, async (db, t, ctx) => ({
      members: (
        await db.query(
          'SELECT u.id,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY u.email',
          [ctx.tenantId],
        )
      ).rows,
      plan: t.plan,
    })),
  )
  app.post('/api/tenants/:tenantId/invitations', (req) =>
    scoped(
      req,
      async (db, t, ctx) => {
        if (
          t.plan !== 'enterprise' ||
          !['active', 'trialing', 'manual'].includes(t.subscription_status)
        )
          throw fail(402, '多人协作需要已开通的企业版')
        const data = inviteInput.parse(req.body),
          token = randomBytes(32).toString('base64url')
        await db.query(
          "INSERT INTO invitations(id,tenant_id,email,role,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '7 days')",
          [randomUUID(), ctx.tenantId, data.email, data.role, hash(token)],
        )
        return { url: `${env.APP_ORIGIN}/?invite=${token}`, expiresInDays: 7 }
      },
      ['owner', 'admin'],
    ),
  )
  app.post('/api/invitations/accept', async (req) => {
    const { token } = z
      .object({ token: z.string().min(32).max(128) })
      .strict()
      .parse(req.body)
    return transaction(pool, async (db) => {
      const {
        rows: [i],
      } = await db.query(
        'SELECT * FROM invitations WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at>now() FOR UPDATE',
        [hash(token)],
      )
      if (!i || i.email !== req.identity.email) throw fail(403, '邀请无效、已过期或邮箱不匹配')
      const {
        rows: [t],
      } = await db.query('SELECT * FROM tenants WHERE id=$1 FOR UPDATE', [i.tenant_id])
      if (
        t.plan !== 'enterprise' ||
        !['active', 'trialing', 'manual'].includes(t.subscription_status)
      )
        throw fail(402, '企业版尚未开通')
      await db.query('INSERT INTO memberships VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
        i.tenant_id,
        req.identity.userId,
        i.role,
      ])
      await db.query('UPDATE invitations SET accepted_at=now() WHERE id=$1', [i.id])
      return { tenantId: i.tenant_id }
    })
  })
  app.delete('/api/tenants/:tenantId/members/:userId', (req) =>
    scoped(
      req,
      async (db, t, ctx) => {
        if (t.role !== 'owner') throw fail(403, '只有企业所有者可以移除成员')
        const userId = uuid.parse(req.params.userId)
        const { rowCount } = await db.query(
          "DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND role!='owner'",
          [ctx.tenantId, userId],
        )
        return { removed: rowCount === 1 }
      },
      ['owner'],
    ),
  )
  app.get('/api/tenants/:tenantId/agents', (req) =>
    scoped(req, async (db, t, ctx) => {
      const key = `agents:${ctx.tenantId}`
      const cached = await cache.get(key)
      if (cached) return JSON.parse(cached)
      const result = {
        agents: (
          await db.query(
            'SELECT id,profile,version,created_at FROM agents WHERE tenant_id=$1 ORDER BY created_at',
            [ctx.tenantId],
          )
        ).rows,
        models: agents.models,
      }
      await cache.set(key, JSON.stringify(result), { EX: 15 })
      return result
    }),
  )
  app.post('/api/tenants/:tenantId/agents', async (req, reply) => {
    const result = await scoped(
      req,
      async (db, t, ctx) => {
        const profile = agentProfile.parse(req.body)
        if (!agents.models.includes(profile.modelId)) throw fail(400, '请选择允许使用的模型')
        const id = randomUUID()
        await db.query('INSERT INTO agents(id,tenant_id,profile,created_by) VALUES($1,$2,$3,$4)', [
          id,
          ctx.tenantId,
          JSON.stringify(profile),
          ctx.userId,
        ])
        return { id, profile }
      },
      ['owner', 'admin'],
    )
    await cache.del(`agents:${req.params.tenantId}`)
    reply.code(201)
    return result
  })
  app.get('/api/tenants/:tenantId/agents/:agentId/harness', (req) =>
    scoped(
      req,
      async (db, t, ctx) => {
        const {
          rows: [a],
        } = await db.query('SELECT * FROM agents WHERE tenant_id=$1 AND id=$2', [
          ctx.tenantId,
          uuid.parse(req.params.agentId),
        ])
        if (!a) throw fail(404, '助手不存在')
        return {
          mode: 'shared-profile',
          parameters: compileProfile(a.profile, {
            roleArn: env.AGENT_EXECUTION_ROLE_ARN,
            memoryArn: env.AGENT_MEMORY_ARN,
          }),
        }
      },
      ['owner', 'admin'],
    ),
  )
  async function executeMetered(req, { requestId, agentId, operation, modelId, perform }) {
    const ctx = scope(req),
      id = randomUUID()
    let replay
    await scoped(req, async (db) => {
      const {
        rows: [old],
      } = await db.query(
        'SELECT * FROM usage_events WHERE tenant_id=$1 AND user_id=$2 AND request_id=$3',
        [ctx.tenantId, ctx.userId, requestId],
      )
      if (old) {
        if (old.operation !== operation || old.agent_id !== (agentId || null))
          throw fail(409, '请求编号已用于其他操作')
        if (old.status === 'completed') {
          replay = old.result
          return
        }
        throw fail(409, '该请求正在处理或需要核对，请勿重复提交')
      }
      await db.query(
        'INSERT INTO usage_events(id,tenant_id,user_id,agent_id,request_id,operation,status,rate_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
        [
          id,
          ctx.tenantId,
          ctx.userId,
          agentId || null,
          requestId,
          operation,
          'pending',
          JSON.stringify(agents.rates[modelId] || {}),
        ],
      )
      const {
        rows: [own],
      } = await db.query(
        'SELECT id FROM usage_events WHERE tenant_id=$1 AND user_id=$2 AND request_id=$3',
        [ctx.tenantId, ctx.userId, requestId],
      )
      if (own.id !== id) throw fail(409, '请求已在处理')
    })
    if (replay) return replay
    const lock = `invoke:${ctx.tenantId}:${ctx.userId}`
    if (!(await cache.set(lock, id, { NX: true, EX: 180 }))) {
      await transaction(
        pool,
        (db) => db.query("UPDATE usage_events SET status='failed' WHERE id=$1", [id]),
        ctx,
      )
      throw fail(429, '请等待上一个助手请求完成')
    }
    const start = Date.now()
    try {
      const result = await perform()
      const cost = priceUsage(result.usage, agents.rates[modelId])
      const response = {
        ...result,
        charge: { microUsd: cost.microUsd, priced: cost.priced },
        requestId,
      }
      await transaction(
        pool,
        async (db) => {
          await db.query(
            "UPDATE usage_events SET status='completed',input_tokens=$2,output_tokens=$3,duration_ms=$4,charge_microusd=$5,result=$6,provider_request_id=$7 WHERE id=$1",
            [
              id,
              cost.input,
              cost.output,
              Date.now() - start,
              cost.microUsd,
              JSON.stringify(response),
              result.providerRequestId || null,
            ],
          )
        },
        ctx,
      )
      return response
    } catch (e) {
      await transaction(
        pool,
        (db) =>
          db.query(
            "UPDATE usage_events SET status='unknown',duration_ms=$2 WHERE id=$1 AND status='pending'",
            [id, Date.now() - start],
          ),
        ctx,
      )
      throw e
    } finally {
      await cache.eval(
        "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
        { keys: [lock], arguments: [id] },
      )
    }
  }
  app.post('/api/tenants/:tenantId/agent-builder', async (req) => {
    if (agents.ready === false) throw fail(503, '助手运行服务尚未部署')
    const { description, requestId } = z
      .object({ description: z.string().trim().min(10).max(4000), requestId: uuid })
      .strict()
      .parse(req.body)
    await scoped(req, async () => {}, ['owner', 'admin'])
    return executeMetered(req, {
      requestId,
      operation: 'builder',
      modelId: env.BUILDER_MODEL_ID,
      perform: () => agents.generate(description),
    })
  })
  app.post('/api/tenants/:tenantId/agents/:agentId/messages', async (req) => {
    const data = messageInput.parse(req.body),
      agentId = uuid.parse(req.params.agentId)
    if (agents.ready === false) throw fail(503, '助手运行服务尚未部署')
    const { profile, conversation } = await scoped(req, async (db, t, ctx) => {
      const {
        rows: [a],
      } = await db.query('SELECT * FROM agents WHERE tenant_id=$1 AND id=$2', [
        ctx.tenantId,
        agentId,
      ])
      if (!a) throw fail(404, '助手不存在')
      if (!agents.models.includes(a.profile.modelId)) throw fail(400, '请选择允许使用的模型')
      let conversation
      if (data.conversationId) {
        conversation = (
          await db.query(
            'SELECT * FROM conversations WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND agent_id=$4',
            [data.conversationId, ctx.tenantId, ctx.userId, agentId],
          )
        ).rows[0]
        if (!conversation) throw fail(404, '对话不存在')
      } else {
        conversation = { id: randomUUID(), runtime_session_id: randomUUID() }
      }
      return { profile: a.profile, conversation }
    })
    return executeMetered(req, {
      requestId: data.requestId,
      operation: 'chat',
      agentId,
      modelId: profile.modelId,
      perform: async () => {
        if (!data.conversationId)
          await scoped(req, async (db, t, ctx) => {
            await db.query(
              'INSERT INTO conversations(id,tenant_id,user_id,agent_id,runtime_session_id) VALUES($1,$2,$3,$4,$5)',
              [conversation.id, ctx.tenantId, ctx.userId, agentId, conversation.runtime_session_id],
            )
          })
        return {
          ...(await agents.invoke({
            profile,
            ...scope(req),
            agentId,
            sessionId: conversation.runtime_session_id,
            prompt: data.prompt,
          })),
          conversationId: conversation.id,
        }
      },
    })
  })
  app.get('/api/tenants/:tenantId/usage', (req) =>
    scoped(req, async (db, t, ctx) => {
      const values = [ctx.tenantId]
      const userFilter = t.role === 'member' ? ' AND user_id=$2' : ''
      if (userFilter) values.push(ctx.userId)
      const { rows } = await db.query(
        `SELECT user_id,operation,status,count(*)::int requests,sum(input_tokens)::text input_tokens,sum(output_tokens)::text output_tokens,sum(charge_microusd)::text charge_microusd FROM usage_events WHERE tenant_id=$1 AND created_at>=date_trunc('month',now())${userFilter} GROUP BY user_id,operation,status`,
        values,
      )
      const modelRows = (
        await db.query(
          `SELECT user_id,department operation,state status,count(*)::int requests,coalesce(sum(input_tokens),0)::text input_tokens,coalesce(sum(output_tokens),0)::text output_tokens,'0'::text charge_microusd FROM model_requests WHERE tenant_id=$1 AND created_at>=date_trunc('month',now())${userFilter} GROUP BY user_id,department,state`,
          values,
        )
      ).rows
      return {
        modelUsage: modelRows,
        period: 'current_month_utc',
        currency: 'USD',
        usage: rows,
        pricingConfigured: Object.keys(agents.rates).length > 0,
        paymentsEnabled: false,
        plan: t.plan,
        subscriptionStatus: t.subscription_status,
      }
    }),
  )
  app.get('/api/tenants/:tenantId/actions', (req) =>
    scoped(req, async (db, t, ctx) => {
      const after = z.coerce
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .default(0)
        .parse(req.query.after)
      const { rows } = await db.query(
        'SELECT seq::text,action FROM office_events WHERE tenant_id=$1 AND seq>$2 ORDER BY seq LIMIT 100',
        [ctx.tenantId, after],
      )
      return { actions: rows.map((x) => x.action), cursor: rows.at(-1)?.seq || String(after) }
    }),
  )
  app.post('/api/tenants/:tenantId/actions', (req) =>
    scoped(
      req,
      async (db, t, ctx) => {
        const action = z
          .object({
            type: z.literal('set_state'),
            rosterNo: z.number().int().min(1).max(9),
            state: z.enum(['idle', 'working', 'thinking', 'talking']),
            task: z.string().max(160).optional(),
          })
          .strict()
          .parse(req.body)
        await db.query('INSERT INTO office_events(tenant_id,action) VALUES($1,$2)', [
          ctx.tenantId,
          JSON.stringify(action),
        ])
        return { accepted: true }
      },
      ['owner', 'admin'],
    ),
  )
  if (staticRoot) {
    await app.register(serveStatic, {
      root: staticRoot,
      wildcard: true,
      setHeaders: (res, path) => {
        if (/\/assets\/.*\.[a-z0-9]+$/i.test(path))
          res.header('Cache-Control', 'public, max-age=86400')
      },
    })
    app.setNotFoundHandler((req, reply) => {
      if (
        req.method !== 'GET' ||
        /^\/(api|auth|health|assets|project-preview)(?:\/|$)/.test(req.url)
      )
        return reply.code(404).send({ error: '不存在' })
      return reply.sendFile('index.html')
    })
  }
  app.addHook('onClose', async () => {})
  return app
}
