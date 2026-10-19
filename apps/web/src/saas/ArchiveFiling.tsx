import { useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'
import { ArchiveSources } from './ArchiveSources'
import { ArchiveRegistration } from './ArchiveRegistration'
import type { ArchiveDocument } from './archive-documents'
import {
  filingDirectoryText,
  matchesFilingSuggestion,
  type FilingSuggestion,
} from './archive-filing'
import './archive-filing.css'

type Props = {
  base: string
  documents: ArchiveDocument[]
  selectedIds: string[]
  disabled: boolean
}
export function ArchiveFiling({ base, documents, selectedIds, disabled }: Props) {
  const selected = selectedIds.slice(0, 4).flatMap((id) => {
    const document = documents.find((d) => d.fileId === id)
    return document ? [document] : []
  })
  const key = JSON.stringify([
    base,
    selected.map((d) => [d.fileId, d.extractionId, d.sha256, d.name, d.state]),
  ])
  return <FilingSession key={key} base={base} documents={selected} disabled={disabled} />
}
function FilingSession({ base, documents, disabled }: Omit<Props, 'selectedIds'>) {
  const [items, setItems] = useState<Record<string, FilingSuggestion | null>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(true),
    working = useRef(false),
    requests = useRef<Record<string, number>>({})
  const endpoint = (id: string) => `${base}/archive/documents/${encodeURIComponent(id)}/filing`
  const next = (id: string) => (requests.current[id] = (requests.current[id] || 0) + 1)
  function checked(value: FilingSuggestion | null, document: ArchiveDocument) {
    if (value && !matchesFilingSuggestion(value, document))
      throw new Error(t('归档建议来源与当前文档版本不一致，请刷新文档列表。'))
    return value
  }
  async function readOne(document: ArchiveDocument, preserveError = false) {
    const request = next(document.fileId)
    try {
      const response = await api<{ suggestion: FilingSuggestion | null }>(endpoint(document.fileId))
      if (!mounted.current || requests.current[document.fileId] !== request) return
      const value = checked(response.suggestion, document)
      setItems((prev) => ({ ...prev, [document.fileId]: value }))
      if (!preserveError) setErrors((prev) => ({ ...prev, [document.fileId]: '' }))
    } catch (error) {
      if (mounted.current && requests.current[document.fileId] === request) {
        setItems((prev) => ({ ...prev, [document.fileId]: null }))
        if (!preserveError)
          setErrors((prev) => ({ ...prev, [document.fileId]: (error as Error).message }))
      }
    }
  }
  async function refresh() {
    setLoading(true)
    await Promise.all(documents.filter((d) => d.state === 'ready').map((d) => readOne(d)))
    if (mounted.current) setLoading(false)
  }
  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
    }
    // This session is keyed by base and every selected source identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const processing = documents
    .filter((d) => items[d.fileId]?.state === 'processing')
    .map((d) => d.fileId)
    .join(',')
  useEffect(() => {
    if (busy || !processing) return
    let polling = false
    const timer = window.setInterval(async () => {
      if (polling) return
      polling = true
      try {
        await Promise.all(
          documents.filter((d) => processing.split(',').includes(d.fileId)).map((d) => readOne(d)),
        )
      } finally {
        polling = false
      }
    }, 2500)
    return () => window.clearInterval(timer)
    // Source identities are fixed by the keyed session; polling follows states.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processing, busy])
  async function generate() {
    if (
      working.current ||
      busy ||
      disabled ||
      loading ||
      !documents.length ||
      documents.some((d) => d.state !== 'ready')
    )
      return
    working.current = true
    setBusy(true)
    setNotice('')
    try {
      for (const document of documents) {
        if (!mounted.current) return
        if (items[document.fileId]?.state === 'ready') continue
        const request = next(document.fileId)
        setActive(document.fileId)
        setErrors((prev) => ({ ...prev, [document.fileId]: '' }))
        try {
          const response = await api<{ suggestion: FilingSuggestion }>(
            endpoint(document.fileId),
            {},
          )
          if (!mounted.current) return
          const value = checked(response.suggestion, document)
          if (requests.current[document.fileId] === request)
            setItems((prev) => ({ ...prev, [document.fileId]: value }))
        } catch (error) {
          if (!mounted.current) return
          setErrors((prev) => ({ ...prev, [document.fileId]: (error as Error).message }))
          await readOne(document, true)
        }
      }
    } finally {
      working.current = false
      if (mounted.current) {
        setBusy(false)
        setActive('')
      }
    }
  }
  const ready = documents.flatMap((d) => {
    const s = items[d.fileId]
    return s?.state === 'ready' && matchesFilingSuggestion(s, d) ? [s] : []
  })
  const directory = filingDirectoryText(documents, ready)
  async function copy() {
    try {
      await navigator.clipboard.writeText(directory)
      if (mounted.current) setNotice(t('归档目录已复制。'))
    } catch {
      if (mounted.current) setNotice(t('复制失败，请使用下载归档目录。'))
    }
  }
  function download() {
    const objectUrl = URL.createObjectURL(
      new Blob(['\uFEFF' + directory], { type: 'text/plain;charset=utf-8' }),
    )
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = '归档目录-建议.txt'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  }
  return (
    <section className="archive-filing" aria-label={t('归档建议工作区')}>
      <h3>{t('分类与归档建议')}</h3>
      <p className="muted small">
        {t('使用上方勾选的资料，自动推荐分类、标签、文件名和档案号。建议需确认，原文件保持不变。')}
      </p>
      <div className="archive-filing-actions">
        <button
          type="button"
          disabled={
            disabled ||
            loading ||
            busy ||
            !!processing ||
            !documents.length ||
            documents.some((d) => d.state !== 'ready') ||
            ready.length === documents.length
          }
          onClick={() => void generate()}
        >
          {t(busy || processing ? '正在生成归档建议…' : '生成归档建议')}
        </button>
        <button type="button" disabled={loading || busy} onClick={() => void refresh()}>
          {t('刷新归档状态')}
        </button>
      </div>
      {loading && <p role="status">{t('正在读取已保存建议…')}</p>}
      {!documents.length && <p>{t('请在上方选择一至四份已就绪资料。')}</p>}
      {documents.map((document) => {
        const item = items[document.fileId],
          result = item?.state === 'ready' ? item.result : undefined
        return (
          <article className="archive-filing-card" key={document.fileId}>
            <h4>{document.name}</h4>
            {errors[document.fileId] && <p role="alert">{errors[document.fileId]}</p>}
            {active === document.fileId && busy ? (
              <p role="status">{t('正在分析分类与标签…')}</p>
            ) : item?.state === 'processing' ? (
              <p role="status">{t('建议生成中，正在等待保存结果；请勿重复提交。')}</p>
            ) : item?.state === 'failed' ? (
              <p role="alert">
                {item.error} {t('点击生成归档建议可手动重试。')}
              </p>
            ) : (
              !result && (
                <p className="muted small">
                  {t(document.state === 'ready' ? '尚未生成归档建议。' : '请等待文档解析完成。')}
                </p>
              )
            )}
            {result && item && (
              <>
                <p className="archive-filing-review">
                  {t(result.needsReview ? '需要重点核对的归档建议' : '待确认的归档建议')}
                </p>
                <dl>
                  <div>
                    <dt>{t('建议归属')}</dt>
                    <dd>
                      {result.department} / {result.category}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('建议档案号')}</dt>
                    <dd>{item.archiveNumber}</dd>
                  </div>
                  <div>
                    <dt>{t('建议文件名')}</dt>
                    <dd>{result.recommendedName}</dd>
                  </div>
                  <div>
                    <dt>{t('建议目录')}</dt>
                    <dd>{result.directory}</dd>
                  </div>
                </dl>
                <div className="archive-filing-tags" aria-label={t('分类标签')}>
                  {result.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
                <p>
                  <strong>{t('推荐依据')}：</strong>
                  {result.reason}
                </p>
                {!!result.warnings.length && (
                  <details>
                    <summary>{t('提取范围与识别提醒')}</summary>
                    <ul>
                      {result.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  </details>
                )}
                <ArchiveSources
                  base={base}
                  citations={result.citations}
                  coverage={result.coverage}
                />
                <ArchiveRegistration base={base} suggestion={item} disabled={disabled || busy} />
              </>
            )}
          </article>
        )
      })}
      {!!ready.length && (
        <section className="archive-filing-directory" aria-label={t('生成的归档目录')}>
          <h4>
            {t('归档目录')} · {ready.length}/{documents.length}
          </h4>
          <p className="muted small">
            {t('目录年份为归档建议生成年份，不是文档日期。系统编号不代表正式入库。')}
          </p>
          <pre>{ready.map((s) => s.result!.relativePath).join('\n')}</pre>
          <div className="archive-filing-actions">
            <button type="button" onClick={() => void copy()}>
              {t('复制归档目录')}
            </button>
            <button type="button" onClick={download}>
              {t('下载归档目录')}
            </button>
          </div>
          {notice && <p role="status">{notice}</p>}
        </section>
      )}
    </section>
  )
}
