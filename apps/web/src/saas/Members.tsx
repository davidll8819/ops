import { useEffect, useState } from 'react'
import { t } from '@/i18n'
import { api, type Tenant } from './api'
export function Members({ base, tenant }: { base: string; tenant: Tenant }) {
  const [members, setMembers] = useState<
      {
        id: string
        email: string
        role: string
      }[]
    >([]),
    [email, setEmail] = useState(''),
    [url, setUrl] = useState(''),
    [error, setError] = useState('')
  useEffect(() => {
    api<{
      members: typeof members
    }>(`${base}/members`)
      .then((r) => setMembers(r.members))
      .catch((e) => setError(e.message))
  }, [base])
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">PEOPLE</p>
        <h1>{t('企业成员')}</h1>
        <p className="muted">{t('成员通过邮箱邀请加入，可以同时属于多个企业。')}</p>
      </div>
      <section className="builder-card">
        {members.map((m) => (
          <div className="member-row" key={m.id}>
            <span>{m.email}</span>
            <span className="plan-tag">
              {{ owner: t('所有者'), admin: t('管理员'), member: t('成员') }[m.role]}
            </span>
          </div>
        ))}
      </section>
      {tenant.role !== 'member' && (
        <section className="builder-card">
          <h2>{t('邀请同事')}</h2>
          {tenant.plan !== 'enterprise' ? (
            <p>{t('多人协作需要企业版。支付接入后可自助升级，目前由运营开通。')}</p>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault()
                try {
                  const r = await api<{
                    url: string
                  }>(`${base}/invitations`, { email, role: 'member' })
                  setUrl(r.url)
                  setError('')
                } catch (e) {
                  setError((e as Error).message)
                }
              }}
            >
              <label>
                {t('同事的邮箱')}
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
              <button className="primary">{t('生成邀请链接')}</button>
            </form>
          )}
          {url && (
            <label>
              {t('请将链接交给对应邮箱的同事')}
              <input readOnly value={url} onFocus={(e) => e.target.select()} />
            </label>
          )}
          {error && <p className="error">{t(error)}</p>}
        </section>
      )}
    </>
  )
}
