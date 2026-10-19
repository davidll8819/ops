import { useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'
import {
  archiveOcrCaution,
  createArchiveRequestScope,
  type ArchiveDocument,
} from './archive-documents'
import {
  comparisonPage,
  comparisonReference,
  validComparisonPair,
  type Comparison,
  type ComparisonHunk,
  type ComparisonReference,
} from './archive-comparisons'
import './archive-comparisons.css'

const labels = { equal: '未变化', added: '新增', removed: '删除', modified: '修改' }

export function ArchiveComparisonResult({ comparison }: { comparison: Comparison }) {
  const [showEqual, setShowEqual] = useState(false)
  const [page, setPage] = useState(0)
  const count = comparison.hunks.filter((hunk) => showEqual || hunk.type !== 'equal').length
  function side(hunk: ComparisonHunk, role: 'old' | 'new') {
    const value = hunk[role]
    const segments = role === 'old' ? hunk.oldSegments : hunk.newSegments
    return (
      <div className={`archive-comparison-side ${role}`}>
        <strong>
          {t(role === 'old' ? '旧版' : '新版')} ·{' '}
          {comparison[role === 'old' ? 'oldVersion' : 'newVersion'].name}
        </strong>
        {value ? (
          <>
            <small>
              {value.location}
              {value.method === 'ocr' ? ' · OCR' : ''}
            </small>
            <pre>
              {segments.map((segment, index) =>
                segment.changed ? (
                  role === 'old' ? (
                    <del key={index}>{segment.text}</del>
                  ) : (
                    <ins key={index}>{segment.text}</ins>
                  )
                ) : (
                  <span key={index}>{segment.text}</span>
                ),
              )}
            </pre>
          </>
        ) : (
          <p className="muted">{t('此版本无对应内容')}</p>
        )}
      </div>
    )
  }
  return (
    <section className="archive-comparison-result" aria-label={t('比对结果')}>
      <p role="status" className="archive-comparison-overview">
        {comparison.overview}
      </p>
      <p className="muted small">{t('仅比对已提取文字，格式、图片和公式表达式不在比对范围内。')}</p>
      {(comparison.oldVersion.ocr || comparison.newVersion.ocr) && (
        <p className="archive-coverage">{t(archiveOcrCaution)}</p>
      )}
      {!!comparison.warnings.length && (
        <ul className="archive-warnings">
          {comparison.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
      <label className="archive-comparison-toggle">
        <input
          type="checkbox"
          checked={showEqual}
          onChange={(event) => {
            setShowEqual(event.target.checked)
            setPage(0)
          }}
        />
        {t('显示未变化内容')}
      </label>
      {comparisonPage(comparison.hunks, showEqual, page).map((hunk) => (
        <article className={`archive-comparison-hunk ${hunk.type}`} key={hunk.id}>
          <strong className="archive-change-label">
            {t(labels[hunk.type])} · {hunk.id}
          </strong>
          {hunk.type === 'modified' && hunk.granularity === 'block' && (
            <p className="muted small">{t('整段替换（未细分字词差异），以下保留完整原文。')}</p>
          )}
          <div className="archive-comparison-sides">
            {side(hunk, 'old')}
            {side(hunk, 'new')}
          </div>
        </article>
      ))}
      {!count && <p>{t('已提取文字未发现变化')}</p>}
      {count > 50 && (
        <nav className="archive-comparison-pages" aria-label={t('比对结果分页')}>
          <button type="button" disabled={!page} onClick={() => setPage(page - 1)}>
            {t('上一页')}
          </button>
          <span>
            {page + 1} / {Math.ceil(count / 50)}
          </span>
          <button
            type="button"
            disabled={(page + 1) * 50 >= count}
            onClick={() => setPage(page + 1)}
          >
            {t('下一页')}
          </button>
        </nav>
      )}
    </section>
  )
}

export function ArchiveComparison({
  base,
  documents,
  disabled = false,
  onActiveChange,
  onSummary,
  openRequest,
  scopeEpoch = 0,
}: {
  base: string
  documents: ArchiveDocument[]
  disabled?: boolean
  onActiveChange: (comparison: ComparisonReference | null) => void
  onSummary: (comparison: ComparisonReference) => void
  openRequest?: { id: string; sequence: number } | null
  scopeEpoch?: number
}) {
  const [oldId, setOldId] = useState('')
  const [newId, setNewId] = useState('')
  const [result, setResult] = useState<Comparison | null>(null)
  const [history, setHistory] = useState<ComparisonReference[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const requests = useRef(createArchiveRequestScope())
  useEffect(() => {
    requests.current.invalidate()
    setBusy(false)
  }, [scopeEpoch])
  const callbacks = useRef({ onActiveChange })
  useEffect(() => {
    callbacks.current = { onActiveChange }
  }, [onActiveChange])
  useEffect(() => {
    let live = true
    setHistoryError('')
    api<{ items: ComparisonReference[] }>(`${base}/archive/comparisons`)
      .then(({ items }) => {
        if (live) setHistory(items.slice(0, 20))
      })
      .catch((failure) => {
        if (live) setHistoryError((failure as Error).message)
      })
    return () => {
      live = false
    }
  }, [base, refresh])
  useEffect(() => {
    const scope = requests.current
    return () => scope.invalidate()
  }, [])
  function changePair(role: 'old' | 'new', id: string) {
    requests.current.invalidate()
    setBusy(false)
    setError('')
    setResult(null)
    onActiveChange(null)
    if (role === 'old') setOldId(id)
    else setNewId(id)
  }
  async function load(id: string) {
    const current = requests.current.begin()
    setBusy(true)
    setResult(null)
    setError('')
    callbacks.current.onActiveChange(null)
    try {
      const { comparison } = await api<{ comparison: Comparison }>(
        `${base}/archive/comparisons/${encodeURIComponent(id)}`,
      )
      if (!current()) return
      setOldId(comparison.oldVersion.fileId)
      setNewId(comparison.newVersion.fileId)
      setResult(comparison)
      callbacks.current.onActiveChange(comparison)
    } catch (failure) {
      if (current()) setError((failure as Error).message)
    } finally {
      if (current()) setBusy(false)
    }
  }
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })
  useEffect(() => {
    if (openRequest) void loadRef.current(openRequest.id)
  }, [openRequest])
  async function create() {
    if (!validComparisonPair(oldId, newId, documents) || busy) return
    const current = requests.current.begin()
    setBusy(true)
    setError('')
    setResult(null)
    onActiveChange(null)
    try {
      const { comparison } = await api<{ comparison: Comparison }>(`${base}/archive/comparisons`, {
        oldFileId: oldId,
        newFileId: newId,
      })
      if (!current()) return
      setResult(comparison)
      onActiveChange(comparison)
      setHistory((items) =>
        [
          comparisonReference(comparison),
          ...items.filter((item) => item.id !== comparison.id),
        ].slice(0, 20),
      )
    } catch (failure) {
      if (current()) setError((failure as Error).message)
    } finally {
      if (current()) setBusy(false)
    }
  }
  const ready = documents.filter((document) => document.state === 'ready')
  return (
    <section className="archive-comparison" aria-label={t('文档版本比对')}>
      <h3>{t('文档版本比对')}</h3>
      <p className="muted small">
        {t('上传并解析两份文档后，分别选择旧版和新版；与问答文档勾选相互独立。')}
      </p>
      <div className="archive-comparison-selectors">
        {(['old', 'new'] as const).map((role) => (
          <label key={role}>
            {t(role === 'old' ? '旧版文档' : '新版文档')}
            <select
              aria-label={t(role === 'old' ? '旧版文档' : '新版文档')}
              value={role === 'old' ? oldId : newId}
              onChange={(event) => changePair(role, event.target.value)}
            >
              <option value="">{t('请选择已就绪文档')}</option>
              {ready.map((document) => (
                <option key={document.fileId} value={document.fileId}>
                  {document.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {oldId && oldId === newId && <p role="status">{t('旧版和新版必须选择不同文件。')}</p>}
      <div className="archive-file-actions">
        <button
          type="button"
          disabled={busy || !validComparisonPair(oldId, newId, documents)}
          onClick={() => void create()}
        >
          {t(busy ? '正在读取比对…' : '开始比对')}
        </button>
        {result && (
          <button type="button" disabled={disabled} onClick={() => onSummary(result)}>
            {t('总结改动')}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {result && <ArchiveComparisonResult key={result.id} comparison={result} />}
      <details className="archive-comparison-history" open>
        <summary>
          {t('历史比对')} · {history.length}
        </summary>
        {historyError && (
          <p role="alert">
            {historyError}{' '}
            <button type="button" onClick={() => setRefresh((value) => value + 1)}>
              {t('重试')}
            </button>
          </p>
        )}
        {history.map((item) => (
          <button type="button" key={item.id} onClick={() => void load(item.id)}>
            {item.oldVersion.name} → {item.newVersion.name}
            <small>
              {new Date(item.createdAt).toLocaleString()} · {item.overview}
            </small>
          </button>
        ))}
      </details>
    </section>
  )
}
