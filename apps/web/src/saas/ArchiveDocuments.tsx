import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'
import { ArchiveComparison } from './ArchiveComparison'
import { ArchiveFiling } from './ArchiveFiling'
import { ArchiveRegistry } from './ArchiveRegistry'
import type { ComparisonReference } from './archive-comparisons'
import {
  createArchiveRequestScope,
  archiveImagePreview,
  archiveOcrCaution,
  readArchiveSelection,
  selectedArchiveFiles,
  toggleArchiveFile,
  type ArchiveDocument,
  type ArchiveDetail,
} from './archive-documents'
import './archive-documents.css'

const stateLabels = {
  unparsed: '已上传 · 待解析',
  processing: '正在解析…',
  ready: '已就绪',
  failed: '解析失败',
}
const selectionKey = (base: string) => `office:archive-selection:${base}`

export function ArchiveDocumentText({ document }: { document: ArchiveDetail }) {
  return (
    <div className="archive-document-text">
      {(document.ocr || document.blocks.some((block) => block.method === 'ocr')) && (
        <p className="archive-coverage">{t(archiveOcrCaution)}</p>
      )}
      {!!document.warnings.length && (
        <ul className="archive-warnings">
          {document.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
      {document.kind === 'docx' && (
        <p className="muted small">
          {t(
            'Word 仅提取正文段落和表格；页眉、页脚、图片文字及复杂排版不在读取范围内。段落编号不是页码。',
          )}
        </p>
      )}
      {document.kind === 'xlsx' && (
        <p className="muted small">{t('Excel 公式使用文件中保存的结果，不重新计算。')}</p>
      )}
      {!document.blocks.length && <p>{t('暂无可预览的正文。')}</p>}
      {document.blocks.map((block) => (
        <section key={block.id}>
          <strong>{block.location}</strong>
          <pre>{block.text}</pre>
        </section>
      ))}
    </div>
  )
}

export function ArchiveDocuments({
  base,
  disabled,
  onSelectionChange,
  onComparisonChange,
  onComparisonSummary,
  comparisonOpen,
  comparisonEpoch = 0,
  comparisonLocked = false,
}: {
  base: string
  disabled: boolean
  onSelectionChange: (ids: string[], ready: boolean) => void
  onComparisonChange?: (comparison: ComparisonReference | null) => void
  onComparisonSummary?: (comparison: ComparisonReference) => void
  comparisonOpen?: { id: string; sequence: number } | null
  comparisonEpoch?: number
  comparisonLocked?: boolean
}) {
  const [documents, setDocuments] = useState<ArchiveDocument[]>([])
  const [expanded, setExpanded] = useState(true)
  const [tool, setTool] = useState<'comparison' | 'filing' | 'registry'>('comparison')
  useEffect(() => {
    if (comparisonOpen) {
      setTool('comparison')
      setExpanded(true)
    }
  }, [comparisonOpen])
  const panelId = useId()
  const [selected, setSelected] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState('')
  const [parsing, setParsing] = useState<string[]>([])
  const [preview, setPreview] = useState<ArchiveDetail | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [previewId, setPreviewId] = useState('')
  const lifecycle = useRef(createArchiveRequestScope())
  const listRequests = useRef(createArchiveRequestScope())
  const previewRequests = useRef(createArchiveRequestScope())
  const documentsRef = useRef<ArchiveDocument[]>([])
  const autoSelect = useRef(new Set<string>())
  const selectedRef = useRef<string[]>([])
  const parsingRef = useRef(new Set<string>())
  const live = useRef<() => boolean>(() => false)
  const selectionCallback = useRef(onSelectionChange)
  useEffect(() => {
    selectionCallback.current = onSelectionChange
  }, [onSelectionChange])
  useEffect(() => {
    if (disabled) setExpanded(false)
  }, [disabled])

  const applyDocuments = useCallback(
    (items: ArchiveDocument[]) => {
      // Successful extractions are immutable. A processing snapshot must never
      // regress a ready file already observed through another read.
      const ready = new Map(
        documentsRef.current
          .filter((item) => item.state === 'ready')
          .map((item) => [item.fileId, item]),
      )
      const merged = items.map((item) => ready.get(item.fileId) || item)
      documentsRef.current = merged
      setDocuments(merged)
      let ids = selectedArchiveFiles(selectedRef.current, merged)
      for (const id of autoSelect.current) {
        const item = merged.find((document) => document.fileId === id)
        if (item?.state === 'ready') {
          const next = toggleArchiveFile(ids, id, merged)
          // An already selected newly parsed file should stay selected.
          if (!ids.includes(id)) {
            ids = next.ids
            if (next.error) setError(t(next.error))
          }
          autoSelect.current.delete(id)
        } else if (item?.state === 'failed') autoSelect.current.delete(id)
      }
      selectedRef.current = ids
      setSelected(ids)
      setLoaded(true)
      selectionCallback.current(ids, true)
      try {
        localStorage.setItem(selectionKey(base), JSON.stringify(ids))
      } catch {
        /* Selection still works without browser storage. */
      }
    },
    [base],
  )

  const refresh = useCallback(async () => {
    const current = listRequests.current.begin()
    setLoading(true)
    try {
      const result = await api<{ items: ArchiveDocument[] }>(`${base}/archive/documents`)
      // Only a newer full list can supersede file discovery. Detail polls cover
      // known files only; applyDocuments preserves their immutable ready state.
      if (!live.current() || !current()) return
      setError('')
      applyDocuments(result.items)
    } catch (failure) {
      if (live.current() && current()) setError((failure as Error).message)
    } finally {
      if (live.current() && current()) setLoading(false)
    }
  }, [base, applyDocuments])

  useEffect(() => {
    const mounted = lifecycle.current.begin()
    live.current = mounted
    try {
      selectedRef.current = readArchiveSelection(localStorage.getItem(selectionKey(base)))
    } catch {
      selectedRef.current = []
    }
    selectionCallback.current([], false)
    void refresh()
    const scope = lifecycle.current,
      lists = listRequests.current,
      previews = previewRequests.current
    return () => {
      scope.invalidate()
      lists.invalidate()
      previews.invalidate()
    }
  }, [base, refresh])

  useEffect(() => {
    const processing = [
      ...new Set([
        ...documents
          .filter((document) => document.state === 'processing')
          .map((document) => document.fileId),
        ...parsing,
      ]),
    ].filter(
      (id) => !documents.some((document) => document.fileId === id && document.state === 'ready'),
    )
    if (!processing.length) return
    let cancelled = false
    let polling = false
    const timer = window.setInterval(async () => {
      if (polling) return
      polling = true
      try {
        const updates = await Promise.all(
          processing.map((id) =>
            api<{ document: ArchiveDetail }>(`${base}/archive/documents/${encodeURIComponent(id)}`),
          ),
        )
        if (cancelled || !live.current()) return
        const byId = new Map(updates.map((result) => [result.document.fileId, result.document]))
        applyDocuments(
          documentsRef.current.map((document) => byId.get(document.fileId) || document),
        )
      } catch (failure) {
        if (!cancelled && live.current())
          setError(`${(failure as Error).message} ${t('请刷新文档状态后重试。')}`)
      } finally {
        polling = false
      }
    }, 2500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [documents, parsing, base, applyDocuments])

  async function parse(id: string) {
    if (parsingRef.current.has(id)) return
    parsingRef.current.add(id)
    const current = live.current
    setParsing((ids) => [...ids, id])
    setError('')
    try {
      const result = await api<{ document: ArchiveDocument }>(
        `${base}/archive/documents/${encodeURIComponent(id)}/parse`,
        {},
      )
      if (!current()) return
      // The POST has finished; only server-reported processing files need polls
      // while the subsequent full membership refresh is still pending.
      setParsing((ids) => ids.filter((value) => value !== id))
      // Refresh reads the complete list so concurrent uploads never replace each other.
      if (result.document.state === 'failed')
        setError(result.document.error || t('解析失败，请重试。'))
      await refresh()
    } catch (failure) {
      if (!current()) return
      setError(
        `${(failure as Error).message} ${t('解析结果可能已保存，请先刷新状态；仍未就绪时可重新解析。')}`,
      )
      // GET also recovers an expired parse lease without repeating an upload.
      try {
        await api(`${base}/archive/documents/${encodeURIComponent(id)}`)
        if (current()) await refresh()
      } catch {
        /* Preserve the parse failure and expose the refresh control. */
      }
    } finally {
      parsingRef.current.delete(id)
      if (current()) setParsing((ids) => ids.filter((value) => value !== id))
    }
  }
  async function upload(file: File) {
    const current = live.current
    setError('')
    if (!/\.(docx|pdf|xlsx|png|jpe?g|webp)$/i.test(file.name)) {
      setError(t('请选择 DOCX、PDF、XLSX、PNG、JPG/JPEG 或 WebP；旧版 DOC/XLS 请先另存为新格式。'))
      return
    }
    if (file.size > 6 * 1024 * 1024 || file.size === 0) {
      setError(t('文件须非空且不超过 6 MiB。'))
      return
    }
    setUploading(file.name)
    let uploadingBytes = true
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1])
        reader.onerror = () => reject(new Error(t('无法读取文件，请重新选择。')))
        reader.onabort = () => reject(new Error(t('文件读取已取消。')))
        reader.readAsDataURL(file)
      })
      if (!current()) return
      const result = await api<{ id: string }>(`${base}/files`, {
        name: file.name,
        mime: /\.png$/i.test(file.name)
          ? 'image/png'
          : /\.jpe?g$/i.test(file.name)
            ? 'image/jpeg'
            : /\.webp$/i.test(file.name)
              ? 'image/webp'
              : file.type || 'application/octet-stream',
        content: data,
      })
      if (!current()) return
      autoSelect.current.add(result.id)
      // Discover membership before starting the awaited parse request. Local busy
      // IDs keep detail polling active even while the list still says unparsed.
      await refresh()
      if (!current()) return
      setUploading('')
      uploadingBytes = false
      await parse(result.id)
    } catch (failure) {
      if (current())
        setError(`${(failure as Error).message} ${t('请先刷新文档列表，确认文件是否已上传。')}`)
    } finally {
      if (current() && uploadingBytes) setUploading('')
    }
  }
  async function showPreview(id: string) {
    const current = previewRequests.current.begin()
    setPreviewId(id)
    setPreview(null)
    setPreviewError('')
    setPreviewLoading(true)
    try {
      const result = await api<{ document: ArchiveDetail }>(
        `${base}/archive/documents/${encodeURIComponent(id)}`,
      )
      if (live.current() && current()) {
        const expected = documentsRef.current.find((item) => item.fileId === id)
        if (
          expected?.state === 'ready' &&
          result.document.state === 'ready' &&
          result.document.fileId === id &&
          !!expected.sha256 &&
          !!expected.extractionId &&
          result.document.sha256 === expected.sha256 &&
          result.document.extractionId === expected.extractionId
        )
          setPreview(result.document)
        else setPreviewError(t('文档身份核对失败，请刷新列表后重试预览。'))
      }
    } catch (failure) {
      if (live.current() && current()) setPreviewError((failure as Error).message)
    } finally {
      if (live.current() && current()) setPreviewLoading(false)
    }
  }
  const selectedNames = documents
    .filter((document) => selected.includes(document.fileId))
    .map((document) => document.name)
  return (
    <section className="archive-documents" aria-label={t('问答文档')}>
      <div className="archive-toolbar archive-panel-heading">
        <strong>{t('问答文档')}</strong>
        <span className="archive-panel-count">
          {t('已选')} {selected.length}/4
        </span>
        <span className="archive-panel-state" role="status">
          {uploading
            ? t('正在上传…')
            : parsing.length || documents.some((item) => item.state === 'processing')
              ? t('正在解析…')
              : error || documents.some((item) => item.state === 'failed')
                ? t('展开查看提示')
                : ''}
        </span>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((value) => !value)}
        >
          {t(expanded ? '收起文档' : '展开文档')}
        </button>
      </div>
      <div className="archive-document-body" id={panelId} hidden={!expanded}>
        <div className="archive-toolbar archive-document-controls">
          <label className="archive-upload">
            {t('上传文档')}
            <input
              type="file"
              accept=".docx,.pdf,.xlsx,.png,.jpg,.jpeg,.webp"
              disabled={disabled || !!uploading}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void upload(file)
              }}
            />
          </label>
          <button type="button" disabled={loading} onClick={() => void refresh()}>
            {t('刷新状态')}
          </button>
        </div>
        <p className="muted small">
          {t(
            'DOCX / PDF（含扫描件）/ XLSX / PNG / JPG / WebP · 每份不超过 6 MiB · 最多选择 4 份。',
          )}
        </p>
        <p className="muted small">
          {t('旧版已就绪 PDF 如需识别扫描页，请重新上传；原有提取与历史引用保持不变。')}
        </p>
        {uploading && (
          <p role="status">
            {t('正在上传并解析')}：{uploading}
          </p>
        )}
        {loading && <p role="status">{t('正在读取文档列表…')}</p>}
        {!loading && !documents.length && !error && (
          <p>{t('还没有文档。上传文件，或将已有文件加入个人文件区后刷新。')}</p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}{' '}
            <button type="button" onClick={() => void refresh()}>
              {t('重新加载文档')}
            </button>
          </p>
        )}
        {!!documents.length && (
          <ul className="archive-file-list">
            {documents.map((document) => (
              <li key={document.fileId}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(document.fileId)}
                    disabled={
                      disabled ||
                      document.state !== 'ready' ||
                      (!selected.includes(document.fileId) && selected.length >= 4)
                    }
                    onChange={() => {
                      const next = toggleArchiveFile(
                        selectedRef.current,
                        document.fileId,
                        documents,
                      )
                      selectedRef.current = next.ids
                      setSelected(next.ids)
                      setError(t(next.error))
                      selectionCallback.current(next.ids, loaded)
                      try {
                        localStorage.setItem(selectionKey(base), JSON.stringify(next.ids))
                      } catch {
                        /* Optional persistence. */
                      }
                    }}
                  />
                  <span>
                    {document.name}
                    <small>
                      {document.state === 'processing' && document.progress
                        ? `${t(document.progress.stage === 'ocr' ? '正在识别（OCR）' : '正在解析…')}· ${t('第')} ${document.progress.page} / ${document.progress.totalPages} ${t('页')}`
                        : t(
                            parsing.includes(document.fileId) && document.state !== 'ready'
                              ? '正在解析…'
                              : stateLabels[document.state],
                          )}
                      {document.ocr && ' · OCR'} · {(document.size / 1024).toFixed(1)} KiB
                    </small>
                  </span>
                </label>
                <div className="archive-file-actions">
                  {document.state === 'ready' ? (
                    <button type="button" onClick={() => void showPreview(document.fileId)}>
                      {t('预览正文')}
                    </button>
                  ) : (
                    document.state !== 'processing' && (
                      <button
                        type="button"
                        disabled={disabled || parsing.includes(document.fileId)}
                        onClick={() => {
                          autoSelect.current.add(document.fileId)
                          void parse(document.fileId)
                        }}
                      >
                        {t(
                          parsing.includes(document.fileId)
                            ? '正在解析…'
                            : document.state === 'failed'
                              ? '重试解析'
                              : '解析文档',
                        )}
                      </button>
                    )
                  )}
                  <a
                    href={`${base}/files/${encodeURIComponent(document.fileId)}/download`}
                    download
                  >
                    {t('原文件')}
                  </a>
                </div>
                {document.error && <p className="error">{document.error}</p>}
              </li>
            ))}
          </ul>
        )}
        <p className="archive-selection" role="status">
          {selectedNames.length
            ? `${t('本次及后续问答使用')}（${selectedNames.length}/4）：${selectedNames.join('、')}`
            : t('未选择文档，将进行普通对话。')}
        </p>
        {previewId && (
          <section className="archive-preview" aria-label={t('文档正文预览')}>
            <div className="archive-toolbar">
              <strong>{preview?.name || t('文档正文预览')}</strong>
              <button
                type="button"
                onClick={() => {
                  previewRequests.current.invalidate()
                  setPreviewId('')
                  setPreview(null)
                }}
              >
                {t('关闭预览')}
              </button>
            </div>
            {previewLoading && <p role="status">{t('正在读取正文…')}</p>}
            {previewError && (
              <p role="alert">
                {previewError}{' '}
                <button type="button" onClick={() => void showPreview(previewId)}>
                  {t('重试')}
                </button>
              </p>
            )}
            {preview &&
              (preview.state === 'ready' ? (
                <>
                  {archiveImagePreview(base, preview) && (
                    <img
                      className="archive-original-image"
                      src={archiveImagePreview(base, preview)!}
                      alt={t('原始图片')}
                    />
                  )}
                  <ArchiveDocumentText document={preview} />
                </>
              ) : (
                <p>{preview.error || t(stateLabels[preview.state])}</p>
              ))}
          </section>
        )}
      </div>
      <div className="archive-tool-tabs" aria-label={t('资料工具')}>
        {onComparisonChange && onComparisonSummary && (
          <button
            type="button"
            aria-pressed={tool === 'comparison'}
            onClick={() => setTool('comparison')}
          >
            {t('文档比对')}
          </button>
        )}
        <button type="button" aria-pressed={tool === 'filing'} onClick={() => setTool('filing')}>
          {t('归档建议')}
        </button>
        <button
          type="button"
          aria-pressed={tool === 'registry'}
          onClick={() => setTool('registry')}
        >
          {t('档案检索')}
        </button>
      </div>
      <fieldset
        className="archive-comparison-scope"
        disabled={comparisonLocked}
        hidden={tool !== 'comparison'}
      >
        {onComparisonChange && onComparisonSummary && (
          <ArchiveComparison
            base={base}
            documents={documents}
            disabled={disabled}
            onActiveChange={onComparisonChange}
            onSummary={onComparisonSummary}
            openRequest={comparisonOpen}
            scopeEpoch={comparisonEpoch}
          />
        )}
      </fieldset>
      {tool === 'filing' && (
        <ArchiveFiling
          base={base}
          documents={documents}
          selectedIds={selected}
          disabled={disabled}
        />
      )}
      {tool === 'registry' && <ArchiveRegistry base={base} />}
    </section>
  )
}
