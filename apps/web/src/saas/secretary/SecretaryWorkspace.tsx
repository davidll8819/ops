import { DailyBrief } from './DailyBrief'
import { Attachments, type Attachment } from './Attachments'
import { ReminderSettings } from './ReminderSettings'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { TaskDependencies } from '../TaskDependencies'
import { isOperationsNavigation } from '../task-dependencies'
import { t, useLanguage } from '@/i18n'
import { SecretaryPreferences } from './SecretaryPreferences'
import { defaultPreferences, portrait, type Preferences } from './preferences'
import {
  departments,
  emptyBoard,
  type Board,
  type Task,
  type Action,
} from '../../../../../packages/secretary/model.mjs'
import '@fontsource-variable/noto-sans-sc'
import './secretary.css'
const localDay = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
type Snapshot = { revision: number; board: Board; preferences?: Preferences }
export function SecretaryWorkspace({
  base,
  canEdit,
  openOperations,
  openSettings,
  initialInput,
  onVoice,
  onTask,
}: {
  base: string
  canEdit: boolean
  openOperations: (brief?: string, task?: Task) => void
  openSettings: () => void
  onVoice: () => void
  onTask: (id: string) => void
  initialInput?: string
}) {
  const language = useLanguage()
  const [saved, setSaved] = useState<Snapshot>({ revision: 0, board: emptyBoard() })
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [input, setInput] = useState('')
  const [uploading, setUploading] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  useEffect(() => {
    if (initialInput) setInput((value) => (value ? `${value}\n${initialInput}` : initialInput))
  }, [initialInput])
  const [intent, setIntent] = useState<'plan' | 'remind' | 'report' | 'meeting'>('plan')
  const [editing, setEditing] = useState<string | null>(null)
  const [edits, setEdits] = useState<Task[]>([])
  const [config, setConfig] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [activeAction, setActiveAction] = useState('')
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const board = saved.board
  const editable = canEdit
  const deptName = (id: string) => {
    const d = departments.find((d) => d.id === id)
    return d ? (language === 'en' ? d.en : d.name) : t('秘书处')
  }
  const title = (task: Task) =>
    language === 'en' ? task.titleEn || task.title : task.titleZh || task.title
  async function refresh() {
    const data = await api<Snapshot>(`${base}/secretary`)
    setSaved(data)
    if (data.preferences) setPreferences(data.preferences)
    return data
  }
  useEffect(() => {
    let live = true
    api<Snapshot>(`${base}/secretary`)
      .then((d) => {
        if (live) {
          setSaved(d)
          if (d.preferences) setPreferences(d.preferences)
        }
      })
      .catch((e) => {
        if (live) setError(e.message)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [base])
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' })
  }, [board.messages.length])
  useEffect(() => {
    let live = true
    const update = () => {
      if (document.hidden) return
      void api<Snapshot>(`${base}/secretary`)
        .then((data) => {
          if (live) setSaved((previous) => (data.revision > previous.revision ? data : previous))
        })
        .catch(() => {
          /* Keep saved content on a temporary background network failure. */
        })
    }
    const timer = window.setInterval(update, 5000)
    window.addEventListener('focus', update)
    return () => {
      live = false
      clearInterval(timer)
      window.removeEventListener('focus', update)
    }
  }, [base])
  const modalOpen = !!editing
  useEffect(() => {
    if (!modalOpen) return
    const previous = document.activeElement as HTMLElement | null
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setEditing(null)
        return
      }
      if (event.key !== 'Tab') return
      const dialog = document.querySelector('.sec-dialog')
      const controls = Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)',
        ) || [],
      )
      const first = controls[0],
        last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', keyboard)
    return () => {
      document.removeEventListener('keydown', keyboard)
      previous?.focus()
    }
  }, [modalOpen])
  async function act(action: Action, requireTasks = false) {
    if (busy || uploading || loading) return false
    setBusy(true)
    setError('')
    setActiveAction(action.type === 'send' ? action.intent : action.type)
    try {
      if (action.type === 'send') {
        setSaved(
          await api<Snapshot>(`${base}/secretary/chat`, {
            revision: saved.revision,
            requireTasks,
            attachmentIds: attachments.map((a) => a.id),
            lastUserMessageId:
              saved.board.messages.filter((m) => m.role === 'user').at(-1)?.id || '',
            text: action.text,
            intent: action.intent,
            language: action.language,
          }),
        )
      } else {
        const next = await api<Snapshot>(`${base}/secretary`, {
          revision: saved.revision,
          action,
          today: localDay(),
        })
        setSaved(next)
      }
      return true
    } catch (e) {
      setError((e as Error).message)
      try {
        await refresh()
      } catch {
        /* Keep the original failure visible. */
      }
      return false
    } finally {
      setBusy(false)
      setActiveAction('')
    }
  }
  function handToOperations() {
    openOperations(input.trim() || undefined)
  }
  async function send() {
    if (!input.trim() || busy || uploading || !editable || loading || !online) return
    if (!attachments.length && intent === 'plan' && isOperationsNavigation(input)) {
      handToOperations()
      return
    }
    const sent = await act({ type: 'send', text: input.trim(), intent, language })
    if (sent) {
      setInput('')
      setAttachments([])
      setIntent('plan')
    }
  }
  const quick = [
    ['plan', '拆分任务', '帮我把这件事拆成部门任务：'],
    ['remind', '催办今天', '请催办今天到期的任务，并整理需要我协调的问题。'],
    ['report', '汇报进度', '请汇报当前任务进度、待确认事项与阻塞原因。'],
    ['meeting', '召集开会', '请安排一次部门协作会议，议题是：'],
  ] as const
  const state = !online
    ? '离线'
    : busy
      ? activeAction === 'remind'
        ? '催办中'
        : '拆分任务中'
      : '在线 · 待命中'
  const openEdit = (batchId: string) => {
    setEditing(batchId)
    setEdits(
      board.tasks.filter((t) => t.batchId === batchId).map((t) => ({ ...t, title: title(t) })),
    )
    setError('')
  }
  return (
    <section className="secretary-workspace" aria-label={t('秘书工作台')}>
      <header className="sec-page-heading">
        <div>
          <span className="sec-kicker">{t('私人秘书')}</span>
          <h1>{t('秘书工作台')}</h1>
        </div>
        <div className="sec-page-tools">
          <button onClick={() => setConfig(!config)}>
            {t(config ? '返回工作台' : '助手配置')}
          </button>
        </div>
      </header>
      {config ? (
        <div className="sec-configuration">
          {loading ? (
            <p>{t('正在加载…')}</p>
          ) : (
            <>
              <SecretaryPreferences base={base} preferences={preferences} onSave={setPreferences} />
              <ReminderSettings base={base} canEdit={canEdit} />
            </>
          )}
        </div>
      ) : (
        <>
          <div className="sec-mode-note" role="status">
            <span aria-hidden="true">◈</span>
            <span>{t('秘书按你的偏好交流，使用当前企业配置的文字模型。')}</span>
          </div>
          {error && (
            <div className="sec-error" role="alert">
              {t(error)}
              <button
                onClick={() => {
                  void refresh()
                    .then(() => setError(''))
                    .catch((e) => setError(e.message))
                }}
              >
                {t('刷新任务')}
              </button>
              <button onClick={openSettings}>{t('检查设置')}</button>
            </div>
          )}
          {loading && <p role="status">{t('正在读取任务记录…')}</p>}
          <div className="secretary-grid">
            <aside className="sec-left" aria-label={t('秘书形象与简报')}>
              <article className="sec-card sec-identity">
                <div className="sec-portrait">
                  <span className="sec-portrait-label">{t('你的专属秘书')}</span>
                  <span className="sec-portrait-orbit" aria-hidden="true" />
                  <img
                    src={portrait(preferences.gender)}
                    alt={t(preferences.gender === 'male' ? '男助手' : '女助手')}
                  />
                </div>
                <div className="sec-identity-copy">
                  <h2>{preferences.name}</h2>
                  <p>{t('总秘书 · 任务拆分与统筹')}</p>
                  <span className={`sec-status ${!online ? 'is-offline' : ''}`} aria-live="polite">
                    <i aria-hidden="true" />
                    {t(state)}
                  </span>
                </div>
              </article>
              <DailyBrief base={base} canEdit={canEdit} />
              <article className="sec-card sec-responsibilities">
                <h2>{t('秘书能做什么')}</h2>
                <ul>
                  {[
                    '把一句话拆成分工任务',
                    '定时催办各部门',
                    '汇总进度向你汇报',
                    '跟进运营部制作与发布',
                  ].map((item, i) => (
                    <li key={item}>
                      <span aria-hidden="true">{['✧', '◷', '≋', '✓'][i]}</span>
                      {t(item)}
                    </li>
                  ))}
                </ul>
                <small>{t('在助手配置中设置定时提醒；视频与发布交给运营工作台')}</small>
              </article>
            </aside>
            <section className="sec-card sec-conversation" aria-label={t('与秘书对话')}>
              <header className="sec-chat-header">
                <div>
                  <span className="sec-chat-mark" aria-hidden="true">
                    ✧
                  </span>
                  <h2>{t('给秘书下指令')}</h2>
                </div>
                <span className="sec-ceo">{t('CEO 办公室')}</span>
              </header>
              <div
                className="sec-chat-body"
                ref={messagesRef}
                role="log"
                aria-label={t('对话记录')}
                aria-live="polite"
              >
                <div className="sec-date-divider">
                  <span>{t('今天')}</span>
                </div>
                <div className="sec-message assistant">
                  <span className="sec-message-author">
                    {preferences.name} <span>{t('秘书处')}</span>
                  </span>
                  <div className="sec-bubble">
                    <strong>{`${preferences.address}${t('，今天有什么安排？')}`}</strong>
                    <p>
                      {t('把想法交给我，我来梳理分工、跟进进度。运营任务交给叶凡的运营工作台。')}
                    </p>
                  </div>
                </div>
                {!board.messages.length && (
                  <div className="sec-suggestion">
                    <p>{t('可以从一件具体的事开始')}</p>
                    <button
                      disabled={!editable || loading}
                      onClick={() => {
                        setIntent('plan')
                        setInput(
                          t(
                            '让叶凡制作一条公司宣传视频，自动编写剧本、制作分镜，完成后发布到指定账号。',
                          ),
                        )
                        inputRef.current?.focus()
                      }}
                    >
                      {t('做一条公司宣传视频')} <span aria-hidden="true">↗</span>
                    </button>
                  </div>
                )}
                {board.messages.map((message) => {
                  const tasks = board.tasks.filter(
                    (task) => task.batchId === message.batchId && message.batchId,
                  )
                  const batch = board.batches.find((b) => b.id === message.batchId)
                  return (
                    <div className={`sec-message ${message.role}`} key={message.id}>
                      <span className="sec-message-author">
                        {message.role === 'user' ? t('我') : preferences.name}
                        {message.role === 'assistant' && <span>{t('秘书处')}</span>}
                      </span>
                      <div className="sec-bubble">
                        <p>{language === 'en' && message.textEn ? message.textEn : message.text}</p>
                        {!!message.attachments?.length && (
                          <div className="message-attachments">
                            {message.attachments.map((a) => (
                              <a key={a.id} href={`${base}/files/${a.id}/download`} download>
                                {a.mime.startsWith('image/') && (
                                  <img src={`${base}/files/${a.id}/preview`} alt={a.name} />
                                )}
                                📎 {a.name}
                              </a>
                            ))}
                          </div>
                        )}
                        {!!tasks.length && (
                          <>
                            <ol className="sec-task-list">
                              {tasks.map((task, i) => (
                                <li key={task.id}>
                                  <span className="sec-task-index">
                                    {String(i + 1).padStart(2, '0')}
                                  </span>
                                  <div>
                                    <button
                                      type="button"
                                      className="sec-title-button"
                                      onClick={() => onTask(task.id)}
                                    >
                                      {title(task)} ↗
                                    </button>
                                    <span>
                                      {deptName(task.dept)} ·{' '}
                                      {departments.find((d) => d.id === task.dept)?.person} ·{' '}
                                      {task.due}
                                    </span>
                                    <TaskDependencies task={task} tasks={board.tasks} compact />
                                  </div>
                                </li>
                              ))}
                            </ol>
                            {batch?.status === 'draft' ? (
                              <div className="sec-task-actions">
                                <button
                                  className="sec-primary"
                                  disabled={busy || !editable}
                                  onClick={() => void act({ type: 'dispatch', batchId: batch.id })}
                                >
                                  {t('确认派发')} <span aria-hidden="true">↗</span>
                                </button>
                                <button
                                  disabled={busy || !editable}
                                  onClick={() => openEdit(batch.id)}
                                >
                                  {t('修改任务')}
                                </button>
                              </div>
                            ) : (
                              <span className="sec-queued">
                                ✓ {t('分工已派发，各部门按依赖顺序自动执行')}
                              </span>
                            )}
                            {batch?.status === 'draft' && (
                              <small>{t('已有任务草稿，请核对部门、日期和任务内容')}</small>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
                {busy && (
                  <p className="sec-thinking" role="status">
                    {t(activeAction === 'dispatch' ? '正在派发任务…' : '秘书正在思考…')}
                  </p>
                )}
              </div>
              {board.messages.length > 0 && (!board.tasks.length || board.lastReplyError) && (
                <div className="sec-task-notice">
                  <p>
                    {t(
                      board.lastReplyError
                        ? '这次任务尚未创建，你的要求已保存。'
                        : '当前只有对话，尚未形成任务记录。',
                    )}
                  </p>
                  <button
                    type="button"
                    disabled={busy || !editable}
                    onClick={() =>
                      void act(
                        {
                          type: 'send',
                          text: board.lastReplyError
                            ? `请重新整理最近这次工作为任务分工，保留完整要求：${board.lastReplyError.requestText}`.slice(
                                0,
                                4000,
                              )
                            : '请把我们已经确认的工作整理为任务分工，保留完整要求、负责人和日期。',
                          intent: 'plan',
                          language,
                        },
                        true,
                      )
                    }
                  >
                    {t(board.lastReplyError ? '重新整理任务' : '整理为任务分工')}
                  </button>
                </div>
              )}
              {error && (
                <p role="status" className="sec-task-notice">
                  {t(error)}
                </p>
              )}
              <form
                className="sec-composer"
                onSubmit={(e) => {
                  e.preventDefault()
                  void send()
                }}
              >
                <div className="sec-quick-actions">
                  <button type="button" onClick={onVoice}>
                    {t('语音输入')}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !editable || loading}
                    onClick={handToOperations}
                  >
                    {t('交给运营工作台')}
                  </button>
                  {quick.map(([key, label, template]) => (
                    <button
                      type="button"
                      key={key}
                      disabled={busy || !editable || loading}
                      onClick={() => {
                        setIntent(key)
                        setInput(t(template))
                        inputRef.current?.focus()
                      }}
                    >
                      <span aria-hidden="true">
                        {key === 'plan'
                          ? '✧'
                          : key === 'remind'
                            ? '◷'
                            : key === 'report'
                              ? '≋'
                              : '♧'}
                      </span>
                      {t(label)}
                    </button>
                  ))}
                </div>
                <Attachments
                  base={base}
                  items={attachments}
                  onChange={setAttachments}
                  onBusy={setUploading}
                  disabled={busy || !editable || loading}
                />
                <div className="sec-input-row">
                  <textarea
                    ref={inputRef}
                    aria-label={t('给秘书的指令')}
                    placeholder={t('说说你想让公司做什么…')}
                    value={input}
                    maxLength={4000}
                    disabled={!editable || loading}
                    onChange={(e) => {
                      setInput(e.target.value)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        void send()
                      }
                    }}
                  />
                  <button
                    className="sec-send"
                    disabled={!input.trim() || busy || uploading || !editable || loading || !online}
                  >
                    {t('发送')} <span aria-hidden="true">↑</span>
                  </button>
                </div>
                <p>
                  {t(editable ? 'Enter 发送 · Shift + Enter 换行' : '仅所有者或管理员可以安排任务')}
                </p>
              </form>
            </section>
          </div>
        </>
      )}
      {editing && (
        <div className="sec-modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-label={t('修改任务')}
            className="sec-dialog"
          >
            <header>
              <h2>{t('修改任务')}</h2>
              <button autoFocus aria-label={t('关闭')} onClick={() => setEditing(null)}>
                ×
              </button>
            </header>
            <p>{t('确认派发前，可以调整每项任务的名称、部门与日期。')}</p>
            <form
              onSubmit={async (e) => {
                e.preventDefault()
                if (
                  await act({
                    type: 'edit',
                    batchId: editing,
                    tasks: edits.map(({ id, title, dept, due }) => ({ id, title, dept, due })),
                  })
                )
                  setEditing(null)
              }}
            >
              {edits.map((task, i) => (
                <fieldset key={task.id}>
                  <legend>
                    {t('任务')} {i + 1}
                  </legend>
                  <label>
                    {t('任务名称')}
                    <input
                      required
                      maxLength={120}
                      value={task.title}
                      onChange={(e) =>
                        setEdits(
                          edits.map((item, n) =>
                            n === i ? { ...item, title: e.target.value } : item,
                          ),
                        )
                      }
                    />
                  </label>
                  <div className="sec-edit-row">
                    <label>
                      {t('负责部门')}
                      <select
                        value={task.dept}
                        onChange={(e) =>
                          setEdits(
                            edits.map((item, n) =>
                              n === i ? { ...item, dept: e.target.value } : item,
                            ),
                          )
                        }
                      >
                        {departments.map((d) => (
                          <option key={d.id} value={d.id}>
                            {deptName(d.id)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {t('截止日期')}
                      <input
                        required
                        type="date"
                        value={task.due}
                        onChange={(e) =>
                          setEdits(
                            edits.map((item, n) =>
                              n === i ? { ...item, due: e.target.value } : item,
                            ),
                          )
                        }
                      />
                    </label>
                  </div>
                </fieldset>
              ))}
              {error && (
                <p role="alert" className="sec-error">
                  {t(error)}
                </p>
              )}
              <footer>
                <button type="button" onClick={() => setEditing(null)}>
                  {t('取消')}
                </button>
                <button className="sec-primary" disabled={busy}>
                  {t('保存修改')}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </section>
  )
}
