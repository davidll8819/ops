import { createHash } from 'node:crypto'
import { agentProfile } from '../../packages/contracts/index.mjs'
export function memoryActor(tenantId, userId, agentId) {
  return (
    'actor_' +
    createHash('sha256')
      .update(JSON.stringify([tenantId, userId, agentId]))
      .digest('hex')
  )
}
export function compileProfile(input, { roleArn, memoryArn } = {}) {
  const p = agentProfile.parse(input)
  return {
    harnessName: `office_${createHash('sha256').update(p.name).digest('hex').slice(0, 16)}`,
    ...(roleArn ? { executionRoleArn: roleArn } : {}),
    model: {
      bedrockModelConfig: {
        modelId: p.modelId,
        maxTokens: p.maxTokens,
        temperature: p.temperature,
      },
    },
    systemPrompt: [{ text: p.systemPrompt }],
    tools: [],
    allowedTools: [],
    maxIterations: 4,
    maxTokens: p.maxTokens,
    timeoutSeconds: 45,
    memory: p.memory
      ? memoryArn
        ? { agentCoreMemoryConfiguration: { arn: memoryArn } }
        : {
            managedMemoryConfiguration: {
              strategies: ['SEMANTIC', 'USER_PREFERENCE'],
              eventExpiryDuration: 30,
            },
          }
      : { disabled: {} },
  }
}
export function invocationFor({
  profile,
  tenantId,
  userId,
  agentId,
  sessionId,
  prompt,
  harnessArn,
}) {
  const p = agentProfile.parse(profile),
    c = compileProfile(p)
  return {
    harnessArn,
    runtimeSessionId: sessionId,
    runtimeUserId: memoryActor(tenantId, userId, agentId),
    actorId: memoryActor(tenantId, userId, agentId),
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    model: c.model,
    systemPrompt: c.systemPrompt,
    tools: [],
    allowedTools: [],
    maxIterations: c.maxIterations,
    maxTokens: c.maxTokens,
    timeoutSeconds: c.timeoutSeconds,
  }
}
