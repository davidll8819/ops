import { PlatformAccounts } from './PlatformAccounts'
import { useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { api, csrf } from '../api'
import './operations.css'
type Status = { ready: boolean; reason: string }
type Publication = {
  execution_mode: 'manual' | 'automatic'
  id: string
  state: string
  payload: {
    content: { title?: string; body?: string; media: { url: string }[] }
    items: { accountId: string; platform: string }[]
    publishAt: string
  }
  result?: unknown
}
type Task = { id: string; title?: string; status?: string }
const states: Record<string, string> = {
  pending: '待你确认',
  rejected: '已退回',
  submitting: '提交中',
  submitted: '已提交平台，等待回执',
  uncertain: '结果待核对，请勿重复发布',
}
function readable(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(readable).filter(Boolean).join('\n')
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.text) return readable(record.text)
    if (record.content) return readable(record.content)
    if (record.message) return readable(record.message)
    if (record.result) return readable(record.result)
    if (record.description) return [record.title, record.description].filter(Boolean).join('\n')
    if (record.errors) return readable(record.errors)
    if (record.tool_name) return String(record.tool_name)
  }
  return ''
}
function resultMedia(value: unknown): { type: string; url: string }[] {
  if (Array.isArray(value)) return value.flatMap(resultMedia)
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  if (
    typeof record.url === 'string' &&
    ['IMAGE', 'VIDEO'].includes(String(record.type)) &&
    /^https?:\/\//.test(record.url)
  )
    return [{ type: String(record.type), url: record.url }]
  return ['message', 'messages', 'result', 'medias', 'structured_output'].flatMap((key) =>
    resultMedia(record[key]),
  )
}
export type OperationsHandoff = {
  id: string
  text: string
  secretaryTaskId?: string
  runtimeTaskId?: string
}
export function OperationsWorkspace({
  base,
  canEdit,
  handoff,
  openSettings,
}: {
  base: string
  canEdit: boolean
  handoff?: OperationsHandoff
  openSettings: () => void
}) {
  const root = `${base}/operations`
  const [status, setStatus] = useState<Status | null>(null),
    [error, setError] = useState('')
  const [prompt, setPrompt] = useState(''),
    [busy, setBusy] = useState(false),
    [output, setOutput] = useState<string[]>([])
  const [media, setMedia] = useState<{ type: string; url: string }[]>([])
  const [receipts, setReceipts] = useState<Record<string, string>>({})
  const [tasks, setTasks] = useState<Task[]>([]),
    [taskId, setTaskId] = useState<string>(),
    [secretaryTaskId, setSecretaryTaskId] = useState<string>()
  const [publications, setPublications] = useState<Publication[]>([]),
    [acting, setActing] = useState('')
  const handledHandoff = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (handoff && handoff.id !== handledHandoff.current && !busy) {
      handledHandoff.current = handoff.id
      setPrompt(handoff.text)
      setSecretaryTaskId(handoff.secretaryTaskId)
      setTaskId(handoff.runtimeTaskId)
      if (handoff.runtimeTaskId)
        void api<{ messages?: unknown[] }>(`${root}/tasks/${handoff.runtimeTaskId}`)
          .then((data) => {
            setOutput([readable(data.messages) || t('任务记录暂无文本')])
            setMedia(resultMedia(data.messages))
          })
          .catch((e) => setError(e.message))
      setOutput([])
      setMedia([])
    }
  }, [handoff, busy, root])
  const refreshApprovals = async () =>
    setPublications((await api<{ items: Publication[] }>(`${root}/publications`)).items)
  async function refresh() {
    setError('')
    try {
      const current = await api<Status>(`${root}/status`)
      setStatus(current)
      await refreshApprovals()
      if (current.ready) {
        const data = await api<{ list?: Task[]; items?: Task[] }>(`${root}/tasks`)
        setTasks(data.list || data.items || [])
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    let live = true
    Promise.all([
      api<Status>(`${root}/status`),
      api<{ items: Publication[] }>(`${root}/publications`),
    ])
      .then(([s, p]) => {
        if (live) {
          setStatus(s)
          setPublications(p.items)
        }
      })
      .catch((e) => {
        if (live) setError(e.message)
      })
    return () => {
      live = false
    }
  }, [root])
  async function send() {
    if (!prompt.trim() || busy) return
    setBusy(true)
    setError('')
    setOutput([prompt])
    setMedia([])
    const brief = prompt
    setPrompt('')
    try {
      const response = await fetch(`${root}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({
          prompt: brief,
          ...(taskId ? { taskId } : {}),
          ...(secretaryTaskId ? { secretaryTaskId } : {}),
        }),
      })
      if (!response.ok) throw new Error((await response.json()).error || '请求失败')
      const reader = response.body!.getReader(),
        decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n')
          if (!data || data === '[DONE]') continue
          try {
            const event = JSON.parse(data)
            if (event.taskId) setTaskId(event.taskId)
            const found = resultMedia(event)
            if (found.length)
              setMedia((items) => [
                ...new Map([...items, ...found].map((item) => [item.url, item])).values(),
              ])
            const text = readable(event)
            if (text) setOutput((items) => [...items.slice(-200), text])
          } catch {
            /* Ignore SSE keep-alives and non-JSON frames. */
          }
        }
      }
      await refresh()
    } catch (e) {
      setError((e as Error).message)
      setPrompt(brief)
    } finally {
      setBusy(false)
    }
  }
  async function decide(id: string, action: string) {
    setActing(id)
    setError('')
    try {
      await api(`${root}/publications/${id}/${action}`, {})
      await refreshApprovals()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setActing('')
    }
  }
  async function loadTask(id: string) {
    try {
      const data = await api<{ messages?: unknown[] }>(`${root}/tasks/${id}`)
      if (handoff?.runtimeTaskId !== id) setSecretaryTaskId(undefined)
      setTaskId(id)
      setOutput([readable(data.messages) || t('任务记录暂无文本')])
      setMedia(resultMedia(data.messages))
    } catch (e) {
      setError((e as Error).message)
    }
  }
  async function receipt(id: string) {
    try {
      const data = await api(`${root}/publications/${id}/receipt`)
      setReceipts((items) => ({ ...items, [id]: JSON.stringify(data, null, 2) }))
    } catch (e) {
      setError((e as Error).message)
    }
  }
  async function stop() {
    if (!taskId) return
    try {
      await api(`${root}/tasks/${taskId}/abort`, {})
      setOutput((items) => [...items, t('已请求停止，等待运行服务确认。')])
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <div className="ops-workspace">
      <p className="muted">{t('由秘书统筹、叶凡执行，使用企业统一配置，无需单独连接。')}</p>
      {handoff && prompt === handoff.text && (
        <p className="ops-notice">{t('秘书转交的工作要求已带入，点击开始制作后才会执行。')}</p>
      )}
      <section className="ops-readiness">
        <span className={`ops-dot ${status?.ready ? 'ready' : ''}`} />
        <div>
          <strong>{t(status?.ready ? '可以开始制作' : '企业服务尚未就绪')}</strong>
          {!status?.ready && <p>{t(status?.reason || '请在统一设置中完善企业服务。')}</p>}
        </div>
        <button onClick={() => void refresh()} disabled={busy}>
          {t('刷新状态')}
        </button>
        {!status?.ready && <button onClick={openSettings}>{t('检查设置')}</button>}
      </section>
      <ol className="ops-pipeline">
        {[
          '需求与策划',
          '提示词与分镜',
          '图片与视频生成',
          '剪辑与素材',
          '账号与发布准备',
          '平台发布与回执',
        ].map((label, i) => (
          <li key={label}>
            <span>{i + 1}</span>
            {t(label)}
          </li>
        ))}
      </ol>
      {error && (
        <p className="error" role="alert">
          {t(error)}
        </p>
      )}
      <section className="builder-card">
        <div className="heading-row">
          <h2>{t('交给运营部的工作')}</h2>
          {busy && taskId && <button onClick={() => void stop()}>{t('停止制作')}</button>}
          {taskId && (
            <button
              disabled={busy}
              onClick={() => {
                setSecretaryTaskId(undefined)
                setTaskId(undefined)
                setOutput([])
                setMedia([])
              }}
            >
              {t('新建任务')}
            </button>
          )}
        </div>
        <p className="muted">
          {t('使用当前企业的 AI 配置自动制作；对外发布需你确认，模型生成会产生服务商费用。')}
        </p>
        <div className="ops-output" aria-live="polite">
          {output.length ? (
            output.map((text, i) => <p key={i}>{text}</p>)
          ) : (
            <p className="muted">
              {t('告诉叶凡主题、受众、视频时长和风格，也可以提供参考素材链接。')}
            </p>
          )}
          {busy && <p>{t('正在执行原始制作流程…')}</p>}
        </div>
        {media.length > 0 && (
          <section className="ops-assets">
            <h3>{t('生成的素材')}</h3>
            {media.map((item, i) => (
              <a key={item.url} href={item.url} target="_blank" rel="noopener noreferrer">
                {t(item.type === 'VIDEO' ? '视频' : '图片')} {i + 1} ↗
              </a>
            ))}
          </section>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void send()
          }}
        >
          <label htmlFor="ops-brief">{t('工作要求')}</label>
          <textarea
            id="ops-brief"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder={t(
              '例如：为我们的产品制作一条 30 秒介绍视频，自动编写剧本、设计分镜、生成视频，并发布到已绑定的指定账号。',
            )}
            disabled={busy}
          />
          <button
            className="primary"
            disabled={!canEdit || !status?.ready || busy || !prompt.trim()}
          >
            {t(busy ? '制作中…' : taskId ? '继续这个任务' : '开始制作')}
          </button>
        </form>
      </section>
      <PlatformAccounts root={root} canEdit={canEdit} openSettings={openSettings} />
      <section className="builder-card">
        <h2>{t('发布确认与记录')}</h2>
        {!publications.length && (
          <p className="muted">{t('暂无发布申请。制作完成后，需要发布的内容会在这里等待你确认。')}</p>
        )}
        {publications.map((item) => (
          <article className="ops-approval" key={item.id}>
            <strong>{item.payload.content.title || t('发布任务')}</strong>
            <span className="plan-tag">{t(states[item.state] || item.state)}</span>
            <p>{item.payload.content.body}</p>
            <p>{item.payload.items.map((v) => `${v.platform} · ${v.accountId}`).join(' / ')}</p>
            <p>{new Date(item.payload.publishAt).toLocaleString()}</p>
            {item.payload.content.media.map((media) => (
              <a key={media.url} href={media.url} target="_blank" rel="noopener noreferrer">
                {t('查看发布素材')} ↗
              </a>
            ))}
            {['submitted', 'uncertain', 'submitting'].includes(item.state) && (
              <>
                <button disabled={!status?.ready} onClick={() => void receipt(item.id)}>
                  {t('查询平台回执')}
                </button>
                {receipts[item.id] && <pre className="ops-receipt">{receipts[item.id]}</pre>}
              </>
            )}
            {item.state === 'pending' && item.execution_mode === 'manual' && (
              <div className="ops-actions">
                <button
                  disabled={!canEdit || !status?.ready || !!acting}
                  onClick={() => void decide(item.id, 'approve')}
                >
                  {t('通过发布')}
                </button>
                <button disabled={!canEdit || !!acting} onClick={() => void decide(item.id,'reject')}>{t('退回修改')}</button>
              </div>
            )}
          </article>
        ))}
      </section>
      <section className="builder-card">
        <h2>{t('历史制作任务')}</h2>
        {tasks.length ? (
          tasks.map((task) => (
            <button key={task.id} disabled={busy} onClick={() => void loadTask(task.id)}>
              {task.title || task.id} · {task.status}
            </button>
          ))
        ) : (
          <p className="muted">{t('连接服务后刷新，可查看原始任务及继续对话。')}</p>
        )}
      </section>
    </div>
  )
}
