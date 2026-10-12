import type OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { toFourYiChatRequest, toGeminiResponse } from './fouryi-gemini.util'

describe('4YI Gemini compatibility', () => {
  it('preserves conversation roles, image/video/audio inputs and JSON output', () => {
    const request = toFourYiChatRequest({ model: 'gemini-3.5-flash', contents: [
      { role: 'user', parts: [{ text: 'Analyze' }, { inlineData: { mimeType: 'image/png', data: 'image' } }, { fileData: { mimeType: 'video/mp4', fileUri: 'https://example.com/video.mp4' } }, { inlineData: { mimeType: 'audio/mp3', data: 'audio' } }] },
      { role: 'model', parts: [{ text: 'Previous response' }] },
    ], config: { systemInstruction: 'Be brief', responseMimeType: 'application/json', maxOutputTokens: 50 } })
    expect(request.messages).toEqual([
      { role: 'system', content: 'Be brief' },
      { role: 'user', content: [{ type: 'text', text: 'Analyze' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,image' } }, { type: 'video_url', video_url: { url: 'https://example.com/video.mp4' } }, { type: 'input_audio', input_audio: { data: 'audio', format: 'mp3' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Previous response' }] },
    ])
    expect(request.response_format).toEqual({ type: 'json_object' })
    expect(request.max_tokens).toBe(50)
  })

  it('retains Gemini text getters and usage for existing tools', () => {
    const result = toGeminiResponse({ choices: [{ message: { content: 'A result' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } as OpenAI.Chat.ChatCompletion)
    expect(result.text).toBe('A result')
    expect(result.usageMetadata?.totalTokenCount).toBe(15)
  })

  it('rejects unsupported native tools instead of contacting another provider', () => {
    expect(() => toFourYiChatRequest({ model: 'gemini-3.5-flash', contents: 'Hello', config: { tools: [{ googleSearch: {} }] } })).toThrow('native Gemini tools')
  })
})
