import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { fail } from '../db.mjs'
export const tierNames = ['strong', 'fast', 'cheap']
const tier = z.enum(tierNames)
const capability = z
  .object({ enabled: z.boolean(), model: z.string().trim().max(150).default('') })
  .strict()
export const defaultCapabilities = (id) =>
  Object.fromEntries(
    ['image', 'video', 'search'].map((kind) => [
      kind,
      {
        enabled: {
          image: ['content_ops', 'design'],
          video: ['content_ops'],
          search: ['secretary', 'market_research', 'outreach'],
        }[kind].includes(id),
        model: '',
      },
    ]),
  )
const department = z
  .object({
    enabled: z.boolean().default(true),
    tier: tier.optional(),
    model: z.string().trim().max(150).default(''),
    fallback: tier.optional(),
    skills: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/)).max(50),
    need_confirm: z.boolean().default(false),
    capabilities: z.object({ image: capability, video: capability, search: capability }).optional(),
  })
  .strict()
export function normalizeGateway(value) {
  let u
  try {
    u = new URL(value)
  } catch {
    throw fail(400, '请填写有效的模型入口地址')
  }
  if (u.origin !== 'https://app.4yi.ai' || u.username || u.password || u.search || u.hash)
    throw fail(400, '当前仅支持已接入的 4YI 模型入口')
  if (!['', '/', '/api/v1', '/api/v1/', '/api/v1/models', '/api/v1/models/'].includes(u.pathname))
    throw fail(400, '请填写模型入口或模型列表地址')
  return 'https://app.4yi.ai/api/v1'
}
export const policySchema = z
  .object({
    gateway: z
      .object({
        base_url: z.string().transform(normalizeGateway),
        api_key: z.literal('${RELAY_API_KEY}'),
      })
      .strict(),
    tiers: z
      .object({
        strong: z.string().trim().max(150),
        fast: z.string().trim().max(150),
        cheap: z.string().trim().max(150),
        image: z.string().trim().max(150).default(''),
        video: z.string().trim().max(150).default(''),
        search: z.string().trim().max(150).default(''),
      })
      .strict(),
    departments: z
      .object(
        Object.fromEntries(
          [
            'secretary',
            'content_ops',
            'market_research',
            'design',
            'dev',
            'archive',
            'compliance',
            'outreach',
            'intern',
          ].map((id) => [id, department]),
        ),
      )
      .strict(),
    aitoearn: z
      .object({
        server_url: z.literal('http://localhost:3002'),
        relay_key: z.literal('${AITOEARN_RELAY_KEY}'),
        region: z.enum(['china', 'global']),
        accounts: z.record(z.string().max(80), z.string().max(150)),
      })
      .strict(),
    budget: z.object({ daily_token_limit: z.number().int().min(1000).max(100000000) }).strict(),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const [id, d] of Object.entries(v.departments)) {
      if (d.enabled && !d.tier && !d.model)
        ctx.addIssue({
          code: 'custom',
          path: ['departments', id, 'tier'],
          message: 'Enabled departments require a tier',
        })
    }
  })
  .transform((value) => ({
    ...value,
    departments: {
      ...Object.fromEntries(
        Object.entries(value.departments).map(([id, d]) => [
          id,
          { ...d, capabilities: d.capabilities || defaultCapabilities(id) },
        ]),
      ),
      content_ops: {
        ...value.departments.content_ops,
        capabilities:
          value.departments.content_ops.capabilities || defaultCapabilities('content_ops'),
        need_confirm: true,
      },
    },
  }))
export function defaultPolicy() {
  const d = (tier, fallback, skills, more = {}) => ({
    enabled: true,
    tier,
    ...(fallback ? { fallback } : {}),
    skills,
    need_confirm: false,
    ...more,
  })
  return policySchema.parse({
    gateway: { base_url: 'https://app.4yi.ai/api/v1', api_key: '${RELAY_API_KEY}' },
    tiers: { strong: '', fast: '', cheap: '', image: '', video: '', search: '' },
    departments: {
      secretary: d('fast', 'cheap', ['task_split', 'remind', 'report']),
      content_ops: d('fast', 'cheap', ['make_video', 'aitoearn_publish'], { need_confirm: true }),
      market_research: d('strong', 'fast', ['competitor_analysis']),
      design: d('fast', null, ['taste']),
      dev: d('strong', 'fast', ['code_review']),
      archive: d('cheap', null, ['auto_archive', 'tidy_tables']),
      compliance: { enabled: false, skills: [], need_confirm: false },
      outreach: { enabled: false, skills: [], need_confirm: false },
      intern: { enabled: false, skills: [], need_confirm: false },
    },
    aitoearn: {
      server_url: 'http://localhost:3002',
      relay_key: '${AITOEARN_RELAY_KEY}',
      region: 'china',
      accounts: {},
    },
    budget: { daily_token_limit: 2000000 },
  })
}
export function toPolicy(value) {
  if (value?.gateway) {
    const { credentials: _credentials, ...policy } = value
    return policySchema.parse(policy)
  }
  const policy = defaultPolicy()
  // Preserve the previous explicit model choice; never migrate credentials into the policy.
  if (value?.agentModel) policy.tiers.fast = value.agentModel
  if (value?.relayRegion) policy.aitoearn.region = value.relayRegion
  return policy
}
export function secretNames(tenantId) {
  const prefix = `TENANT_${tenantId.replaceAll('-', '').toUpperCase()}`
  return { ai: `${prefix}_RELAY_API_KEY`, relay: `${prefix}_AITOEARN_RELAY_KEY` }
}
export function tenantSecrets(env, tenantId) {
  const names = secretNames(tenantId),
    single = env.GATEWAY_TENANT_ID === tenantId
  return {
    ai: env[names.ai] || (single ? env.RELAY_API_KEY : undefined),
    relay: env[names.relay] || (single ? env.AITOEARN_RELAY_KEY : undefined),
  }
}
export function resolveDepartment(policy, id) {
  const d = policy.departments[id]
  if (!d?.enabled) throw fail(409, '该部门的模型服务尚未启用')
  const model = d.model || policy.tiers[d.tier]
  if (!model) throw fail(409, '请先配置该部门使用的模型档位')
  return { model, fallback: d.fallback ? policy.tiers[d.fallback] : '', tier: d.tier }
}
export function gatewayToken(secret, tenantId) {
  return createHmac('sha256', secret).update(`office-model-gateway-v1:${tenantId}`).digest('hex')
}
export function validGatewayToken(secret, tenantId, authorization = '') {
  const actual = Buffer.from(authorization),
    expected = Buffer.from(`Bearer ${gatewayToken(secret, tenantId)}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function resolveCapability(policy, id, kind) {
  if (kind === 'text') return resolveDepartment(policy, id)
  const d = policy.departments[id]
  if (!d?.enabled) throw fail(409, '该部门的模型服务尚未启用')
  const selected = (d.capabilities || defaultCapabilities(id))[kind]
  if (!selected?.enabled) throw fail(409, '该部门尚未启用此项模型能力')
  const model = selected.model || policy.tiers[kind]
  if (!model)
    throw fail(409, `请先配置${{ image: '图片', video: '视频', search: '搜索' }[kind]}模型`)
  return { model, fallback: '', tier: kind }
}
