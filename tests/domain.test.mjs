import test from 'node:test'
import assert from 'node:assert/strict'
import { memoryActor, compileProfile, invocationFor } from '../apps/runtime/harness.mjs'
import { priceUsage } from '../apps/api/src/agents.mjs'
import { agentProfile } from '../packages/contracts/index.mjs'
const profile = {
  name: '调研助手',
  systemPrompt: '收集信息并整理待核实的问题',
  modelId: 'test-model',
  maxTokens: 2048,
  temperature: 0.4,
  memory: true,
}
test('memory partitions tenant, user and agent independently', () => {
  const keys = [
    memoryActor('t1', 'u1', 'a1'),
    memoryActor('t2', 'u1', 'a1'),
    memoryActor('t1', 'u2', 'a1'),
    memoryActor('t1', 'u1', 'a2'),
  ]
  assert.equal(new Set(keys).size, 4)
  assert.equal(keys[0], memoryActor('t1', 'u1', 'a1'))
})
test('profile cannot inject tools, IAM role or tenant identity', () => {
  for (const field of ['tools', 'executionRoleArn', 'tenantId', 'actorId'])
    assert.equal(agentProfile.safeParse({ ...profile, [field]: 'malicious' }).success, false)
})
test('native harness export and shared invocation use the same approved parameters', () => {
  const compiled = compileProfile(profile, { roleArn: 'role' })
  const call = invocationFor({
    profile,
    tenantId: 't',
    userId: 'u',
    agentId: 'a',
    sessionId: 's',
    prompt: 'hello',
    harnessArn: 'h',
  })
  assert.deepEqual(call.model, compiled.model)
  assert.deepEqual(call.systemPrompt, compiled.systemPrompt)
  assert.deepEqual(call.allowedTools, [])
  assert.equal(call.actorId, memoryActor('t', 'u', 'a'))
  assert.equal(call.runtimeSessionId, 's')
})
test('disabling memory exports an explicit disabled configuration', () =>
  assert.deepEqual(compileProfile({ ...profile, memory: false }).memory, { disabled: {} }))
test('selling price uses micro dollars, keeps unknown prices unpriced', () => {
  assert.deepEqual(
    priceUsage(
      { inputTokens: 100, outputTokens: 10 },
      { inputUsdPerMillion: 2, outputUsdPerMillion: 8 },
    ),
    { input: 100, output: 10, microUsd: 280, priced: true },
  )
  assert.equal(priceUsage({ inputTokens: 100 }, undefined).priced, false)
  assert.throws(() => priceUsage({ inputTokens: -1 }))
})
