import { useState } from 'react'
import { t } from '@/i18n'
import { DEPARTMENT_AGENTS } from '@/data/team'
import type { Task } from '../../../../packages/secretary/model.mjs'
import { EmployeeDialog } from './EmployeeDialog'

export function AgentWorkspace({
  openOperations,
  base,
  openSettings,
  openSkills,
  initialId,
  onTool,
  tasks,
  onRun,
  onTaskOperations,
  busyTask,
  canEdit,
}: {
  openOperations: import('./operations/models').OpenOperations
  base: string
  openSettings: () => void
  openSkills: () => void
  onTool: (tool: string) => void
  tasks: Task[]
  onRun: (task: Task) => void
  onTaskOperations: (task: Task) => void
  busyTask: string
  canEdit: boolean
  initialId?: string
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialId || null)
  const selected = DEPARTMENT_AGENTS.find((agent) => agent.id === selectedId)
  return (
    <>
      <div className="page-heading team-heading">
        <p className="eyebrow">AI TEAM</p>
        <h1>
          {t('智能体')} <span className="team-count">{DEPARTMENT_AGENTS.length}</span>
        </h1>
        <p className="muted">{t('七位部门员工与一位实习生，由私人秘书李婉儿统一协调。')}</p>
      </div>
      <div className="team-grid">
        {DEPARTMENT_AGENTS.map((agent) => (
          <article className="team-card" key={agent.id}>
            <div className="team-card-top">
              <span
                className="team-avatar"
                style={{ borderColor: `#${agent.color.toString(16).padStart(6, '0')}` }}
                aria-hidden="true"
              >
                {agent.name.slice(0, 1)}
              </span>
              <span className="team-status">{t('部门助手')}</span>
            </div>
            <p className="team-department">{t(agent.department)}</p>
            <h2>{agent.name}</h2>
            <p className="team-responsibility">{t(agent.responsibility)}</p>
            <div className="team-card-footer">
              <span>{t('部门成员')}</span>
              <button
                aria-label={`${agent.name} · ${t('打开对话')}`}
                onClick={() => setSelectedId(agent.id)}
              >
                {t('打开对话')} <span aria-hidden="true">↗</span>
              </button>
            </div>
          </article>
        ))}
      </div>
      <p className="team-runtime-note">{t('选择员工后可直接对话，使用企业配置的部门模型。')}</p>
      {selected && (
        <EmployeeDialog
          key={selected.id}
          employee={selected}
          base={base}
          close={() => setSelectedId(null)}
          openSettings={openSettings}
          openSkills={openSkills}
          openOperations={openOperations}
          onTool={onTool}
          tasks={tasks.filter((task) => task.dept === selected.id)}
          onRun={onRun}
          onTaskOperations={onTaskOperations}
          busyTask={busyTask}
          canEdit={canEdit}
        />
      )}
    </>
  )
}
