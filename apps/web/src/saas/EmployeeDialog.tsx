import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { t } from '@/i18n'
import type { AgentRosterEntry } from '@/data/team'
import type { Employee } from '../../../../packages/employees/registry.mjs'
import type { Task } from '../../../../packages/secretary/model.mjs'
import { api } from './api'
import { departmentIds } from './departments'
import { DepartmentChat } from './DepartmentChat'
import { TaskProgress } from './TaskProgress'
import { EmployeeSkills } from './EmployeeSkills'
import { EmployeeProject, type EmployeeProjectSnapshot } from './EmployeeProject'
import { EmployeeDeliverables } from './EmployeeDeliverables'
import type { AcceptanceSession } from './EmployeeAcceptance'
import { DragonProjects } from './DragonProjects'
import './employee-dialog.css'

type ModelRoute = {
  enabled: boolean
  configured: boolean
  model: string
  fallback: string
  source: 'company' | 'department'
}
type EmployeeProfile = Employee & {
  chatInstructions: string
  models: Record<'text' | 'search' | 'image' | 'video', ModelRoute>
  skills: { id: string; name: string; version: string }[]
}
const modelLabels = {
  text: '对话与文字任务',
  search: '联网调研任务',
  image: '图片任务',
  video: '视频任务',
}

export function EmployeeDialog({
  employee,
  base,
  close,
  openSettings,
  openSkills,
  openOperations,
  onTool,
  tasks,
  onRun,
  onTaskOperations,
  busyTask,
  canEdit,
}: {
  employee: AgentRosterEntry
  base: string
  close: () => void
  openSettings: () => void
  openSkills: () => void
  openOperations: import('./operations/models').OpenOperations
  onTool: (tool: string) => void
  tasks: Task[]
  onRun: (task: Task) => void
  onTaskOperations: (task: Task) => void
  busyTask: string
  canEdit: boolean
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const [view, setView] = useState<'chat' | 'deliverables' | 'profile' | 'tasks' | 'project'>(
    'chat',
  )
  const [profile, setProfile] = useState<EmployeeProfile | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [snapshot, setProject] = useState<EmployeeProjectSnapshot | null>(null)
  const [projectRefreshes, setProjectRefreshes] = useState<Record<string, number>>({})
  const [selection, setSelection] = useState<{ base: string; id: string | null } | null>(null)
  const selectedProjectId = selection?.base === base ? selection.id : null
  const projectSelectionReady = selection?.base === base
  const [projectDrafts, setProjectDrafts] = useState<Record<string, string>>({})
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({})
  const [acceptanceSessions, setAcceptanceSessions] = useState<
    Record<string, Record<string, AcceptanceSession | undefined>>
  >({})
  const [pendingProjects, setPendingProjects] = useState<Record<string, boolean>>({})
  const [projectErrors, setProjectErrors] = useState<Record<string, string>>({})
  const mounted = useRef(false)
  const scope = `${base}/${selectedProjectId || 'unassigned'}`
  const currentScope = useRef(scope)
  useLayoutEffect(() => {
    currentScope.current = scope
  }, [scope])
  const projectRefresh = projectRefreshes[scope] || 0
  const project = snapshot?.workspace?.id === selectedProjectId ? snapshot : null
  const projectRequestPending = pendingProjects[scope] || false
  const workspaceEndpoint = selectedProjectId
    ? `${base}/employees/code-agent/projects/${selectedProjectId}/workspace`
    : undefined
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const openProject = useCallback(
    (runId?: string) => {
      setSelectedRunId(runId || null)
      setProjectRefreshes((items) => ({ ...items, [scope]: (items[scope] || 0) + 1 }))
      setView('project')
    },
    [scope],
  )
  const selectProject = useCallback(
    (id: string | null) => {
      setSelection({ base, id })
      setSelectedRunId(null)
      const selectedScope = `${base}/${id || 'unassigned'}`
      setProjectRefreshes((items) => ({
        ...items,
        [selectedScope]: (items[selectedScope] || 0) + 1,
      }))
    },
    [base],
  )
  const refreshProject = useCallback(() => {
    if (mounted.current)
      setProjectRefreshes((items) => ({ ...items, [scope]: (items[scope] || 0) + 1 }))
  }, [scope])
  const pendingChange = useCallback(
    (pending: boolean) => {
      if (mounted.current) setPendingProjects((items) => ({ ...items, [scope]: pending }))
    },
    [scope],
  )
  const chatErrorChange = useCallback(
    (message: string) => {
      if (mounted.current) setProjectErrors((items) => ({ ...items, [scope]: message }))
    },
    [scope],
  )
  const changeDraft = useCallback(
    (value: string, submitted?: string) => {
      if (mounted.current)
        setProjectDrafts((items) => {
          if (submitted !== undefined && items[scope] !== submitted) return items
          return { ...items, [scope]: value }
        })
    },
    [scope],
  )
  const changeAcceptanceSession = useCallback(
    (versionId: string, session: AcceptanceSession | null) => {
      if (mounted.current)
        setAcceptanceSessions((items) => ({
          ...items,
          [scope]: { ...items[scope], [versionId]: session || undefined },
        }))
    },
    [scope],
  )
  const showDeliverables = useCallback(() => setView('deliverables'), [])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    const element = dialog.current
    if (!returnFocus.current && document.activeElement instanceof HTMLElement)
      returnFocus.current = document.activeElement
    if (element && !element.open) element.showModal()
    // Removing the dialog closes it. Calling close() in StrictMode cleanup would
    // enqueue onClose during the next setup and dismiss a newly opened dialog.
    return () => returnFocus.current?.focus()
  }, [])
  useEffect(() => {
    let live = true
    api<{ employees: EmployeeProfile[] }>(`${base}/employees`)
      .then(({ employees }) => {
        if (!live) return
        const found = employees.find((e) => e.id === employee.id)
        if (!found) throw new Error('员工资料暂时不可用')
        setProfile(found)
        setError('')
      })
      .catch((e) => {
        if (live) setError(e.message)
      })
    return () => {
      live = false
    }
  }, [base, employee.id, reload])
  const leaveFor = (open: () => void) => {
    close()
    open()
  }
  return (
    <dialog
      ref={dialog}
      className={`employee-dialog${employee.id === 'file-agent' ? ' employee-dialog-archive' : employee.id === 'app-agent' ? ' employee-dialog-content' : ''}`}
      aria-labelledby="employee-dialog-title"
      style={
        { '--employee-color': `#${employee.color.toString(16).padStart(6, '0')}` } as CSSProperties
      }
      onCancel={close}
      onClose={close}
    >
      <header className="employee-dialog-header">
        <span className="team-avatar" aria-hidden="true">
          {employee.name.slice(0, 1)}
        </span>
        <div>
          <p>{t(employee.department)}</p>
          <h1 id="employee-dialog-title">{employee.name}</h1>
        </div>
        <button
          autoFocus
          className="employee-dialog-close"
          aria-label={t('关闭员工对话')}
          onClick={close}
        >
          ×
        </button>
      </header>
      {employee.id === 'code-agent' && (
        <DragonProjects
          key={`chooser:${base}`}
          base={base}
          selectedId={selectedProjectId}
          canEdit={canEdit}
          onSelect={selectProject}
        />
      )}
      <nav className="employee-dialog-nav" aria-label={t('员工工作区')}>
        <button aria-pressed={view === 'chat'} onClick={() => setView('chat')}>
          {t('对话')}
        </button>
        {employee.id === 'code-agent' && (
          <button aria-pressed={view === 'deliverables'} onClick={() => setView('deliverables')}>
            {t('成果')}
          </button>
        )}
        {employee.id === 'code-agent' && (
          <button aria-pressed={view === 'project'} onClick={() => openProject()}>
            {t('项目工作区')}
          </button>
        )}
        <button aria-pressed={view === 'profile'} onClick={() => setView('profile')}>
          {t('员工档案')}
        </button>
        <button aria-pressed={view === 'tasks'} onClick={() => setView('tasks')}>
          {t('任务记录')} · {tasks.length}
        </button>
      </nav>
      <div className="employee-dialog-body">
        <div className="employee-chat-view" hidden={view !== 'chat'}>
          <p className="employee-responsibility">{t(employee.responsibility)}</p>
          {employee.id === 'app-agent' && (
            <button onClick={() => leaveFor(() => openOperations())}>{t('打开运营工作台')}</button>
          )}
          {(employee.id !== 'code-agent' || projectSelectionReady) && (
            <DepartmentChat
              key={`chat:${scope}:${employee.id}`}
              base={base}
              department={departmentIds[employee.id]}
              employeeName={employee.name}
              archiveDocuments={employee.id === 'file-agent'}
              onOperations={
                employee.id === 'app-agent' && canEdit
                  ? (brief) =>
                      leaveFor(() =>
                        openOperations(
                          brief.messages.at(-1)?.text || brief.title,
                          undefined,
                          brief,
                        ),
                      )
                  : undefined
              }
              openSettings={() => leaveFor(openSettings)}
              project={
                employee.id === 'code-agent'
                  ? {
                      id: selectedProjectId,
                      draft: projectDrafts[scope] || '',
                      onDraftChange: changeDraft,
                      requestPending: projectRequestPending,
                      error: projectErrors[scope] || '',
                      onErrorChange: chatErrorChange,
                      refreshVersion: projectRefresh,
                      ready: Boolean(project?.workspace),
                      available: Boolean(project?.runtime.available),
                      activeRunId: project?.workspace?.activeRunId,
                      canEdit,
                      onOpen: openProject,
                      onDeliverables: showDeliverables,
                      onRefresh: refreshProject,
                      onPendingChange: pendingChange,
                    }
                  : undefined
              }
            />
          )}
        </div>
        {employee.id === 'code-agent' && selectedProjectId && view === 'deliverables' && (
          <EmployeeDeliverables
            key={`deliverables:${scope}`}
            base={base}
            projectId={selectedProjectId}
            canEdit={canEdit}
            onRestored={refreshProject}
            onPendingChange={pendingChange}
            projectRevision={project?.workspace?.revision}
            activeRunId={project?.workspace?.activeRunId}
            requestPending={projectRequestPending}
            selectedVersionId={selectedVersions[scope] || ''}
            onVersionChange={(versionId) =>
              setSelectedVersions((items) => ({ ...items, [scope]: versionId }))
            }
            acceptanceSessions={acceptanceSessions[scope] || {}}
            onAcceptanceSessionChange={changeAcceptanceSession}
            onChat={() => setView('chat')}
            onProject={() => openProject()}
            onFeedback={(text) => {
              if (currentScope.current !== scope || projectRequestPending) return
              setProjectDrafts((items) => ({
                ...items,
                [scope]: `${items[scope] || ''}${items[scope] ? '\n\n' : ''}${text}`,
              }))
              setView('chat')
            }}
          />
        )}
        {employee.id === 'code-agent' && workspaceEndpoint && (
          <EmployeeProject
            key={`project:${scope}`}
            workspaceEndpoint={workspaceEndpoint}
            refreshVersion={projectRefresh}
            requestPending={projectRequestPending}
            selectedRunId={selectedRunId}
            visible={view === 'project'}
            onChange={setProject}
          />
        )}
        {employee.id === 'code-agent' &&
          !selectedProjectId &&
          (view === 'project' || view === 'deliverables') && (
            <p>{t('新建项目后，对话、文件和成果会分别保存在该项目中。')}</p>
          )}
        {view === 'profile' && (
          <div className="employee-profile">
            <section>
              <h2>{t('工作职责')}</h2>
              <p>{t(employee.responsibility)}</p>
              <p className="muted small">{t('由私人秘书协调任务，按需要与其他部门协作。')}</p>
            </section>
            {error ? (
              <p role="alert" className="error">
                {t(error)} <button onClick={() => setReload((n) => n + 1)}>{t('重新加载')}</button>
              </p>
            ) : !profile ? (
              <p role="status">{t('正在读取员工配置…')}</p>
            ) : (
              <>
                <section>
                  <details>
                    <summary>{t('查看当前工作指令')}</summary>
                    <p>{profile.chatInstructions}</p>
                  </details>
                </section>
                <section>
                  <div className="heading-row">
                    <h2>{t('模型配置')}</h2>
                    {canEdit && (
                      <button onClick={() => leaveFor(openSettings)}>{t('配置模型')}</button>
                    )}
                  </div>
                  <p className="muted small">
                    {t('按任务类型读取企业设置中的部门模型。配置状态不代表联网测试结果。')}
                  </p>
                  <dl className="employee-models">
                    {(Object.keys(modelLabels) as (keyof typeof modelLabels)[]).map((kind) => {
                      const model = profile.models[kind]
                      return (
                        <div key={kind}>
                          <dt>{t(modelLabels[kind])}</dt>
                          <dd>
                            <strong>
                              {model.model || t(model.enabled ? '尚未选择模型' : '未启用')}
                            </strong>
                            {model.enabled && (
                              <span>
                                {t(model.source === 'department' ? '部门专用模型' : '继承企业模型')}{' '}
                                · {t(model.configured ? '已配置' : '配置未完成')}
                              </span>
                            )}
                            {model.fallback && (
                              <span>
                                {t('备用模型')}：{model.fallback}
                              </span>
                            )}
                          </dd>
                        </div>
                      )
                    })}
                  </dl>
                </section>
                <EmployeeSkills
                  key={`${base}/${employee.id}`}
                  base={base}
                  employeeId={employee.id}
                  canEdit={canEdit}
                  openLibrary={() => leaveFor(openSkills)}
                  onSaved={() => setReload((n) => n + 1)}
                />
              </>
            )}
            {employee.id === 'file-agent' && (
              <section>
                <h2>{t('资料室工具')}</h2>
                <div className="employee-actions">
                  <button onClick={() => leaveFor(() => onTool('files'))}>{t('文件浏览')}</button>
                  <button onClick={() => leaveFor(() => onTool('ocr'))}>{t('截图 OCR')}</button>
                </div>
              </section>
            )}
            {employee.id === 'app-agent' && (
              <button onClick={() => leaveFor(() => openOperations())}>
                {t('打开运营工作台')}
              </button>
            )}
          </div>
        )}
        {view === 'tasks' && (
          <TaskProgress
            base={base}
            tasks={tasks}
            onRun={onRun}
            onOperations={(task) => leaveFor(() => onTaskOperations(task))}
            busyId={busyTask}
            canEdit={canEdit}
          />
        )}
      </div>
    </dialog>
  )
}
