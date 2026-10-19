import { afterEach, describe, expect, it, vi } from 'vitest'
import { config } from '../../../config'
import { ImageService } from './image.service'

describe('company Wan image generation', () => {
  const original = config.ai.fouryi.apiKey
  afterEach(() => { config.ai.fouryi.apiKey = original })
  function setup() {
    const openai = { createImageGeneration: vi.fn().mockResolvedValue({ data: [] }) }
    const service = new ImageService({} as never, openai as never, {} as never, {} as never, { config: { image: { generation: [], edit: [] } } } as never, {} as never)
    const edit = vi.spyOn(service, 'edit').mockResolvedValue({ list: [] } as never)
    return { service, openai, edit }
  }
  it('routes a text-only Wan request through one neutral reference without changing the selected model', async () => {
    config.ai.fouryi.apiKey = 'unit-test-gateway'
    const { service, openai, edit } = setup()
    await service.generation({ user: 'user', model: 'alibaba/wan2.6-image', prompt: 'Coffee', n: 1, size: '1024x1024' })
    expect(edit).toHaveBeenCalledOnce()
    expect(openai.createImageGeneration).not.toHaveBeenCalled()
    const input = edit.mock.calls[0][0]
    expect(input.model).toBe('alibaba/wan2.6-image')
    expect(input.prompt).toBe('Coffee')
    expect(input.n).toBe(1)
    const reference = Buffer.from((input.image as string).split(',')[1], 'base64')
    expect(reference.subarray(1, 4).toString()).toBe('PNG')
    expect(reference.readUInt32BE(16)).toBe(1024)
    expect(reference.readUInt32BE(20)).toBe(1024)
  })
  it('keeps other models on their normal image generation route', async () => {
    config.ai.fouryi.apiKey = 'unit-test-gateway'
    const { service, openai, edit } = setup()
    await service.generation({ user: 'user', model: 'other-image', prompt: 'Coffee', n: 1 })
    expect(openai.createImageGeneration).toHaveBeenCalledOnce()
    expect(edit).not.toHaveBeenCalled()
  })
})
