import { randomUUID, createHash } from 'node:crypto'
import { fail } from '../db.mjs'

export const comparisonAlgorithmVersion = 'text-diff-1'
export function comparisonSource(document) {
  const { fileId, name, extractionId, sha256, parserVersion, kind, ocr } = document
  return { fileId, name, extractionId, sha256, parserVersion, kind, ocr }
}
export function comparisonReference(comparison) {
  const { id, createdAt, oldVersion, newVersion, algorithmVersion, stats, overview } = comparison
  return { id, createdAt, oldVersion, newVersion, algorithmVersion, stats, overview }
}
function comparison(row) {
  return {
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    ...row.sources,
    ...row.result,
    algorithmVersion: row.algorithm_version,
  }
}

// This loader never reparses. Locks are used only for the final identity check/write.
export async function loadComparisonInputs(db, ctx, oldFileId, newFileId, { lock = false } = {}) {
  if (oldFileId === newFileId) throw fail(400, '请选择两个不同文件作为旧版和新版')
  const rows = (
    await db.query(
      `SELECT id,name,data FROM workspace_files WHERE id=ANY($1::uuid[]) AND tenant_id=$2 AND user_id=$3 ORDER BY id${lock ? ' FOR SHARE' : ''}`,
      [[oldFileId, newFileId], ctx.tenantId, ctx.userId],
    )
  ).rows
  if (rows.length !== 2) throw fail(404, '文件不存在')
  const extractions = (
    await db.query(
      'SELECT * FROM archive_documents WHERE file_id=ANY($1::uuid[]) AND tenant_id=$2 AND user_id=$3',
      [[oldFileId, newFileId], ctx.tenantId, ctx.userId],
    )
  ).rows
  const documents = new Map()
  for (const file of rows) {
    const extraction = extractions.find((d) => d.file_id === file.id)
    if (extraction?.state !== 'ready')
      throw fail(409, '所选文件尚未解析完成，请完成解析或重试后比对')
    const bytes = Buffer.from(file.data)
    if (bytes.length > 6 * 1024 * 1024) throw fail(413, '文件超过 6 MiB，请拆分文件后比对')
    if (createHash('sha256').update(bytes).digest('hex') !== extraction.sha256)
      throw fail(409, '原文件与已提取文字的校验不一致，请重新上传文件')
    documents.set(file.id, {
      fileId: file.id,
      name: file.name,
      extractionId: extraction.id,
      sha256: extraction.sha256,
      parserVersion: extraction.parser_version,
      kind: extraction.kind,
      ocr: Boolean(extraction.stats?.ocr),
      blocks: extraction.blocks,
      warnings: extraction.warnings,
    })
  }
  return [documents.get(oldFileId), documents.get(newFileId)]
}

function assertIdentity(documents, sources) {
  const current = {
    oldVersion: comparisonSource(documents[0]),
    newVersion: comparisonSource(documents[1]),
  }
  // JSONB object key order is not stable; compare canonical source fields individually.
  for (const side of ['oldVersion', 'newVersion'])
    for (const key of Object.keys(current[side]))
      if (current[side][key] !== sources[side][key])
        throw fail(409, '比对来源已变化，请重新选择文件')
}

export async function persistComparison(db, ctx, documents, result) {
  if (Buffer.byteLength(JSON.stringify(result)) > 6 * 1024 * 1024)
    throw fail(413, '比对结果超过 6 MiB，请拆分文件后比对')
  const sources = {
    oldVersion: comparisonSource(documents[0]),
    newVersion: comparisonSource(documents[1]),
  }
  const current = await loadComparisonInputs(
    db,
    ctx,
    sources.oldVersion.fileId,
    sources.newVersion.fileId,
    { lock: true },
  )
  assertIdentity(current, sources)
  const args = [
    ctx.tenantId,
    ctx.userId,
    sources.oldVersion.extractionId,
    sources.newVersion.extractionId,
    comparisonAlgorithmVersion,
  ]
  await db.query(
    'INSERT INTO archive_comparisons(id,tenant_id,user_id,old_extraction_id,new_extraction_id,algorithm_version,sources,result) VALUES($6,$1,$2,$3,$4,$5,$7,$8) ON CONFLICT(tenant_id,user_id,old_extraction_id,new_extraction_id,algorithm_version) DO NOTHING',
    [...args, randomUUID(), JSON.stringify(sources), JSON.stringify(result)],
  )
  const row = (
    await db.query(
      'SELECT * FROM archive_comparisons WHERE tenant_id=$1 AND user_id=$2 AND old_extraction_id=$3 AND new_extraction_id=$4 AND algorithm_version=$5',
      args,
    )
  ).rows[0]
  return comparison(row)
}

export async function getComparison(db, ctx, id) {
  const row = (
    await db.query(
      'SELECT * FROM archive_comparisons WHERE id=$1 AND tenant_id=$2 AND user_id=$3',
      [id, ctx.tenantId, ctx.userId],
    )
  ).rows[0]
  if (!row) throw fail(404, '比对记录不存在')
  const documents = await loadComparisonInputs(
    db,
    ctx,
    row.sources.oldVersion.fileId,
    row.sources.newVersion.fileId,
  )
  assertIdentity(documents, row.sources)
  return comparison(row)
}

export async function listComparisons(db, ctx) {
  // Fetch no result hunks for lightweight history, even internally.
  const rows = (
    await db.query(
      "SELECT id,created_at,sources,algorithm_version,result->'stats' stats,result->>'overview' overview FROM archive_comparisons WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC,id LIMIT 20",
      [ctx.tenantId, ctx.userId],
    )
  ).rows
  return rows.map((row) =>
    comparisonReference({
      id: row.id,
      createdAt: new Date(row.created_at).toISOString(),
      ...row.sources,
      algorithmVersion: row.algorithm_version,
      stats: row.stats,
      overview: row.overview,
    }),
  )
}
