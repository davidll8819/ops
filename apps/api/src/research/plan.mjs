import { randomUUID } from 'node:crypto'
import { fail } from '../db.mjs'
import { taskDependencyState } from '../task-dependencies.mjs'
export function plannedTasks(input, { batchId, brief, language = 'zh' }) {
  const ids = input.map(() => randomUUID())
  const tasks = input.map((item, index) => ({
    ...item,
    id: ids[index],
    batchId,
    status: 'draft',
    engine: 'department-v1',
    summary: item.brief || brief,
    request: item.brief || brief,
    publishRequired: !!item.publishRequired,
    requiresConfirmation: true,
    dependsOn: (item.dependsOn || []).map((i) => {
      if (!Number.isInteger(i) || i < 0 || i >= ids.length || i === index)
        throw fail(502, '任务依赖关系无效')
      return ids[i]
    }),
  }))
  const visit = (task, stack = new Set()) => {
    if (stack.has(task.id)) throw fail(502, '任务依赖不能形成循环')
    const next = new Set([...stack, task.id])
    for (const id of task.dependsOn)
      visit(
        tasks.find((t) => t.id === id),
        next,
      )
  }
  tasks.forEach((t) => visit(t))
  const research = tasks.filter((t) => ['review-agent', 'new-agent-8'].includes(t.dept))
  research.forEach((t) => {
    t.engine = 'research-v1'
    t.executionNote = '等待确认调研分工'
  })
  if (research.length) {
    const archive = tasks.find((t) => t.dept === 'file-agent') || {
      id: randomUUID(),
      batchId,
      status: 'draft',
      title: language === 'en' ? 'Archive research reports' : '归档调研报告',
      dept: 'file-agent',
      due: research[0].due,
      summary: '按日期和部门保存调研报告、来源及检索时间',
      publishRequired: false,
      requiresConfirmation: true,
    }
    archive.engine = 'research-v1'
    archive.dependsOn = [...new Set([...(archive.dependsOn || []), ...research.map((t) => t.id)])]
    archive.executionNote = '等待调研报告完成后归档'
    if (!tasks.includes(archive)) tasks.push(archive)
    tasks.forEach((t) => visit(t))
  }
  return tasks
}
export async function enqueueResearch(db, ctx, board, batchId) {
  const tasks = board.tasks.filter((t) => t.batchId === batchId)
  for (const task of tasks) {
    if (task.status !== 'queued') throw fail(409, '请先确认任务分工')
    if (['review-agent', 'new-agent-8'].includes(task.dept)) task.engine = 'research-v1'
    else if (task.engine !== 'research-v1') task.engine = 'department-v1'
    if (
      task.engine === 'research-v1' &&
      !['review-agent', 'new-agent-8', 'file-agent'].includes(task.dept)
    )
      throw fail(409, '调研链路的负责人不可改为其他部门，请重新生成分工')
    if ((task.dependsOn || []).some((id) => !board.tasks.some((item) => item.id === id)))
      throw fail(409, '前置任务不存在，请重新安排分工')
    await db.query(
      "INSERT INTO task_jobs(tenant_id,user_id,task_id,state) VALUES($1,$2,$3,'queued') ON CONFLICT DO NOTHING",
      [ctx.tenantId, ctx.userId, task.id],
    )
    const dependency = taskDependencyState(board, task)
    task.executionNote = dependency.ready ? '已确认，等待后台执行器接收' : dependency.note
  }
}
