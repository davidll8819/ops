import { useEffect, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'

export type Conversation = {
  revision: number
  messages: { id: string; role: string; text: string }[]
}
export function DepartmentChat({
  base,
  department,
  openSettings,
  initial = '',
  image,
}: {
  base: string
  department: string
  openSettings: () => void
  initial?: string
  image?: string
}) {
  const [conversation, setConversation] = useState<Conversation>({ revision: 0, messages: [] }),
    [input, setInput] = useState(initial),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('')
  useEffect(() => {
    let live = true
    setLoading(true)
    api<Conversation>(`${base}/departments/${department}/conversation`)
      .then((r) => {
        if (live) setConversation(r)
      })
      .catch((e) => {
        if (live) setError(e.message)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [base, department])
  return (
    <section className="department-chat">
      <div className="heading-row">
        <h2>{t('与部门对话')}</h2>
        <button onClick={openSettings}>{t('模型设置')}</button>
      </div>
      <div role="log" className="department-messages">
        {!conversation.messages.length && (
          <p>{t('写下工作要求，回复与结果会保存到当前企业的个人对话中。')}</p>
        )}
        {conversation.messages.map((m) => (
          <article key={m.id} className={m.role}>
            <strong>{t(m.role === 'user' ? '我' : '部门回复')}</strong>
            <p>{m.text}</p>
          </article>
        ))}
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!input.trim() || busy || loading) return
          setBusy(true)
          setError('')
          try {
            setConversation(
              await api<Conversation>(`${base}/departments/${department}/chat`, {
                text: input,
                revision: conversation.revision,
                ...(image ? { image } : {}),
              }),
            )
            setInput('')
          } catch (e) {
            setError((e as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <label>
          {t('工作要求')}
          <textarea
            required
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={4}
            maxLength={20000}
          />
        </label>
        <button className="primary" disabled={busy || loading || !input.trim()}>
          {t(busy ? '正在处理…' : '发送')}
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {t(error)} <button onClick={openSettings}>{t('检查设置')}</button>
        </p>
      )}
    </section>
  )
}
