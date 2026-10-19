import { randomUUID } from 'node:crypto'
import { fail } from '../db.mjs'
import { validateFiles } from '../../../execution/files.mjs'

export const projectRoles = ['owner', 'admin']
export const projectMetadata = (row) => ({
  id: row.id,
  name: row.name,
  revision: row.revision,
  activeRunId: row.active_run_id,
  updatedAt: row.updated_at,
  isDefault: row.is_default,
})
export const versionMetadata = (row) => ({
  id: row.id,
  label: row.label,
  kind: row.kind,
  sourceRevision: row.source_revision,
  createdAt: row.created_at,
  fileCount: row.file_count ?? row.files.length,
  bytes: Number(row.snapshot_bytes),
})
export const projectInstructions = (row) =>
  row
    ? `\n当前独立项目：${row.name}（ID ${row.id}）。只处理这个项目。文件可能已由用户恢复到历史版本，继续修改前必须重新读取当前文件。`
    : ''
export async function projectRow(db, ctx, lock = false) {
  const explicit = !!ctx.projectId
  const row = (
    await db.query(
      `SELECT * FROM employee_workspaces WHERE tenant_id=$1 AND user_id=$2 AND ${explicit ? 'id=$3' : 'is_default=true'}${lock ? ' FOR UPDATE' : ''}`,
      explicit ? [ctx.tenantId, ctx.userId, ctx.projectId] : [ctx.tenantId, ctx.userId],
    )
  ).rows[0]
  if (explicit && !row) throw fail(404, '项目不存在')
  return row
}
export async function lockProjectOwner(db, ctx) {
  // Shared with legacy conversation commits, so creating the first project cannot
  // adopt history while an old model response is being committed.
  await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [ctx.userId])
}
export async function insertProject(db, ctx, name, { defaultOnly = false } = {}) {
  await lockProjectOwner(db, ctx)
  const existing = (
    await db.query(
      'SELECT id,is_default FROM employee_workspaces WHERE tenant_id=$1 AND user_id=$2 ORDER BY is_default DESC,updated_at,id',
      [ctx.tenantId, ctx.userId],
    )
  ).rows
  if (defaultOnly && existing.length) return existing.find((r) => r.is_default)
  if (existing.length >= 20) throw fail(409, '每个用户最多创建20个项目')
  const isDefault = !existing.length
  const legacy = isDefault
    ? (
        await db.query(
          "SELECT messages,revision FROM department_conversations WHERE tenant_id=$1 AND user_id=$2 AND department='dev' FOR UPDATE",
          [ctx.tenantId, ctx.userId],
        )
      ).rows[0]
    : null
  const files = [
    {
      path: 'README.md',
      contentBase64: Buffer.from(
        '# 龙傲天项目工作区\n\n这是独立项目，可在对话中创建文件、编写代码和运行测试。\nNode.js 24、npm、Python3 标准库可用；暂不支持联网安装依赖。\n',
      ).toString('base64'),
    },
  ]
  return (
    await db.query(
      'INSERT INTO employee_workspaces(id,tenant_id,user_id,name,files,is_default,messages,conversation_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [
        randomUUID(),
        ctx.tenantId,
        ctx.userId,
        name,
        JSON.stringify(files),
        isDefault,
        JSON.stringify(legacy?.messages || []),
        legacy?.revision || 0,
      ],
    )
  ).rows[0]
}
export async function ownedVersion(db, ctx, id) {
  const row = (
    await db.query(
      'SELECT * FROM employee_project_versions WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3 AND user_id=$4',
      [id, ctx.projectId, ctx.tenantId, ctx.userId],
    )
  ).rows[0]
  if (!row) throw fail(404, '保存的项目版本不存在')
  return row
}
export async function insertVersion(db, ctx, row, label, kind) {
  validateFiles(row.files)
  const bytes = row.files.reduce(
    (sum, file) => sum + Buffer.from(file.contentBase64, 'base64').length,
    0,
  )
  const quota = (
    await db.query(
      'SELECT count(*) count,coalesce(sum(snapshot_bytes),0) bytes FROM employee_project_versions WHERE workspace_id=$1 AND tenant_id=$2 AND user_id=$3',
      [row.id, ctx.tenantId, ctx.userId],
    )
  ).rows[0]
  if (Number(quota.count) >= 100 || Number(quota.bytes) + bytes > 256 * 1024 * 1024)
    throw fail(409, '项目版本已达到100个或256 MiB总容量上限，请保留现有历史并减少新快照大小')
  return (
    await db.query(
      'INSERT INTO employee_project_versions(id,workspace_id,tenant_id,user_id,label,kind,source_revision,files) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [
        randomUUID(),
        row.id,
        ctx.tenantId,
        ctx.userId,
        label,
        kind,
        row.revision,
        JSON.stringify(row.files),
      ],
    )
  ).rows[0]
}
