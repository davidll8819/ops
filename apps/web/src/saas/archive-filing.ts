import type { ArchiveCitation, ArchiveDocument } from './archive-documents'
export type FilingSuggestion = {
  id: string
  state: 'processing' | 'ready' | 'failed'
  source: {
    fileId: string
    name: string
    extractionId: string
    sha256: string
    parserVersion: string
    kind: string
    ocr: boolean
  }
  archiveNumber: string
  archiveYear: string
  createdAt: string
  updatedAt: string
  error?: string
  result?: {
    title: string
    department: string
    category: string
    tags: string[]
    reason: string
    needsReview: boolean
    citations: ArchiveCitation[]
    coverage: string
    warnings: string[]
    recommendedName: string
    directory: string
    relativePath: string
  }
}
export function matchesFilingSuggestion(suggestion: FilingSuggestion, document: ArchiveDocument) {
  return (
    document.state === 'ready' &&
    suggestion.source?.fileId === document.fileId &&
    suggestion.source?.extractionId === document.extractionId &&
    suggestion.source?.sha256 === document.sha256 &&
    suggestion.source?.name === document.name &&
    ['ready', 'processing', 'failed'].includes(suggestion.state) &&
    (suggestion.state !== 'ready' || !!suggestion.result)
  )
}
export function filingDirectoryText(documents: ArchiveDocument[], suggestions: FilingSuggestion[]) {
  const ready = documents.flatMap((document) => {
    const suggestion = suggestions.find(
      (value) =>
        value.state === 'ready' && value.result && matchesFilingSuggestion(value, document),
    )
    return suggestion ? [suggestion] : []
  })
  return [
    '归档目录（待确认建议）',
    `当前选中资料：${ready.length}/${documents.length} 份已生成建议；未就绪资料不在以下目录中。`,
    '以下为系统建议，未正式入库，未重命名或移动原文件；年份为生成建议时的归档年份，不是文档日期。',
    '',
    ...ready.flatMap((s) => [
      s.result!.relativePath,
      `  原文件：${s.source.name}`,
      `  建议档案号：${s.archiveNumber}`,
      `  建议归属：${s.result!.department} / ${s.result!.category}`,
      `  标签：${s.result!.tags.join('、')}`,
      `  推荐依据：${s.result!.reason}`,
      `  核对提示：${s.result!.needsReview ? '需要重点核对' : '建议仍需人工确认'}`,
      `  来源版本：${s.source.extractionId} / SHA256 ${s.source.sha256}`,
      `  内容范围：${s.result!.coverage}`,
      ...s.result!.warnings.map((w) => `  提醒：${w}`),
      ...s.result!.citations.map((c) => `  出处：${c.filename} · ${c.location}「${c.quote}」`),
      '',
    ]),
  ].join('\n')
}
