import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../../../../config'
import { GeminiService } from '../gemini/gemini.service'
import { OpenaiService } from '../openai/openai.service'
import { applyFourYiRouting } from './fouryi.config'

// Exercise the real SDK serialization against a fake HTTP transport.
describe('4YI SDK transport', () => {
  const originalKey = config.ai.fouryi.apiKey
  const requests: Request[] = []
  let openai: OpenaiService
  let responseBody: unknown
  let streamResponse = false
  const availability = { execute: vi.fn(async (_context, run: () => Promise<unknown>) => run()) }

  beforeEach(() => {
    requests.length = 0
    streamResponse = false
    config.ai.fouryi.apiKey = 'company-test-key'
    const settings = structuredClone(config)
    settings.ai.fouryi.baseUrl = 'https://gateway.example'
    applyFourYiRouting(settings)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.url === 'data:,')
        return new Response()
      requests.push(request)
      if (streamResponse)
        return new Response('data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"glm-5.2","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      return new Response(JSON.stringify(responseBody), { headers: { 'content-type': 'application/json' } })
    }))
    openai = new OpenaiService(settings.ai.openai, availability as never)
  })

  afterEach(() => {
    config.ai.fouryi.apiKey = originalKey
    vi.unstubAllGlobals()
  })

  it('sends non-stream chat with company auth and an idempotency key', async () => {
    responseBody = { id: 'chat-1', choices: [{ message: { role: 'assistant', content: 'hello' } }] }
    await openai.createRawCompletion({ model: 'glm-5.2', messages: [{ role: 'user', content: 'Hello' }] })
    expect(requests[0].url).toBe('https://gateway.example/api/v1/chat/completions')
    expect(requests[0].headers.get('authorization')).toBe('Bearer company-test-key')
    expect(requests[0].headers.get('idempotency-key')).toBeTruthy()
    expect((await requests[0].json()).model).toBe('glm-5.2')
  })

  it('streams Chat Completions through the same gateway', async () => {
    streamResponse = true
    const stream = await openai.createRawStream({ model: 'glm-5.2', messages: [{ role: 'user', content: 'Hello' }], stream: true })
    const chunks = []
    for await (const chunk of stream)
      chunks.push(chunk)
    expect(requests[0].url).toBe('https://gateway.example/api/v1/chat/completions')
    expect(chunks[0].choices[0].delta.content).toBe('hello')
  })

  it('serializes image generation and multipart edits for 4YI', async () => {
    responseBody = { created: 1, data: [{ b64_json: 'aW1hZ2U=' }] }
    await openai.createImageGeneration({ model: 'openai/gpt-image-2', prompt: 'A square', size: '1024x1024' })
    await openai.createImageEdit({ model: 'gemini-3-pro-image', prompt: 'Make it blue', image: new File(['image'], 'reference.png', { type: 'image/png' }) })
    expect(requests.map(request => request.url)).toEqual(['https://gateway.example/api/v1/images/generations', 'https://gateway.example/api/v1/images/edits'])
    expect((await requests[0].json()).model).toBe('openai/gpt-image-2')
    expect(requests[1].headers.get('content-type')).toContain('multipart/form-data')
    const form = await requests[1].formData()
    expect(form.get('model')).toBe('gemini-3-pro-image')
    expect(form.get('image')).toBeInstanceOf(File)
  })

  it('routes existing Gemini tools through OpenAI and retains Gemini response accessors', async () => {
    responseBody = { id: 'chat-1', choices: [{ message: { role: 'assistant', content: '{"summary":"ok"}' } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }
    const gemini = new GeminiService({ apiKey: 'unused', baseUrl: 'https://unused.example' }, availability as never, undefined, openai)
    const result = await gemini.generateContent({ model: 'gemini-3.5-flash', contents: [{ role: 'user', parts: [{ text: 'Summarize' }] }] })
    expect(requests[0].url).toBe('https://gateway.example/api/v1/chat/completions')
    expect(result.text).toBe('{"summary":"ok"}')
    responseBody = { created: 1, data: [{ b64_json: 'aW1hZ2U=' }] }
    const images = await gemini.generateImage({ prompt: 'A square', model: 'gemini-3-pro-image-preview' })
    expect(requests[1].url).toBe('https://gateway.example/api/v1/images/generations')
    expect((await requests[1].json()).model).toBe('gemini-3-pro-image')
    expect(images.images[0].imageData.toString()).toBe('image')
  })
})
