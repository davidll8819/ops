import type { AppConfig } from '../../../../config'
import { AiLogChannel } from '@yikart/mongodb'
import { z } from 'zod'
import { fourYiApiBaseUrl } from './fouryi.config'

const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  type: z.string().optional(),
  model_type: z.string().optional(),
  video_image_input: z.boolean().optional(),
  video_image_mode: z.string().optional(),
  output_modalities: z.array(z.string()).optional(),
  modes: z.array(z.string()).optional(),
  supported_modes: z.array(z.string()).optional(),
  resolutions: z.array(z.string()).default([]),
  durations: z.array(z.number()).default([]),
  aspect_ratios: z.array(z.string()).default([]),
  max_input_images: z.number().int().nonnegative().optional(),
})

export type FourYiModel = z.infer<typeof modelSchema>

export enum FourYiModelKind {
  Chat = 'chat',
  Image = 'image',
  Video = 'video',
}

export function getFourYiModelKind(model: FourYiModel): FourYiModelKind | undefined {
  const kind = model.type ?? model.model_type
  if (kind === 'video' || model.output_modalities?.includes('video'))
    return FourYiModelKind.Video
  if (kind === 'image' || model.output_modalities?.includes('image'))
    return FourYiModelKind.Image
  if (kind === 'chat' || kind === 'text' || model.output_modalities?.includes('text'))
    return FourYiModelKind.Chat
  // The OpenAI model list may omit modalities. These are 4YI's published families.
  if (/^(?:seedance|wan-|wan.*(?:video|t2v|i2v|r2v)|happyhorse|hailuo|grok.*video)/i.test(model.id))
    return FourYiModelKind.Video
  if (/image|(?:^|\/)wan.*t2i/i.test(model.id))
    return FourYiModelKind.Image
  if (/^(?:claude|gpt|gemini|deepseek|glm|qwen|minimax|moonshotai|grok)/i.test(model.id))
    return FourYiModelKind.Chat
  return undefined
}

export async function loadFourYiModels(settings: AppConfig['ai']['fouryi']): Promise<FourYiModel[]> {
  const response = await fetch(`${fourYiApiBaseUrl(settings.baseUrl)}/models`, {
    headers: { Authorization: `Bearer ${settings.apiKey}` },
    signal: AbortSignal.timeout(settings.timeout),
    redirect: 'error',
  })
  if (!response.ok)
    throw new Error(`4YI model discovery failed (HTTP ${response.status})`)
  return z.object({ data: z.array(modelSchema) }).parse(await response.json()).data
}

export function toFourYiVideoModel(model: FourYiModel): AppConfig['ai']['models']['video']['generation'][number] {
  const modeMap: Record<string, 'text2video' | 'image2video' | 'multi-image2video'> = {
    'text_to_video': 'text2video',
    'image_to_video': 'image2video',
    'reference_to_video': 'multi-image2video',
    'text2video': 'text2video',
    'image2video': 'image2video',
    'multi-image2video': 'multi-image2video',
  }
  const modes = (model.modes ?? model.supported_modes ?? []).flatMap(mode => modeMap[mode] ? [modeMap[mode]] : [])
  if (!modes.length) {
    if (model.video_image_input === false || model.id.endsWith('-t2v'))
      modes.push('text2video')
    else if (model.id.endsWith('-r2v'))
      modes.push('multi-image2video')
    else if (model.id.endsWith('-i2v'))
      modes.push('image2video')
    else
      modes.push('text2video', model.video_image_mode === 'reference_images' ? 'multi-image2video' : 'image2video')
  }
  return {
    name: model.id,
    description: model.description ?? model.name ?? model.id,
    channel: AiLogChannel.FourYi,
    tags: [],
    modes,
    resolutions: model.resolutions,
    durations: model.durations,
    aspectRatios: model.aspect_ratios,
    maxInputImages: model.video_image_input === false ? 0 : model.max_input_images ?? 1,
    defaults: {},
  }
}

export function applyFourYiModels(config: AppConfig, models: FourYiModel[]): void {
  const chat = models.filter(model => getFourYiModelKind(model) === FourYiModelKind.Chat)
  const images = models.filter(model => getFourYiModelKind(model) === FourYiModelKind.Image)
  config.ai.models.chat = chat.map(model => ({
    name: model.id,
    description: model.description ?? model.name ?? model.id,
    channel: AiLogChannel.FourYi,
    tags: [],
    scenes: ['web', 'comment', 'plugin', 'draft-generation'],
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
  }))
  config.ai.models.image = {
    generation: images.map(model => ({ name: model.id, description: model.description ?? model.name ?? model.id, tags: [], sizes: ['1024x1024'], qualities: [], styles: [] })),
    edit: images.filter(model => /^(?:gemini-|(?:openai\/)?gpt-)/.test(model.id) || model.modes?.includes('image_to_image')).map(model => ({ name: model.id, description: model.description ?? model.name ?? model.id, tags: [], sizes: ['1024x1024'], maxInputImages: model.max_input_images ?? 1 })),
  }
  config.ai.models.video.generation = models.filter(model => getFourYiModelKind(model) === FourYiModelKind.Video).map(toFourYiVideoModel)
  config.ai.draftGeneration.imageModels = images.map(model => ({
    model: model.id,
    displayName: model.description ?? model.name ?? model.id,
    tags: [],
    supportedAspectRatios: model.aspect_ratios.length ? model.aspect_ratios : ['1:1'],
    maxInputImages: model.max_input_images ?? 1,
    pricing: [{ resolution: '1K' }],
  }))
  if (!chat.some(model => model.id === config.ai.draftGeneration.planner.defaultModel) && chat[0])
    config.ai.draftGeneration.planner.defaultModel = chat[0].id

  const agentModels = chat.filter(model => model.id.startsWith('claude-')).map(model => model.id)
  config.agent.models = agentModels
  if (agentModels.length) {
    if (!agentModels.includes(config.agent.defaultModel))
      config.agent.defaultModel = agentModels[0]
    if (!agentModels.includes(config.agent.backgroundModel))
      config.agent.backgroundModel = agentModels.find(model => model.includes('haiku')) ?? config.agent.defaultModel
    if (!agentModels.includes(config.agent.thinkModel))
      config.agent.thinkModel = config.agent.defaultModel
  }
}
