import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { defaultPolicy, policySchema, tenantSecrets, secretNames, normalizeGateway, validGatewayToken, gatewayToken, resolveDepartment, resolveCapability } from '../apps/api/src/operations/policy.mjs'
import { streamUsage, readUsage } from '../apps/api/src/operations/gateway.mjs'
import { budgetDay } from '../apps/api/src/operations/budget.mjs'

test('policy normalizes discovery URLs, preserves department tiers, keeps secrets out of policy and enforces per-publication approval', () => {
  const p = defaultPolicy(); p.gateway.base_url += '/models'
  assert.equal(policySchema.parse(p).gateway.base_url,'https://app.4yi.ai/api/v1')
  assert.equal(p.departments.compliance.enabled,false)
  assert.equal(p.departments.archive.tier,'cheap')
  assert.throws(() => policySchema.parse({...p,gateway:{...p.gateway,api_key:'raw-secret'}}))
  assert.equal(policySchema.parse({...p,departments:{...p.departments,content_ops:{...p.departments.content_ops,need_confirm:false}}}).departments.content_ops.need_confirm,true)
  for (const url of ['http://localhost:3000','https://app.4yi.ai.evil.test','https://app.4yi.ai/api/v1?key=x','bad']) assert.throws(() => normalizeGateway(url))
})
test('department-specific text and search choices override company defaults while old tier policies still inherit', () => {
  const p = defaultPolicy()
  p.tiers.fast = 'company-fast'
  p.tiers.search = 'company-search'
  p.departments.market_research.model = 'research-text'
  p.departments.market_research.capabilities.search.model = 'research-search'
  p.departments.outreach.enabled = true
  p.departments.outreach.tier = 'fast'
  assert.equal(resolveDepartment(p, 'market_research').model, 'research-text')
  assert.equal(resolveCapability(p, 'market_research', 'search').model, 'research-search')
  assert.equal(resolveDepartment(p, 'content_ops').model, 'company-fast')
  assert.equal(resolveCapability(p, 'outreach', 'search').model, 'company-search')
})
test('unbound common environment keys never bleed between companies', () => {
  const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222'
  const env = {RELAY_API_KEY:'a-secret',AITOEARN_RELAY_KEY:'a-relay',GATEWAY_TENANT_ID:a,[secretNames(b).ai]:'b-secret'}
  assert.equal(tenantSecrets(env,a).ai,'a-secret'); assert.equal(tenantSecrets(env,b).ai,'b-secret')
  assert.equal(tenantSecrets(env,b).relay,undefined)
  assert.equal(tenantSecrets({RELAY_API_KEY:'unbound'},a).ai,undefined)
  assert.ok(validGatewayToken('bridge',a,`Bearer ${gatewayToken('bridge',a)}`))
  assert.equal(validGatewayToken('bridge',b,`Bearer ${gatewayToken('bridge',a)}`),false)
})
test('stream meters wait for completion and include Anthropic cached input', () => {
  const meter = streamUsage(false)
  const source = 'data: {"usage":{"prompt_tokens":20,"completion_tokens":4}}\r\n\r\ndata: [DONE]\r\n\r\n'
  for (const char of source) meter.feed(char)
  assert.deepEqual(meter.result(),{input:20,output:4})
  const incomplete = streamUsage(false); incomplete.feed('data: {"usage":{"prompt_tokens":20,"completion_tokens":4}}\n\n')
  assert.equal(incomplete.result(),undefined)
  const a = streamUsage(true)
  a.feed('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":30,"cache_creation_input_tokens":20,"output_tokens":0}}}\n\n')
  a.feed('data: {"type":"message_delta","usage":{"output_tokens":12}}\n\ndata: {"type":"message_stop"}\n\n')
  assert.deepEqual(a.result(),{input:60,output:12})
  assert.equal(readUsage({usage:{prompt_tokens:-1,completion_tokens:2}}),undefined)
})
test('budget resets on Shanghai midnight', () => {
  assert.equal(budgetDay(new Date('2026-10-11T15:59:59Z')),'2026-10-11')
  assert.equal(budgetDay(new Date('2026-10-11T16:00:00Z')),'2026-10-12')
})
test('original runtime resolves environment references without storing key values', async () => {
  const source = await readFile('integrations/aitoearn/source/project/aitoearn-backend/libs/common/src/utils/office-env.util.ts','utf8')
  const {resolveOfficeEnv} = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`)
  const original = {ai:{key:'${RELAY_API_KEY}'},list:['${OTHER_KEY}']}
  assert.deepEqual(resolveOfficeEnv(original,{RELAY_API_KEY:'private',OTHER_KEY:'second'}),{ai:{key:'private'},list:['second']})
  assert.equal(original.ai.key,'${RELAY_API_KEY}')
  assert.throws(() => resolveOfficeEnv(original,{}),/Missing required environment variable/)
})
