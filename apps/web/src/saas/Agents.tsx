import { useState } from 'react'
import { t } from '@/i18n'
import { api, type Profile, type Agent } from './api'
const blank: Profile = {
  name: '',
  systemPrompt: '',
  modelId: '',
  maxTokens: 2048,
  temperature: 0.4,
  memory: true,
}
export function AgentPanel({
  title = '把工作交给合适的助手',
  base,
  agents,
  models,
  canEdit,
  refresh,
}: {
  title?: string
  base: string
  agents: Agent[]
  models: string[]
  canEdit: boolean
  refresh: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false),
    [profile, setProfile] = useState<Profile>(blank),
    [description, setDescription] = useState(''),
    [selected, setSelected] = useState<Agent | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [params, setParams] = useState('')
  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="page-heading heading-row">
        <div>
          <p className="eyebrow">YOUR AI TEAM</p>
          <h1>{t(title)}</h1>
          <p className="muted">{t('从目标出发，配置提示词、模型与记忆。')}</p>
        </div>
        {canEdit && (
          <button
            className="primary"
            onClick={() => {
              setProfile({ ...blank, modelId: models[0] || '' })
              setEditing(!editing)
            }}
          >
            {t('＋ 创建助手')}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {t(error)}
        </p>
      )}
      {editing && (
        <section className="builder-card">
          <h2>{t('Agent builder（助手构建器）')}</h2>
          <label>
            {t('描述助手的任务')}
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('例如：为市场团队整理调研资料，先归纳事实，再列出待验证的问题。')}
            />
          </label>
          <button
            disabled={busy || description.length < 10}
            onClick={() =>
              run(async () => {
                const r = await api<{
                  profile: Profile
                }>(`${base}/agent-builder`, { description, requestId: crypto.randomUUID() })
                setProfile(r.profile)
              })
            }
          >
            {t('自动生成配置')}
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void run(async () => {
                await api(`${base}/agents`, profile)
                await refresh()
                setEditing(false)
              })
            }}
          >
            <div className="form-grid">
              <label>
                {t('助手名称')}
                <input
                  value={profile.name}
                  required
                  onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                />
              </label>
              <label>
                {t('模型')}
                <select
                  value={profile.modelId}
                  onChange={(e) => setProfile({ ...profile, modelId: e.target.value })}
                  required
                >
                  <option value="">{t('选择模型')}</option>
                  {models.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              {t('工作指令')}
              <textarea
                className="prompt-input"
                minLength={8}
                required
                value={profile.systemPrompt}
                onChange={(e) => setProfile({ ...profile, systemPrompt: e.target.value })}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={profile.memory}
                onChange={(e) => setProfile({ ...profile, memory: e.target.checked })}
              />
              {t('启用个人记忆（仅当前企业、用户与助手）')}
            </label>
            <button className="primary" disabled={busy}>
              {busy ? t('处理中…') : t('保存并创建助手')}
            </button>
          </form>
        </section>
      )}
      <div className="agent-grid">
        {agents.map((a) => (
          <article className="assistant-card" key={a.id}>
            <span className="assistant-icon">◈</span>
            <h2>{a.profile.name}</h2>
            <p>{a.profile.systemPrompt.slice(0, 110)}</p>
            <span className="small muted">
              {a.profile.memory ? t('个人记忆已启用') : t('不保存长期记忆')}
            </span>
            <div className="card-actions">
              <button className="primary" onClick={() => setSelected(a)}>
                {t('开始对话 →')}
              </button>
              {canEdit && (
                <button
                  onClick={() =>
                    run(async () =>
                      setParams(
                        JSON.stringify(await api(`${base}/agents/${a.id}/harness`), null, 2),
                      ),
                    )
                  }
                >
                  {t('查看配置')}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {agents.length === 0 && !editing && (
        <div className="empty-state">
          <span>◈</span>
          <h2>{t('你的第一位助手，等你定义')}</h2>
          <p>{t('创建一个助手，为它设置清楚的工作目标。')}</p>
        </div>
      )}
      {params && (
        <section className="builder-card">
          <button onClick={() => setParams('')}>{t('关闭')}</button>
          <pre>{params}</pre>
        </section>
      )}
      {selected && (
        <Chat key={selected.id} base={base} agent={selected} close={() => setSelected(null)} />
      )}
    </>
  )
}
export function Chat({ base, agent, close }: { base: string; agent: Agent; close: () => void }) {
  const [prompt, setPrompt] = useState(''),
    [messages, setMessages] = useState<
      {
        role: string
        text: string
      }[]
    >([]),
    [conversationId, setConversationId] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  return (
    <aside className="chat-panel">
      <header>
        <div>
          <strong>{agent.profile.name}</strong>
          <p className="small muted">{t('当前企业 · 你的私人对话')}</p>
        </div>
        <button aria-label={t('关闭对话')} onClick={close}>
          ×
        </button>
      </header>
      <div className="chat-messages">
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role}`}>
            {m.text}
          </div>
        ))}
        {busy && <p>{t('助手正在处理…')}</p>}
        {error && <p className="error">{t(error)}</p>}
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          const text = prompt
          setBusy(true)
          setError('')
          setMessages((m) => [...m, { role: 'user', text }])
          setPrompt('')
          try {
            const r = await api<{
              text: string
              conversationId: string
            }>(`${base}/agents/${agent.id}/messages`, {
              prompt: text,
              conversationId,
              requestId: crypto.randomUUID(),
            })
            setConversationId(r.conversationId)
            setMessages((m) => [...m, { role: 'assistant', text: r.text }])
          } catch (e) {
            setError((e as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <textarea
          aria-label={t('消息')}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('告诉助手你想完成什么…')}
        />
        <button className="primary" disabled={busy || !prompt.trim()}>
          {t('发送')}
        </button>
      </form>
    </aside>
  )
}
