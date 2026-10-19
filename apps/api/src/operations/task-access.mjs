import { fail } from '../db.mjs'
// The upstream identity is shared by a tenant. Office owns user-level task authorization.
export async function ownRuntimeIds(db, ctx) {
  const rows = (
    await db.query(
      'SELECT runtime_task_id FROM operations_submissions WHERE tenant_id=$1 AND user_id=$2 AND runtime_task_id IS NOT NULL',
      [ctx.tenantId, ctx.userId],
    )
  ).rows
  const board = (
    await db.query('SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2', [
      ctx.tenantId,
      ctx.userId,
    ])
  ).rows[0]?.board
  return new Set(
    [
      ...rows.map((r) => r.runtime_task_id),
      ...(board?.tasks || []).filter((t) => t.dept === 'app-agent').map((t) => t.runtimeTaskId),
    ].filter((id) => /^[a-f0-9]{24}$/.test(id || '')),
  )
}
export async function assertRuntimeAccess(db, ctx, id) {
  if (!(await ownRuntimeIds(db, ctx)).has(id)) throw fail(404, '制作任务不存在')
}
