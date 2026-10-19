import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { fail } from '../db.mjs'
import { projectRow, ownedVersion } from './project-store.mjs'
import { deliveryFiles, listDeliverables, productZip } from './deliverables.mjs'
import { snapshotSha256 } from './snapshot-hash.mjs'
import { versionTestHistory, deliveryTestEvidence } from './version-tests.mjs'

const initialItems = [
  { id: 'core-functionality', title: '核心功能符合要求' },
  { id: 'operations-display', title: '主要操作与页面显示正常' },
  { id: 'usage-instructions', title: '使用说明与实际作品一致' },
]
const itemSchema = z
  .object({
    id: z.union([z.string().uuid(), z.enum(initialItems.map((item) => item.id))]),
    title: z.string().trim().min(1).max(160),
    status: z.enum(['unchecked', 'passed', 'failed']),
    note: z.string().max(2000),
  })
  .strict()
  .refine((item) => item.status === 'unchecked' || item.note.trim().length > 0, {
    message: '通过或失败的验收项必须填写实际观察记录',
  })
export const acceptanceInput = z
  .object({
    revision: z.number().int().nonnegative(),
    entry: z.string().max(512),
    items: z
      .array(itemSchema)
      .min(1)
      .max(20)
      .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
        message: '验收项编号不能重复',
      }),
    instructions: z.string().max(8000),
    limitations: z.string().max(8000),
  })
  .strict()

const values = (ctx, versionId) => [versionId, ctx.projectId, ctx.tenantId, ctx.userId]
const deliveryView = (row) => ({
  id: row.id,
  versionId: row.version_id,
  versionLabel: row.version_label,
  sourceRevision: row.source_revision,
  label: row.label,
  entry: row.entry,
  items: row.items,
  systemCheck: row.system_check,
  automatedTest: row.automated_test ?? null,
  instructions: row.instructions,
  limitations: row.limitations,
  createdAt: row.created_at,
})
export function versionDeliverySnapshot(project, version) {
  return {
    projectId: project.id,
    versionId: version.id,
    name: project.name,
    revision: version.source_revision,
    files: version.files,
    activeRunId: null,
    updatedAt: version.created_at,
  }
}
async function versionContext(db, ctx, versionId, lock = false) {
  const project = await projectRow(db, ctx, lock)
  const version = await ownedVersion(db, ctx, versionId)
  return { project, version, snapshot: versionDeliverySnapshot(project, version) }
}
async function acceptanceRow(db, ctx, versionId) {
  return (
    await db.query(
      'SELECT * FROM employee_project_acceptance WHERE version_id=$1 AND workspace_id=$2 AND tenant_id=$3 AND user_id=$4',
      values(ctx, versionId),
    )
  ).rows[0]
}
async function deliveryForVersion(db, ctx, versionId) {
  return (
    await db.query(
      'SELECT * FROM employee_project_deliveries WHERE version_id=$1 AND workspace_id=$2 AND tenant_id=$3 AND user_id=$4',
      values(ctx, versionId),
    )
  ).rows[0]
}
async function draftView(db, ctx, versionId, row, snapshot, delivery) {
  return {
    versionId,
    revision: row?.revision || 0,
    entry: row?.entry ?? listDeliverables(snapshot).entries[0]?.path ?? '',
    items: row?.items ?? initialItems.map((item) => ({ ...item, status: 'unchecked', note: '' })),
    instructions: row?.instructions ?? '',
    limitations: row?.limitations ?? '',
    systemCheck: row?.system_check ?? null,
    delivery: delivery ? deliveryView(delivery) : null,
    ...await versionTestHistory(db, ctx, versionId),
  }
}
function validEntry(snapshot, entry) {
  return !!entry && listDeliverables(snapshot).entries.some((item) => item.path === entry)
}
async function mutableDraft(db, ctx, versionId, revision) {
  const context = await versionContext(db, ctx, versionId, true)
  if (await deliveryForVersion(db, ctx, versionId))
    throw fail(409, '此版本已正式交付，验收记录只读；请保存新版本继续修改')
  const row = await acceptanceRow(db, ctx, versionId)
  if ((row?.revision ?? 0) !== revision) throw fail(409, '验收记录已更新，请刷新后重试')
  return { ...context, row }
}
export async function readAcceptance(db, ctx, versionId) {
  const { snapshot } = await versionContext(db, ctx, versionId)
  return draftView(
    db,
    ctx,
    versionId,
    await acceptanceRow(db, ctx, versionId),
    snapshot,
    await deliveryForVersion(db, ctx, versionId),
  )
}
export async function saveAcceptance(db, ctx, versionId, input) {
  const data = acceptanceInput.parse(input)
  const { row, snapshot } = await mutableDraft(db, ctx, versionId, data.revision)
  if (data.entry && !validEntry(snapshot, data.entry))
    throw fail(400, '请选择保存版本中的 HTML 网页成果')
  const check = row?.entry === data.entry ? row.system_check : null
  const saved = (
    await db.query(
      `INSERT INTO employee_project_acceptance(version_id,workspace_id,tenant_id,user_id,revision,entry,items,instructions,limitations,system_check)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT(version_id) DO UPDATE SET revision=EXCLUDED.revision,entry=EXCLUDED.entry,items=EXCLUDED.items,instructions=EXCLUDED.instructions,limitations=EXCLUDED.limitations,system_check=EXCLUDED.system_check,updated_at=now() RETURNING *`,
      [
        ...values(ctx, versionId),
        data.revision + 1,
        data.entry,
        JSON.stringify(data.items),
        data.instructions,
        data.limitations,
        check ? JSON.stringify(check) : null,
      ],
    )
  ).rows[0]
  return draftView(db, ctx, versionId, saved, snapshot, null)
}
export async function checkAcceptance(db, ctx, versionId, revision) {
  const { row, snapshot, version } = await mutableDraft(db, ctx, versionId, revision)
  if (!row) throw fail(409, '请先保存验收记录')
  if (!validEntry(snapshot, row.entry))
    throw fail(409, '保存的版本没有所选 HTML 网页成果，无法检查成果包')
  const evidence = {
    status: 'failed',
    entry: row.entry,
    snapshotSha256: snapshotSha256(version),
    fileCount: deliveryFiles(version.files).length,
    packageBytes: 0,
    checkedAt: new Date().toISOString(),
    detail:
      '系统文件检查失败，无法组装静态成果包。仅检查文件与成果包可用性，不验证功能、浏览器兼容性或玩法正确性。',
  }
  try {
    const bytes = await productZip(snapshot, row.entry)
    if (!bytes.length) throw new Error('Empty product package')
    evidence.status = 'passed'
    evidence.packageBytes = bytes.length
    evidence.detail =
      '所选 HTML 存在于保存版本，已成功组装静态成果 ZIP。仅检查文件与成果包可用性，不验证功能、浏览器兼容性或玩法正确性。'
  } catch {
    // Only actual package assembly is evidence. Auth, selection and revision errors remain HTTP errors.
  }
  const saved = (
    await db.query(
      'UPDATE employee_project_acceptance SET system_check=$5,revision=revision+1,updated_at=now() WHERE version_id=$1 AND workspace_id=$2 AND tenant_id=$3 AND user_id=$4 RETURNING *',
      [...values(ctx, versionId), JSON.stringify(evidence)],
    )
  ).rows[0]
  return draftView(db, ctx, versionId, saved, snapshot, null)
}
export async function confirmDelivery(db, ctx, versionId, revision, label, testRunId) {
  const { row, snapshot, version } = await mutableDraft(db, ctx, versionId, revision)
  const automatedTest = await deliveryTestEvidence(db, ctx, version, testRunId)
  if (
    !row ||
    !validEntry(snapshot, row.entry) ||
    !row.instructions.trim() ||
    !row.limitations.trim() ||
    !row.items.length ||
    row.items.some((item) => item.status !== 'passed' || !item.note.trim()) ||
    row.system_check?.status !== 'passed' ||
    row.system_check.entry !== row.entry ||
    row.system_check.snapshotSha256 !== snapshotSha256(version) ||
    row.system_check.packageBytes <= 0
  )
    throw fail(409, '请先完成并保存全部用户试玩确认、系统文件检查、使用说明与已知限制')
  const result = (
    await db.query(
      `INSERT INTO employee_project_deliveries(id,version_id,workspace_id,tenant_id,user_id,version_label,source_revision,label,entry,items,system_check,instructions,limitations,automated_test)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        randomUUID(),
        ...values(ctx, versionId),
        version.label,
        version.source_revision,
        label,
        row.entry,
        JSON.stringify(row.items),
        JSON.stringify(row.system_check),
        row.instructions,
        row.limitations,
        JSON.stringify(automatedTest),
      ],
    )
  ).rows[0]
  return deliveryView(result)
}
export async function listDeliveries(db, ctx) {
  await projectRow(db, ctx)
  return (
    await db.query(
      'SELECT * FROM employee_project_deliveries WHERE workspace_id=$1 AND tenant_id=$2 AND user_id=$3 ORDER BY created_at DESC,id DESC',
      [ctx.projectId, ctx.tenantId, ctx.userId],
    )
  ).rows.map(deliveryView)
}
export async function ownedDelivery(db, ctx, id) {
  const project = await projectRow(db, ctx)
  const row = (
    await db.query(
      'SELECT * FROM employee_project_deliveries WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3 AND user_id=$4',
      [id, ctx.projectId, ctx.tenantId, ctx.userId],
    )
  ).rows[0]
  if (!row) throw fail(404, '正式交付记录不存在')
  return {
    delivery: deliveryView(row),
    snapshot: versionDeliverySnapshot(project, await ownedVersion(db, ctx, row.version_id)),
  }
}
