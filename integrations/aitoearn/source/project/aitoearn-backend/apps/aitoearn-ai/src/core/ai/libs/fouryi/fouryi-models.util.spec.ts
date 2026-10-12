import { describe, expect, it, vi } from 'vitest'
import { config } from '../../../../config'
import { applyFourYiModels, loadFourYiModels, toFourYiVideoModel } from './fouryi-models.util'
import { applyFourYiRouting, fourYiApiBaseUrl } from './fouryi.config'

const catalog = [
  { id: 'claude-opus-4-6', type: 'chat', resolutions: [], durations: [], aspect_ratios: [] },
  { id: 'gemini-3.5-flash', type: 'chat', resolutions: [], durations: [], aspect_ratios: [] },
  { id: 'gemini-3-pro-image', type: 'image', resolutions: [], durations: [], aspect_ratios: [] },
  { id: 'grok-imagine-video', type: 'video', modes: ['text_to_video', 'image_to_video'], resolutions: ['720p'], durations: [6], aspect_ratios: ['16:9'] },
]

describe('4YI company routing', () => {
  it('normalizes both a site URL and an API base URL', () => {
    expect(fourYiApiBaseUrl('https://app.4yi.ai/')).toBe('https://app.4yi.ai/api/v1')
    expect(fourYiApiBaseUrl('https://app.4yi.ai/api/v1/')).toBe('https://app.4yi.ai/api/v1')
  })

  it('routes chat, images and Agent through the company credentials', () => {
    const settings = structuredClone(config)
    settings.ai.fouryi = { baseUrl: 'https://company.example/api/v1/', apiKey: 'test-company-key', timeout: 12000 }
    applyFourYiRouting(settings)
    expect(settings.ai.openai).toEqual({ baseUrl: 'https://company.example/api/v1', apiKey: 'test-company-key', timeout: 12000 })
    expect(settings.ai.anthropic.baseUrl).toBe('https://company.example/api/anthropic')
    expect(settings.agent.baseUrl).toBe('https://company.example/api/anthropic/v1/messages')
    expect(settings.agent.apiKey).toBe('test-company-key')
    expect(settings.enableConfigLogging).toBe(false)
  })

  it('preserves existing providers when 4YI is not configured', () => {
    const settings = structuredClone(config)
    settings.ai.fouryi.apiKey = ''
    const before = structuredClone(settings)
    applyFourYiRouting(settings)
    expect(settings).toEqual(before)
  })

  it('replaces all catalogs, including same-name legacy videos and draft models', () => {
    const settings = structuredClone(config)
    applyFourYiModels(settings, catalog)
    expect(settings.ai.models.chat.map(model => model.name)).toEqual(['claude-opus-4-6', 'gemini-3.5-flash'])
    expect(settings.ai.models.image.generation.map(model => model.name)).toEqual(['gemini-3-pro-image'])
    expect(settings.ai.models.video.generation).toEqual([expect.objectContaining({ name: 'grok-imagine-video', channel: '4yi', modes: ['text2video', 'image2video'] })])
    expect(settings.ai.draftGeneration.imageModels.map(model => model.model)).toEqual(['gemini-3-pro-image'])
    expect(settings.agent.models).toEqual(['claude-opus-4-6'])
    expect(settings.agent.backgroundModel).toBe('claude-opus-4-6')
  })

  it('uses gateway image-input metadata when advertising video modes', () => {
    const base = { resolutions: [], durations: [], aspect_ratios: [] }
    expect(toFourYiVideoModel({ ...base, id: 'hailuo-2.3', video_image_input: false }).modes).toEqual(['text2video'])
    expect(toFourYiVideoModel({ ...base, id: 'wan3.0-video', video_image_input: true, video_image_mode: 'reference_images' }).modes).toEqual(['text2video', 'multi-image2video'])
    expect(toFourYiVideoModel({ ...base, id: 'happyhorse-1.1-i2v', video_image_input: true }).modes).toEqual(['image2video'])
  })

  it('never falls back to legacy models when gateway discovery fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('secret upstream details', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(loadFourYiModels(config.ai.fouryi)).rejects.toThrow('HTTP 401')
      expect(fetchMock.mock.calls[0][1].redirect).toBe('error')
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
