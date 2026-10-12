import { useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'
export type Config = {
  authMode: string
  agentsReady: boolean
  paymentsEnabled: boolean
  agentRegion: string
}
export function Login({
  config,
  onLogin,
  initialError,
}: {
  config: Config | null
  onLogin: () => Promise<void>
  initialError: string
}) {
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(initialError),
    [busy, setBusy] = useState(false)
  return (
    <main className="login-layout">
      <section className="login-story">
        <a className="wordmark" href="/">
          ◈ Wishtaday
        </a>
        <div>
          <p className="eyebrow">{t('你的企业 · 你的智能团队')}</p>
          <h1>
            {t('让每一份想法，')}
            <br />
            {t('都有助手接住。')}
          </h1>
          <p className="story-description">
            {t(
              '在同一个工作空间里创建助手、延续对话、了解每一次使用。切换企业，工作与记忆各归其位。',
            )}
          </p>
          <div className="story-cards">
            <div>
              <span>01</span>
              <strong>{t('一个账户，多个工作空间')}</strong>
            </div>
            <div>
              <span>02</span>
              <strong>{t('为每项工作配置专属助手')}</strong>
            </div>
            <div>
              <span>03</span>
              <strong>{t('成员、记忆与用量清晰可见')}</strong>
            </div>
          </div>
        </div>
        <p className="story-footer">WISHTADAY · AI OFFICE</p>
      </section>
      <section className="login-form-side">
        <div className="login-card">
          <span className="login-symbol">↗</span>
          <p className="eyebrow">{t('欢迎回来')}</p>
          <h2>{t('登录你的工作空间')}</h2>
          <p className="muted">{t('登录后才能使用办公室与智能助手。')}</p>
          {config?.authMode === 'local' ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault()
                setBusy(true)
                setError('')
                try {
                  await api('/auth/local', { email, password })
                  await onLogin()
                } catch (e) {
                  setError((e as Error).message)
                } finally {
                  setBusy(false)
                }
              }}
            >
              <label>
                {t('邮箱')}
                <input
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
              <label>
                {t('密码')}
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
              <button className="primary wide" disabled={busy}>
                {busy ? t('正在登录…') : t('登录')}
              </button>
              <p className="small muted">
                {t(
                  '本地验证模式。云端用户名密码和 Passkey（通行密钥）由 Cognito（身份服务）提供。',
                )}
              </p>
            </form>
          ) : (
            <>
              <a className="primary button-link wide" href="/auth/login">
                {t('登录 / 创建账户 →')}
              </a>
              <p className="small muted">
                {t('支持用户名密码、Passkey（通行密钥）。登录方式在安全登录页中选择。')}
              </p>
            </>
          )}
          {error && (
            <p className="error" role="alert">
              {t(error)}
            </p>
          )}
          <div className="login-footnote">
            {t('企业成员通过邀请加入；同一邮箱可访问多个企业。')}
          </div>
        </div>
      </section>
    </main>
  )
}
