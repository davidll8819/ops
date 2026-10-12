import { useEffect, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'
import { TaskImages } from './TaskImages'
import { unfinishedImage } from './task-image-state'
import { TaskDependencies } from './TaskDependencies'
import { taskRunState, taskStateLabel } from './task-dependencies'
import { departments, type Board, type Task } from '../../../../packages/secretary/model.mjs'
export type TaskFilter = 'all' | 'completed' | 'pending'
const taskState = (task: Task) => taskStateLabel(task.status)
export function TaskCenter({
  base,
  board,
  filter,
  onFilter,
  selected,
  onSelect,
  onRun,
  onOperations,
  canEdit,
  busyId,
  onUpdate,
}: {
  base: string
  board: Board
  filter: TaskFilter
  onFilter: (v: TaskFilter) => void
  selected?: string
  onSelect: (id?: string) => void
  onRun: (task: Task) => void
  onOperations: (task: Task) => void
  canEdit: boolean
  busyId: string
  onUpdate: (board: Board) => void
}) {
  const [query, setQuery] = useState(''),
    [error, setError] = useState(''),
    [acting, setActing] = useState(false)
  const task = board.tasks.find((t) => t.id === selected)
  const tasks = board.tasks
    .filter(
      (task) =>
        (filter === 'all' ||
          (filter === 'completed' ? task.status === 'completed' : task.status !== 'completed')) &&
        `${task.title} ${departments.find((d) => d.id === task.dept)?.person || ''}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .slice()
    .reverse()
  async function action(type: 'approve' | 'reject' | 'dispatch') {
    if (!task) return
    setActing(true)
    setError('')
    try {
      const snap = await api<{ revision: number }>(`${base}/secretary`)
      const updated = await api<{ board: Board }>(`${base}/secretary`, {
        revision: snap.revision,
        today: new Date().toISOString().slice(0, 10),
        action:
          type === 'dispatch'
            ? { type, batchId: task.batchId }
            : {
                type,
                taskId: task.id,
                feedback: type === 'reject' ? '请根据任务要求修改成果' : '',
              },
      })
      onUpdate(updated.board)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setActing(false)
    }
  }
  return (
    <section className="results-page">
      <div className="page-heading">
        <p className="eyebrow">DELIVERABLES</p>
        <h1>{t(task ? '任务成果' : '任务总览')}</h1>
        <p className="muted">{t('完整查看任务、成品与来源，完成成果自动归档到资料室。')}</p>
      </div>
      {error && (
        <p className="error" role="alert">
          {t(error)}
        </p>
      )}
      {task ? (
        <article className="result-detail">
          <button onClick={() => onSelect(undefined)}>← {t('返回任务列表')}</button>
          <header>
            <span className="plan-tag">{t(taskState(task))}</span>
            <h2>{task.title}</h2>
            <p>
              {t(departments.find((d) => d.id === task.dept)?.name || '部门成员')} ·{' '}
              {departments.find((d) => d.id === task.dept)?.person} ·{' '}
              {task.finishedAt ? new Date(task.finishedAt).toLocaleString() : task.due}
            </p>
          </header>
          <p role="status">{t(task.executionNote || taskState(task))}</p>
          <TaskDependencies task={task} tasks={board.tasks} base={base} />
          <TaskImages base={base} task={task} />
          {task.status === 'completed' && !task.images?.length && (
            <div className="result-document">{task.summary}</div>
          )}
          {task.status !== 'completed' && (
            <p className="result-document">{task.request || task.summary}</p>
          )}
          {task.media?.map((m, i) => (
            <div key={i}>
              {m.type === 'VIDEO' ? (
                <video controls preload="metadata" src={m.url} style={{ maxWidth: '100%' }} />
              ) : (
                <img src={m.url} alt={task.title} style={{ maxWidth: '100%' }} />
              )}
              <a href={m.url} target="_blank" rel="noopener noreferrer">
                {t(m.type === 'VIDEO' ? '视频' : '图片')} {i + 1} ↗
              </a>
            </div>
          ))}
          {task.archiveFileId && (
            <a
              className="result-download"
              href={`${base}/files/${task.archiveFileId}/download`}
              download
            >
              {t('下载归档文档')}
            </a>
          )}
          {task.archivedAt && (
            <p className="muted">
              {t('已归档到资料室')} · {new Date(task.archivedAt).toLocaleString()}
            </p>
          )}
          {task.archiveNote && <p role="status">{t(task.archiveNote)}</p>}
          {!!task.sources?.length && (
            <section>
              <h3>{t('调研来源')}</h3>
              {task.sources.map((s) => (
                <p key={s.id}>
                  <a href={s.url} target="_blank" rel="noopener noreferrer">
                    [{s.id}] {s.title}
                  </a>
                </p>
              ))}
            </section>
          )}
          {!!task.attachmentIds?.length && (
            <section>
              <h3>{t('任务附件')}</h3>
              {task.attachmentIds.map((id, i) => (
                <p key={id}>
                  <a href={`${base}/files/${id}/download`} download>
                    {t('附件')} {i + 1}
                  </a>
                </p>
              ))}
            </section>
          )}
          <div className="result-actions">
            {task.dept === 'app-agent' && (
              <button onClick={() => onOperations(task)}>{t('打开运营工作台')}</button>
            )}
            {taskRunState(task, board.tasks).available && (
              <button
                disabled={!canEdit || !!busyId || !taskRunState(task, board.tasks).canRun}
                onClick={() => {
                  if (taskRunState(task, board.tasks).canRun) onRun(task)
                }}
              >
                {t(
                  unfinishedImage(task)
                    ? '生成图片'
                    : task.status === 'blocked'
                      ? '重试任务'
                      : '开始执行',
                )}
              </button>
            )}
            {task.runtimePending && <p role="status">{t('正在核对运营任务状态，请勿重复启动')}</p>}
            {task.status === 'draft' && task.batchId && (
              <button disabled={!canEdit || acting} onClick={() => void action('dispatch')}>
                {t('确认派发')}
              </button>
            )}
            {task.status === 'approval' && (
              <>
                <button disabled={!canEdit || acting} onClick={() => void action('approve')}>
                  {t('通过发布')}
                </button>
                <button disabled={!canEdit || acting} onClick={() => void action('reject')}>
                  {t('退回修改')}
                </button>
              </>
            )}
          </div>
          {!!task.steps?.length && (
            <details>
              <summary>{t('查看执行记录')}</summary>
              <ol>
                {task.steps.map((s, i) => (
                  <li key={i}>
                    {t(s.note)}
                    <p>{s.detail}</p>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </article>
      ) : (
        <>
          <div className="result-toolbar">
            {(['all', 'completed', 'pending'] as const).map((key) => (
              <button key={key} aria-pressed={filter === key} onClick={() => onFilter(key)}>
                {t({ all: '全部任务', completed: '已完成的任务', pending: '待处理' }[key])}
              </button>
            ))}
            <input
              aria-label={t('搜索任务')}
              placeholder={t('搜索任务或负责人')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {!tasks.length && <p className="result-empty">{t('当前没有符合条件的任务')}</p>}
          <div className="result-grid">
            {tasks.map((task) => (
              <button className="result-card" key={task.id} onClick={() => onSelect(task.id)}>
                {task.images?.[0] ? (
                  <img src={`${base}/files/${task.images[0].fileId}/preview`} alt={task.title} />
                ) : (
                  <div className="result-type">
                    {t(task.dept === 'app-agent' ? '运营成果' : '文档与任务')}
                  </div>
                )}
                <span className="plan-tag">{t(taskState(task))}</span>
                <h2>{task.title}</h2>
                <p>
                  {departments.find((d) => d.id === task.dept)?.person} · {task.due}
                </p>
                <span>{t(task.status === 'completed' ? '查看成品' : '查看任务')} ↗</span>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
type StoredFile = { id: string; name: string; mime: string; size: number; created_at: string }
export function ArchiveRoom({ base, onTask }: { base: string; onTask: (id: string) => void }) {
  const [data, setData] = useState<{ tasks: Task[]; files: StoredFile[] }>({
      tasks: [],
      files: [],
    }),
    [error, setError] = useState(''),
    [query, setQuery] = useState(''),
    [kind, setKind] = useState('all'),
    [dept, setDept] = useState(''),
    [day, setDay] = useState(''),
    [loading, setLoading] = useState(true),
    [preview, setPreview] = useState<StoredFile>(),
    [text, setText] = useState('')
  useEffect(() => {
    let live = true
    setLoading(true)
    void api(`${base}/deliverables/sync`, {})
      .then(() => api<typeof data>(`${base}/deliverables`))
      .then((r) => {
        if (live) setData(r)
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
    setText('')
    if (!preview || !(preview.mime.startsWith('text/') || preview.mime === 'application/json'))
      return
    let live = true
    fetch(`${base}/files/${preview.id}/download`)
      .then(async (r) => {
        if (!r.ok) throw Error(t('文件读取失败'))
        return r.text()
      })
      .then((s) => {
        if (live) setText(s)
      })
      .catch((e) => {
        if (live) setError(e.message)
      })
    return () => {
      live = false
    }
  }, [base, preview])
  const owner = (id: string) =>
    data.tasks.find(
      (task) => task.archiveFileId === id || task.images?.some((img) => img.fileId === id),
    )
  const files = data.files.filter(
    (f) =>
      `${f.name} ${owner(f.id)?.title || ''}`.toLowerCase().includes(query.toLowerCase()) &&
      (!dept || owner(f.id)?.dept === dept) &&
      (!day || f.created_at.slice(0, 10) === day) &&
      (kind === 'all' ||
        (kind === 'image'
          ? f.mime.startsWith('image/')
          : kind === 'result'
            ? !!owner(f.id)
            : !owner(f.id))),
  )
  return (
    <section className="results-page">
      <div className="page-heading">
        <p className="eyebrow">ARCHIVE</p>
        <h1>{t('资料室')}</h1>
        <p className="muted">{t('按任务、部门和日期保存成果与附件，仅当前企业中的你可以查看。')}</p>
      </div>
      {error && (
        <p className="error" role="alert">
          {t(error)}
        </p>
      )}
      <div className="result-toolbar">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('搜索文件')}
          aria-label={t('搜索文件')}
        />
        <select aria-label={t('文件分类')} value={kind} onChange={(e) => setKind(e.target.value)}>
          {[
            ['all', '全部文件'],
            ['result', '任务成果'],
            ['image', '图片'],
            ['attachment', '上传附件'],
          ].map(([v, l]) => (
            <option key={v} value={v}>
              {t(l)}
            </option>
          ))}
        </select>
        <select aria-label={t('按部门筛选')} value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">{t('全部部门')}</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {t(d.name)}
            </option>
          ))}
        </select>
        <input
          type="date"
          aria-label={t('归档日期')}
          value={day}
          onChange={(e) => setDay(e.target.value)}
        />
      </div>
      {loading ? (
        <p role="status">{t('正在读取…')}</p>
      ) : (
        !files.length && <p className="result-empty">{t('当前没有符合条件的文件')}</p>
      )}
      <div className="result-grid">
        {files.map((file) => (
          <article className="result-card" key={file.id}>
            {file.mime.startsWith('image/') && (
              <img src={`${base}/files/${file.id}/preview`} alt={file.name} />
            )}
            <h2>{file.name}</h2>
            <p>
              {new Date(file.created_at).toLocaleDateString()} · {Math.ceil(file.size / 1024)} KB
            </p>
            <div className="result-actions">
              <button onClick={() => setPreview(file)}>{t('预览')}</button>
              <a href={`${base}/files/${file.id}/download`} download>
                {t('下载')}
              </a>
              {owner(file.id) && (
                <button onClick={() => onTask(owner(file.id)!.id)}>{t('查看原任务')}</button>
              )}
            </div>
          </article>
        ))}
      </div>
      {preview && (
        <div className="asset-modal-backdrop">
          <section
            className="asset-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('文件预览')}
          >
            <header>
              <h2>{preview.name}</h2>
              <button onClick={() => setPreview(undefined)}>{t('关闭')}</button>
            </header>
            {preview.mime.startsWith('image/') ? (
              <img src={`${base}/files/${preview.id}/preview`} alt={preview.name} />
            ) : preview.mime.startsWith('text/') || preview.mime === 'application/json' ? (
              <pre>{text || t('正在读取…')}</pre>
            ) : (
              <p>{t('请下载此文件查看')}</p>
            )}
            <a href={`${base}/files/${preview.id}/download`} download>
              {t('下载')}
            </a>
          </section>
        </div>
      )}
    </section>
  )
}
