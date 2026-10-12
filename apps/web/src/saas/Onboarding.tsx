import { useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'
export function CreateTenant({ onCreated }: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState(''),
    [error, setError] = useState('')
  return (
    <section className="empty-card">
      <p className="eyebrow">{t('开始协作')}</p>
      <h1>{t('创建你的工作空间')}</h1>
      <p className="muted">{t('一个企业对应一个独立工作空间。企业版可邀请多位成员。')}</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          try {
            await api('/api/tenants', { name })
            await onCreated()
          } catch (e) {
            setError((e as Error).message)
          }
        }}
      >
        <label>
          {t('工作空间名称')}
          <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
        </label>
        <button className="primary">{t('创建工作空间')}</button>
      </form>
      {error && <p className="error">{t(error)}</p>}
    </section>
  )
}
export function Invitation({ onAccepted }: { onAccepted: () => Promise<void> }) {
  const token =
      new URLSearchParams(location.search).get('invite') ||
      sessionStorage.getItem('pending-invite'),
    [error, setError] = useState(''),
    [done, setDone] = useState(false)
  if (!token || done) return null
  return (
    <div className="invite-banner">
      {t('你收到了一份企业邀请。')}
      <button
        onClick={async () => {
          try {
            await api('/api/invitations/accept', { token })
            sessionStorage.removeItem('pending-invite')
            history.replaceState({}, '', '/')
            setDone(true)
            await onAccepted()
          } catch (e) {
            setError((e as Error).message)
          }
        }}
      >
        {t('接受邀请')}
      </button>
      {error && <span className="error">{t(error)}</span>}
    </div>
  )
}
