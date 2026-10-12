import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore'
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import { invocationFor } from '../../runtime/harness.mjs'
import { agentProfile } from '../../../packages/contracts/index.mjs'
import { fail } from './db.mjs'
export function awsAgents(env) {
  const region = env.AGENT_REGION || 'us-west-2'
  if (!['us-west-2', 'us-east-2'].includes(region))
    throw new Error('AgentCore must not run in Hong Kong')
  const client = new BedrockAgentCoreClient({ region, maxAttempts: 1 })
  const builder = new BedrockRuntimeClient({ region, maxAttempts: 1 })
  const models = (env.ALLOWED_MODEL_IDS || '').split(',').filter(Boolean)
  const rates = JSON.parse(env.MODEL_RATES_JSON || '{}')
  return {
    models,
    rates,
    ready: Boolean(
      env.AGENT_HARNESS_ARN && env.AGENT_STATELESS_HARNESS_ARN && env.BUILDER_MODEL_ID,
    ),
    async generate(description) {
      if (!env.BUILDER_MODEL_ID) throw fail(503, '尚未配置自动生成模型')
      const response = await builder.send(
        new ConverseCommand({
          modelId: env.BUILDER_MODEL_ID,
          inferenceConfig: { maxTokens: 1800, temperature: 0.2 },
          system: [
            {
              text:
                'Generate an AI assistant configuration as JSON only. Use the same language as the user request. Keys: name, systemPrompt (detailed instructions), modelId, maxTokens (2048), temperature (0.4), memory (true). Never add tools, network access, execution roles or infrastructure. modelId must be ' +
                models[0],
            },
          ],
          messages: [{ role: 'user', content: [{ text: description }] }],
        }),
        { abortSignal: AbortSignal.timeout(55000) },
      )
      const text = response.output?.message?.content?.map((x) => x.text || '').join('') || ''
      const profile = agentProfile.parse(
        JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')),
      )
      if (!models.includes(profile.modelId)) throw fail(502, '生成结果使用了未授权的模型')
      return { profile, usage: response.usage, providerRequestId: response.$metadata.requestId }
    },
    async invoke(input) {
      const arn = input.profile.memory ? env.AGENT_HARNESS_ARN : env.AGENT_STATELESS_HARNESS_ARN
      if (!arn) throw fail(503, '助手运行服务尚未部署')
      const result = await client.send(
        new InvokeHarnessCommand(invocationFor({ ...input, harnessArn: arn })),
        { abortSignal: AbortSignal.timeout(55000) },
      )
      let text = '',
        usage = { inputTokens: 0, outputTokens: 0 },
        seenUsage = false
      for await (const event of result.stream || []) {
        if (event.contentBlockDelta?.delta?.text) text += event.contentBlockDelta.delta.text
        if (event.metadata?.usage) {
          usage = event.metadata.usage
          seenUsage = true
        }
        const errorKey = Object.keys(event).find((k) => /exception|error/i.test(k))
        if (errorKey) throw fail(502, '助手执行失败，用量等待核对')
      }
      if (!seenUsage) throw fail(502, '未收到完整用量，调用需要核对')
      return { text, usage, providerRequestId: result.$metadata.requestId }
    },
  }
}
export function priceUsage(usage, rate) {
  const input = Number(usage?.inputTokens || 0),
    output = Number(usage?.outputTokens || 0)
  if (![input, output].every((n) => Number.isSafeInteger(n) && n >= 0))
    throw new Error('Invalid provider usage')
  if (!rate) return { input, output, microUsd: 0, priced: false }
  if (
    ![rate.inputUsdPerMillion, rate.outputUsdPerMillion].every((n) => Number.isFinite(n) && n >= 0)
  )
    throw new Error('Invalid model rates')
  // USD per million tokens equals micro-USD per token. Rates are a versioned selling price, not an AWS cost estimate.
  return {
    input,
    output,
    microUsd: Math.ceil(input * rate.inputUsdPerMillion + output * rate.outputUsdPerMillion),
    priced: true,
  }
}
