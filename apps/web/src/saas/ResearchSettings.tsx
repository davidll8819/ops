import { useEffect, useState } from 'react'
import { api } from './api'
import { t } from '@/i18n'
type Configuration = { provider: 'tavily' | 'brave'; keySet: boolean }
export function ResearchSettings({ base, canEdit }: { base: string; canEdit: boolean }) {
  const [config, setConfig] = useState<Configuration>({ provider: 'tavily', keySet: false }),
    [key, setKey] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  useEffect(() => {
    if (!canEdit) return
    let live = true
    api<Configuration>(`${base}/research/settings`)
      .then((v) => {
        if (live) setConfig(v)
      })
      .catch((e) => {
        if (live) setError(e.message)
      })
    return () => {
      live = false
    }
  }, [base, canEdit])
  async function save(clear = false) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await api<Configuration>(
        `${base}/research/settings`,
        { provider: config.provider, ...(key ? { apiKey: key } : {}), clear },
        'PUT',
      )
      setConfig(result)
      setKey('')
      setNotice(clear ? '搜索密钥已移除' : '联网搜索配置已保存')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (!canEdit) return null
  return (
    <section className="builder-card ops-settings">
      <h2>{t('市场调研 · 联网搜索')}</h2>
      <p className="muted">
        {t(
          '刘市根据目标搜索公开资料、读取网页并生成带来源的报告。搜索词会发送给所选搜索服务，网页内容会交给企业配置的模型分析。',
        )}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <fieldset disabled={busy}>
          <label>
            {t('搜索服务')}
            <select
              value={config.provider}
              onChange={(e) => {
                setConfig({ provider: e.target.value as Configuration['provider'], keySet: false })
                setKey('')
              }}
            >
              <option value="tavily">Tavily</option>
              <option value="brave">Brave Search</option>
            </select>
          </label>
          <label>
            {t('搜索 API Key')}
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={t(config.keySet ? '已配置，留空保持原密钥' : '填写搜索服务的 API Key')}
            />
          </label>
          <p>
            {t('搜索密钥状态')}：{t(config.keySet ? '已配置' : '尚未配置')}
          </p>
          <p className="muted">
            {t(
              '每项调研最多 3 次搜索、6 次网页读取和 8 轮模型调用；搜索服务按自己的套餐计费，不计入文字 Token 上限。没有搜索密钥时不会伪造调研结果。',
            )}
          </p>
          <button className="primary">{t('保存联网搜索配置')}</button>
          {config.keySet && (
            <button type="button" onClick={() => void save(true)}>
              {t('移除搜索密钥')}
            </button>
          )}
        </fieldset>
      </form>
      {error && (
        <p role="alert" className="error">
          {t(error)}
        </p>
      )}
      {notice && <p role="status">{t(notice)}</p>}
    </section>
  )
}
