import { useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'
import { ArchiveSources } from './ArchiveSources'
import { archiveCategories, type ArchiveRecord } from './archive-records'
import './archive-records.css'
type Listing = { items: ArchiveRecord[]; total: number; page: number; pageSize: number }
export function ArchiveRegistry({ base }: { base: string }) {
  return <RegistrySession key={base} base={base} />
}
function RegistrySession({ base }: { base: string }) {
  const [filters, setFilters] = useState({ category: '', tag: '', q: '' }),
    [applied, setApplied] = useState(filters),
    [data, setData] = useState<Listing>({ items: [], total: 0, page: 1, pageSize: 20 }),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [detail, setDetail] = useState<ArchiveRecord | null>(null),
    [detailError, setDetailError] = useState(''),
    [detailBusy, setDetailBusy] = useState(false)
  const alive = useRef(true),
    seq = useRef(0),
    detailSeq = useRef(0),
    endpoint = `${base}/archive/records`
  async function search(page = 1, next = filters) {
    const n = ++seq.current
    detailSeq.current++
    setDetail(null)
    setDetailError('')
    setDetailBusy(false)
    setLoading(true)
    setError('')
    setData({ items: [], total: 0, page, pageSize: 20 })
    setApplied(next)
    try {
      const r = await api<Listing>(
        endpoint + '?' + new URLSearchParams({ ...next, page: String(page) }),
      )
      if (alive.current && n === seq.current) setData(r)
    } catch (e) {
      if (alive.current && n === seq.current) setError((e as Error).message)
    } finally {
      if (alive.current && n === seq.current) setLoading(false)
    }
  }
  useEffect(() => {
    alive.current = true
    void search()
    return () => {
      alive.current = false
    } // Tenant changes unmount this session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  async function show(item: ArchiveRecord) {
    const n = ++detailSeq.current
    setDetail(null)
    setDetailError('')
    setDetailBusy(true)
    try {
      const { record } = await api<{ record: ArchiveRecord }>(
        endpoint + '/' + encodeURIComponent(item.id),
      )
      if (!alive.current || n !== detailSeq.current) return
      if (
        record.id !== item.id ||
        record.state !== 'archived' ||
        record.source.sha256 !== item.source.sha256 ||
        record.source.fileId !== item.source.fileId ||
        record.source.extractionId !== item.source.extractionId
      )
        throw new Error(t('档案来源不一致，请重新检索。'))
      setDetail(record)
    } catch (e) {
      if (alive.current && n === detailSeq.current) setDetailError((e as Error).message)
    } finally {
      if (alive.current && n === detailSeq.current) setDetailBusy(false)
    }
  }
  return (
    <section className="archive-registry" aria-label={t('正式档案检索')}>
      <h3>{t('档案检索')}</h3>
      <p className="muted small">
        {t('检索你在当前企业确认归档的资料；未确认的草稿不会出现在这里。')}
      </p>
      <form
        className="archive-registry-filters"
        onSubmit={(e) => {
          e.preventDefault()
          void search()
        }}
      >
        <label>
          {t('按资料类型')}
          <select
            aria-label={t('按资料类型')}
            value={filters.category}
            onChange={(e) => setFilters((v) => ({ ...v, category: e.target.value }))}
          >
            <option value="">{t('全部类型')}</option>
            {archiveCategories.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label>
          {t('按标签')}
          <input
            maxLength={20}
            value={filters.tag}
            onChange={(e) => setFilters((v) => ({ ...v, tag: e.target.value }))}
          />
        </label>
        <label>
          {t('档案关键词')}
          <input
            maxLength={120}
            value={filters.q}
            onChange={(e) => setFilters((v) => ({ ...v, q: e.target.value }))}
            placeholder={t('名称或档案号')}
          />
        </label>
        <button type="submit">{t('检索档案')}</button>
      </form>
      {loading && <p role="status">{t('正在检索档案…')}</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && (
        <p>
          {t('正式档案')}：{data.total}
        </p>
      )}
      {!loading && !error && !data.items.length && <p>{t('没有符合条件的正式档案。')}</p>}
      {data.items.map((item) => (
        <article className="archive-registry-card" key={item.id}>
          <h4>{item.filename}</h4>
          <p>
            {item.archiveNumber} · {item.metadata.department} / {item.metadata.category}
          </p>
          <div className="archive-filing-tags">
            {item.metadata.tags.map((tag) => (
              <button
                type="button"
                key={tag}
                onClick={() => {
                  const f = { ...applied, tag }
                  setFilters(f)
                  void search(1, f)
                }}
              >
                {tag}
              </button>
            ))}
          </div>
          <p className="archive-record-path">{item.directory}</p>
          <p>
            {t('归档时间')}：{new Date(item.archivedAt!).toLocaleString()}
          </p>
          <button type="button" onClick={() => void show(item)}>
            {t('查看档案')}
          </button>
        </article>
      ))}
      <div className="archive-filing-actions">
        <button
          type="button"
          disabled={loading || data.page <= 1}
          onClick={() => void search(data.page - 1, applied)}
        >
          {t('上一页')}
        </button>
        <span>
          {data.page} / {Math.max(1, Math.ceil(data.total / data.pageSize))}
        </span>
        <button
          type="button"
          disabled={loading || data.page * data.pageSize >= data.total}
          onClick={() => void search(data.page + 1, applied)}
        >
          {t('下一页')}
        </button>
      </div>
      {detailBusy && <p role="status">{t('正在核验档案原件…')}</p>}
      {detailError && <p role="alert">{detailError}</p>}
      {detail && (
        <section className="archive-record-detail" aria-label={t('档案详情')}>
          <h4>
            {t('已正式归档')} · {detail.filename}
          </h4>
          <p>{detail.archiveNumber}</p>
          <p className="archive-record-path">{detail.relativePath}</p>
          <p>
            {t('人工归档说明')}：{detail.metadata.note || t('未填写')}
          </p>
          <p>
            {t('原始文件')}：{detail.source.name}
          </p>
          <p>
            {t('来源版本')}：{detail.source.extractionId}
          </p>
          <a href={`${base}/files/${encodeURIComponent(detail.source.fileId)}/download`} download>
            {t('下载归档原件')}
          </a>
          {detail.evidence && (
            <>
              <p>
                <strong>{t('原模型推荐依据')}：</strong>
                {detail.evidence.reason}
              </p>
              <ArchiveSources
                base={base}
                citations={detail.evidence.citations}
                coverage={detail.evidence.coverage}
              />
              {detail.evidence.warnings.map((w, i) => (
                <p className="muted small" key={i}>
                  {w}
                </p>
              ))}
            </>
          )}
        </section>
      )}
    </section>
  )
}
