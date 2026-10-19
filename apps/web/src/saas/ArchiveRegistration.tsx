import { useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'
import type { FilingSuggestion } from './archive-filing'
import {
  archiveCategories,
  archiveDepartments,
  sameRecordSource,
  type ArchiveMetadata,
  type ArchiveRecord,
} from './archive-records'
import './archive-records.css'
export function ArchiveRegistration({
  base,
  suggestion,
  disabled,
}: {
  base: string
  suggestion: FilingSuggestion
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <section className="archive-registration">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {t(open ? '收起归档编辑' : '修改并归档')}
      </button>
      {open && (
        <RecordEditor
          key={base + suggestion.id}
          base={base}
          suggestion={suggestion}
          disabled={disabled}
        />
      )}
    </section>
  )
}
function RecordEditor({
  base,
  suggestion,
  disabled,
}: {
  base: string
  suggestion: FilingSuggestion
  disabled: boolean
}) {
  const result = suggestion.result!,
    initial = {
      title: result.title,
      department: result.department,
      category: result.category,
      tags: result.tags,
      note: '',
    }
  const [record, setRecord] = useState<ArchiveRecord | null>(null),
    [fields, setFields] = useState<ArchiveMetadata>(initial),
    [tags, setTags] = useState(initial.tags.join('、')),
    [loading, setLoading] = useState(true),
    [validated, setValidated] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const active = useRef(true),
    working = useRef(false),
    sequence = useRef(0),
    endpoint = `${base}/archive/filings/${encodeURIComponent(suggestion.id)}/record`
  function checked(r: ArchiveRecord | null) {
    if (r && !sameRecordSource(r, suggestion))
      throw Object.assign(new Error(t('档案来源与当前建议不一致，请重新载入。')), { status: 409 })
    return r
  }
  function accept(r: ArchiveRecord | null) {
    setRecord(r)
    setFields(r?.metadata || initial)
    setTags((r?.metadata || initial).tags.join('、'))
  }
  async function load() {
    const n = ++sequence.current
    setLoading(true)
    setValidated(false)
    setError('')
    setNotice('')
    try {
      const { record: r } = await api<{ record: ArchiveRecord | null }>(endpoint)
      if (active.current && n === sequence.current) {
        accept(checked(r))
        setValidated(true)
      }
    } catch (e) {
      if (active.current && n === sequence.current) setError((e as Error).message)
    } finally {
      if (active.current && n === sequence.current) setLoading(false)
    }
  }
  useEffect(() => {
    active.current = true
    void load()
    return () => {
      active.current = false
    } // This editor is keyed by tenant and immutable suggestion identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const metadata = {
      ...fields,
      tags: [
        ...new Set(
          tags
            .split(/[、,，\n]/)
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ],
    },
    dirty = !record || JSON.stringify(metadata) !== JSON.stringify(record.metadata),
    archived = record?.state === 'archived'
  async function mutate(confirm = false) {
    if (
      working.current ||
      !validated ||
      loading ||
      disabled ||
      archived ||
      (confirm && (!record || dirty))
    )
      return
    working.current = true
    setBusy(true)
    setError('')
    setNotice('')
    const n = ++sequence.current
    try {
      const r = await api<{ record: ArchiveRecord }>(
        confirm ? `${base}/archive/records/${encodeURIComponent(record!.id)}/confirm` : endpoint,
        confirm ? { revision: record!.revision } : { revision: record?.revision || 0, metadata },
      )
      if (active.current && n === sequence.current) {
        accept(checked(r.record))
        setNotice(t(confirm ? '归档完成，可在档案检索中查找。' : '归档草稿已保存。'))
      }
    } catch (e) {
      if (active.current && n === sequence.current) {
        setError((e as Error).message)
        if ((e as Error & { status?: number }).status === 409) setValidated(false)
      }
    } finally {
      working.current = false
      if (active.current && n === sequence.current) setBusy(false)
    }
  }
  function field<K extends keyof ArchiveMetadata>(key: K, value: ArchiveMetadata[K]) {
    setFields((f) => ({ ...f, [key]: value }))
  }
  return (
    <div className="archive-record-editor" aria-label={t('归档编辑')}>
      {loading && <p role="status">{t('正在读取归档草稿…')}</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <p>
        <strong>{t(archived ? '已正式归档' : '待核对归档草稿')}</strong> ·{' '}
        {suggestion.archiveNumber}
      </p>
      <fieldset disabled={disabled || !validated || loading || busy || !!archived}>
        <label>
          {t('归档主题')}
          <input
            value={fields.title}
            maxLength={80}
            onChange={(e) => field('title', e.target.value)}
          />
        </label>
        <label>
          {t('归属部门')}
          <select
            aria-label={t('归属部门')}
            value={fields.department}
            onChange={(e) => field('department', e.target.value)}
          >
            {archiveDepartments.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          {t('资料类型')}
          <select
            aria-label={t('资料类型')}
            value={fields.category}
            onChange={(e) => field('category', e.target.value)}
          >
            {archiveCategories.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          {t('归档标签')}
          <input
            aria-label={t('归档标签')}
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            maxLength={130}
          />
          <small>{t('用顿号或逗号分隔，最多六个标签。')}</small>
        </label>
        <label>
          {t('归档说明')}
          <textarea
            value={fields.note}
            maxLength={600}
            rows={3}
            onChange={(e) => field('note', e.target.value)}
          />
        </label>
      </fieldset>
      {record && (
        <p className="archive-record-path">
          {t('已保存归档名称')}：{record.filename}
          <br />
          {t('已保存目录')}：{record.directory}
        </p>
      )}
      {archived ? (
        <p>
          {t('归档时间')}：{new Date(record!.archivedAt!).toLocaleString()}
        </p>
      ) : (
        <>
          <p className="muted small">
            {t('确认归档后将登记为正式记录，原文件保留。修改后请先保存草稿，再确认归档。')}
          </p>
          <div className="archive-filing-actions">
            <button
              type="button"
              disabled={disabled || !validated || loading || busy || !dirty}
              onClick={() => void mutate()}
            >
              {t('保存归档草稿')}
            </button>
            <button
              type="button"
              disabled={disabled || !validated || loading || busy || dirty || !record}
              onClick={() => void mutate(true)}
            >
              {t('确认归档')}
            </button>
          </div>
        </>
      )}
      <button type="button" disabled={busy || loading} onClick={() => void load()}>
        {t('重新载入（会覆盖当前修改）')}
      </button>
    </div>
  )
}
