import { useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'
import {
  createArchiveRequestScope,
  archiveImagePreview,
  archiveOcrCaution,
  matchingCitationBlock,
  type ArchiveCitation,
  type ArchiveDetail,
} from './archive-documents'

function ArchiveCitationSource({ base, citation }: { base: string; citation: ArchiveCitation }) {
  const [detail, setDetail] = useState<ArchiveDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requests = useRef(createArchiveRequestScope())
  // The parent keys this component by the complete saved evidence identity.
  // Equivalent objects from a conversation refresh keep an in-flight preview.
  useEffect(() => {
    const scope = requests.current
    return () => scope.invalidate()
  }, [])
  async function preview() {
    const current = requests.current.begin()
    setLoading(true)
    setError('')
    setDetail(null)
    try {
      const result = await api<{ document: ArchiveDetail }>(
        `${base}/archive/documents/${encodeURIComponent(citation.fileId)}`,
      )
      if (current()) setDetail(result.document)
    } catch (failure) {
      if (current()) setError((failure as Error).message)
    } finally {
      if (current()) setLoading(false)
    }
  }
  const block = detail ? matchingCitationBlock(citation, detail) : null
  const image = block && detail ? archiveImagePreview(base, detail) : null
  return (
    <details className="archive-citation">
      <summary>
        [{citation.id}] {citation.side && `${t(citation.side === 'old' ? '旧版' : '新版')} · `}
        {citation.archiveNumber && `${citation.archiveNumber} · `}
        {citation.filename} · {citation.location}
      </summary>
      <p className="muted small">
        {t(citation.method === 'ocr' ? '识别文字摘录（OCR）' : '回答时保存的原文摘录')}
      </p>
      <blockquote>{citation.quote}</blockquote>
      {citation.archiveName && (
        <p className="muted small">
          {t('正式档案名称')}：{citation.archiveName}
        </p>
      )}
      <div className="archive-file-actions">
        <button type="button" disabled={loading} onClick={() => void preview()}>
          {t(loading ? '正在核对来源…' : '查看该位置正文')}
        </button>
        <a href={`${base}/files/${encodeURIComponent(citation.fileId)}/download`} download>
          {t('下载原文件')}
        </a>
      </div>
      {loading && <p role="status">{t('正在读取来源…')}</p>}
      {error && <p role="alert">{error}</p>}
      {detail &&
        (block ? (
          <section className="archive-source-block">
            <strong>{block.location}</strong>
            {image && <img className="archive-original-image" src={image} alt={t('原始图片')} />}
            <pre>{block.text}</pre>
          </section>
        ) : (
          <p role="status">
            {t('当前提取版本或来源位置与历史引用不一致，无法展开核对；以上保留回答时保存的摘录。')}
          </p>
        ))}
    </details>
  )
}

export function ArchiveSources({
  base,
  citations,
  coverage,
}: {
  base: string
  citations?: ArchiveCitation[]
  coverage?: string
}) {
  return (
    <div className="archive-sources">
      {coverage && <p className="archive-coverage">{coverage}</p>}
      {citations?.some((citation) => citation.method === 'ocr') && (
        <p className="archive-coverage">{t(archiveOcrCaution)}</p>
      )}
      {!!citations?.length && (
        <div aria-label={t('回答出处')}>
          {citations.map((citation) => (
            <ArchiveCitationSource
              key={JSON.stringify([
                base,
                citation.id,
                citation.fileId,
                citation.extractionId,
                citation.sha256,
                citation.filename,
                citation.blockId,
                citation.location,
                citation.quote,
                citation.method,
                citation.page,
                citation.comparisonId,
                citation.changeId,
                citation.side,
                citation.archiveRecordId,
                citation.archiveNumber,
                citation.archiveName,
              ])}
              base={base}
              citation={citation}
            />
          ))}
        </div>
      )}
    </div>
  )
}
