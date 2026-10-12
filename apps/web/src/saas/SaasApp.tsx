import { Login, type Config } from './Login'
import { CreateTenant, Invitation } from './Onboarding'
import { Workspace } from './Workspace'
import { t, useLanguage, setLanguage } from '@/i18n'
import { useEffect, useState } from 'react'
import { api, setCsrf, type Me } from './api'
import './saas.css'

export default function SaasApp() {
  const language = useLanguage()
  const [me, setMe] = useState<Me | null>(null),
    [config, setConfig] = useState<Config | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [tenantId, setTenantId] = useState('')
  async function refresh() {
    const data = await api<Me>('/api/me')
    setCsrf(data.csrf)
    setMe(data)
    setTenantId((id) => (data.tenants.some((t) => t.id === id) ? id : data.tenants[0]?.id || ''))
  }
  useEffect(() => {
    const invite = new URLSearchParams(location.search).get('invite')
    if (invite) sessionStorage.setItem('pending-invite', invite)
    let live = true
    Promise.all([
      fetch('/public/config').then((r) => r.json()),
      fetch('/api/me').then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([c, m]) => {
        if (!live) return
        setConfig(c)
        if (m) {
          setMe(m)
          setCsrf(m.csrf)
          setTenantId(m.tenants[0]?.id || '')
        }
      })
      .catch(() => setError(t('无法连接服务')))
      .finally(() => {
        if (live) setLoading(false)
      })
    const logout = () => {
      setMe(null)
      setCsrf('')
    }
    window.addEventListener('office:unauthorized', logout)
    return () => {
      live = false
      window.removeEventListener('office:unauthorized', logout)
    }
  }, [])
  if (loading)
    return (
      <div className="welcome">
        <p>{t('正在连接你的工作空间…')}</p>
      </div>
    )
  if (!me)
    return (
      <>
        <div className="language-fixed">
          <button onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}>
            {language === 'zh' ? 'English' : '中文'}
          </button>
        </div>
        <Login config={config} onLogin={refresh} initialError={t(error)} />
      </>
    )
  const active = me.tenants.find((t) => t.id === tenantId)
  return (
    <div className="saas-app">
      <header className="saas-header">
        <a className="wordmark" href="/">
          ◈{' '}
          <span>
            Wish<span className="muted">taday</span>
          </span>
        </a>
        <span className="header-divider" />
        <select
          aria-label={t('切换企业')}
          value={tenantId}
          onChange={(e) => {
            setTenantId(e.target.value)
            setError('')
          }}
        >
          <option value="">{t('选择工作空间')}</option>
          {me.tenants.map((item) => (
            <option value={item.id} key={item.id}>
              {item.name} · {item.plan === 'enterprise' ? t('企业版') : t('个人版')}
            </option>
          ))}
        </select>
        <button onClick={() => setTenantId('')}>{t('＋ 工作空间')}</button>
        <span className="header-spacer" />
        <button onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}>
          {language === 'zh' ? 'English' : '中文'}
        </button>
        <span className="user-email">{me.user.email}</span>
        <button
          onClick={async () => {
            try {
              const r = await api<{
                redirect: string
              }>('/auth/logout', {})
              location.href = r.redirect
            } catch (e) {
              setError(String(e))
            }
          }}
        >
          {t('退出')}
        </button>
      </header>
      {error && (
        <p role="alert" className="error">
          {t(error)}
        </p>
      )}
      {config?.agentsReady === false && (
        <div className="connection-note">
          {t(
            '本地工作空间：在设置中配置企业 API Key 和模型后，即可使用秘书与部门对话。',
          )}
        </div>
      )}
      <Invitation onAccepted={refresh} />
      {active ? (
        <Workspace key={active.id} tenant={active} />
      ) : (
        <CreateTenant
          onCreated={async () => {
            await refresh()
          }}
        />
      )}
    </div>
  )
}
