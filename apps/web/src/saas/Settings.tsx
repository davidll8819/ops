import { useEffect, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'
import './operations/operations.css'

type Tier = 'strong' | 'fast' | 'cheap'
type Capability = 'image' | 'video' | 'search'
type ModelSlot = Tier | Capability
type ModelEntry = { id: string; kinds: string[]; source: string; searchVerified?: boolean }
type Department = {
  enabled: boolean
  tier?: Tier
  fallback?: Tier
  skills: string[]
  need_confirm: boolean
  capabilities?: Record<Capability, { enabled: boolean; model: string }>
}
type Policy = {
  gateway: { base_url: string; api_key: string }
  tiers: Record<ModelSlot, string>
  departments: Record<string, Department>
  aitoearn: {
    server_url: string
    relay_key: string
    region: string
    accounts: Record<string, string>
  }
  budget: { daily_token_limit: number }
}
type Configuration = {
  configured: boolean
  revision: number
  policy: Policy
  aiKeySet: boolean
  relayKeySet: boolean
  secretNames: { ai: string; relay: string }
  budget: { used: number; reserved: number; available: number; day: string }
}
const departments: Record<string, string> = {
  secretary: '秘书处',
  content_ops: '运营部',
  market_research: '市场调研',
  design: '设计部',
  dev: '程序部',
  archive: '资料室',
  compliance: '合规部',
  outreach: '拓客部',
  intern: '实习生',
}
const tiers: Record<Tier, string> = { strong: '强推理', fast: '快速', cheap: '低成本' }
const slots: Record<ModelSlot, string> = { ...tiers, image: '图片', video: '视频', search: '搜索' }
export function Settings({ base, canEdit }: { base: string; canEdit: boolean }) {
  const [config, setConfig] = useState<Configuration | null>(null),
    [policy, setPolicy] = useState<Policy | null>(null)
  const [aiKey, setAiKey] = useState(''),
    [relayKey, setRelayKey] = useState('')
  const [models, setModels] = useState<ModelEntry[]>([])
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  useEffect(() => {
    if (!canEdit) return
    let live = true
    api<Configuration>(`${base}/operations/settings`)
      .then((data) => {
        if (live) {
          setConfig(data)
          setPolicy(data.policy)
        }
      })
      .catch((e) => {
        if (live) setError(e.message)
      })
    return () => {
      live = false
    }
  }, [base, canEdit])
  async function save() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api(
        `${base}/operations/settings`,
        {
          policy: {
            ...policy,
            departments: Object.fromEntries(
              Object.entries(policy!.departments).map(([id, d]) => [
                id,
                { ...d, skills: d.skills.filter(Boolean) },
              ]),
            ),
          },
          ...(aiKey.trim() ? { aiKey: aiKey.trim() } : {}),
          ...(relayKey.trim() ? { relayKey: relayKey.trim() } : {}),
        },
        'PUT',
      )
      const data = await api<Configuration>(`${base}/operations/settings`)
      setConfig(data)
      setPolicy(data.policy)
      setAiKey('')
      setRelayKey('')
      setNotice('配置已保存，已部署的运行服务会自动使用最新密钥和档位。')
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }
  async function discover() {
    if (!(await save())) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const data = await api<{ catalog: ModelEntry[] }>(`${base}/operations/models`)
      setModels(data.catalog)
      setNotice(
        data.catalog.length
          ? '模型列表已分类，请下拉选择文字、图片、视频和搜索模型。'
          : '服务没有返回可用模型。',
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  function department(id: string, patch: Partial<Department>) {
    if (policy)
      setPolicy({
        ...policy,
        departments: { ...policy.departments, [id]: { ...policy.departments[id], ...patch } },
      })
  }
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">SETTINGS</p>
        <h1>{t('设置')}</h1>
        <p className="muted">
          {t('每个企业一个模型入口，各部门按工作步骤调用文字、图片、视频和搜索能力。')}
        </p>
      </div>
      <section className="builder-card ops-settings">
        <div className="heading-row">
          <h2>{t('企业模型与部门配置')}</h2>
          <span className="plan-tag">{t('企业自带密钥')}</span>
        </div>
        {!canEdit ? (
          <p>{t('仅企业所有者和管理员可以修改服务配置。')}</p>
        ) : !policy || !config ? (
          <p>{t('正在加载…')}</p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <fieldset disabled={busy}>
              <legend>{t('第一层 · 模型中转站')}</legend>
              <label>
                {t('接口地址')}
                <input
                  required
                  type="url"
                  value={policy.gateway.base_url}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      gateway: { ...policy.gateway, base_url: e.target.value },
                    })
                  }
                />
              </label>
              <label>
                {t('企业 AI API Key')}
                <input
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={aiKey}
                  onChange={(e) => setAiKey(e.target.value)}
                  placeholder={t(
                    config.aiKeySet ? '已配置，留空保持原密钥' : '填写当前企业的 API Key',
                  )}
                />
              </label>
              <p className="muted">
                {t(
                  '密钥仅用于当前企业，加密保存在服务器，保存后不回显。填写新密钥可替换，留空保留原值。',
                )}
              </p>
              <p className="ops-notice">
                {t('AI 密钥状态')}：{t(config.aiKeySet ? '已配置' : '尚未配置')}
              </p>
              <button type="button" onClick={() => void discover()}>
                {t('读取模型列表')}
              </button>
            </fieldset>
            <fieldset disabled={busy}>
              <legend>{t('第二层 · 公司模型能力')}</legend>
              <div className="ops-tier-grid">
                {(Object.keys(slots) as ModelSlot[]).map((key) => {
                  const kind = key === 'image' || key === 'video' ? key : 'text'
                  const matching = models.filter((m) =>
                    key === 'search' ? m.searchVerified : m.kinds.includes(kind),
                  )
                  const unknown =
                    key === 'search' ? [] : models.filter((m) => m.kinds.includes('unknown'))
                  const current = policy.tiers[key]
                  return (
                    <label key={key}>
                      {t(slots[key])}
                      <select
                        aria-label={`${t(slots[key])} ${t('模型')}`}
                        value={current}
                        onChange={(e) =>
                          setPolicy({
                            ...policy,
                            tiers: { ...policy.tiers, [key]: e.target.value },
                          })
                        }
                      >
                        <option value="">
                          {t(models.length ? '请选择模型' : '请先读取模型列表')}
                        </option>
                        {current && ![...matching, ...unknown].some((m) => m.id === current) && (
                          <option value={current}>
                            {current} · {t('已保存，待核对')}
                          </option>
                        )}
                        <optgroup
                          label={t(
                            kind === 'text'
                              ? '文字模型'
                              : kind === 'image'
                                ? '图片生成模型'
                                : '视频生成模型',
                          )}
                        >
                          {matching.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.id}
                            </option>
                          ))}
                        </optgroup>
                        {!!unknown.length && (
                          <optgroup label={t('待识别能力，请按服务商说明选择')}>
                            {unknown.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.id}
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </label>
                  )
                })}
              </div>
              {!!models.length && (
                <p className="ops-notice">
                  {t('文字模型')} {models.filter((m) => m.kinds.includes('text')).length} ·{' '}
                  {t('图片生成模型')} {models.filter((m) => m.kinds.includes('image')).length} ·{' '}
                  {t('视频生成模型')} {models.filter((m) => m.kinds.includes('video')).length} ·{' '}
                  {t('待识别')} {models.filter((m) => m.kinds.includes('unknown')).length}
                </p>
              )}
              <p className="muted">
                {t(
                  '文字工作选择强推理、快速或低成本；图片、视频、搜索是独立能力，同一部门可以同时使用。',
                )}
              </p>
              <p className="muted">
                {t(
                  '搜索下拉列出已验证接口格式的模型，实际可用性仍取决于企业账号权限。部门默认继承公司模型，也可单独指定。',
                )}
              </p>
            </fieldset>
            <fieldset disabled={busy}>
              <legend>{t('第三层 · 部门配置')}</legend>
              <div className="ops-department-list">
                {Object.entries(departments).map(([id, name]) => {
                  const d = policy.departments[id]
                  return (
                    <article className="ops-department" key={id}>
                      <div className="heading-row">
                        <strong>{t(name)}</strong>
                        <label className="ops-toggle">
                          <input
                            type="checkbox"
                            checked={d.enabled}
                            onChange={(e) =>
                              department(id, {
                                enabled: e.target.checked,
                                ...(!d.tier && e.target.checked ? { tier: 'fast' as Tier } : {}),
                              })
                            }
                          />
                          {t(d.enabled ? '已启用' : '未启用')}
                        </label>
                      </div>
                      <div className="ops-tier-grid">
                        <label>
                          {t('文字处理模型')}
                          <select
                            aria-label={`${t(name)} ${t('文字处理模型')}`}
                            value={d.tier || ''}
                            onChange={(e) => department(id, { tier: e.target.value as Tier })}
                            disabled={!d.enabled}
                          >
                            <option value="" disabled>
                              {t('待配置')}
                            </option>
                            {(Object.keys(tiers) as Tier[]).map((key) => (
                              <option key={key} value={key}>
                                {key} · {t(tiers[key])}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          {t('文字备用模型')}
                          <select
                            aria-label={`${t(name)} ${t('文字备用模型')}`}
                            value={d.fallback || ''}
                            onChange={(e) =>
                              department(id, {
                                fallback: (e.target.value || undefined) as Tier | undefined,
                              })
                            }
                            disabled={!d.enabled}
                          >
                            <option value="">{t('不自动切换')}</option>
                            {(Object.keys(tiers) as Tier[]).map((key) => (
                              <option key={key} value={key}>
                                {key} · {t(tiers[key])}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          {t('技能引用')}
                          <input
                            value={d.skills.join(', ')}
                            onChange={(e) =>
                              department(id, {
                                skills: e.target.value.split(',').map((s) => s.trim()),
                              })
                            }
                          />
                        </label>
                      </div>
                      <div className="ops-capability-grid">
                        {(['image', 'video', 'search'] as Capability[]).map((kind) => {
                          const c = d.capabilities?.[kind] || {
                            enabled: {
                              image: ['content_ops', 'design'],
                              video: ['content_ops'],
                              search: ['secretary', 'market_research', 'outreach'],
                            }[kind].includes(id),
                            model: '',
                          }
                          const patch = (value: Partial<typeof c>) =>
                            department(id, {
                              capabilities: {
                                ...d.capabilities,
                                [kind]: { ...c, ...value },
                              } as Department['capabilities'],
                            })
                          const options = models.filter((m) =>
                            kind === 'search' ? m.searchVerified : m.kinds.includes(kind),
                          )
                          return (
                            <div key={kind}>
                              <label className="ops-toggle">
                                <input
                                  type="checkbox"
                                  checked={c.enabled}
                                  disabled={!d.enabled}
                                  onChange={(e) => patch({ enabled: e.target.checked })}
                                />
                                {t(slots[kind])}
                              </label>
                              <select
                                aria-label={`${t(name)} ${t(slots[kind])}`}
                                value={c.model}
                                disabled={!d.enabled || !c.enabled}
                                onChange={(e) => patch({ model: e.target.value })}
                              >
                                <option value="">
                                  {t('继承公司配置')} · {policy.tiers[kind] || t('待配置')}
                                </option>
                                {c.model && !options.some((m) => m.id === c.model) && (
                                  <option value={c.model}>{c.model}</option>
                                )}
                                {options.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {m.id}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )
                        })}
                      </div>
                      {id === 'content_ops' && (
                        <p className="ops-notice">{t('自动制作，所有对外发布须先确认')}</p>
                      )}
                    </article>
                  )
                })}
              </div>
              <p className="muted">
                {t(
                  '技能引用用于关联技能目录；填写名称不会自动安装或执行技能。文字备用模型仅在明确的服务错误后尝试，不重跑整个制作流程。',
                )}
              </p>
            </fieldset>
            <fieldset disabled={busy}>
              <legend>{t('每日用量上限')}</legend>
              <label>
                {t('每天最多 Token')}
                <input
                  required
                  type="number"
                  min="1000"
                  max="100000000"
                  step="1"
                  value={policy.budget.daily_token_limit}
                  onChange={(e) =>
                    setPolicy({ ...policy, budget: { daily_token_limit: Number(e.target.value) } })
                  }
                />
              </label>
              <div className="ops-budget-stats">
                <span>
                  {t('今日已用')}
                  <strong>{config.budget.used.toLocaleString()}</strong>
                </span>
                <span>
                  {t('进行中或待核对')}
                  <strong>{config.budget.reserved.toLocaleString()}</strong>
                </span>
                <span>
                  {t('当前可用')}
                  <strong>{config.budget.available.toLocaleString()}</strong>
                </span>
              </div>
              <p className="muted">
                {t(
                  '按上海时间每日重置。统一入口的文字调用预占后结算；异常未返回用量时保留预占。图片、视频费用及旧 AWS 自定义助手不计入此限额。',
                )}
              </p>
            </fieldset>
            <fieldset disabled={busy}>
              <legend>{t('AiToEarn · 发布对接')}</legend>
              <label>
                {t('本地服务地址')}
                <input readOnly value={policy.aitoearn.server_url} />
              </label>
              <p className="muted">
                {t('服务器部署地址由部署人员配置，不能用企业设置访问任意内网地址。')}
              </p>
              <label>
                {t('中转服务区域')}
                <select
                  value={policy.aitoearn.region}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      aitoearn: { ...policy.aitoearn, region: e.target.value },
                    })
                  }
                >
                  <option value="china">{t('中国服务')}</option>
                  <option value="global">{t('国际服务')}</option>
                </select>
              </label>
              <label>
                {t('平台中转 API Key')}
                <input
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={relayKey}
                  onChange={(e) => setRelayKey(e.target.value)}
                  placeholder={t(
                    config.relayKeySet ? '已配置，留空保持原密钥' : '填写平台中转服务的 API Key',
                  )}
                />
              </label>
              <p>
                {t('平台中转密钥状态')}：{t(config.relayKeySet ? '已配置' : '尚未配置')}
              </p>
              <label>
                {t('抖音账号备注')}
                <input
                  value={policy.aitoearn.accounts.douyin || ''}
                  placeholder={t('可稍后配置')}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      aitoearn: {
                        ...policy.aitoearn,
                        accounts: { ...policy.aitoearn.accounts, douyin: e.target.value },
                      },
                    })
                  }
                />
              </label>
              <p className="muted">
                {t(
                  '账号备注不代表已绑定。完成平台授权后，发布申请需你确认；平台中转密钥与 AI 密钥互相独立。',
                )}
              </p>
            </fieldset>
            <button className="primary" disabled={busy}>
              {t(busy ? '正在保存…' : '保存企业配置')}
            </button>
          </form>
        )}
        {error && (
          <p role="alert" className="error">
            {t(error)}
          </p>
        )}
        {notice && (
          <p role="status" className="ops-notice">
            {t(notice)}
          </p>
        )}
      </section>
    </>
  )
}
