import type { FilingSuggestion } from './archive-filing'
export const archiveDepartments = [
  '程序部',
  '资料室',
  '运营部',
  '市场调研',
  '合规部',
  '设计部',
  '拓客部',
  '通用资料',
]
export const archiveCategories = [
  '制度流程',
  '合同协议',
  '项目资料',
  '财务资料',
  '人事行政',
  '市场调研',
  '设计素材',
  '运营资料',
  '其他资料',
]
export type ArchiveMetadata = {
  title: string
  department: string
  category: string
  tags: string[]
  note: string
}
export type ArchiveRecord = {
  id: string
  suggestionId: string
  state: 'draft' | 'archived'
  revision: number
  metadata: ArchiveMetadata
  archiveNumber: string
  archiveYear: string
  filename: string
  directory: string
  relativePath: string
  source: FilingSuggestion['source']
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  confirmedBy: string | null
  evidence?: FilingSuggestion['result']
}
export const sameRecordSource = (record: ArchiveRecord, suggestion: FilingSuggestion) =>
  record.suggestionId === suggestion.id &&
  ['fileId', 'extractionId', 'sha256', 'name'].every(
    (k) =>
      record.source?.[k as keyof ArchiveRecord['source']] ===
      suggestion.source[k as keyof ArchiveRecord['source']],
  )
