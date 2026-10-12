import type OpenAI from 'openai'
import { GenerateContentParameters, GenerateContentResponse } from '@google/genai'
import { z } from 'zod'

const partSchema = z.object({
  text: z.string().optional(),
  inlineData: z.object({ mimeType: z.string(), data: z.string() }).optional(),
  fileData: z.object({ mimeType: z.string().optional(), fileUri: z.string() }).optional(),
}).strict()
const contentSchema = z.object({ role: z.enum(['user', 'model']).optional(), parts: z.array(partSchema) })

export function toFourYiChatRequest(params: GenerateContentParameters): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  const contents = z.union([z.string(), contentSchema, z.array(z.union([z.string(), contentSchema, partSchema]))]).parse(params.contents)
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = []
  if (params.config?.tools?.length)
    throw new Error('4YI Gemini compatibility does not support native Gemini tools')
  if (params.config?.systemInstruction) {
    const instruction = params.config.systemInstruction
    if (typeof instruction !== 'string')
      throw new Error('4YI system instruction must be text')
    messages.push({ role: 'system', content: instruction })
  }
  for (const item of Array.isArray(contents) ? contents : [contents]) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item })
      continue
    }
    const parts = 'parts' in item ? item.parts : [item]
    const content = parts.map((part) => {
      if (part.text !== undefined)
        return { type: 'text', text: part.text }
      const mime = part.inlineData?.mimeType ?? part.fileData?.mimeType ?? ''
      const url = part.inlineData ? `data:${mime};base64,${part.inlineData.data}` : part.fileData?.fileUri
      if (mime.startsWith('image/'))
        return { type: 'image_url', image_url: { url } }
      if (mime.startsWith('video/'))
        return { type: 'video_url', video_url: { url } }
      if (part.inlineData && (mime === 'audio/wav' || mime === 'audio/mp3' || mime === 'audio/mpeg'))
        return { type: 'input_audio', input_audio: { data: part.inlineData.data, format: mime === 'audio/wav' ? 'wav' : 'mp3' } }
      throw new Error('Unsupported Gemini media part for the 4YI chat endpoint')
    })
    // video_url is the gateway's multimodal extension to Chat Completions.
    messages.push({ role: 'role' in item && item.role === 'model' ? 'assistant' : 'user', content } as OpenAI.Chat.ChatCompletionMessageParam)
  }
  return {
    model: params.model,
    messages,
    stream: false,
    temperature: params.config?.temperature,
    top_p: params.config?.topP,
    max_tokens: params.config?.maxOutputTokens,
    stop: params.config?.stopSequences,
    response_format: params.config?.responseMimeType === 'application/json' ? { type: 'json_object' } : undefined,
  }
}

export function toGeminiResponse(result: OpenAI.Chat.ChatCompletion): GenerateContentResponse {
  return Object.assign(new GenerateContentResponse(), {
    candidates: [{ content: { role: 'model', parts: [{ text: result.choices[0]?.message.content ?? '' }] } }],
    usageMetadata: {
      promptTokenCount: result.usage?.prompt_tokens,
      candidatesTokenCount: result.usage?.completion_tokens,
      totalTokenCount: result.usage?.total_tokens,
      cachedContentTokenCount: result.usage?.prompt_tokens_details?.cached_tokens,
    },
  })
}
