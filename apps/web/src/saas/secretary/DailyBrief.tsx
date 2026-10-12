import { useEffect, useState } from 'react'
import { t, useLanguage } from '@/i18n'
import { api } from '../api'
type Brief = {
  day: string
  topic: string
  text: string
  generatedAt: string
  sources: { id: string; title: string; url: string }[]
}
export function DailyBrief({ base, canEdit }: { base: string; canEdit: boolean }) {
  const language = useLanguage(),
    [brief, setBrief] = useState<Brief | null>(null),
    [topic, setTopic] = useState(t('AI 应用、一人公司与中小企业经营')),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  useEffect(() => {
    let live = true
    api<{ brief: Brief | null }>(`${base}/secretary/brief`)
      .then((r) => {
        if (live) {
          setBrief(r.brief)
          if (r.brief) setTopic(r.brief.topic)
        }
      })
      .catch((e) => {
        if (live) setError(e.message)
      })
    return () => {
      live = false
    }
  }, [base])
  async function generate() {
    setBusy(true)
    setError('')
    try {
      const r = await api<{ brief: Brief }>(`${base}/secretary/brief`, { topic, language })
      setBrief(r.brief)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <article className="sec-card sec-brief">
      <header>
        <h2>{t('今日简报')}</h2>
        <span>{brief?.day || t('新闻与资讯')}</span>
      </header>
      <label className="brief-topic">
        {t('关注方向')}
        <input
          value={topic}
          maxLength={160}
          onChange={(e) => setTopic(e.target.value)}
          disabled={busy || !canEdit}
        />
      </label>
      <button disabled={busy || !canEdit || !topic.trim()} onClick={() => void generate()}>
        {t(busy ? '正在查阅新闻…' : '读取今日新闻')}
      </button>
      {error && (
        <p role="alert" className="error">
          {t(error)}
        </p>
      )}
      {brief ? (
        <>
          <p className="brief-content">{brief.text}</p>
          <details>
            <summary>{t('新闻来源')}</summary>
            {brief.sources.map((s) => (
              <p key={s.id}>
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  [{s.id}] {s.title}
                </a>
              </p>
            ))}
          </details>
          <small>
            {t('检索时间')} · {new Date(brief.generatedAt).toLocaleString()}
          </small>
        </>
      ) : (
        <p>{t('读取关注领域的真实新闻，保留发布日期与来源。同一天同一主题复用已有简报。')}</p>
      )}
    </article>
  )
}
