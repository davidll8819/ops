import { archiveTask } from '../task-assets.mjs'
import { transaction, fail } from '../db.mjs'
// Only authenticated server responses can advance execution state. Browser text cannot mark a task complete.
export async function updateLinkedTask(pool, ctx, id, change) {
  return transaction(
    pool,
    async (db) => {
      const row = (
        await db.query(
          'SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',
          [ctx.tenantId, ctx.userId],
        )
      ).rows[0]
      const task = row?.board.tasks.find((t) => t.id === id && t.dept === 'app-agent')
      if (!task) throw fail(404, '任务不存在')
      change(task)
      await archiveTask(db, ctx, task)
      await db.query(
        'UPDATE secretary_workspaces SET board=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',
        [ctx.tenantId, ctx.userId, JSON.stringify(row.board)],
      )
    },
    ctx,
  )
}
export function runtimeOutput(value) {
  const texts = [],
    media = []
  function walk(v, depth = 0) {
    if (depth > 15 || !v) return
    if (typeof v === 'string') {
      texts.push(v)
      for (const match of v.matchAll(/\[Resource link: (?:Generated image|Image \d+)\]\s+(https?:\/\/[^\s<>]+)/g))
        media.push({ type: 'IMAGE', url: match[1] })
      if (v.length < 1024 * 1024 && (v.trim().startsWith('{') || v.trim().startsWith('['))) {
        try { walk(JSON.parse(v), depth + 1) } catch { /* Tool output may be plain text. */ }
      }
      return
    }
    if (Array.isArray(v)) {
      v.forEach((x) => walk(x, depth + 1))
      return
    }
    if (typeof v !== 'object') return
    if (['IMAGE', 'VIDEO'].includes(v.type) && /^https?:\/\//.test(v.url || ''))
      media.push({ type: v.type, url: v.url })
    if (['SUCCESS', 'completed'].includes(v.status) && /^https?:\/\//.test(v.videoUrl || ''))
      media.push({ type: 'VIDEO', url: v.videoUrl })
    if (v.type === 'resource_link' && /image/i.test(v.name || '') && /^https?:\/\//.test(v.uri || ''))
      media.push({ type: 'IMAGE', url: v.uri })
    if (v.text) walk(v.text, depth + 1)
    else if (v.content) walk(v.content, depth + 1)
    for (const k of ['message', 'messages', 'result', 'medias', 'structured_output'])
      if (v[k]) walk(v[k], depth + 1)
  }
  walk(value)
  return {
    text: [...new Set(texts)].join('\n').slice(0, 150000),
    media: [...new Map(media.map((m) => [m.url, m])).values()].slice(0, 30),
  }
}
export function applyRuntimeStatus(task, result) {
  const status = result?.status
  if (!['running', 'completed', 'requires_action', 'error', 'aborted'].includes(status)) return
  task.status = status === 'running' ? 'working' : status === 'completed' ? 'completed' : 'blocked'
  task.executionNote = {
    running: '运营服务正在执行',
    completed: '运营制作流程已结束，请查看产物与平台回执',
    requires_action: '运营流程需要补充信息或账号授权',
    error: '运营服务执行失败，请查看任务记录',
    aborted: '运营任务已停止',
  }[status]
  if (status === 'completed') {
    const output = runtimeOutput(result.messages || result.result)
    task.summary = output.text || '运营任务已结束，暂无可读取的文字成果，请查看运营工作台。'
    task.media = output.media
  }
  task.runtimePending = false
  task.updatedAt = new Date().toISOString()
  if (status !== 'running') task.finishedAt = task.updatedAt
}
export async function* trackOperationsStream(stream, { pool, ctx, id, submissionId }) {
  const reader = stream.getReader(),
    decoder = new TextDecoder()
  let buffer = '',
    runtimeId
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const payload = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n')
        let event
        try {
          event = JSON.parse(payload)
        } catch {
          continue
        }
        if (!runtimeId && /^[a-f0-9]{24}$/.test(event.taskId || '')) {
          runtimeId = event.taskId
          await updateLinkedTask(pool, ctx, id, (t) => {
            if (submissionId && t.runtimeSubmissionId !== submissionId) return
            t.runtimeTaskId = runtimeId
            t.runtimePending = false
            t.status = 'working'
            t.executionNote = '运营服务正在执行'
            t.updatedAt = new Date().toISOString()
          })
        }
      }
      if (buffer.length > 1024 * 1024) buffer = ''
      yield value
    }
  } finally {
    reader.releaseLock()
    // SSE ending is not evidence that generation or publishing succeeded.
    await updateLinkedTask(pool, ctx, id, (t) => {
      if (submissionId && t.runtimeSubmissionId !== submissionId) return
      if (t.status === 'completed') return
      if (!runtimeId) {
        t.status = 'blocked'
        t.executionNote = '运营任务结果待核对，请勿重复提交'
      } else t.executionNote = '正在核对运营服务任务状态'
    })
  }
}
