import { deriveOfficeWorkStatuses } from './office-work-status'
import { TaskCenter, ArchiveRoom, type TaskFilter } from './TaskCenter'
import { WorkspaceTools } from './WorkspaceTools'
import { emptyBoard, type Task, type Board } from '../../../../packages/secretary/model.mjs'
import { lazy, Suspense, useCallback, useEffect, useState, useMemo } from 'react'
import { t, useLanguage } from '@/i18n'
import { api, type Tenant } from './api'
import { Members } from './Members'
import { Usage } from './Usage'
import { Skills, type SkillView } from './Skills'
import { SkillUpload } from './SkillUpload'
import { AgentWorkspace } from './AgentWorkspace'
import { SecretaryWorkspace } from './secretary/SecretaryWorkspace'
import { OperationsDialog } from './operations/OperationsDialog'
import type { OperationsHandoff } from './operations/OperationsWorkspace'
import type { OperationsBrief } from './operations/models'
import { Settings } from './Settings'
import { NavigationIcon } from './NavigationIcon'
import { OfficeHeaderStats, OfficeRightPanel } from '@/components/OfficeDashboardChrome'
const Office = lazy(() => import('../App'))
export function Workspace({ tenant }: { tenant: Tenant }) {
  const language = useLanguage()
  const [operationsOpen, setOperationsOpen] = useState(false)
  const [operationsVisited, setOperationsVisited] = useState(false)
  const [handoff, setHandoff] = useState<OperationsHandoff>()
  const openOperations = useCallback(
    (brief?: string, task?: Task, savedBrief?: OperationsBrief) => {
      if (brief?.trim() || task)
        setHandoff({
          id: crypto.randomUUID(),
          text: brief?.trim() || '',
          secretaryTaskId: task?.id,
          runtimeTaskId: task?.runtimeTaskId,
          brief: savedBrief,
        })
      setOperationsVisited(true)
      setOperationsOpen(true)
    },
    [],
  )
  const [skillView, setSkillView] = useState<SkillView>('catalog')
  const [skillRevision, setSkillRevision] = useState(0)
  const skillInstalled = () => {
    setSkillRevision((n) => n + 1)
    setSkillView('installed')
  }
  const [automatic, setAutomatic] = useState(false)
  const [tab, setTab] = useState('office')
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('all')
  const [selectedTask, setSelectedTask] = useState<string>()
  const openTasks = (filter: TaskFilter = 'all', id?: string) => {
    setTaskFilter(filter)
    setSelectedTask(id)
    setTab('tasks')
  }
  const base = `/api/tenants/${tenant.id}`
  const [tool, setTool] = useState(''),
    [dictated, setDictated] = useState(''),
    [agentId, setAgentId] = useState<string>()
  const [board, setBoard] = useState<Board>(emptyBoard()),
    [status, setStatus] = useState<{
      departments: {
        id: string
        name: string
        ready: boolean
        enabled?: boolean
        active?: boolean
      }[]
      memoryMb: number
      uptime: number
    } | null>(null)
  const workIndicators = useMemo(() => deriveOfficeWorkStatuses(board, status), [board, status])
  const [busyTask, setBusyTask] = useState(''),
    [taskError, setTaskError] = useState('')
  const openTaskOperations = (task: Task) => openOperations(`${task.title}\n${task.summary}`, task)
  async function runTask(task: Task) {
    setBusyTask(task.id)
    setTaskError('')
    try {
      const result = await api<{ board: Board }>(
        `${base}/secretary/tasks/${task.id}/run`,
        task.status === 'completed' ? { regenerateImage: true } : {},
      )
      setBoard(result.board)
    } catch (e) {
      setTaskError((e as Error).message)
    } finally {
      setBusyTask('')
    }
  }
  useEffect(() => {
    if (tab === 'secretary' && dictated) setDictated('')
  }, [tab, dictated])
  const openSettings = () => {
    setOperationsOpen(false)
    setTool('')
    setTab('settings')
  }
  const openPerson = useCallback(
    (id: string) => {
      if (id === 'marvis') setTab('secretary')
      else if (id === 'app-agent') openOperations()
      else {
        setAgentId(id)
        setTab('agents')
      }
    },
    [openOperations],
  )
  useEffect(() => {
    let live = true
    let pending = false
    const update = async () => {
      if (document.hidden || pending) return
      pending = true
      await Promise.all([
        api<{ board: Board }>(`${base}/secretary`),
        api<NonNullable<typeof status>>(`${base}/workspace/status`),
      ])
        .then(([b, s]) => {
          if (live) {
            setTaskError('')
            setBoard(b.board)
            setStatus(s)
          }
        })
        .catch(() => {
          if (live) setTaskError('任务状态暂时无法刷新，显示上次记录')
        })
        .finally(() => {
          pending = false
        })
    }
    update()
    const timer = setInterval(update, 5000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [base, tab])

  useEffect(() => {
    const ids = [
      ...new Set(
        board.tasks
          .filter((task) => task.runtimeTaskId && task.status === 'working')
          .map((task) => task.runtimeTaskId!),
      ),
    ]
    if (!ids.length) return
    let live = true,
      pending = false
    const sync = async () => {
      if (pending || document.hidden) return
      pending = true
      try {
        for (const id of ids) await api(`${base}/operations/tasks/${id}`)
      } catch {
        if (live) setTaskError('运营任务状态暂时无法核对')
      } finally {
        pending = false
      }
    }
    void sync()
    const timer = setInterval(() => void sync(), 7000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [base, board.tasks.map((task) => `${task.runtimeTaskId}:${task.status}`).join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={`workspace ${['secretary', 'tasks', 'archive'].includes(tab) ? 'workspace-secretary-layout' : ''}`}
    >
      <aside className="workspace-nav">
        <p className="eyebrow">WORKSPACE</p>
        <h2>{tenant.name}</h2>
        <span className="plan-tag">{tenant.plan === 'enterprise' ? t('企业版') : t('个人版')}</span>
        <nav lang={language} aria-label={t('主导航')}>
          {[
            ['secretary', t('私人秘书')],
            ['office', t('办公室')],
            ['tasks', t('任务成果')],
            ['archive', t('资料室')],
            ['members', t('企业成员')],
            ['skills', t('技能库')],
            ['agents', t('智能体')],
            ['settings', t('设置')],
            ['usage', t('用量与费用')],
          ].map(([key, label]) => (
            <button
              key={key}
              aria-current={tab === key ? 'page' : undefined}
              className={tab === key ? 'selected' : ''}
              onClick={() => {
                setAgentId(undefined)
                setTab(key)
                if (key === 'tasks') {
                  setSelectedTask(undefined)
                  setTaskFilter('completed')
                }
              }}
            >
              <NavigationIcon name={key} />
              <span className="nav-label">{label}</span>
            </button>
          ))}
        </nav>
        <div className="workspace-note">
          <strong>{t('专属于当前企业')}</strong>
          <p>{t('助手配置、成员和使用记录都在此工作空间中管理。')}</p>
        </div>
      </aside>
      <main
        className={`workspace-content ${tab === 'office' ? 'workspace-office' : tab === 'skills' ? 'workspace-skills' : tab === 'secretary' ? 'workspace-secretary' : ''}`}
      >
        {tab === 'tasks' && taskError && (
          <p className="error" role="alert">
            {t(taskError)}
          </p>
        )}
        {tab === 'secretary' && (
          <SecretaryWorkspace
            base={base}
            canEdit={tenant.role !== 'member'}
            openOperations={openOperations}
            initialInput={dictated}
            openSettings={openSettings}
            onVoice={() => setTool('voice')}
            onTask={(id) => openTasks('all', id)}
          />
        )}
        {tab === 'office' && (
          <>
            <OfficeHeaderStats
              board={board}
              status={status}
              onTasks={(filter) => openTasks(filter)}
              onSettings={openSettings}
            />
            <div className="office-scene-toolbar">
              <span>{t('办公室互动')}</span>
              <button aria-pressed={automatic} onClick={() => setAutomatic(!automatic)}>
                {t(automatic ? '关闭互动' : '开启互动')}
              </button>
              <small>{t('红灯执行中 · 黄灯待确认或待处理 · 绿灯空闲')}</small>
            </div>
            <Suspense fallback={<p>{t('正在加载办公室…')}</p>}>
              <Office
                tenantId={tenant.id}
                workIndicators={workIndicators}
                automatic={automatic}
                onAutomaticChange={setAutomatic}
                onOpenOperations={openOperations}
                onOpenPerson={openPerson}
              />
            </Suspense>
          </>
        )}
        {tab === 'tasks' && (
          <TaskCenter
            base={base}
            board={board}
            filter={taskFilter}
            onFilter={setTaskFilter}
            selected={selectedTask}
            onSelect={setSelectedTask}
            onRun={runTask}
            onOperations={openTaskOperations}
            canEdit={tenant.role !== 'member'}
            busyId={busyTask}
            onUpdate={setBoard}
          />
        )}
        {tab === 'archive' && <ArchiveRoom base={base} onTask={(id) => openTasks('all', id)} />}
        {tab === 'members' && <Members base={base} tenant={tenant} />}{' '}
        {tab === 'skills' && (
          <Skills
            base={base}
            canEdit={tenant.role !== 'member'}
            view={skillView}
            onView={setSkillView}
            revision={skillRevision}
            onInstalled={skillInstalled}
            openOperations={openOperations}
          />
        )}
        {tab === 'agents' && (
          <AgentWorkspace
            key={agentId || 'all'}
            initialId={agentId}
            onTool={setTool}
            tasks={board.tasks}
            onRun={runTask}
            onTaskOperations={openTaskOperations}
            busyTask={busyTask}
            canEdit={tenant.role !== 'member'}
            base={base}
            openSettings={openSettings}
            openSkills={() => {
              setSkillView('installed')
              setTab('skills')
            }}
            openOperations={openOperations}
          />
        )}
        {tab === 'settings' && <Settings base={base} canEdit={tenant.role !== 'member'} />}
        {tab === 'usage' && <Usage base={base} />}
      </main>
      {tool && (
        <WorkspaceTools
          key={tool}
          base={base}
          tool={tool}
          onClose={() => setTool('')}
          openSettings={openSettings}
          onDictated={(text) => {
            setDictated(text)
            setTab('secretary')
          }}
        />
      )}
      {operationsVisited && (
        <OperationsDialog
          open={operationsOpen}
          onClose={() => setOperationsOpen(false)}
          base={base}
          canEdit={tenant.role !== 'member'}
          handoff={handoff}
          openSettings={openSettings}
        />
      )}
      {['secretary', 'tasks', 'archive'].includes(tab) ? null : tab === 'office' ? (
        <OfficeRightPanel
          base={base}
          board={board}
          onRun={runTask}
          onOperations={openTaskOperations}
          busyId={busyTask}
          canEdit={tenant.role !== 'member'}
          error={taskError}
          onTask={(task) => openTasks('all', task.id)}
        />
      ) : tab === 'skills' ? (
        <aside className="workspace-extension skill-upload-rail" aria-label={t('技能上传区')}>
          <SkillUpload
            base={base}
            canEdit={tenant.role !== 'member'}
            onInstalled={skillInstalled}
          />
        </aside>
      ) : (
        <aside className="workspace-extension" aria-label={t('右侧预留区')}>
          <div className="extension-placeholder">
            <span aria-hidden="true">＋</span>
            <h2>{t('扩展区域')}</h2>
            <p>{t('为后续功能预留')}</p>
          </div>
        </aside>
      )}
    </div>
  )
}
