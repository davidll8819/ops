import type { Task } from '../../../../packages/secretary/model.mjs'
import { unfinishedImage } from './task-image-state'

export const taskStateLabel = (status?: Task['status']) =>
  status
    ? {
        draft: '待确认分工',
        queued: '等待执行',
        working: '正在执行',
        completed: '已完成',
        blocked: '需要处理',
        approval: '待你确认',
        review: '报告待查看',
        authorized: '已许可',
        revision: '已退回',
      }[status]
    : '任务记录缺失'

export function taskDependencies(task: Task, tasks: Task[]) {
  return (task.dependsOn || []).map((id) => {
    const prerequisite = tasks.find((candidate) => candidate.id === id)
    return { id, task: prerequisite, ready: prerequisite?.status === 'completed' }
  })
}

export function taskRunState(task: Task, tasks: Task[]) {
  const prerequisitesReady = taskDependencies(task, tasks).every((dependency) => dependency.ready)
  const available =
    !task.runtimePending && (['queued', 'blocked'].includes(task.status) || unfinishedImage(task))
  return { available, prerequisitesReady, canRun: available && prerequisitesReady }
}

export function isOperationsNavigation(text: string) {
  // Creation/assignment requests must reach the secretary planner. Navigation is explicit.
  return /^(?:请\s*)?(?:帮我\s*)?(?:打开|进入)(?:一下)?\s*运营工作台[。！!\s]*$|^(?:please\s+)?(?:open|enter)\s+(?:the\s+)?operations workspace[.!\s]*$/i.test(
    text.trim(),
  )
}
