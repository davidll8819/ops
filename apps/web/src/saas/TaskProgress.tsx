import { useState } from 'react'
import { TaskImages } from './TaskImages'
import { unfinishedImage } from './task-image-state'
import { TaskDependencies } from './TaskDependencies'
import { taskRunState } from './task-dependencies'
import { t, useLanguage } from '@/i18n'
import { departments, type Task } from '../../../../packages/secretary/model.mjs'
export function TaskProgress({
  tasks,
  onRun,
  onOperations,
  busyId = '',
  canEdit = true,
  base,
  compact = false,
  onOpen,
}: {
  base: string
  compact?: boolean
  onOpen?: (task: Task) => void
  tasks: Task[]
  onRun: (task: Task) => void
  onOperations: (task: Task) => void
  busyId?: string
  canEdit?: boolean
}) {
  const language = useLanguage(),
    [history, setHistory] = useState(false)
  const current = tasks.filter((task) => task.status !== 'completed'),
    finished = tasks.filter((task) => task.status === 'completed')
  const items = (history ? finished : current).slice().reverse()
  return (
    <section className="task-progress-panel" aria-label={t('任务执行进度')}>
      <header>
        <h2>{t('任务执行进度')}</h2>
        <span>{t('实际执行状态')}</span>
      </header>
      <div className="task-progress-tabs">
        <button aria-pressed={!history} onClick={() => setHistory(false)}>
          {t('当前任务')} {current.length}
        </button>
        <button aria-pressed={history} onClick={() => setHistory(true)}>
          {t('历史任务')} {finished.length}
        </button>
      </div>
      {!items.length && (
        <p className="task-progress-empty">{t(history ? '暂无已完成任务' : '暂无进行中的任务')}</p>
      )}
      {items.map((task) => {
        const person = departments.find((d) => d.id === task.dept),
          ops = task.dept === 'app-agent',
          done = task.status === 'completed',
          working = task.status === 'working',
          blocked = ['blocked', 'revision'].includes(task.status)
        const run = taskRunState(task, tasks)
        const phase = done ? 3 : working || task.startedAt ? 2 : task.status === 'draft' ? 0 : 1
        const state = done
          ? '已完成'
          : working
            ? '正在执行'
            : blocked
              ? '需要处理'
              : task.status === 'draft'
                ? '待确认分工'
                : !run.prerequisitesReady
                  ? '等待前置任务'
                  : '等待执行'
        return (
          <details
            className={`execution-card ${blocked ? 'is-blocked' : working ? 'is-working' : ''}`}
            key={task.id}
            style={
              {
                '--task-accent':
                  (
                    {
                      'new-agent-7': '#9873bb',
                      'app-agent': '#4b9790',
                      'file-agent': '#7799be',
                      'code-agent': '#cf9464',
                    } as Record<string, string>
                  )[task.dept] || '#909cb3',
              } as React.CSSProperties
            }
          >
            <summary>
              <div className="execution-card-owner">
                <span>{person?.person || t('部门成员')}</span>
                <b>{t(state)}</b>
              </div>
              <strong className="execution-title">
                {language === 'en' ? task.titleEn || task.title : task.titleZh || task.title}
              </strong>
              <span className="execution-department">
                {person ? (language === 'en' ? person.en : person.name) : task.dept} · {task.due}
              </span>
              <ol className="execution-stages" aria-label={t('任务阶段')}>
                {['待分工', '已派发', '执行中', '已完成'].map((step, i) => (
                  <li
                    key={step}
                    className={i <= phase ? 'reached' : ''}
                    aria-current={i === phase ? 'step' : undefined}
                  >
                    <i />
                    <span>{t(step)}</span>
                  </li>
                ))}
              </ol>
              <p className="execution-note">
                {t(
                  task.executionNote ||
                    (working
                      ? '正在调用部门模型生成文字结果'
                      : done
                        ? '文字结果已生成'
                        : ops && task.status !== 'draft' && task.engine !== 'department-v1'
                          ? '等待在运营工作台启动'
                          : '等待部门开始执行'),
                )}
              </p>
              <span className="execution-expand">{t('查看详情')} ⌄</span>
            </summary>
            <div className="execution-detail">
              <TaskDependencies task={task} tasks={tasks} base={base} compact={compact} />
              {compact ? (
                <>
                  <p>{t(task.executionNote || state)}</p>
                  <button onClick={() => onOpen?.(task)}>
                    {t(done ? '查看成品' : '查看任务详情')} ↗
                  </button>
                </>
              ) : (
                <>
                  {task.startedAt && (
                    <p>
                      {t('开始时间')}：{new Date(task.startedAt).toLocaleString()}
                    </p>
                  )}
                  {task.finishedAt && (
                    <p>
                      {t('结束时间')}：{new Date(task.finishedAt).toLocaleString()}
                    </p>
                  )}
                  {task.researchOutline?.length ? (
                    <section>
                      <h3>{t('调研目录')}</h3>
                      <ol className="task-step-log">
                        {task.researchOutline.map((section) => (
                          <li key={section.id}>
                            <strong>{section.title}</strong>
                            {' · '}
                            {t(
                              {
                                pending: '等待查询',
                                searching: '正在查询',
                                completed: '已核对来源',
                                blocked: '资料不足',
                              }[section.status],
                            )}
                            <small>{section.questions.join(' / ')}</small>
                            {section.limitation && <small>{section.limitation}</small>}
                          </li>
                        ))}
                      </ol>
                    </section>
                  ) : null}
                  {task.steps?.length ? (
                    <ol className="task-step-log">
                      {task.steps.map((step, i) => (
                        <li key={i}>
                          <time>{new Date(step.time).toLocaleTimeString()}</time> {t(step.note)}
                          <small>{step.detail}</small>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {done && !ops && (
                    <>
                      <h3>{t('执行结果')}</h3>
                      <p className="task-result">{t(task.summary)}</p>
                      <TaskImages task={task} base={base} />
                    </>
                  )}
                  {unfinishedImage(task) && (
                    <button
                      disabled={!canEdit || !!busyId || !run.canRun}
                      onClick={() => {
                        if (run.canRun) onRun(task)
                      }}
                    >
                      {t('生成图片')}
                    </button>
                  )}
                  {task.sources?.length ? (
                    <section>
                      <h3>{t('调研来源')}</h3>
                      {task.sources.map((source) => (
                        <p key={source.id}>
                          <a href={source.url} target="_blank" rel="noopener noreferrer">
                            [{source.id}] {source.title}
                          </a>
                          <small>
                            {t(source.read ? '已读取正文' : '搜索摘要')} ·{' '}
                            {new Date(source.retrievedAt).toLocaleString()}
                          </small>
                        </p>
                      ))}
                    </section>
                  ) : null}
                  {task.archiveFileId && (
                    <a href={`${base}/files/${task.archiveFileId}/download`} download>
                      {t('下载归档报告')}
                    </a>
                  )}
                  {!done && <p>{t(task.executionNote || '等待执行')}</p>}
                  {ops && task.status !== 'draft' && (
                    <button onClick={() => onOperations(task)}>
                      {t(task.runtimeTaskId ? '查看运营任务' : '打开运营工作台')}
                    </button>
                  )}
                  {run.available && !unfinishedImage(task) && (
                    <button
                      disabled={!canEdit || !!busyId || !run.canRun}
                      onClick={() => {
                        if (run.canRun) onRun(task)
                      }}
                    >
                      {t(
                        busyId === task.id
                          ? '正在执行'
                          : task.status === 'blocked'
                            ? '重试任务'
                            : '开始执行',
                      )}
                    </button>
                  )}
                  {task.runtimePending && (
                    <p role="status">{t('正在核对运营任务状态，请勿重复启动')}</p>
                  )}
                </>
              )}
            </div>
          </details>
        )
      })}
    </section>
  )
}
