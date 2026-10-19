import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { fail } from '../db.mjs'
import { filingDepartments, filingCategories, buildFilingResult } from './filing.mjs'
import { filingView, loadFilingDocument } from './filing-store.mjs'

export const recordMetadata = z
  .object({
    title: z.string().trim().min(1).max(80),
    department: z.enum(filingDepartments),
    category: z.enum(filingCategories),
    tags: z
      .array(z.string().trim().min(1).max(20))
      .min(1)
      .max(6)
      .transform((tags) => [...new Set(tags)]),
    note: z.string().trim().max(600),
  })
  .strict()
export const recordRevision = z.number().int().min(1).max(2147483646)
export function recordView(row, suggestion, { evidence = true } = {}) {
  const s = filingView(suggestion),
    path = buildFilingResult({ ...row.metadata }, s.source, s.archiveNumber, s.archiveYear)
  return {
    id: row.id,
    suggestionId: row.suggestion_id,
    state: row.state,
    revision: row.revision,
    metadata: row.metadata,
    archiveNumber: s.archiveNumber,
    archiveYear: s.archiveYear,
    filename: path.recommendedName,
    directory: path.directory,
    relativePath: path.relativePath,
    source: s.source,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    confirmedBy: row.confirmed_by,
    ...(evidence ? { evidence: s.result } : {}),
  }
}
async function suggestionFor(db, ctx, id, { lock = false } = {}) {
  const s = (
    await db.query(
      "SELECT * FROM archive_filing_suggestions WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND state='ready'",
      [id, ctx.tenantId, ctx.userId],
    )
  ).rows[0]
  if (!s) throw fail(404, '归档建议不存在或尚未就绪')
  const doc = await loadFilingDocument(db, ctx, s.source.fileId, { lock })
  for (const k of ['fileId', 'name', 'extractionId', 'sha256', 'parserVersion', 'kind', 'ocr'])
    if (doc[k] !== s.source[k]) throw fail(409, '档案来源已变化，请重新上传资料')
  return s
}
async function rowFor(db, ctx, suggestionId, { lock = false } = {}) {
  return (
    await db.query(
      `SELECT * FROM archive_records WHERE suggestion_id=$1 AND tenant_id=$2 AND user_id=$3${lock ? ' FOR UPDATE' : ''}`,
      [suggestionId, ctx.tenantId, ctx.userId],
    )
  ).rows[0]
}
export async function readRecordDraft(db, ctx, suggestionId) {
  const s = await suggestionFor(db, ctx, suggestionId)
  const r = await rowFor(db, ctx, suggestionId)
  return r ? recordView(r, s) : null
}
export async function saveRecordDraft(db, ctx, suggestionId, { revision, metadata }) {
  const s = await suggestionFor(db, ctx, suggestionId, { lock: true })
  const identity = filingView(s),
    filename = buildFilingResult(
      metadata,
      identity.source,
      identity.archiveNumber,
      identity.archiveYear,
    ).recommendedName
  if (revision === 0) {
    const r = (
      await db.query(
        'INSERT INTO archive_records(id,tenant_id,user_id,suggestion_id,metadata,filename) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(suggestion_id) DO NOTHING RETURNING *',
        [randomUUID(), ctx.tenantId, ctx.userId, suggestionId, JSON.stringify(metadata), filename],
      )
    ).rows[0]
    if (!r) throw fail(409, '归档草稿已更新，请重新载入后修改')
    return recordView(r, s)
  }
  const r = await rowFor(db, ctx, suggestionId, { lock: true })
  if (!r || r.state !== 'draft' || r.revision !== revision)
    throw fail(409, '归档草稿已更新或已正式归档，请重新载入')
  const next = (
    await db.query(
      'UPDATE archive_records SET metadata=$2,filename=$3,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',
      [r.id, JSON.stringify(metadata), filename],
    )
  ).rows[0]
  return recordView(next, s)
}
async function recordIdentity(db, ctx, id) {
  const r = (
    await db.query('SELECT * FROM archive_records WHERE id=$1 AND tenant_id=$2 AND user_id=$3', [
      id,
      ctx.tenantId,
      ctx.userId,
    ])
  ).rows[0]
  if (!r) throw fail(404, '档案不存在')
  return r
}
export async function confirmRecord(db, ctx, id, revision) {
  const initial = await recordIdentity(db, ctx, id),
    s = await suggestionFor(db, ctx, initial.suggestion_id, { lock: true }),
    r = await rowFor(db, ctx, initial.suggestion_id, { lock: true })
  if (r.revision !== revision) throw fail(409, '归档草稿版本已变化，请重新载入后核对')
  if (r.state === 'archived') return recordView(r, s)
  const saved = (
    await db.query(
      "UPDATE archive_records SET state='archived',archived_at=now(),confirmed_by=$2,updated_at=now() WHERE id=$1 RETURNING *",
      [id, ctx.userId],
    )
  ).rows[0]
  return recordView(saved, s)
}
export async function readArchivedRecord(db, ctx, id) {
  const r = await recordIdentity(db, ctx, id)
  if (r.state !== 'archived') throw fail(404, '正式档案不存在')
  const s = await suggestionFor(db, ctx, r.suggestion_id)
  return recordView(r, s)
}
const literal = (s) => s.replace(/[\\%_]/g, '\\$&')
export async function listArchivedRecords(db, ctx, { category = '', tag = '', q = '', page = 1 }) {
  const where = ['r.tenant_id=$1', 'r.user_id=$2', "r.state='archived'"],
    params = [ctx.tenantId, ctx.userId]
  const add = (sql, value) => {
    params.push(value)
    where.push(sql.replaceAll('?', `$${params.length}`))
  }
  if (category) add("r.metadata->>'category'=?", category)
  if (tag) add("r.metadata->'tags' @> ?::jsonb", JSON.stringify([tag]))
  if (q)
    add(
      "(r.metadata->>'title' ILIKE ? ESCAPE '\\' OR r.filename ILIKE ? ESCAPE '\\')",
      '%' + literal(q) + '%',
    )
  const predicate = where.join(' AND '),
    join =
      ' FROM archive_records r JOIN archive_filing_suggestions s ON s.id=r.suggestion_id AND s.tenant_id=r.tenant_id AND s.user_id=r.user_id '
  const total = Number(
    (await db.query('SELECT count(*)::int n' + join + 'WHERE ' + predicate, params)).rows[0].n,
  )
  const rows = (
    await db.query(
      'SELECT r.*,to_jsonb(s) suggestion' +
        join +
        'WHERE ' +
        predicate +
        ` ORDER BY r.archived_at DESC,r.id DESC LIMIT 20 OFFSET $${params.length + 1}`,
      [...params, (page - 1) * 20],
    )
  ).rows
  return {
    items: rows.map((row) => recordView(row, row.suggestion, { evidence: false })),
    total,
    page,
    pageSize: 20,
  }
}
