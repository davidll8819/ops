import { fail } from '../db.mjs'
export async function readSubmission(db, ctx, id) {
  const row = (
    await db.query(
      'SELECT id,state,brief_id,runtime_task_id,created_at,updated_at FROM operations_submissions WHERE id=$1 AND tenant_id=$2 AND user_id=$3',
      [id, ctx.tenantId, ctx.userId],
    )
  ).rows[0]
  if (!row) throw fail(404, '提交记录不存在')
  return {
    requestId: row.id,
    state: row.state,
    runtimeTaskId: row.runtime_task_id,
    briefId: row.brief_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
export async function listSubmissions(db, ctx) {
  const rows = (
    await db.query(
      'SELECT id,state,runtime_task_id,created_at,updated_at FROM operations_submissions WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 50',
      [ctx.tenantId, ctx.userId],
    )
  ).rows
  return rows.map((row) => ({
    requestId: row.id,
    state: row.state,
    runtimeTaskId: row.runtime_task_id,
    createdAt: row.created_at,
  }))
}
export async function reserveSubmission(db, ctx, input, fingerprint) {
  const result = await db.query(
    "INSERT INTO operations_submissions(id,tenant_id,user_id,fingerprint,brief_id,state) VALUES($1,$2,$3,$4,$5,'reserved') ON CONFLICT DO NOTHING RETURNING id",
    [input.requestId, ctx.tenantId, ctx.userId, fingerprint, input.briefId || null],
  )
  if (!result.rows.length)
    throw fail(409, '此制作请求已接收，或结果待核对。请查询原提交记录，不要重复生成')
}
export async function updateSubmission(db, ctx, id, runtimeId, failed = false) {
  await db.query(
    'UPDATE operations_submissions SET state=$4,runtime_task_id=coalesce(runtime_task_id,$5),updated_at=now() WHERE id=$1 AND tenant_id=$2 AND user_id=$3',
    [
      id,
      ctx.tenantId,
      ctx.userId,
      failed ? 'failed' : runtimeId ? 'submitted' : 'uncertain',
      runtimeId || null,
    ],
  )
}
export async function* trackSubmission(stream, update) {
  const decoder = new TextDecoder()
  let buffer = '',
    runtimeId
  try {
    for await (const value of stream) {
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        let event
        try {
          event = JSON.parse(
            frame
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim())
              .join('\n'),
          )
        } catch {
          continue
        }
        if (!runtimeId && /^[a-f0-9]{24}$/.test(event.taskId || '')) {
          runtimeId = event.taskId
          await update(runtimeId)
        }
      }
      if (buffer.length > 1024 * 1024) buffer = ''
      yield value
    }
  } finally {
    await update(runtimeId)
  }
}
