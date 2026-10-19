import type { AiAvailabilityService } from '../../ai-availability'
import { Logger } from '@nestjs/common'
import { FileUtil, UserType } from '@yikart/common'
import { AiLogStatus } from '@yikart/mongodb'
import { vi } from 'vitest'
import { config } from '../../../config'
import { ImageService } from '../../ai/image'
import { GrokVideoService, OpenAIVideoService } from '../../ai/video'
import { MediaMcp, MediaToolName } from './media.mcp'

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return { ...original, createSdkMcpServer: vi.fn(options => options) }
})

describe('mediaMcp', () => {
  let mediaMcp: MediaMcp
  let mockLogger: Logger
  let mockOpenaiVideoService: vi.Mocked<OpenAIVideoService>
  let mockImageService: vi.Mocked<ImageService>
  let mockAiAvailability: vi.Mocked<Pick<AiAvailabilityService, 'execute'>>
  let mockGrokVideoService: vi.Mocked<GrokVideoService>

  let taskRepository: { updateMediaRequestByIdAndUserId: ReturnType<typeof vi.fn>, getByUserIdAndId: ReturnType<typeof vi.fn> }
  const userId = 'test-user-id'
  const userType = UserType.User

  beforeEach(() => {
    const unresolved = new Set<string>()
    taskRepository = { getByUserIdAndId: vi.fn().mockResolvedValue({}), updateMediaRequestByIdAndUserId: vi.fn(async (task, user, kind, pending) => { const key = task + user + kind; if (pending && unresolved.has(key)) return false; if (pending) unresolved.add(key); else unresolved.delete(key); return true }) }
    FileUtil.init({ endpoint: 'https://cdn.example.com' })
    mockLogger = {
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    } as unknown as Logger

    mockOpenaiVideoService = {
      createVideo: vi.fn(),
      getVideo: vi.fn(),
      createCharacter: vi.fn(),
      getCharacter: vi.fn(),
    } as unknown as vi.Mocked<OpenAIVideoService>

    mockImageService = {
      userGeminiGeneration: vi.fn(),
    } as unknown as vi.Mocked<ImageService>

    mockAiAvailability = {
      execute: vi.fn().mockImplementation((_ctx: unknown, fn: () => unknown) => (fn as () => Promise<unknown>)()),
    } as unknown as vi.Mocked<Pick<AiAvailabilityService, 'execute'>>

    mockGrokVideoService = {} as vi.Mocked<GrokVideoService>

    mediaMcp = new MediaMcp(
      mockOpenaiVideoService,
      mockImageService,
      mockAiAvailability as unknown as AiAvailabilityService,
      mockGrokVideoService,
      {} as never,
      taskRepository as never,
    )
    // Override the logger for testing
    Object.defineProperty(mediaMcp, 'logger', { value: mockLogger })
  })

  it('enforces the saved user format even when the agent requests another size', async () => {
    taskRepository.getByUserIdAndId.mockResolvedValue({ videoFormat: { ratio: '9:16', resolution: '720p' } })
    const videos = { userVideoGeneration: vi.fn().mockResolvedValue({ id: 'video-1' }) }
    const company = new MediaMcp(mockOpenaiVideoService, mockImageService, mockAiAvailability as never, mockGrokVideoService, videos as never, taskRepository as never)
    await company.createFourYiVideoTool(userId, userType, 'task-1').handler({ model: 'fixture', prompt: 'Coffee', ratio: '16:9', resolution: '1080p' }, {})
    expect(videos.userVideoGeneration).toHaveBeenCalledWith(expect.objectContaining({ ratio: '9:16', resolution: '720p' }))
    expect(taskRepository.getByUserIdAndId).toHaveBeenCalledWith(userId, 'task-1')
  })

  describe('createGenerateImageTool', () => {
    it('should have correct tool name', () => {
      const tool = mediaMcp.createGenerateImageTool(userId, userType)
      expect(tool.name).toBe(MediaToolName.GenerateImage)
    })

    it('should call imageService.userGeminiGeneration with correct params', async () => {
      mockImageService.userGeminiGeneration.mockResolvedValue({
        usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
        images: [{ url: 'https://example.com/image1.png', data: '', mimeType: 'image/png' }],
      })

      const tool = mediaMcp.createGenerateImageTool(userId, userType)
      await tool.handler({
        prompt: 'A cute cat',
        imageUrls: ['https://example.com/ref.png'],
        imageSize: '2K',
        aspectRatio: '16:9',
      } as never, {})

      expect(mockImageService.userGeminiGeneration).toHaveBeenCalledWith({
        userId,
        userType,
        prompt: 'A cute cat',
        imageUrls: ['https://example.com/ref.png'],
        imageSize: '2K',
        aspectRatio: '16:9',
      })
    })

    it('should pass selected gemini image model when provided', async () => {
      mockImageService.userGeminiGeneration.mockResolvedValue({
        usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
        images: [{ url: 'https://example.com/image1.png', data: '', mimeType: 'image/png' }],
      })

      const tool = mediaMcp.createGenerateImageTool(userId, userType)
      await tool.handler({
        prompt: 'A cute cat',
        model: 'gemini-3-pro-image-preview',
      } as never, {})

      expect(mockImageService.userGeminiGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gemini-3-pro-image-preview',
        }),
      )
    })

    it('should return generated image URLs', async () => {
      mockImageService.userGeminiGeneration.mockResolvedValue({
        usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
        images: [
          { url: 'image1.png', data: '', mimeType: 'image/png' },
          { url: 'image2.png', data: '', mimeType: 'image/png' },
        ],
      })

      const tool = mediaMcp.createGenerateImageTool(userId, userType)
      const result = await tool.handler({
        prompt: 'A cute cat',
        imageUrls: [],
        imageSize: undefined,
        aspectRatio: undefined,
      } as never, {})

      expect(result.isError).toBeUndefined()
      expect(result.content).toBeDefined()
      expect(result.content.length).toBeGreaterThan(0)

      // Should contain resource_link entries
      const resourceLinks = result.content.filter(c => c.type === 'resource_link')
      expect(resourceLinks.length).toBe(2)
    })

    it('should use default empty array for imageUrls when not provided', async () => {
      mockImageService.userGeminiGeneration.mockResolvedValue({
        usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
        images: [{ url: 'image.png', data: '', mimeType: 'image/png' }],
      })

      const tool = mediaMcp.createGenerateImageTool(userId, userType)
      await tool.handler({
        prompt: 'A cute cat',
        imageUrls: [],
        imageSize: undefined,
        aspectRatio: undefined,
      } as never, {})

      expect(mockImageService.userGeminiGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          imageUrls: [],
        }),
      )
    })
  })

  describe('createGenerateVideoTool', () => {
    it('should have correct tool name', () => {
      const tool = mediaMcp.createGenerateVideoTool(userId, userType)
      expect(tool.name).toBe(MediaToolName.GenerateVideo)
    })

    it('should call openaiVideoService.createVideo with correct params', async () => {
      mockOpenaiVideoService.createVideo.mockResolvedValue({
        id: 'task-123',
        status: 'in_progress',
      } as never)

      const tool = mediaMcp.createGenerateVideoTool(userId, userType)
      await tool.handler({
        prompt: 'A cat walking',
        model: 'sora-2',
        input_reference: undefined,
        seconds: undefined,
        size: undefined,
      } as never, {})

      expect(mockOpenaiVideoService.createVideo).toHaveBeenCalledWith({
        userId,
        userType,
        prompt: 'A cat walking',
        input_reference: undefined,
        model: 'sora-2',
        seconds: '10',
        size: '720x1280',
      })
    })

    it('should use sora-2-pro defaults when model is sora-2-pro', async () => {
      mockOpenaiVideoService.createVideo.mockResolvedValue({
        id: 'task-123',
        status: 'in_progress',
      } as never)

      const tool = mediaMcp.createGenerateVideoTool(userId, userType)
      await tool.handler({
        prompt: 'A cat walking',
        model: 'sora-2-pro',
        input_reference: undefined,
        seconds: undefined,
        size: undefined,
      } as never, {})

      expect(mockOpenaiVideoService.createVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          seconds: '25',
          size: '1024x1792',
        }),
      )
    })

    it('should return success result with task id', async () => {
      mockOpenaiVideoService.createVideo.mockResolvedValue({
        id: 'task-123',
        status: 'in_progress',
      } as never)

      const tool = mediaMcp.createGenerateVideoTool(userId, userType)
      const result = await tool.handler({
        prompt: 'A cat walking',
        model: 'sora-2',
        input_reference: undefined,
        seconds: undefined,
        size: undefined,
      } as never, {})

      expect(result.isError).toBeUndefined()
      const textContent = result.content[0] as { type: 'text', text: string }
      expect(textContent.text).toContain('task-123')
    })

    it('should return error result when video generation fails', async () => {
      mockOpenaiVideoService.createVideo.mockResolvedValue({
        id: 'task-123',
        status: AiLogStatus.Failed,
        error: { code: 'policy_violation', message: 'Content policy violation' },
      } as never)

      const tool = mediaMcp.createGenerateVideoTool(userId, userType)
      const result = await tool.handler({
        prompt: 'A cat walking',
        model: 'sora-2',
        input_reference: undefined,
        seconds: undefined,
        size: undefined,
      } as never, {})

      expect(result.isError).toBe(true)
      const textContent = result.content[0] as { type: 'text', text: string }
      expect(textContent.text).toContain('Failed')
    })
  })

  describe('createGetVideoStatusTool', () => {
    it('should have correct tool name', () => {
      const tool = mediaMcp.createGetVideoStatusTool(userId, userType)
      expect(tool.name).toBe(MediaToolName.GetVideoStatus)
    })

    it('should return completed status with video URL', async () => {
      mockOpenaiVideoService.getVideo.mockResolvedValue({
        id: 'task-123',
        object: 'video',
        model: 'sora-2',
        prompt: 'test',
        status: 'completed',
        url: 'video.mp4',
        progress: 100,
        created_at: Math.floor(Date.now() / 1000) - 60,
        completed_at: Math.floor(Date.now() / 1000),
        expires_at: null,
        error: null,
        remixed_from_video_id: null,
        seconds: '10',
        size: '720x1280',
      })

      const tool = mediaMcp.createGetVideoStatusTool(userId, userType)
      const result = await tool.handler({ taskId: 'task-123' }, {})

      expect(result.isError).toBeUndefined()
      const textContent = result.content[0] as { type: 'text', text: string }
      expect(textContent.text).toContain('completed')
      expect(textContent.text).toContain('video.mp4')
    })

    it('should return failed status with error message', async () => {
      mockOpenaiVideoService.getVideo.mockResolvedValue({
        id: 'task-123',
        object: 'video',
        model: 'sora-2',
        prompt: 'test',
        status: 'failed',
        progress: 0,
        error: { code: 'error', message: 'Processing error' },
        created_at: Math.floor(Date.now() / 1000) - 60,
        completed_at: null,
        expires_at: null,
        remixed_from_video_id: null,
        seconds: '10',
        size: '720x1280',
      })

      const tool = mediaMcp.createGetVideoStatusTool(userId, userType)
      const result = await tool.handler({ taskId: 'task-123' }, {})

      expect(result.isError).toBe(true)
      const textContent = result.content[0] as { type: 'text', text: string }
      expect(textContent.text).toContain('failed')
      expect(textContent.text).toContain('Processing error')
    })

    it('should return progress status when still processing', async () => {
      mockOpenaiVideoService.getVideo.mockResolvedValue({
        id: 'task-123',
        object: 'video',
        model: 'sora-2',
        prompt: 'test',
        status: 'in_progress',
        progress: 50,
        created_at: Math.floor(Date.now() / 1000) - 30,
        completed_at: null,
        expires_at: null,
        error: null,
        remixed_from_video_id: null,
        seconds: '10',
        size: '720x1280',
      })

      const tool = mediaMcp.createGetVideoStatusTool(userId, userType)
      const result = await tool.handler({ taskId: 'task-123' }, {})

      expect(result.isError).toBeUndefined()
      const textContent = result.content[0] as { type: 'text', text: string }
      expect(textContent.text).toContain('in_progress')
      expect(textContent.text).toContain('50%')
    })
  })

  describe('createSoraCharacterTool', () => {
    it('should have correct tool name', () => {
      const tool = mediaMcp.createSoraCharacterTool(userId, userType)
      expect(tool.name).toBe(MediaToolName.CreateSoraCharacter)
    })

    it('should call openaiVideoService.createCharacter with correct params', async () => {
      mockOpenaiVideoService.createCharacter.mockResolvedValue({
        id: 'char-123',
        object: 'character',
        model: 'sora-2-character',
        username: 'testchar',
        status: 'processing',
        created_at: Math.floor(Date.now() / 1000),
      })

      const tool = mediaMcp.createSoraCharacterTool(userId, userType)
      await tool.handler({
        prompt: 'A young woman',
        videoUrl: 'https://example.com/video.mp4',
        taskId: undefined,
        timestamps: '1,3',
      } as never, {})

      expect(mockOpenaiVideoService.createCharacter).toHaveBeenCalledWith({
        userId,
        userType,
        prompt: 'A young woman',
        videoUrl: 'https://example.com/video.mp4',
        taskId: undefined,
        timestamps: '1,3',
      })
    })

    it('should return success result with character id and username', async () => {
      mockOpenaiVideoService.createCharacter.mockResolvedValue({
        id: 'char-123',
        object: 'character',
        model: 'sora-2-character',
        username: 'testchar',
        status: 'processing',
        created_at: Math.floor(Date.now() / 1000),
      })

      const tool = mediaMcp.createSoraCharacterTool(userId, userType)
      const result = await tool.handler({
        prompt: 'A young woman',
        videoUrl: undefined,
        taskId: undefined,
        timestamps: '1,3',
      } as never, {})

      expect(result.isError).toBeUndefined()
      const textContent = result.content[0] as { type: 'text', text: string }
      expect(textContent.text).toContain('char-123')
      expect(textContent.text).toContain('@testchar')
    })

    it('should return error when character creation fails', async () => {
      mockOpenaiVideoService.createCharacter.mockResolvedValue({
        id: 'char-123',
        object: 'character',
        model: 'sora-2-character',
        username: 'testchar',
        status: 'failed',
        created_at: Math.floor(Date.now() / 1000),
        error: { code: 400, message: 'Invalid video' },
      })

      const tool = mediaMcp.createSoraCharacterTool(userId, userType)
      const result = await tool.handler({
        prompt: 'A young woman',
        videoUrl: undefined,
        taskId: undefined,
        timestamps: '1,3',
      } as never, {})

      expect(result.isError).toBe(true)
      const textContent = result.content[0] as { type: 'text', text: string }
      expect(textContent.text).toContain('Failed')
    })
  })

  describe('createGetSoraCharacterTool', () => {
    it('should have correct tool name', () => {
      const tool = mediaMcp.createGetSoraCharacterTool(userId, userType)
      expect(tool.name).toBe(MediaToolName.GetSoraCharacter)
    })

    it('should return completed status with username', async () => {
      mockOpenaiVideoService.getCharacter.mockResolvedValue({
        id: 'char-123',
        object: 'character',
        model: 'sora-2-character',
        username: 'testchar',
        status: 'completed',
        created_at: Math.floor(Date.now() / 1000),
      })

      const tool = mediaMcp.createGetSoraCharacterTool(userId, userType)
      const result = await tool.handler({ characterId: 'char-123' }, {})

      expect(result.isError).toBeUndefined()
      const textContent = result.content[0] as { type: 'text', text: string }
      expect(textContent.text).toContain('ready')
      expect(textContent.text).toContain('@testchar')
    })

    it('should return failed status with error', async () => {
      mockOpenaiVideoService.getCharacter.mockResolvedValue({
        id: 'char-123',
        object: 'character',
        model: 'sora-2-character',
        username: 'testchar',
        status: 'failed',
        created_at: Math.floor(Date.now() / 1000),
        error: { code: 500, message: 'Processing failed' },
      })

      const tool = mediaMcp.createGetSoraCharacterTool(userId, userType)
      const result = await tool.handler({ characterId: 'char-123' }, {})

      expect(result.isError).toBe(true)
      const textContent = result.content[0] as { type: 'text', text: string }
      expect(textContent.text).toContain('failed')
    })

    it('should return processing status', async () => {
      mockOpenaiVideoService.getCharacter.mockResolvedValue({
        id: 'char-123',
        object: 'character',
        model: 'sora-2-character',
        username: 'testchar',
        status: 'processing',
        created_at: Math.floor(Date.now() / 1000),
      })

      const tool = mediaMcp.createGetSoraCharacterTool(userId, userType)
      const result = await tool.handler({ characterId: 'char-123' }, {})

      expect(result.isError).toBeUndefined()
      const textContent = result.content[0] as { type: 'text', text: string }
      expect(textContent.text).toContain('processing')
    })
  })

  describe('createServer', () => {
    it('should create server with correct name', () => {
      const server = mediaMcp.createServer(userId, userType, 'task-1')
      expect(server.name).toBe('mediaGeneration')
    })

    it('should include expected tools', () => {
      const server = mediaMcp.createServer(userId, userType, 'task-1') as { tools?: Array<{ name: string }> }
      const toolNames = server.tools?.map(t => t.name)

      expect(toolNames).toContain(MediaToolName.GenerateImage)
      expect(toolNames).toContain(MediaToolName.GenerateVideoWithGrok)
      expect(toolNames).toContain(MediaToolName.GetGrokVideoStatus)
    })
  })

  it('company mode exposes only gateway image/video tools and uses generic task routing', async () => {
    const originalKey = config.ai.fouryi.apiKey
    const videoService = { userVideoGeneration: vi.fn().mockResolvedValue({ id: 'company-task' }), getVideoTaskStatus: vi.fn().mockResolvedValue({ id: 'company-task', status: 'success' }) }
    const imageService = { userGeneration: vi.fn().mockResolvedValue({ list: [{ url: 'company/image.png' }] }), userEdit: vi.fn().mockResolvedValue({ list: [{ url: 'company/edit.png' }] }) }
    config.ai.fouryi.apiKey = 'test-company-key'
    try {
      const companyMedia = new MediaMcp(mockOpenaiVideoService, imageService as never, mockAiAvailability as never, mockGrokVideoService, videoService as never, taskRepository as never)
      const videoTool = companyMedia.createFourYiVideoTool(userId, userType, 'task-1')
      await videoTool.handler({ model: 'seedance-2.0', prompt: 'A scene', duration: 6 } as never, {})
      expect(videoService.userVideoGeneration).toHaveBeenCalledWith({ userId, userType, model: 'seedance-2.0', prompt: 'A scene', duration: 6, metadata: { officeTaskId: 'task-1' } })
      await companyMedia.createFourYiVideoStatusTool(userId, userType).handler({ taskId: 'company-task' }, {})
      expect(videoService.getVideoTaskStatus).toHaveBeenCalledWith({ userId, userType, taskId: 'company-task' })
      await companyMedia.createFourYiImageTool(userId, userType, 'task-1').handler({ model: 'gpt-image-2', prompt: 'A square', size: '1024x1024' }, {})
      await companyMedia.createFourYiImageTool(userId, userType, 'task-1').handler({ model: 'gpt-image-2', prompt: 'Edit', size: '1024x1024', imageUrls: ['https://cdn.example/reference.png'] }, {})
      expect(imageService.userGeneration).toHaveBeenCalledOnce()
      expect(imageService.userEdit).toHaveBeenCalledOnce()
      const server = companyMedia.createServer(userId, userType, 'task-1') as unknown as { tools: Array<{ name: string }> }
      expect(server.tools.map(tool => tool.name)).toEqual([MediaToolName.GenerateImage, MediaToolName.GenerateVideo, MediaToolName.GetVideoStatus])
      expect(mockOpenaiVideoService.createVideo).not.toHaveBeenCalled()
    }
    finally {
      config.ai.fouryi.apiKey = originalKey
    }
  })

  it('blocks repeated paid media submissions after a tool failure while status reads remain available', async () => {
    const images = { userGeneration: vi.fn().mockRejectedValue(new Error('Unknown generation result')) }
    const videos = { userVideoGeneration: vi.fn().mockRejectedValue(new Error('Unknown generation result')), getVideoTaskStatus: vi.fn().mockResolvedValue({ status: 'InProgress' }) }
    const company = new MediaMcp(mockOpenaiVideoService, images as never, mockAiAvailability as never, mockGrokVideoService, videos as never, taskRepository as never)
    for (const tool of [company.createFourYiImageTool(userId, userType, 'task-1'), company.createFourYiVideoTool(userId, userType, 'task-1')]) {
      await tool.handler({ model: 'fixture', prompt: 'Coffee', size: '1024x1024' } as never, {})
      const result = await tool.handler({ model: 'fixture', prompt: 'Different coffee', size: '1024x1024' } as never, {})
      expect(result.isError).toBe(true)
    }
    const recreated = new MediaMcp(mockOpenaiVideoService, images as never, mockAiAvailability as never, mockGrokVideoService, videos as never, taskRepository as never)
    await recreated.createFourYiImageTool(userId, userType, 'task-1').handler({ model: 'fixture', prompt: 'Still unresolved', size: '1024x1024' }, {})
    await recreated.createFourYiVideoTool(userId, userType, 'task-1').handler({ model: 'fixture', prompt: 'Still unresolved' }, {})
    expect(images.userGeneration).toHaveBeenCalledOnce()
    expect(videos.userVideoGeneration).toHaveBeenCalledOnce()
    await company.createFourYiVideoStatusTool(userId, userType).handler({ taskId: 'existing' }, {})
    expect(videos.getVideoTaskStatus).toHaveBeenCalledOnce()
  })
})
