import { t, useLanguage } from '@/i18n'
import { departments, type Task } from '../../../../packages/secretary/model.mjs'
import { taskDependencies, taskStateLabel } from './task-dependencies'
import './task-dependencies.css'

export function TaskDependencies({
  task,
  tasks,
  base,
  compact = false,
}: {
  task: Task
  tasks: Task[]
  base?: string
  compact?: boolean
}) {
  const language = useLanguage()
  const dependencies = taskDependencies(task, tasks)
  const pending = dependencies.some((dependency) => !dependency.ready)
  const received = task.receivedInputs || []
  if (!dependencies.length && !received.length) return null
  const title = (value: Task) =>
    language === 'en' ? value.titleEn || value.title : value.titleZh || value.title
  const automatic = task.engine === 'department-v1' || task.engine === 'research-v1'
  return (
    <section
      className={`task-dependencies${compact ? ' is-compact' : ''}`}
      aria-label={t('部门协作流程')}
    >
      {!!dependencies.length && (
        <>
          <h3>{t('前置任务')}</h3>
          <div className="task-dependency-list" role="list">
            {dependencies.map((dependency) => (
              <div className="task-dependency-item" role="listitem" key={dependency.id}>
                <span>{dependency.task ? title(dependency.task) : t('任务记录缺失')}</span>
                <strong className={dependency.ready ? 'is-complete' : 'is-waiting'}>
                  {t(taskStateLabel(dependency.task?.status))}
                </strong>
              </div>
            ))}
          </div>
          {task.status === 'draft' ? (
            <p className="task-dependency-note">
              {t('确认派发后，各部门按前置任务顺序自动执行。')}
            </p>
          ) : task.status === 'queued' ? (
            <p className="task-dependency-note" role="status">
              {t(
                automatic
                  ? pending
                    ? '前置任务完成后自动执行'
                    : '前置任务已完成，等待自动执行'
                  : pending
                    ? '请先完成前置任务'
                    : '前置任务已完成，可以开始执行',
              )}
            </p>
          ) : pending && task.status === 'blocked' ? (
            <p className="task-dependency-note">{t('请先完成前置任务')}</p>
          ) : null}
        </>
      )}
      {!!received.length && (
        <div className="task-received-inputs">
          <h3>{t('已收到成果')}</h3>
          {received.map((input) => {
            const source = tasks.find((candidate) => candidate.id === input.taskId)
            const department = departments.find((candidate) => candidate.id === input.dept)
            return (
              <div className="task-received-item" key={input.taskId}>
                <strong>{source ? title(source) : input.title}</strong>
                <small>
                  {department ? (language === 'en' ? department.en : department.name) : input.dept}
                  {' · '}
                  {t('已接收')}
                  {!compact &&
                    input.receivedAt &&
                    ` · ${new Date(input.receivedAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}`}
                </small>
                {!compact &&
                  base &&
                  input.fileIds?.map((id, index) => (
                    <a href={`${base}/files/${encodeURIComponent(id)}/download`} download key={id}>
                      {t('下载前序成果')} {index + 1}
                    </a>
                  ))}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
