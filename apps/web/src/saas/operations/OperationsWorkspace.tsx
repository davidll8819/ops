import { PlatformAccounts } from './PlatformAccounts'
import { VideoPreview } from './VideoPreview'
import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { useOperationsTask } from './useOperationsTask'
import type { OperationsHandoff } from './models'
export type { OperationsHandoff } from './models'
import { t } from '@/i18n'
import { api } from '../api'
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
export function OperationsWorkspace(props: ComponentProps<typeof OperationsSession>) {
  return <OperationsSession key={props.base} {...props} />
}
function OperationsSession({
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
  const task = useOperationsTask(root, handoff, canEdit, !!status?.ready)
  const { prompt, setPrompt, busy, output, media, taskId } = task
  const [receipts, setReceipts] = useState<Record<string, string>>({})
  const [tasks, setTasks] = useState<Task[]>([])
  const [submissions, setSubmissions] = useState<
    { requestId: string; state: string; createdAt: string }[]
  >([])
  const [publications, setPublications] = useState<Publication[]>([]),
    [acting, setActing] = useState('')
  const live = useRef(false),
    refreshId = useRef(0)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const refresh = useCallback(async () => {
    const id = ++refreshId.current
    try {
      const [current, pubs, records] = await Promise.all([
        api<Status>(`${root}/status`),
        api<{ items: Publication[] }>(`${root}/publications`),
        api<{ items: typeof submissions }>(`${root}/submissions`),
      ])
      if (!live.current || id !== refreshId.current) return
      setStatus(current)
      setPublications(pubs.items)
      setSubmissions(records.items)
      setError('')
      if (current.ready) {
        const data = await api<{ list?: Task[]; items?: Task[] }>(`${root}/tasks`)
        if (live.current && id === refreshId.current) setTasks(data.list || data.items || [])
      }
    } catch (e) {
      if (live.current && id === refreshId.current) setError((e as Error).message)
    }
  }, [root])
  useEffect(() => {
    void refresh()
  }, [refresh, busy])
  async function decide(id: string, action: string) {
    setActing(id)
    setError('')
    try {
      await api(`${root}/publications/${id}/${action}`, {})
      if (live.current) await refresh()
    } catch (e) {
      if (live.current) setError((e as Error).message)
    } finally {
      if (live.current) setActing('')
    }
  }
  async function receipt(id: string) {
    try {
      const data = await api(`${root}/publications/${id}/receipt`)
      if (live.current) setReceipts((items) => ({ ...items, [id]: JSON.stringify(data, null, 2) }))
    } catch (e) {
      if (live.current) setError((e as Error).message)
    }
  }
  return (
    <div className="ops-workspace">
      <p className="muted">
        {t('策划、文案与分镜从叶凡对话带入；核对要求后制作，成果与发布回执在这里查看。')}
      </p>
      {handoff && prompt === handoff.text && (
        <p className="ops-notice">{t('工作要求已带入，核对或修改后点击开始制作才会执行。')}</p>
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
      {(error || task.error) && (
        <p className="error" role="alert">
          {t(error || task.error)}
        </p>
      )}
      <section className="builder-card">
        <div className="heading-row">
          <h2>{t('交给运营部的工作')}</h2>
          {(busy || task.running) && taskId && (
            <button disabled={!canEdit} onClick={() => void task.stop()}>
              {t('停止制作')}
            </button>
          )}
          {(taskId || output.length > 0) && !task.unresolved && (
            <button disabled={busy || task.running} onClick={task.reset}>
              {t('新建任务')}
            </button>
          )}
        </div>
        <p className="muted">
          {t('使用当前企业的 AI 配置自动制作；对外发布需你确认，模型生成会产生服务商费用。')}
        </p>
        {task.brief && (
          <section className="ops-brief-source">
            <strong>方案来源 · 叶凡对话</strong>
            <p>
              {task.brief.title} · 对话版本 {task.brief.sourceRevision} ·{' '}
              {new Date(task.brief.createdAt).toLocaleString()}
            </p>
            <details>
              <summary>查看保存的工作要求与方案原文</summary>
              <pre>{task.brief.text}</pre>
            </details>
            <p className="muted">本次输入的修改优先于原方案；保存的原文保留供核对。</p>
          </section>
        )}
        {task.phase && (
          <div className="ops-task-status" role="status">
            <strong>{t(task.phase)}</strong>
            {(taskId || task.unresolved) && (
              <button disabled={busy} onClick={() => void task.recover()}>
                {t('核对提交记录')}
              </button>
            )}
          </div>
        )}
        {task.videoPending && (
          <p role="status">视频仍在生成，工作台正在核对原任务，不会重复提交。</p>
        )}
        {media.length > 0 && (
          <section className="ops-assets">
            <h3>{t('生成的素材')}</h3>
            {media.map((item, i) => (
              <figure key={item.url}>
                {item.type === 'VIDEO' ? (
                  <VideoPreview item={item} />
                ) : (
                  <img
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    src={item.url}
                    alt={`生成的图片 ${i + 1}`}
                  />
                )}
                <figcaption>
                  <a href={item.url} target="_blank" rel="noopener noreferrer">
                    {t(item.type === 'VIDEO' ? '打开视频' : '打开图片')} {i + 1} ↗
                  </a>
                </figcaption>
              </figure>
            ))}
          </section>
        )}
        <div className="ops-output" aria-live="polite">
          {output.length ? (
            output.map((text, i) => <p key={i}>{text}</p>)
          ) : (
            <p className="muted">
              {t('告诉叶凡主题、受众、视频时长和风格，也可以提供参考素材链接。')}
            </p>
          )}
          {busy && <p>{t('正在接收制作记录…')}</p>}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void task.send()
          }}
        >
          <label htmlFor="ops-brief">{t('工作要求')}</label>
          <fieldset disabled={!canEdit || busy || task.running || task.unresolved}>
            <label>
              <input
                type="checkbox"
                checked={!!task.videoFormat}
                onChange={(event) =>
                  task.setVideoFormat(
                    event.target.checked ? { ratio: '9:16', resolution: '720p' } : undefined,
                  )
                }
              />
              指定视频规格
            </label>
            {task.videoFormat && (
              <div className="heading-row">
                <label>
                  视频比例
                  <select
                    aria-label="视频比例"
                    value={task.videoFormat.ratio}
                    onChange={(event) =>
                      task.setVideoFormat({
                        ...task.videoFormat!,
                        ratio: event.target.value as '9:16' | '16:9' | '1:1',
                      })
                    }
                  >
                    <option value="9:16">9:16 竖屏</option>
                    <option value="16:9">16:9 横屏</option>
                    <option value="1:1">1:1 方形</option>
                  </select>
                </label>
                <label>
                  视频分辨率
                  <select
                    aria-label="视频分辨率"
                    value={task.videoFormat.resolution}
                    onChange={(event) =>
                      task.setVideoFormat({
                        ...task.videoFormat!,
                        resolution: event.target.value as '720p' | '1080p',
                      })
                    }
                  >
                    <option value="720p">720p</option>
                    <option value="1080p">1080p</option>
                  </select>
                </label>
              </div>
            )}
            <p className="muted">
              勾选后以这里的规格为准；不勾选则按工作要求制作。规格不符会保留成品并提示，不会自动重试。
            </p>
          </fieldset>
          <textarea
            id="ops-brief"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={8}
            maxLength={20000}
            placeholder={t(
              '例如：为我们的产品制作一条 30 秒介绍视频，按已确认分镜制作预览，完成后先验收，不发布。',
            )}
            disabled={busy || task.running || task.unresolved}
          />
          <button
            className="primary"
            disabled={
              !canEdit ||
              !status?.ready ||
              busy ||
              task.running ||
              task.unresolved ||
              !prompt.trim()
            }
          >
            {t(busy ? '制作中…' : taskId ? '继续这个任务' : '开始制作')}
          </button>
        </form>
      </section>
      <PlatformAccounts root={root} canEdit={canEdit} openSettings={openSettings} />
      <section className="builder-card">
        <h2>{t('发布确认与记录')}</h2>
        {!publications.length && (
          <p className="muted">
            {t('暂无发布申请。制作完成后，需要发布的内容会在这里等待你确认。')}
          </p>
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
                <button
                  disabled={!canEdit || !!acting}
                  onClick={() => void decide(item.id, 'reject')}
                >
                  {t('退回修改')}
                </button>
              </div>
            )}
          </article>
        ))}
      </section>
      <section className="builder-card">
        <h2>{t('历史制作任务')}</h2>
        {!!submissions.length && (
          <div className="ops-submissions">
            <h3>本人的制作提交记录</h3>
            <p className="muted">关闭或刷新页面后可核对原提交；查询记录不会重新生成。</p>
            {submissions.map((s) => (
              <button
                key={s.requestId}
                disabled={busy}
                onClick={() => void task.recoverSubmission(s.requestId)}
              >
                {new Date(s.createdAt).toLocaleString()} · {s.requestId.slice(0, 8)} ·{' '}
                {s.state === 'submitted'
                  ? '已接收，可查状态'
                  : s.state === 'failed'
                    ? '未开始制作，可调整要求'
                    : '结果待核对'}
              </button>
            ))}
          </div>
        )}
        {tasks.length ? (
          tasks.map((item) => (
            <button key={item.id} disabled={busy} onClick={() => void task.selectTask(item.id)}>
              {item.title || item.id} · {item.status}
            </button>
          ))
        ) : (
          <p className="muted">{t('连接服务后刷新，可查看原始任务及继续对话。')}</p>
        )}
      </section>
    </div>
  )
}
