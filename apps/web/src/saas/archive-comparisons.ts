import type { ArchiveDocument } from './archive-documents'

export type ComparisonSide = {
  blockId: string
  location: string
  text: string
  method?: 'ocr'
  page?: number
}
export type Segment = { text: string; changed: boolean }
export type ComparisonHunk = {
  id: string
  type: 'equal' | 'added' | 'removed' | 'modified'
  granularity: 'inline' | 'block'
  old: ComparisonSide | null
  new: ComparisonSide | null
  oldSegments: Segment[]
  newSegments: Segment[]
}
export type ComparisonSource = {
  fileId: string
  name: string
  extractionId: string
  sha256: string
  parserVersion: string
  kind: string
  ocr: boolean
}
export type ComparisonReference = {
  id: string
  createdAt: string
  oldVersion: ComparisonSource
  newVersion: ComparisonSource
  algorithmVersion: string
  stats: { added: number; removed: number; modified: number; unchanged: number }
  overview: string
}
export type Comparison = ComparisonReference & { warnings: string[]; hunks: ComparisonHunk[] }

export function comparisonReference(comparison: Comparison): ComparisonReference {
  return {
    id: comparison.id,
    createdAt: comparison.createdAt,
    oldVersion: comparison.oldVersion,
    newVersion: comparison.newVersion,
    algorithmVersion: comparison.algorithmVersion,
    stats: comparison.stats,
    overview: comparison.overview,
  }
}

export function validComparisonPair(oldId: string, newId: string, documents: ArchiveDocument[]) {
  return (
    !!oldId &&
    oldId !== newId &&
    [oldId, newId].every((id) =>
      documents.some((document) => document.fileId === id && document.state === 'ready'),
    )
  )
}
export function comparisonPage(hunks: ComparisonHunk[], showEqual: boolean, page: number) {
  return hunks
    .filter((hunk) => showEqual || hunk.type !== 'equal')
    .slice(page * 50, (page + 1) * 50)
}
