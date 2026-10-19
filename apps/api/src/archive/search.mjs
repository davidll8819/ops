import { fail } from '../db.mjs'
import { loadFilingDocument, filingView } from './filing-store.mjs'
import { buildDocumentContext } from './context.mjs'
const stop = new Set([
  '请问',
  '请帮',
  '帮我',
  '我查',
  '查询',
  '检索',
  '已归',
  '归档',
  '档资',
  '资料',
  '文档',
  '回答',
  '什么',
  '多少',
  '一下',
  '告诉',
  '根据',
  '当前',
  '中的',
  '里面',
  '是否',
  '哪些',
  '以及',
  '还有',
  '这个',
  '那份',
  '这份',
  '需要',
  '问题',
  '要求',
  '给我',
  '我们',
  '你们',
  '请从',
  '档案',
  '已在',
])
export function archiveQueryTerms(text = '') {
  const value = text.normalize('NFKC').toLowerCase(),
    terms = [...(value.match(/zl-\d{4}-\d{6,}/g) || []), ...(value.match(/[a-z0-9]+/g) || [])]
  for (const word of value.match(/[\p{Script=Han}]+/gu) || [])
    for (let i = 0; i < word.length - 1; i++) terms.push(word.slice(i, i + 2))
  return [...new Set(terms)].filter((t) => !stop.has(t)).slice(0, 32)
}
const pattern = (t) => '%' + t.replace(/[\\%_]/g, '\\$&') + '%'
const referenceFor = (row, identity) => ({
  id: row.id,
  archiveNumber: identity.archiveNumber,
  filename: row.filename,
  fileId: identity.source.fileId,
  extractionId: identity.source.extractionId,
  sha256: identity.source.sha256,
})
async function checkedDocument(db, ctx, row, { lock = false } = {}) {
  const s = filingView(row.suggestion),
    doc = await loadFilingDocument(db, ctx, s.source.fileId, { lock })
  for (const key of ['fileId', 'name', 'extractionId', 'sha256', 'parserVersion', 'kind', 'ocr'])
    if (doc[key] !== s.source[key]) throw fail(409, '已归档资料来源已变化，请核对原件后重试')
  return { ...doc, archive: { id: row.id, archiveNumber: s.archiveNumber, filename: row.filename } }
}
export async function searchArchivedDocuments(db, ctx, { question, history = [] }) {
  const primary = archiveQueryTerms(question),
    secondary = archiveQueryTerms(
      history
        .filter((m) => m.role === 'user' && m.archiveSearch)
        .slice(-2)
        .map((m) => m.text)
        .join('\n'),
    )
  const reference = { query: question, matchedCount: 0, records: [] },
    documents = []
  if (!primary.length) return { documents, reference }
  const rows = (
    await db.query(
      `
 SELECT r.id,r.filename,to_jsonb(s) suggestion,count(*) OVER() matched_count
 FROM archive_records r
 JOIN archive_filing_suggestions s ON s.id=r.suggestion_id AND s.tenant_id=r.tenant_id AND s.user_id=r.user_id AND s.state='ready'
 JOIN archive_documents d ON d.id=s.extraction_id AND d.tenant_id=r.tenant_id AND d.user_id=r.user_id AND d.state='ready'
 CROSS JOIN LATERAL (SELECT lower(r.filename||' '||r.metadata::text||' '||d.blocks::text) text) content
 CROSS JOIN LATERAL (SELECT count(*) n FROM unnest($3::text[]) term WHERE content.text LIKE term ESCAPE '\\') primary_hits
 CROSS JOIN LATERAL (SELECT count(*) n FROM unnest($4::text[]) term WHERE content.text LIKE term ESCAPE '\\') history_hits
 WHERE r.tenant_id=$1 AND r.user_id=$2 AND r.state='archived' AND primary_hits.n>0
 AND (cardinality($5::text[])=0 OR lower('ZL-'||to_char(s.created_at AT TIME ZONE 'Asia/Shanghai','YYYY')||'-'||lpad(s.serial_number::text,GREATEST(6,length(s.serial_number::text)),'0'))=ANY($5::text[]))
 ORDER BY (primary_hits.n*100+history_hits.n) DESC,r.archived_at DESC,r.id DESC LIMIT 4`,
      [
        ctx.tenantId,
        ctx.userId,
        primary.map(pattern),
        secondary.map(pattern),
        primary.filter((t) => /^zl-\d{4}-\d{6,}$/.test(t)),
      ],
    )
  ).rows
  reference.matchedCount = Number(rows[0]?.matched_count || 0)
  for (const row of rows) {
    documents.push(await checkedDocument(db, ctx, row))
    reference.records.push(referenceFor(row, filingView(row.suggestion)))
  }
  return { documents, reference }
}
export function buildArchivedContext({ documents, reference }) {
  const base = buildDocumentContext(documents, { question: reference.query }),
    byFile = new Map(documents.map((d) => [d.fileId, d.archive]))
  const sources = base.sources.map((s) => ({
    ...s,
    archiveRecordId: byFile.get(s.fileId).id,
    archiveNumber: byFile.get(s.fileId).archiveNumber,
    archiveName: byFile.get(s.fileId).filename,
  }))
  const documentCoverage = `本轮在你当前企业可访问的正式档案中按关键词检索，匹配 ${reference.matchedCount} 份，本轮使用 ${documents.length} 份相关档案摘录；关键词匹配不代表语义穷尽检索。 ${base.documentCoverage || '仅依据本轮提供的已提取正文作答。'}`
  const content = JSON.parse(base.content)
  content.sources = content.sources.map((s, i) => ({
    ...s,
    archiveNumber: sources[i].archiveNumber,
    archiveName: sources[i].archiveName,
  }))
  content.documentCoverage = documentCoverage
  content.extractionWarnings = documents
    .flatMap((d) => (d.warnings || []).map((w) => `${d.name}：${w}`))
    .join('\n')
    .slice(0, 2000)
  return {
    ...base,
    sources,
    documentCoverage,
    instructions:
      base.instructions +
      ' 本轮是正式档案检索问答。档案号与正式名称仅用于标识来源，不代表所有档案或原文均已审查。',
    content: JSON.stringify(content),
  }
}
export const missingArchiveReply =
  '本轮未找到可用的相关正式档案摘录，暂时无法据此回答。请补充档案号、资料主题或问题关键词后再问。'
export async function revalidateArchivedSearch(db, ctx, { reference }) {
  for (const ref of [...reference.records].sort((a, b) => a.fileId.localeCompare(b.fileId))) {
    const row = (
      await db.query(
        "SELECT r.id,r.filename,to_jsonb(s) suggestion FROM archive_records r JOIN archive_filing_suggestions s ON s.id=r.suggestion_id AND s.tenant_id=r.tenant_id AND s.user_id=r.user_id WHERE r.id=$1 AND r.tenant_id=$2 AND r.user_id=$3 AND r.state='archived' AND s.state='ready'",
        [ref.id, ctx.tenantId, ctx.userId],
      )
    ).rows[0]
    if (!row) throw fail(409, '本轮检索的正式档案已不可访问，请重新提问')
    await checkedDocument(db, ctx, row, { lock: true })
    const actual = referenceFor(row, filingView(row.suggestion))
    for (const key of Object.keys(actual))
      if (actual[key] !== ref[key]) throw fail(409, '正式档案来源版本已变化，请重新提问')
  }
}
