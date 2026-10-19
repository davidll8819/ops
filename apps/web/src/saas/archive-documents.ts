export type ArchiveBlock = {
  id: string
  location: string
  text: string
  method?: 'ocr'
  page?: number
}
export type ArchiveDocument = {
  fileId: string
  name: string
  mime: string
  size: number
  createdAt: string
  extractionId: string | null
  sha256: string | null
  kind: string | null
  state: 'unparsed' | 'processing' | 'ready' | 'failed'
  error: string | null
  warnings: string[]
  blockCount: number
  progress?: { stage: 'extracting' | 'ocr'; page: number; totalPages: number }
  ocr?: boolean
}
export type ArchiveDetail = ArchiveDocument & { blocks: ArchiveBlock[] }
export type ArchiveFileReference = {
  fileId: string
  name: string
  extractionId: string
  sha256: string
}
export type ArchiveCitation = {
  id: string
  fileId: string
  extractionId: string
  sha256: string
  filename: string
  blockId: string
  location: string
  quote: string
  method?: 'ocr'
  page?: number
  comparisonId?: string
  changeId?: string
  side?: 'old' | 'new'
  archiveRecordId?: string
  archiveNumber?: string
  archiveName?: string
}
export type ArchiveSearchReference = {
  query: string
  matchedCount: number
  records: {
    id: string
    archiveNumber: string
    filename: string
    fileId: string
    extractionId: string
    sha256: string
  }[]
}

export const archiveOcrCaution = 'OCR 识别可能有误，尤其是数字、手写或模糊内容；请核对原文件。'

export function archiveImagePreview(base: string, document: ArchiveDetail): string | null {
  return document.state === 'ready' &&
    document.kind === 'image' &&
    !!document.fileId &&
    !!document.extractionId &&
    !!document.sha256 &&
    ['image/png', 'image/jpeg', 'image/webp'].includes(document.mime)
    ? `${base}/files/${encodeURIComponent(document.fileId)}/preview`
    : null
}

export function selectedArchiveFiles(ids: string[], documents: ArchiveDocument[]): string[] {
  const ready = new Set(
    documents.filter((item) => item.state === 'ready').map((item) => item.fileId),
  )
  return [...new Set(ids)].filter((id) => ready.has(id)).slice(0, 4)
}
export function toggleArchiveFile(ids: string[], id: string, documents: ArchiveDocument[]) {
  const selected = selectedArchiveFiles(ids, documents)
  if (selected.includes(id)) return { ids: selected.filter((value) => value !== id), error: '' }
  if (!documents.some((item) => item.fileId === id && item.state === 'ready'))
    return { ids: selected, error: '文档解析完成后才能选择' }
  if (selected.length >= 4) return { ids: selected, error: '最多选择 4 份文档' }
  return { ids: [...selected, id], error: '' }
}
export function createArchiveRequestScope() {
  let version = 0
  return {
    begin() {
      const request = ++version
      return () => request === version
    },
    invalidate() {
      version++
    },
  }
}
const normalized = (text: string) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim()
export function matchingCitationBlock(
  citation: ArchiveCitation,
  document: ArchiveDetail,
): ArchiveBlock | null {
  if (
    document.state !== 'ready' ||
    document.fileId !== citation.fileId ||
    !citation.sha256 ||
    document.extractionId !== citation.extractionId ||
    document.sha256 !== citation.sha256 ||
    !normalized(citation.quote)
  )
    return null
  return (
    document.blocks.find(
      (block) =>
        block.id === citation.blockId &&
        block.location === citation.location &&
        block.method === citation.method &&
        (citation.page === undefined || block.page === citation.page) &&
        normalized(block.text).includes(normalized(citation.quote)),
    ) || null
  )
}
export function readArchiveSelection(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw || '[]')
    return Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => typeof item === 'string'))].slice(0, 4)
      : []
  } catch {
    return []
  }
}
