import { useState } from 'react'
import { t } from '@/i18n'
import { api } from '../api'
const platforms: Record<string, string> = {
  douyin: '抖音',
  xhs: '小红书',
  wxSph: '微信视频号',
  wxGzh: '微信公众号',
  bilibili: '哔哩哔哩',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  twitter: 'X',
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  threads: 'Threads',
  pinterest: 'Pinterest',
}
export function PlatformAccounts({
  root,
  canEdit,
  openSettings,
}: {
  root: string
  canEdit: boolean
  openSettings: () => void
}) {
  const [accounts, setAccounts] = useState<
      { id?: string; accountId?: string; name?: string; displayName?: string; platform?: string }[]
    >([]),
    [platform, setPlatform] = useState('douyin'),
    [auth, setAuth] = useState<{ url: string; sessionId: string; platform: string } | null>(null),
    [error, setError] = useState(''),
    [state, setState] = useState(''),
    [busy, setBusy] = useState(false)
  async function load() {
    setError('')
    try {
      const data = await api<unknown>(`${root}/accounts`)
      const d = data as { items?: typeof accounts; list?: typeof accounts }
      setAccounts(Array.isArray(data) ? data : d.items || d.list || [])
      setState('平台账号已刷新')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <section className="builder-card">
      <div className="heading-row">
        <h2>{t('平台账号')}</h2>
        <button disabled={busy} onClick={() => void load()}>
          {t('刷新账号')}
        </button>
      </div>
      <p>{t('绑定后的账号供运营流程发布使用，提交前须确认。国内外平台均通过企业自己的中转服务连接。')}</p>
      {accounts.map((a, i) => (
        <p key={a.id || a.accountId || i}>
          {a.displayName || a.name || a.accountId || a.id} · {a.platform}
        </p>
      ))}
      <label>
        {t('选择发布平台')}
        <select
          value={platform}
          onChange={(e) => {
            setPlatform(e.target.value)
            setAuth(null)
            setState('')
          }}
        >
          {Object.entries(platforms).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={!canEdit || busy}
        onClick={async () => {
          setBusy(true)
          setError('')
          try {
            const r = await api<{ url: string; sessionId: string }>(`${root}/accounts/connect`, {
              platform,
            })
            if (
              !r.url?.startsWith('https://') &&
              ![
                'data:image/png;base64,',
                'data:image/jpeg;base64,',
                'data:image/webp;base64,',
              ].some((prefix) => r.url?.startsWith(prefix))
            )
              throw new Error('运行服务没有返回可用的授权地址')
            setAuth({ ...r, platform })
            setState('请完成平台授权后检查结果')
          } catch (e) {
            setError((e as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        {t('绑定平台账号')}
      </button>
      {auth && (
        <div>
          {auth.url.startsWith('https://') ? (
            <a href={auth.url} target="_blank" rel="noopener noreferrer">
              {t('打开平台授权页面')} ↗
            </a>
          ) : (
            <img className="ocr-preview" src={auth.url} alt={t('平台授权二维码')} />
          )}
          <button
            onClick={async () => {
              setError('')
              try {
                const r = await api<{ status: string; requiresSelection?: boolean }>(
                  `${root}/accounts/auth/${auth.platform}/${encodeURIComponent(auth.sessionId)}`,
                )
                setState(r.requiresSelection ? '请在平台授权页面完成子账号选择' : r.status)
              } catch (e) {
                setError((e as Error).message)
              }
            }}
          >
            {t('检查授权结果')}
          </button>
        </div>
      )}
      {state && <p role="status">{t(state)}</p>}
      {error && (
        <p role="alert" className="error">
          {t(error)} <button onClick={openSettings}>{t('检查设置')}</button>
        </p>
      )}
    </section>
  )
}
