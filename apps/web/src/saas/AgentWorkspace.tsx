import { TaskProgress } from './TaskProgress'
import type { Task } from '../../../../packages/secretary/model.mjs'
import { DepartmentChat } from './DepartmentChat'
import { departmentIds } from './departments'
import { useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { DEPARTMENT_AGENTS } from '@/data/team'

export function AgentWorkspace({
  openOperations,
  base,
  openSettings,
  initialId,
  onTool,
  tasks,
  onRun,
  onTaskOperations,
  busyTask,
  canEdit,
}: {
  openOperations: () => void
  base: string
  openSettings: () => void
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
  const detailRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (selectedId) detailRef.current?.focus()
  }, [selectedId])

  if (selected)
    return (
      <section
        ref={detailRef}
        tabIndex={-1}
        className="team-detail"
        aria-label={`${selected.name} · ${t('智能体详情')}`}
      >
        <button className="team-back" onClick={() => setSelectedId(null)}>
          ← {t('返回智能体')}
        </button>
        <div className="team-detail-heading">
          <span
            className="team-avatar"
            style={{ borderColor: `#${selected.color.toString(16).padStart(6, '0')}` }}
            aria-hidden="true"
          >
            {selected.name.slice(0, 1)}
          </span>
          <div>
            <p className="team-department">{t(selected.department)}</p>
            <h1>{selected.name}</h1>
          </div>
          <span className="team-status">
            {t(selected.id === 'app-agent' ? '待连接' : '部门助手')}
          </span>
        </div>
        <section className="team-section">
          <h2>{t('工作职责')}</h2>
          <p>{t(selected.responsibility)}</p>
          <p className="muted small">{t('由私人秘书协调任务，按需要与其他部门协作。')}</p>
        </section>

        {selected.id === 'file-agent' && (
          <section className="archive-tools">
            <h2>{t('资料室工具')}</h2>
            <p>{t('文件整理与图片文字提取，由赵雅梦处理。')}</p>
            <div>
              <button onClick={() => onTool('files')}>{t('文件浏览')}</button>
              <button onClick={() => onTool('ocr')}>{t('截图 OCR')}</button>
            </div>
          </section>
        )}
        <TaskProgress base={base}
          tasks={tasks.filter((task) => task.dept === selected.id)}
          onRun={onRun}
          onOperations={onTaskOperations}
          busyId={busyTask}
          canEdit={canEdit}
        />
        <DepartmentChat
          key={selected.id}
          base={base}
          department={departmentIds[selected.id]}
          openSettings={openSettings}
        />
      </section>
    )

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
              <span>{t(agent.id === 'app-agent' ? '运营工作台' : '部门成员')}</span>
              <button
                aria-label={`${agent.name} · ${t(agent.id === 'app-agent' ? '打开运营工作台' : '查看职责')}`}
                onClick={() =>
                  agent.id === 'app-agent' ? openOperations() : setSelectedId(agent.id)
                }
              >
                {t(agent.id === 'app-agent' ? '打开运营工作台' : '查看详情')}{' '}
                <span aria-hidden="true">↗</span>
              </button>
            </div>
          </article>
        ))}
      </div>
      <p className="team-runtime-note">{t('选择员工后可直接对话，使用企业配置的部门模型。')}</p>
    </>
  )
}
