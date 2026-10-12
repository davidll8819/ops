import { UserType } from '@yikart/common'
import { AiLogChannel, AiLogStatus } from '@yikart/mongodb'
import { vi } from 'vitest'
import { TaskStatus } from '../../../../common'
import { config } from '../../../../config'
import { loadFourYiModels, toFourYiVideoModel } from '../../libs/fouryi/fouryi-models.util'
import { FourYiVideoService } from './fouryi-video.service'

describe('fourYiVideoService', () => {
  const originalApiKey = config.ai.fouryi.apiKey
  const fetchMock = vi.fn()
  const aiLogRepo = { create: vi.fn(), updateByIdAndStatus: vi.fn() }
  const assetsService = { uploadFromUrl: vi.fn(), uploadFromBuffer: vi.fn() }
  const storageProvider = { parsePathFromUrl: vi.fn((url: string) => url), toPresignedUrl: vi.fn(async (url: string) => url) }
  const aiAvailability = { recordAsyncComplete: vi.fn() }
  let service: FourYiVideoService

  beforeEach(() => {
    config.ai.fouryi.apiKey = 'test-key'
    fetchMock.mockReset()
    vi.clearAllMocks()
    aiLogRepo.create.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    service = new FourYiVideoService(aiLogRepo as never, assetsService as never, storageProvider as never, aiAvailability as never)
  })

  afterAll(() => {
    config.ai.fouryi.apiKey = originalApiKey
    vi.unstubAllGlobals()
  })

  it('loads all models from the authenticated 4yi model endpoint', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'seedance-2.0', description: 'Seedance', modes: ['text_to_video', 'image_to_video'] }] })))

    const models = (await loadFourYiModels(config.ai.fouryi)).map(toFourYiVideoModel)

    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/models$/), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
    }))
    expect(models).toEqual([expect.objectContaining({
      name: 'seedance-2.0',
      channel: AiLogChannel.FourYi,
      modes: ['text2video', 'image2video'],
    })])
  })

  it('submits text and reference video jobs using 4yi request fields', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'remote-1' })))
    aiLogRepo.create.mockResolvedValue({ id: 'local-1' })
    storageProvider.parsePathFromUrl.mockReturnValue('https://cdn.example/reference.png')

    const result = await service.createFromRequest({
      userId: 'user-1',
      userType: UserType.User,
      model: 'seedance-2.0',
      prompt: 'A moving shot',
      image: 'https://cdn.example/reference.png',
      duration: 6,
      mode: 'multi-ref',
    } as never)

    expect(result).toEqual({ id: 'local-1' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'seedance-2.0',
      prompt: 'A moving shot',
      mode: 'image_to_video',
      duration_seconds: 6,
      response_format: 'url',
      extra_body: { reference_images: ['https://cdn.example/reference.png'] },
    })
  })

  it('uses the documented image_to_video mode for R2V models', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'remote-r2v' })))
    aiLogRepo.create.mockResolvedValue({ id: 'local-r2v' })
    await service.createFromRequest({ userId: 'user-1', userType: UserType.User, model: 'happyhorse-1.1-r2v', prompt: 'A scene', images: ['https://cdn.example/image.png'] })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).mode).toBe('image_to_video')
  })

  it('requires an image for reference-only models', async () => {
    await expect(service.createFromRequest({ userId: 'user-1', userType: UserType.User, model: 'happyhorse-1.1-r2v', prompt: 'A scene' })).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not silently discard unsupported video and audio references', async () => {
    await expect(service.createFromRequest({ userId: 'user-1', userType: UserType.User, model: 'seedance-2.0', prompt: 'A scene', videos: ['https://cdn.example/video.mp4'] })).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not expose upstream error bodies or the API key', async () => {
    fetchMock.mockResolvedValue(new Response('echo test-key', { status: 401 }))
    try {
      await service.createFromRequest({ userId: 'user-1', userType: UserType.User, model: 'seedance-2.0', prompt: 'A scene' })
      throw new Error('Expected request to fail')
    }
    catch (error) {
      expect(String(error)).not.toContain('test-key')
    }
  })

  const task = () => ({ id: 'local-1', taskId: 'remote-1', userId: 'user-1', model: 'seedance-2.0', status: AiLogStatus.Generating, startedAt: new Date(), channel: AiLogChannel.FourYi })

  it('saves successful videos and prefers the persisted asset over expiring upstream URLs', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'completed', video_url: 'https://upstream.example/video.mp4' })))
    assetsService.uploadFromUrl.mockResolvedValue({ asset: { path: 'saved/video.mp4' } })
    aiLogRepo.updateByIdAndStatus.mockResolvedValue({ id: 'local-1' })
    await service.poll(task() as never)
    const update = aiLogRepo.updateByIdAndStatus.mock.calls[0][2].$set
    expect(update.status).toBe(AiLogStatus.Success)
    expect(service.getTaskResult(update.response).videoUrl).toBe('saved/video.mp4')
    expect(aiAvailability.recordAsyncComplete).toHaveBeenCalledOnce()
  })

  it('downloads the authenticated artifact when completion has no URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed' })))
      .mockResolvedValueOnce(new Response('video bytes', { headers: { 'content-type': 'video/mp4' } }))
    assetsService.uploadFromBuffer.mockResolvedValue({ asset: { path: 'saved/artifact.mp4' } })
    await service.poll(task() as never)
    expect(fetchMock.mock.calls[1][0]).toMatch(/remote-1\/artifact$/)
    expect(assetsService.uploadFromBuffer).toHaveBeenCalledOnce()
  })

  it('authenticates a gateway artifact URL returned as video_url', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'completed', video_url: `${config.ai.fouryi.baseUrl}/api/v1/videos/generations/remote-1/artifact` })))
      .mockResolvedValueOnce(new Response('video bytes', { headers: { 'content-type': 'video/mp4' } }))
    assetsService.uploadFromBuffer.mockResolvedValue({ asset: { path: 'saved/artifact.mp4' } })
    await service.poll(task() as never)
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer test-key')
    expect(assetsService.uploadFromUrl).not.toHaveBeenCalled()
    expect(assetsService.uploadFromBuffer).toHaveBeenCalledOnce()
    expect(aiLogRepo.updateByIdAndStatus.mock.calls[0][2].$set.status).toBe(AiLogStatus.Success)
  })

  it('records failures without downloading an artifact', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: 'failed', error: { message: 'Provider failed' } })))
    await service.poll(task() as never)
    expect(aiLogRepo.updateByIdAndStatus.mock.calls[0][2].$set.status).toBe(AiLogStatus.Failed)
    expect(assetsService.uploadFromUrl).not.toHaveBeenCalled()
    expect(service.getTaskResult({ status: 'failed', error: { message: 'Provider failed' } })).toMatchObject({ status: TaskStatus.Failure, error: { message: 'Provider failed' } })
  })

  it('keeps pending and transient polling failures retryable', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'processing' }))).mockRejectedValueOnce(new Error('timeout'))
    await service.poll(task() as never)
    await service.poll(task() as never)
    expect(aiLogRepo.updateByIdAndStatus).not.toHaveBeenCalled()
  })
})
