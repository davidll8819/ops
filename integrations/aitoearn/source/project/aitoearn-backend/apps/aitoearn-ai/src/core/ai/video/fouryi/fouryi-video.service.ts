import type { FourYiVideoAiLog } from '../video-ai-log.interface'
import type { UserVideoGenerationRequestDto } from '../video.dto'
import { Injectable, Logger } from '@nestjs/common'
import { AssetsService, StorageProvider } from '@yikart/assets'
import { AppException, FileUtil, ResponseCode } from '@yikart/common'
import { AiLogChannel, AiLogRepository, AiLogStatus, AiLogType, AssetType } from '@yikart/mongodb'
import { TaskStatus } from '../../../../common'
import { config } from '../../../../config'
import { AiAvailabilityService } from '../../../ai-availability/ai-availability.service'
import { fourYiApiBaseUrl } from '../../libs/fouryi/fouryi.config'

type FourYiTask = Record<string, unknown>

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function unwrap(value: unknown): unknown {
  return asRecord(value)?.['data'] ?? value
}

function getString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.length > 0)
      return candidate
  }
  return undefined
}

@Injectable()
export class FourYiVideoService {
  private readonly logger = new Logger(FourYiVideoService.name)

  constructor(
    private readonly aiLogRepo: AiLogRepository,
    private readonly assetsService: AssetsService,
    private readonly storageProvider: StorageProvider,
    private readonly aiAvailability: AiAvailabilityService,
  ) {}

  private get baseUrl() { return fourYiApiBaseUrl(config.ai.fouryi.baseUrl) }

  private async toAccessibleUrl(url: string): Promise<string> {
    const path = this.storageProvider.parsePathFromUrl(url)
    return path.startsWith('http') || url.startsWith('data:') ? url : this.storageProvider.toPresignedUrl(path)
  }

  private async request(path: string, init: RequestInit = {}) {
    if (!config.ai.fouryi.apiKey)
      throw new AppException(ResponseCode.AiCallFailed, { error: '4yi API key is not configured' })
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(config.ai.fouryi.timeout),
      headers: {
        Authorization: `Bearer ${config.ai.fouryi.apiKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })
    if (!response.ok) {
      throw new AppException(ResponseCode.AiCallFailed, { error: `4yi API HTTP ${response.status}` })
    }
    return response
  }

  async createFromRequest(request: UserVideoGenerationRequestDto): Promise<{ id: string }> {
    const inputImages = [
      ...(typeof request.image === 'string' ? [request.image] : request.image ?? []),
      ...(request.images ?? []),
    ]
    const referenceImages = await Promise.all(inputImages.map(url => this.toAccessibleUrl(url)))
    if (request.videos?.length || request.audios?.length || request.video_url || request.image_tail)
      throw new AppException(ResponseCode.AiCallFailed, { error: '4YI video adapter supports text and image references only' })
    if (!referenceImages.length && (request.model.endsWith('-r2v') || request.model.endsWith('-i2v') || request.mode === 'multi-image2video' || request.mode === 'image2video'))
      throw new AppException(ResponseCode.AiCallFailed, { error: '4YI image and reference video modes require an input image' })
    const mode = referenceImages.length ? 'image_to_video' : 'text_to_video'
    const body = {
      model: request.model,
      prompt: request.prompt,
      mode,
      duration_seconds: request.duration,
      aspect_ratio: request.ratio,
      resolution: request.resolution,
      response_format: 'url',
      ...(referenceImages.length ? { extra_body: { reference_images: referenceImages } } : {}),
    }
    const startedAt = new Date()
    const result = asRecord(unwrap(await (await this.request('/videos/generations', { method: 'POST', body: JSON.stringify(body) })).json())) ?? {}
    const remoteTaskId = getString(result, 'id', 'generation_id', 'task_id')
    if (!remoteTaskId)
      throw new AppException(ResponseCode.AiCallFailed, { error: '4yi response is missing generation id' })

    const aiLog = await this.aiLogRepo.create({
      userId: request.userId,
      userType: request.userType,
      taskId: remoteTaskId,
      model: request.model,
      channel: AiLogChannel.FourYi,
      startedAt,
      type: AiLogType.Video,
      request: { ...body, remoteTaskId, groupId: request.groupId },
      response: result,
      status: AiLogStatus.Generating,
    })
    return { id: aiLog.id }
  }

  extractInput(request: FourYiVideoAiLog['request']) {
    const extraBody = request['extra_body'] as Record<string, unknown> | undefined
    return {
      prompt: request.prompt,
      groupId: request.groupId,
      images: (extraBody?.['reference_images'] as string[] | undefined) ?? [],
      duration: request['duration_seconds'] as number | undefined,
    }
  }

  getTaskResult(result: FourYiTask) {
    const rawError = result['error']
    const nestedError = rawError && typeof rawError === 'object' ? getString(rawError as Record<string, unknown>, 'message', 'detail') : undefined
    const errorMessage = getString(result, 'error_message', 'message') ?? nestedError ?? (typeof rawError === 'string' ? rawError : undefined)
    return {
      status: this.normalizeStatus(getString(result, 'status', 'state')),
      videoUrl: getString(result, 'videoUrl', 'video_url', 'url', 'artifact_url'),
      error: errorMessage ? { message: errorMessage } : undefined,
    }
  }

  private normalizeStatus(status?: string): TaskStatus {
    switch (status?.toLowerCase()) {
      case 'completed': case 'complete': case 'succeeded': case 'success': case 'succeed': return TaskStatus.Success
      case 'failed': case 'failure': case 'error': case 'cancelled': case 'canceled': return TaskStatus.Failure
      default: return TaskStatus.InProgress
    }
  }

  async poll(task: FourYiVideoAiLog) {
    if (task.status !== AiLogStatus.Generating || !task.taskId)
      return
    let remote: FourYiTask
    try {
      remote = asRecord(unwrap(await (await this.request(`/videos/generations/${encodeURIComponent(task.taskId)}`)).json())) ?? {}
      const status = this.normalizeStatus(getString(remote, 'status', 'state'))
      if (status === TaskStatus.InProgress)
        return

      let videoUrl = getString(remote, 'video_url', 'videoUrl', 'url', 'artifact_url')
      if (status === TaskStatus.Success) {
        // Gateway artifact URLs require the company key; never forward it to a CDN.
        if (videoUrl && new URL(videoUrl, this.baseUrl).origin !== new URL(this.baseUrl).origin) {
          const uploaded = await this.assetsService.uploadFromUrl(task.userId, { url: videoUrl, type: AssetType.AiVideo }, task.model)
          videoUrl = uploaded.asset.path
        }
        else {
          const artifact = await this.request(`/videos/generations/${encodeURIComponent(task.taskId)}/artifact`)
          const contentType = artifact.headers.get('content-type') ?? 'video/mp4'
          if (contentType.includes('json')) {
            const artifactJson = asRecord(unwrap(await artifact.json())) ?? {}
            const artifactUrl = getString(artifactJson, 'url', 'video_url', 'artifact_url')
            if (!artifactUrl)
              throw new Error('4yi artifact response did not include a video URL')
            const uploaded = await this.assetsService.uploadFromUrl(task.userId, { url: artifactUrl, type: AssetType.AiVideo }, task.model)
            videoUrl = uploaded.asset.path
          }
          else {
            const uploaded = await this.assetsService.uploadFromBuffer(task.userId, Buffer.from(await artifact.arrayBuffer()), { type: AssetType.AiVideo, mimeType: contentType }, task.model)
            videoUrl = uploaded.asset.path
          }
        }
      }

      const response = { ...remote, status: status === TaskStatus.Success ? 'completed' : 'failed', videoUrl }
      const elapsedMs = Date.now() - task.startedAt.getTime()
      const updated = await this.aiLogRepo.updateByIdAndStatus(task.id, AiLogStatus.Generating, {
        $set: {
          status: status === TaskStatus.Success ? AiLogStatus.Success : AiLogStatus.Failed,
          response,
          duration: elapsedMs,
          ...(status === TaskStatus.Failure ? { errorMessage: this.getTaskResult(remote).error?.message ?? '4yi video generation failed' } : {}),
        },
      })
      if (updated)
        await this.aiAvailability.recordAsyncComplete(task.taskId, { provider: '4yi', operation: 'videoGeneration', model: task.model }, { success: status === TaskStatus.Success, latencyMs: elapsedMs })
    }
    catch (error) {
      this.logger.warn({ error, taskId: task.taskId, aiLogId: task.id }, '4yi video status poll failed; will retry')
    }
  }

  toCommonResult(response: FourYiTask = {}) {
    const result = this.getTaskResult(response)
    return { ...result, videoUrl: result.videoUrl ? FileUtil.buildUrl(result.videoUrl) : undefined }
  }
}
