import { createHash, randomUUID } from 'node:crypto'
import { fail } from '../db.mjs'
import { buildFilingResult } from './filing.mjs'

export async function loadFilingDocument(db, ctx, fileId, { lock = false } = {}) {
  const file = (
    await db.query(
      `SELECT id,name,data FROM workspace_files WHERE id=$1 AND tenant_id=$2 AND user_id=$3${lock ? ' FOR SHARE' : ''}`,
      [fileId, ctx.tenantId, ctx.userId],
    )
  ).rows[0]
  if (!file) throw fail(404, '文件不存在')
  const extraction = (
    await db.query(
      'SELECT * FROM archive_documents WHERE file_id=$1 AND tenant_id=$2 AND user_id=$3',
      [fileId, ctx.tenantId, ctx.userId],
    )
  ).rows[0]
  if (extraction?.state !== 'ready') throw fail(409, '文件尚未解析完成，请完成解析后生成归档建议')
  const bytes = Buffer.from(file.data)
  if (bytes.length > 6 * 1024 * 1024) throw fail(413, '文件超过 6 MiB，请拆分后上传')
  if (createHash('sha256').update(bytes).digest('hex') !== extraction.sha256)
    throw fail(409, '原文件与已提取文字的校验不一致，请重新上传')
  return {
    fileId,
    name: file.name,
    extractionId: extraction.id,
    sha256: extraction.sha256,
    parserVersion: extraction.parser_version,
    kind: extraction.kind,
    ocr: Boolean(extraction.stats?.ocr),
    blocks: extraction.blocks,
    warnings: extraction.warnings,
  }
}
const sourceOf = ({ fileId, name, extractionId, sha256, parserVersion, kind, ocr }) => ({
  fileId,
  name,
  extractionId,
  sha256,
  parserVersion,
  kind,
  ocr,
})
function assertSource(document, source) {
  for (const [key, value] of Object.entries(sourceOf(document)))
    if (value !== source[key]) throw fail(409, '归档建议来源已变化，请重新上传资料')
}
export function filingView(row) {
  const archiveYear = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
  }).format(new Date(row.created_at))
  return {
    id: row.id,
    state: row.state,
    source: row.source,
    archiveNumber: `ZL-${archiveYear}-${String(row.serial_number).padStart(6, '0')}`,
    archiveYear,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.error ? { error: row.error } : {}),
    ...(row.state === 'ready' ? { result: row.result } : {}),
  }
}
async function rowFor(db, ctx, extractionId, lock = false) {
  return (
    await db.query(
      `SELECT * FROM archive_filing_suggestions WHERE extraction_id=$1 AND tenant_id=$2 AND user_id=$3${lock ? ' FOR UPDATE' : ''}`,
      [extractionId, ctx.tenantId, ctx.userId],
    )
  ).rows[0]
}
export async function readFiling(db, ctx, fileId) {
  const document = await loadFilingDocument(db, ctx, fileId)
  await db.query(
    "UPDATE archive_filing_suggestions SET state='failed',error='生成任务已过期，请手动重试。',lease_until=NULL,updated_at=now() WHERE extraction_id=$1 AND tenant_id=$2 AND user_id=$3 AND state='processing' AND lease_until<=now()",
    [document.extractionId, ctx.tenantId, ctx.userId],
  )
  const row = await rowFor(db, ctx, document.extractionId)
  if (!row) return null
  assertSource(document, row.source)
  return filingView(row)
}
export async function reserveFiling(db, ctx, fileId) {
  const document = await loadFilingDocument(db, ctx, fileId, { lock: true })
  await db.query(
    'INSERT INTO archive_filing_suggestions(id,tenant_id,user_id,extraction_id,source) VALUES($1,$2,$3,$4,$5) ON CONFLICT(extraction_id) DO NOTHING',
    [
      randomUUID(),
      ctx.tenantId,
      ctx.userId,
      document.extractionId,
      JSON.stringify(sourceOf(document)),
    ],
  )
  let row = await rowFor(db, ctx, document.extractionId, true)
  assertSource(document, row.source)
  if (
    row.state === 'ready' ||
    (row.state === 'processing' && new Date(row.lease_until) > new Date())
  )
    return { suggestion: filingView(row), claimed: false }
  const attemptId = randomUUID()
  row = (
    await db.query(
      "UPDATE archive_filing_suggestions SET state='processing',attempt_id=$2,lease_until=now()+interval '10 minutes',error=NULL,updated_at=now() WHERE id=$1 RETURNING *",
      [row.id, attemptId],
    )
  ).rows[0]
  return { suggestion: filingView(row), claimed: true, attemptId, document }
}
export async function completeFiling(db, ctx, reservation, value) {
  const document = await loadFilingDocument(db, ctx, reservation.suggestion.source.fileId, {
    lock: true,
  })
  assertSource(document, reservation.suggestion.source)
  const row = await rowFor(db, ctx, document.extractionId, true)
  if (
    row?.state !== 'processing' ||
    row.attempt_id !== reservation.attemptId ||
    new Date(row.lease_until) <= new Date()
  )
    throw fail(409, '归档建议任务已更新，请刷新查看结果')
  const identity = filingView(row),
    result = buildFilingResult(value, document, identity.archiveNumber, identity.archiveYear)
  const saved = (
    await db.query(
      "UPDATE archive_filing_suggestions SET state='ready',result=$2,error=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *",
      [row.id, JSON.stringify(result)],
    )
  ).rows[0]
  return filingView(saved)
}
export async function failFiling(db, ctx, reservation) {
  await db.query(
    "UPDATE archive_filing_suggestions SET state='failed',error='归档建议未生成，请检查模型设置或稍后手动重试。',lease_until=NULL,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND state='processing' AND attempt_id=$4",
    [reservation.suggestion.id, ctx.tenantId, ctx.userId, reservation.attemptId],
  )
}
