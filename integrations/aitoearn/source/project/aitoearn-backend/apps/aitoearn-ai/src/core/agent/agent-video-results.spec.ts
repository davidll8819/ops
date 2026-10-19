import { vi } from 'vitest'
import { AgentService } from './agent.service'

describe('saved task videos', () => {
  it('reads owned saved videos after parent failure without generating or hiding the error', async () => {
    const tasks = { getUserTask: vi.fn().mockResolvedValue({ id: 'task-a', status: 'error', messages: [] }) }
    const logs = { listByUserIdAndRequestOfficeTaskId: vi.fn().mockResolvedValue([{ id: 'video-a' }, { id: 'video-b' }]) }
    const first = { id: 'video-a', status: 'SUCCESS', specification: { matches: true } }, second = { id: 'video-b', status: 'SUCCESS', specification: { matches: false } }
    const videos = { getVideoTaskStatus: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) }
    const service = new AgentService(tasks as never, {} as never, {} as never, logs as never, videos as never)
    expect(await service.getTask('owner', 'task-a')).toMatchObject({ status: 'error', savedVideos: [first, second] })
    expect(logs.listByUserIdAndRequestOfficeTaskId).toHaveBeenCalledWith('owner', 'task-a')
    expect(videos.getVideoTaskStatus).toHaveBeenNthCalledWith(1, { userId: 'owner', userType: 'user', taskId: 'video-a' })
  })
  it('does not read video logs when a different user cannot read the parent task', async () => {
    const logs = { listByUserIdAndRequestOfficeTaskId: vi.fn() }
    const service = new AgentService({ getUserTask: vi.fn().mockResolvedValue(null) } as never, {} as never, {} as never, logs as never, {} as never)
    await expect(service.getTask('stranger', 'task-a')).rejects.toThrow()
    expect(logs.listByUserIdAndRequestOfficeTaskId).not.toHaveBeenCalled()
  })
})
