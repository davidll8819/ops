import { randomUUID, createHash } from 'node:crypto'
import { fail } from '../db.mjs'
import { validProgress } from './worker.mjs'
const parserVersion = 'archive-2'
export const supportedDocument = (name) => /\.(docx|pdf|xlsx|png|jpe?g|webp)$/i.test(name)
async function original(db, ctx, fileId, { lock = false } = {}) {
  const row = (
    await db.query(
      `SELECT id,name,mime,${lock ? 'data,' : ''}octet_length(data) size,created_at FROM workspace_files WHERE id=$1 AND tenant_id=$2 AND user_id=$3${lock ? ' FOR UPDATE' : ''}`,
      [fileId, ctx.tenantId, ctx.userId],
    )
  ).rows[0]
  if (!row) throw fail(404, '文件不存在')
  if (!supportedDocument(row.name))
    throw fail(400, '请选择 DOCX、PDF、XLSX、PNG、JPG/JPEG 或 WebP 文件；旧版 DOC/XLS 请先转换格式')
  return row
}
async function recover(db, ctx, fileId) {
  await db.query(
    "UPDATE archive_documents SET state='failed',progress=NULL,lease_until=NULL,error='上次解析已中断或超时，请重试',updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND state='processing' AND lease_until<=now() AND ($3::uuid IS NULL OR file_id=$3)",
    [ctx.tenantId, ctx.userId, fileId || null],
  )
}
function document(file, extraction, preview = false) {
  return {
    fileId: file.id,
    name: file.name,
    mime: file.mime,
    size: file.size,
    createdAt: file.created_at,
    extractionId: extraction?.id || null,
    sha256: extraction?.sha256 || null,
    kind: extraction?.kind || null,
    state: extraction?.state || 'unparsed',
    error: extraction?.error || null,
    warnings: extraction?.warnings || [],
    blockCount: extraction?.block_count ?? extraction?.blocks?.length ?? 0,
    ...(extraction?.state === 'processing' && validProgress(extraction.progress)
      ? { progress: extraction.progress }
      : {}),
    ...(extraction?.state === 'ready' ? { ocr: Boolean(extraction.stats?.ocr) } : {}),
    ...(preview ? { blocks: extraction?.state === 'ready' ? extraction.blocks : [] } : {}),
  }
}
async function extraction(db, ctx, id) {
  return (
    await db.query(
      'SELECT * FROM archive_documents WHERE file_id=$1 AND tenant_id=$2 AND user_id=$3',
      [id, ctx.tenantId, ctx.userId],
    )
  ).rows[0]
}
export async function getDocument(db, ctx, id, { preview = true } = {}) {
  const file = await original(db, ctx, id)
  await recover(db, ctx, id)
  return document(file, await extraction(db, ctx, id), preview)
}
export async function listDocuments(db, ctx) {
  await recover(db, ctx)
  const files = (
    await db.query(
      'SELECT id,name,mime,octet_length(data) size,created_at FROM workspace_files WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC,id',
      [ctx.tenantId, ctx.userId],
    )
  ).rows.filter((f) => supportedDocument(f.name))
  const rows = (
    await db.query(
      'SELECT id,file_id,sha256,kind,state,error,warnings,progress,stats,jsonb_array_length(blocks) block_count FROM archive_documents WHERE tenant_id=$1 AND user_id=$2',
      [ctx.tenantId, ctx.userId],
    )
  ).rows
  return files.map((file) =>
    document(
      file,
      rows.find((row) => row.file_id === file.id),
    ),
  )
}
export async function claimParse(db, ctx, fileId) {
  const file = await original(db, ctx, fileId, { lock: true })
  await recover(db, ctx, fileId)
  const current = await extraction(db, ctx, fileId)
  if (current?.state === 'ready' || current?.state === 'processing')
    return { document: document(file, current) }
  const attemptId = randomUUID()
  const leaseSeconds = /\.(pdf|png|jpe?g|webp)$/i.test(file.name) ? 360 : 90
  if (current)
    await db.query(
      "UPDATE archive_documents SET state='processing',attempt_id=$4,attempts=attempts+1,lease_until=now()+$5*interval '1 second',parser_version=$6,progress=NULL,error=NULL,updated_at=now() WHERE file_id=$1 AND tenant_id=$2 AND user_id=$3 AND state='failed'",
      [fileId, ctx.tenantId, ctx.userId, attemptId, leaseSeconds, parserVersion],
    )
  else
    await db.query(
      "INSERT INTO archive_documents(id,file_id,tenant_id,user_id,sha256,parser_version,state,attempt_id,lease_until) VALUES($1,$2,$3,$4,$5,$6,'processing',$7,now()+$8*interval '1 second')",
      [
        randomUUID(),
        fileId,
        ctx.tenantId,
        ctx.userId,
        createHash('sha256').update(Buffer.from(file.data)).digest('hex'),
        parserVersion,
        attemptId,
        leaseSeconds,
      ],
    )
  return { attemptId, input: { name: file.name, bytes: Buffer.from(file.data) } }
}
export async function saveParseProgress(db, ctx, fileId, attemptId, progress) {
  if (!validProgress(progress)) return
  await db.query(
    "UPDATE archive_documents SET progress=$5,updated_at=now() WHERE file_id=$1 AND tenant_id=$2 AND user_id=$3 AND attempt_id=$4 AND state='processing' AND lease_until>now()",
    [fileId, ctx.tenantId, ctx.userId, attemptId, JSON.stringify(progress)],
  )
}
export async function finishParse(db, ctx, fileId, attemptId, { result, error }) {
  if (result)
    await db.query(
      "UPDATE archive_documents SET state='ready',kind=$5,blocks=$6,warnings=$7,stats=$8,progress=NULL,error=NULL,lease_until=NULL,updated_at=now() WHERE file_id=$1 AND tenant_id=$2 AND user_id=$3 AND attempt_id=$4 AND state='processing' AND lease_until>now()",
      [
        fileId,
        ctx.tenantId,
        ctx.userId,
        attemptId,
        result.kind,
        JSON.stringify(result.blocks),
        JSON.stringify(result.warnings),
        JSON.stringify(result.stats),
      ],
    )
  else
    await db.query(
      "UPDATE archive_documents SET state='failed',error=$5,progress=NULL,lease_until=NULL,updated_at=now() WHERE file_id=$1 AND tenant_id=$2 AND user_id=$3 AND attempt_id=$4 AND state='processing' AND lease_until>now()",
      [fileId, ctx.tenantId, ctx.userId, attemptId, error],
    )
  return getDocument(db, ctx, fileId, { preview: false })
}
export async function selectedDocuments(db, ctx, fileIds) {
  const documents = []
  for (const id of fileIds) {
    const selected = await getDocument(db, ctx, id)
    if (selected.state !== 'ready') throw fail(409, '所选文件尚未解析完成，请完成解析或重试后提问')
    documents.push(selected)
  }
  return documents
}
