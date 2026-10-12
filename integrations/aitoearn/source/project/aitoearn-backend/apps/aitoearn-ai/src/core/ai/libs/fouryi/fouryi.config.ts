import type { AppConfig } from '../../../../config'

export function fourYiApiBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '')}/api/v1`
}

/** A configured company gateway owns all new AI requests. */
export function applyFourYiRouting(config: AppConfig): void {
  if (!config.ai.fouryi.apiKey)
    return

  config.enableConfigLogging = false
  config.ai.openai = {
    apiKey: config.ai.fouryi.apiKey,
    baseUrl: fourYiApiBaseUrl(config.ai.fouryi.baseUrl),
    timeout: config.ai.fouryi.timeout,
  }
  const anthropicBaseUrl = fourYiApiBaseUrl(config.ai.fouryi.baseUrl).replace(/\/v1$/, '/anthropic')
  config.ai.anthropic = { apiKey: config.ai.fouryi.apiKey, baseUrl: anthropicBaseUrl }
  config.agent.apiKey = config.ai.fouryi.apiKey
  config.agent.baseUrl = `${anthropicBaseUrl}/v1/messages`
}
