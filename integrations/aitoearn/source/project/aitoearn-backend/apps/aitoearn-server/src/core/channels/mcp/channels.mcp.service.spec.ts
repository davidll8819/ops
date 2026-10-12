import { AccountType } from '@yikart/common'
import { PublishRecordSource } from '@yikart/mongodb'
import { describe, expect, it, vi } from 'vitest'
import { RelayAccountException } from '../relay/relay-account.exception'
import { ChannelsMcpService } from './channels.mcp.service'

vi.mock('@yikart/mongodb', () => ({
  PublishRecordSource: {
    Mcp: 'mcp',
  },
}))

vi.mock('../accounts/account.service', () => ({ AccountService: class AccountService {} }))
vi.mock('../relay/relay-client.service', () => ({ RelayClientService: class RelayClientService {} }))

vi.mock('../analytics/analytics.service', () => ({ AnalyticsService: class AnalyticsService {} }))
vi.mock('../engagement/engagement.service', () => ({ EngagementService: class EngagementService {} }))
vi.mock('../platforms/platforms.service', () => ({ PlatformsService: class PlatformsService {} }))
vi.mock('../platforms/platforms.registry', () => ({ PlatformIntegrationRegistry: class PlatformIntegrationRegistry {} }))
vi.mock('../publish/flows/publish-flow.service', () => ({ PublishFlowService: class PublishFlowService {} }))
vi.mock('../publish/records/publish-record-read.service', () => ({ PublishRecordReadService: class PublishRecordReadService {} }))
vi.mock('../publish/tasks/publish-task.service', () => ({ PublishTaskService: class PublishTaskService {} }))
vi.mock('../works/work.service', () => ({ WorkService: class WorkService {} }))

function createService(overrides: {
  publishFlowService?: Record<string, unknown>
  publishTaskService?: Record<string, unknown>
  recordReadService?: Record<string, unknown>
  analyticsService?: Record<string, unknown>
  engagementService?: Record<string, unknown>
  workService?: Record<string, unknown>
  registry?: Record<string, unknown>
  platformsService?: Record<string, unknown>
  accountService?: Record<string, unknown>
  relayClientService?: Record<string, unknown>
} = {}) {
  return new ChannelsMcpService(
    (overrides.publishFlowService ?? {}) as never,
    (overrides.publishTaskService ?? {}) as never,
    (overrides.recordReadService ?? {}) as never,
    (overrides.analyticsService ?? {}) as never,
    (overrides.engagementService ?? {}) as never,
    (overrides.workService ?? {}) as never,
    (overrides.registry ?? {}) as never,
    (overrides.platformsService ?? {}) as never,
    (overrides.accountService ?? {}) as never,
    (overrides.relayClientService ?? {}) as never,
  )
}

describe('channelsMcpService', () => {
  it('queries connected accounts using the authenticated user', async () => {
    const accountService = { list: vi.fn().mockResolvedValue({ total: 0, list: [] }) }
    await createService({ accountService }).listChannelAccounts('user_1')
    expect(accountService.list).toHaveBeenCalledWith('user_1', {})
  })

  it('relays an authorized publish flow with mapped accounts and uploaded media exactly once', async () => {
    const result = { flowId: 'flow_1', tasks: [{ id: 'record_1' }] }
    const publishFlowService = {
      createFlow: vi.fn().mockRejectedValue(new RelayAccountException('remote_1', 'local_1')),
    }
    const relayClientService = {
      replaceLocalUrls: vi.fn(async (body: unknown) => JSON.parse(JSON.stringify(body).replaceAll('http://localhost:8080/oss/video.mp4', 'https://cdn.example.test/video.mp4'))),
      post: vi.fn().mockResolvedValue(result),
    }
    const service = createService({ publishFlowService, relayClientService })
    const params = {
      flowId: 'flow_1',
      content: { media: [{ url: 'http://localhost:8080/oss/video.mp4' }] },
      publishAt: new Date('2026-09-26T10:00:00Z'),
      items: [{ accountId: 'local_1', platform: AccountType.TikTok }],
    }
    await expect(service.createChannelPublishFlow('user_1', params)).resolves.toEqual(result)
    expect(publishFlowService.createFlow).toHaveBeenCalledWith('user_1', expect.any(Object))
    expect(relayClientService.post).toHaveBeenCalledTimes(1)
    expect(relayClientService.post).toHaveBeenCalledWith('/v2/channels/publish/flows', expect.objectContaining({
      flowId: 'flow_1',
      context: { source: 'mcp' },
      content: { media: [{ url: 'https://cdn.example.test/video.mp4' }] },
      items: [{ accountId: 'remote_1', platform: AccountType.TikTok }],
    }))
    expect(params.items[0].accountId).toBe('local_1')
  })

  it('never relays ownership or other local validation failures', async () => {
    const error = new Error('Account not owned by user')
    const publishFlowService = { createFlow: vi.fn().mockRejectedValue(error) }
    const relayClientService = { replaceLocalUrls: vi.fn(), post: vi.fn() }
    const service = createService({ publishFlowService, relayClientService })
    await expect(service.createChannelPublishFlow('user_1', {
      content: { media: [] },
      publishAt: new Date(),
      items: [{ accountId: 'other-account', platform: AccountType.TikTok }],
    })).rejects.toBe(error)
    expect(relayClientService.replaceLocalUrls).not.toHaveBeenCalled()
    expect(relayClientService.post).not.toHaveBeenCalled()
  })

  it('marks publish flows as MCP source', async () => {
    const publishFlowService = {
      createFlow: vi.fn().mockResolvedValue({ flowId: 'flow_1', tasks: [] }),
    }
    const service = createService({ publishFlowService })

    await service.createChannelPublishFlow('user_1', {
      content: {
        title: 'title',
        body: 'body',
        media: [],
        topics: [],
      },
      publishAt: new Date('2026-05-25T00:00:00.000Z'),
      context: {
        materialId: 'material_1',
      },
      items: [{
        platform: AccountType.Twitter,
        accountId: 'account_1',
      }],
    })

    expect(publishFlowService.createFlow).toHaveBeenCalledWith('user_1', expect.objectContaining({
      context: expect.objectContaining({
        materialId: 'material_1',
        source: PublishRecordSource.Mcp,
      }),
    }))
  })

  it('reads publish records by flowId without a union lookup payload', async () => {
    const recordReadService = {
      getByFlowId: vi.fn().mockResolvedValue({ id: 'record_1' }),
      getDetail: vi.fn(),
    }
    const service = createService({ recordReadService })

    await expect(service.getChannelPublishRecordByFlowId('user_1', {
      flowId: 'flow_1',
    })).resolves.toEqual({ id: 'record_1' })

    expect(recordReadService.getByFlowId).toHaveBeenCalledWith('user_1', 'flow_1')
    expect(recordReadService.getDetail).not.toHaveBeenCalled()
  })

  it('reads publish records by recordId without a union lookup payload', async () => {
    const recordReadService = {
      getDetail: vi.fn().mockResolvedValue({ id: 'record_1' }),
    }
    const service = createService({ recordReadService })

    await expect(service.getChannelPublishRecordByRecordId('user_1', {
      recordId: 'record_1',
    })).resolves.toEqual({ id: 'record_1' })

    expect(recordReadService.getDetail).toHaveBeenCalledWith('record_1', 'user_1')
  })

  it('reads publish records by taskId without using record detail lookup', async () => {
    const recordReadService = {
      getByTaskId: vi.fn().mockResolvedValue({ id: 'record_1', taskId: 'task_1' }),
      getDetail: vi.fn(),
    }
    const service = createService({ recordReadService })

    await expect(service.getChannelPublishRecordByTaskId('user_1', {
      taskId: 'task_1',
    })).resolves.toEqual({ id: 'record_1', taskId: 'task_1' })

    expect(recordReadService.getByTaskId).toHaveBeenCalledWith('user_1', 'task_1')
    expect(recordReadService.getDetail).not.toHaveBeenCalled()
  })

  it('keeps taskId publish record misses as nullable MCP results', async () => {
    const recordReadService = {
      getByTaskId: vi.fn().mockResolvedValue(null),
    }
    const service = createService({ recordReadService })

    await expect(service.getChannelPublishRecordByTaskId('user_1', {
      taskId: 'task_1',
    })).resolves.toBeNull()

    expect(recordReadService.getByTaskId).toHaveBeenCalledWith('user_1', 'task_1')
  })

  it('uses account-scoped option sources for YouTube categories', async () => {
    const publishOptions = {
      getAccountValues: vi.fn().mockResolvedValue({ field: 'categoryId', items: [] }),
    }
    const service = createService({ platformsService: publishOptions })

    await service.listYoutubeChannelPlatformCategories('user_1', {
      accountId: 'account_1',
      regionCode: 'US',
    })

    expect(publishOptions.getAccountValues).toHaveBeenCalledWith('user_1', 'account_1', 'categoryId', {
      id: undefined,
      regionCode: 'US',
    })
  })

  it('uses account-scoped option sources for Bilibili categories', async () => {
    const publishOptions = {
      getAccountValues: vi.fn().mockResolvedValue({ field: 'tid', items: [] }),
    }
    const service = createService({ platformsService: publishOptions })

    await service.listBilibiliChannelPlatformCategories('user_1', {
      accountId: 'account_1',
    })

    expect(publishOptions.getAccountValues).toHaveBeenCalledWith('user_1', 'account_1', 'tid')
  })
})
