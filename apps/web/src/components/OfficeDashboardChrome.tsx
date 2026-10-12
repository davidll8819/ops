import { TaskProgress } from '../saas/TaskProgress'
import type { Task } from '../../../../packages/secretary/model.mjs'
import { t } from '@/i18n'
import type { Board } from '../../../../packages/secretary/model.mjs'
type Status = {
  departments: { id: string; name: string; ready: boolean }[]
  memoryMb: number
  uptime: number
}
export function OfficeHeaderStats({
  board,
  status,
  onTasks,
  onSettings,
}: {
  board: Board
  status: Status | null
  onTasks: (filter: 'all'|'completed'|'pending') => void
  onSettings: () => void
}) {
  const values = [
    ['任务总数', board.tasks.length],
    ['已完成', board.tasks.filter((t) => t.status === 'completed').length],
    ['待处理', board.tasks.filter((t) => ['draft', 'queued', 'blocked'].includes(t.status)).length],
    ['模型已配置', `${status?.departments.filter((d) => d.ready).length || 0}/9`],
  ]
  return (
    <header className="office-header-stats" aria-label={t('办公室概览')}>
      {values.map(([name, value]) => (
        <button
          className="stat-card"
          key={name}
          onClick={name === '模型已配置' ? onSettings : () => onTasks(name === '已完成' ? 'completed' : name === '待处理' ? 'pending' : 'all')}
        >
          <span className="stat-label">{t(String(name))}</span>
          <strong className="stat-value">{value}</strong>
          <span className="stat-hint">{t('查看任务与部门')}</span>
        </button>
      ))}
      <section className="stat-card resource-card">
        <span className="stat-label">{t('本机服务')}</span>
        <strong className="stat-value">{status ? `${status.memoryMb} MB` : '—'}</strong>
        <span>{t('服务内存')}</span>
      </section>
    </header>
  )
}
export function OfficeRightPanel({
  base,
  board,
  onRun,
  onOperations,
  busyId,
  canEdit,
  error,
  onTask,
}: {
  base: string
  board: Board
  onRun: (task: Task) => void
  onOperations: (task: Task) => void
  busyId: string
  canEdit: boolean
  error: string
  onTask: (task: Task) => void
}) {
  return (
    <aside className="office-right-panel office-progress-rail" aria-label={t('办公室任务面板')}>
      <TaskProgress
        base={base}
        tasks={board.tasks}
        onRun={onRun}
        onOperations={onOperations}
        busyId={busyId}
        canEdit={canEdit}
        onOpen={onTask}
        compact
      />
      {error && (
        <p role="alert" className="error">
          {t(error)}
        </p>
      )}
      <p className="progress-legend">{t('阶段由执行记录更新，不显示聊天内容。')}</p>
    </aside>
  )
}
