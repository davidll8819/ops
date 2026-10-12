import { useEffect, useState } from 'react'
import { t } from '@/i18n'
import { api } from '../api'
type Reminder = {
  id: string
  title: string
  next_at: string
  repeat_daily: boolean
  active: boolean
  last_at?: string
}
export function ReminderSettings({ base, canEdit }: { base: string; canEdit: boolean }) {
  const [items, setItems] = useState<Reminder[]>([]),
    [title, setTitle] = useState(''),
    [when, setWhen] = useState(''),
    [daily, setDaily] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  async function load() {
    setItems((await api<{ items: Reminder[] }>(`${base}/secretary/reminders`)).items)
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message))
  }, [base]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="sec-card sec-preferences">
      <h2>{t('定时提醒')}</h2>
      <p>
        {t(
          '到时在秘书对话中提醒你；应用服务需要保持运行。每天重复使用当前设置的时间，不会自动发布内容。',
        )}
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError('')
          try {
            if (!when || Number.isNaN(Date.parse(when))) throw new Error('请选择有效的提醒时间')
            await api(`${base}/secretary/reminders`, {
              title,
              nextAt: new Date(when).toISOString(),
              repeatDaily: daily,
            })
            setTitle('')
            await load()
          } catch (e) {
            setError((e as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <label>
          {t('提醒内容')}
          <input
            required
            maxLength={500}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          {t('提醒时间')}
          <input
            required
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
        </label>
        <label>
          <input type="checkbox" checked={daily} onChange={(e) => setDaily(e.target.checked)} />
          {t('每天重复')}
        </label>
        <button disabled={!canEdit || busy}>{t('保存提醒')}</button>
      </form>
      {items.map((r) => (
        <article key={r.id}>
          <strong>{r.title}</strong>
          <p>
            {new Date(r.next_at).toLocaleString()} · {t(r.active ? '已启用' : '已结束')}
          </p>
          {r.active && (
            <button
              disabled={!canEdit || busy}
              onClick={async () => {
                try {
                  await api(`${base}/secretary/reminders/${r.id}/cancel`, {})
                  await load()
                } catch (e) {
                  setError((e as Error).message)
                }
              }}
            >
              {t('取消提醒')}
            </button>
          )}
        </article>
      ))}
      {error && (
        <p className="error" role="alert">
          {t(error)}
        </p>
      )}
    </section>
  )
}
