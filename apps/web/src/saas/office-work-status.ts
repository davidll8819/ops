import type { Board, Task } from '../../../../packages/secretary/model.mjs'
import { TEAM_ROSTER } from '../data/team'
import { departmentIds } from './departments'

/** Work indicators describe persisted work/configuration, never animation poses. */
export type OfficeWorkState =
  'working' | 'pending' | 'queued' | 'idle' | 'unconfigured' | 'disabled' | 'unknown'

export type OfficeWorkStatus = {
  status: OfficeWorkState
  label: string
  labelEn: string
  color: number
  taskId?: string
  taskTitle?: string
}

export type OfficeDepartmentStatus = {
  id: string
  ready: boolean
  enabled?: boolean
  active?: boolean
}

type StatusDefinition = Omit<OfficeWorkStatus, 'taskId' | 'taskTitle'>

const red = 0xdc4646
const yellow = 0xd6a329
const green = 0x4a9c59
const gray = 0x8a9299

const working: StatusDefinition = {
  status: 'working',
  label: '工作中',
  labelEn: 'Working',
  color: red,
}

const taskIndicators: Partial<Record<Task['status'], StatusDefinition>> = {
  working,
  draft: { status: 'pending', label: '等待确认', labelEn: 'Awaiting confirmation', color: yellow },
  approval: { status: 'pending', label: '等待确认', labelEn: 'Awaiting approval', color: yellow },
  review: { status: 'pending', label: '待查看', labelEn: 'Ready for review', color: yellow },
  revision: { status: 'pending', label: '待修改', labelEn: 'Revision needed', color: yellow },
  blocked: { status: 'pending', label: '待处理', labelEn: 'Needs attention', color: yellow },
  queued: { status: 'queued', label: '等待执行', labelEn: 'Queued', color: yellow },
  authorized: {
    status: 'queued',
    label: '等待发布',
    labelEn: 'Awaiting publication',
    color: yellow,
  },
}

function taskPriority(task: Task) {
  if (task.status === 'working') return 3
  if (taskIndicators[task.status]?.status === 'pending') return 2
  if (taskIndicators[task.status]?.status === 'queued') return 1
  return 0
}

function recentTaskTime(task: Task) {
  return Date.parse(task.updatedAt || task.startedAt || '') || 0
}

/**
 * An employee may own several tasks. Active work wins over waiting work;
 * completed tasks never hide an outstanding task. With no outstanding work,
 * only a confirmed-ready department is green.
 */
export function deriveOfficeWorkStatuses(
  board: Pick<Board, 'tasks'>,
  workspaceStatus: { departments: OfficeDepartmentStatus[] } | null | undefined,
): Record<string, OfficeWorkStatus> {
  const configurations = new Map(
    (workspaceStatus?.departments || []).map((department) => [department.id, department]),
  )

  return Object.fromEntries(
    TEAM_ROSTER.map((member) => {
      const configuration = configurations.get(departmentIds[member.id])
      const task = board.tasks
        .filter((candidate) => candidate.dept === member.id && taskPriority(candidate) > 0)
        .sort(
          (a, b) => taskPriority(b) - taskPriority(a) || recentTaskTime(b) - recentTaskTime(a),
        )[0]

      // A direct department/secretary request is real work even without a Task.
      if (configuration?.active) {
        return [
          member.id,
          {
            ...working,
            ...(task?.status === 'working' ? { taskId: task.id, taskTitle: task.title } : {}),
          },
        ]
      }
      if (task) {
        return [
          member.id,
          {
            ...taskIndicators[task.status]!,
            taskId: task.id,
            taskTitle: task.title,
          },
        ]
      }
      if (!configuration) {
        return [
          member.id,
          {
            status: 'unknown',
            label: '状态查询中',
            labelEn: 'Checking status',
            color: gray,
          },
        ]
      }
      if (configuration.enabled === false) {
        return [
          member.id,
          {
            status: 'disabled',
            label: '未启用',
            labelEn: 'Disabled',
            color: gray,
          },
        ]
      }
      if (!configuration.ready) {
        return [
          member.id,
          {
            status: 'unconfigured',
            label: '待配置',
            labelEn: 'Setup required',
            color: gray,
          },
        ]
      }
      return [
        member.id,
        {
          status: 'idle',
          label: '空闲',
          labelEn: 'Idle',
          color: green,
        },
      ]
    }),
  )
}
