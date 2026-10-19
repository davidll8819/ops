import { randomUUID } from 'node:crypto'
import { transaction, tenantAccess, fail } from './db.mjs'
import { createModelGateway, loadPolicy } from './operations/gateway.mjs'
import { loadAssignedSkills } from './skill-runtime.mjs'
import { resolveTaskInputs, taskDependencyState } from './task-dependencies.mjs'
import { needsDesignImage } from './design-images.mjs'
import {
  departmentMap,
  departmentRoster,
  performDepartmentTask,
  persistDepartmentResult,
} from './secretary-execution.mjs'

const readBoard = async (db, ctx) =>
  (
    await db.query(
      'SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',
      [ctx.tenantId, ctx.userId],
    )
  ).rows[0]
const saveBoard = (db, ctx, board) =>
  db.query(
    'UPDATE secretary_workspaces SET board=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',
    [ctx.tenantId, ctx.userId, JSON.stringify(board)],
  )
async function office(db, ctx, task, working) {
  const rosterNo = departmentRoster[departmentMap[task.dept]]
  if (!rosterNo) return
  await db.query('INSERT INTO office_events(tenant_id,action) VALUES($1,$2)', [
    ctx.tenantId,
    JSON.stringify({
      type: 'set_state',
      rosterNo,
      state: working ? 'working' : 'idle',
      task: working ? '正在执行部门任务' : '部门任务已更新',
    }),
  ])
}

export function createDepartmentEngine({ pool, env, fetcher, operations }) {
  const gateway = createModelGateway({ pool, env, fetcher })
  const scoped = (ctx, fn) =>
    transaction(
      pool,
      async (db) => {
        await tenantAccess(db, ctx.userId, ctx.tenantId, ['owner', 'admin'])
        return fn(db)
      },
      ctx,
    )
  async function update(ctx, claim, fn) {
    return scoped(ctx, async (db) => {
      const current = await readBoard(db, ctx)
      const job = (
        await db.query(
          "SELECT * FROM task_jobs WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3 AND state='running' AND claim_id=$4 FOR UPDATE",
          [ctx.tenantId, ctx.userId, claim.task.id, claim.id],
        )
      ).rows[0]
      if (!job || new Date(job.lease_until).getTime() <= Date.now())
        throw fail(409, '任务执行权已失效')
      const task = current?.board.tasks.find((item) => item.id === claim.task.id)
      if (!task || task.engine !== 'department-v1') throw fail(409, '任务执行权已失效')
      await fn(db, task, current.board)
      await saveBoard(db, ctx, current.board)
    })
  }
  async function claimNext(ctx) {
    return scoped(ctx, async (db) => {
      const current = await readBoard(db, ctx)
      if (!current) return
      const jobs = (
        await db.query(
          "SELECT * FROM task_jobs WHERE tenant_id=$1 AND user_id=$2 AND state IN ('queued','running') ORDER BY updated_at,task_id FOR UPDATE SKIP LOCKED",
          [ctx.tenantId, ctx.userId],
        )
      ).rows
      let changed = false,
        claim
      for (const job of jobs) {
        const task = current.board.tasks.find((item) => item.id === job.task_id)
        if (!task || task.engine !== 'department-v1') continue
        if (job.state === 'running') {
          if (new Date(job.lease_until).getTime() > Date.now()) continue
          if (task.dept === 'app-agent' && task.runtimeTaskId) {
            // The external task identity is durable. Reconcile it; never submit a duplicate.
            await db.query(
              "UPDATE task_jobs SET state='completed',claim_id=NULL,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3",
              [ctx.tenantId, ctx.userId, task.id],
            )
          } else {
            task.status = 'blocked'
            task.executionNote = task.runtimePending
              ? '运营任务结果待核对，请勿重复提交'
              : '执行中断，结果待核对；请手动重试'
            task.finishedAt = new Date().toISOString()
            await db.query(
              "UPDATE task_jobs SET state='blocked',claim_id=NULL,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3",
              [ctx.tenantId, ctx.userId, task.id],
            )
            await office(db, ctx, task, false)
          }
          changed = true
          continue
        }
        if (task.status !== 'queued') continue
        if (task.dept === 'app-agent' && (task.runtimePending || task.runtimeTaskId)) {
          task.executionNote = '已有运营任务等待核对，不会重复提交'
          await db.query(
            'UPDATE task_jobs SET state=$4,updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3',
            [ctx.tenantId, ctx.userId, task.id, task.runtimeTaskId ? 'completed' : 'blocked'],
          )
          if (!task.runtimeTaskId) task.status = 'blocked'
          changed = true
          continue
        }
        const dependencyState = taskDependencyState(current.board, task)
        if (!dependencyState.ready) {
          if (task.executionNote !== dependencyState.note) {
            task.executionNote = dependencyState.note
            changed = true
          }
          continue
        }
        let inputs
        try {
          inputs = await resolveTaskInputs(db, ctx, current.board, task)
          if (!departmentMap[task.dept]) throw fail(409, '部门尚未接入')
        } catch (error) {
          task.status = 'blocked'
          task.executionNote = error.expose ? error.message : '无法读取前置成果，请检查任务资料'
          await db.query(
            "UPDATE task_jobs SET state='blocked',updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3",
            [ctx.tenantId, ctx.userId, task.id],
          )
          changed = true
          continue
        }
        const id = randomUUID()
        task.request ||= task.summary
        task.receivedInputs = inputs.receivedInputs
        task.outputKind = needsDesignImage(task) ? 'image' : 'text'
        if (task.dept !== 'app-agent') task.status = 'working'
        task.startedAt = new Date().toISOString()
        delete task.finishedAt
        task.executionNote =
          task.dept === 'app-agent'
            ? '前置成果已接收，正在连接运营服务'
            : inputs.dependencies.length
              ? '前置成果已接收，正在执行部门任务'
              : '正在执行部门任务'
        await db.query(
          "UPDATE task_jobs SET state='running',claim_id=$4,lease_until=now()+interval '90 seconds',updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3",
          [ctx.tenantId, ctx.userId, task.id, id],
        )
        if (task.dept !== 'app-agent') await office(db, ctx, task, true)
        changed = true
        claim = { id, task: { ...structuredClone(task), _claimId: id }, inputs }
        break
      }
      if (changed) await saveBoard(db, ctx, current.board)
      return claim
    })
  }
  async function execute(ctx, claim) {
    const heartbeat = setInterval(() => {
      void scoped(ctx, (db) =>
        db.query(
          "UPDATE task_jobs SET lease_until=now()+interval '90 seconds' WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3 AND state='running' AND claim_id=$4 AND lease_until>now()",
          [ctx.tenantId, ctx.userId, claim.task.id, claim.id],
        ),
      ).catch(() => {})
    }, 20000)
    heartbeat.unref()
    try {
      if (claim.task.dept === 'app-agent') {
        if (!operations?.execute) throw fail(409, '运营运行服务尚未接入')
        await operations.execute(ctx, claim.task, claim.inputs)
        await update(ctx, claim, async (db, task) => {
          if (!task.runtimeTaskId) throw fail(409, '运营任务结果待核对，请勿重复提交')
          // This job only submits; the external runtime owns the task completion state.
          await db.query(
            "UPDATE task_jobs SET state='completed',lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3 AND claim_id=$4",
            [ctx.tenantId, ctx.userId, task.id, claim.id],
          )
          await office(db, ctx, task, task.status === 'working')
        })
      } else {
        const department = departmentMap[claim.task.dept]
        const { policy, skills } = await scoped(ctx, async (db) => ({
          ...(await loadPolicy(db, ctx.tenantId, env)),
          skills: await loadAssignedSkills(db, ctx.tenantId, department),
        }))
        const call = async (request) => {
          await update(ctx, claim, async () => {})
          return gateway(request)
        }
        const result = await performDepartmentTask({
          call,
          ctx,
          policy,
          task: claim.task,
          skills,
          inputs: claim.inputs,
        })
        await update(ctx, claim, async (db, task) => {
          await persistDepartmentResult(db, ctx, task, result)
          await db.query(
            'UPDATE task_jobs SET state=$5,lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3 AND claim_id=$4',
            [
              ctx.tenantId,
              ctx.userId,
              task.id,
              claim.id,
              task.status === 'completed' ? 'completed' : 'blocked',
            ],
          )
          await office(db, ctx, task, false)
        })
      }
    } catch (error) {
      try {
        await update(ctx, claim, async (db, task) => {
          // A known runtime id always remains reconcilable, including after the response stream breaks.
          if (task.dept === 'app-agent' && task.runtimeTaskId) {
            await db.query(
              "UPDATE task_jobs SET state='completed',lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3 AND claim_id=$4",
              [ctx.tenantId, ctx.userId, task.id, claim.id],
            )
            return
          }
          task.status = 'blocked'
          task.executionNote = task.runtimePending
            ? '运营任务结果待核对，请勿重复提交'
            : error.expose
              ? error.message
              : '任务未完成，请检查执行服务设置'
          task.finishedAt = new Date().toISOString()
          await db.query(
            "UPDATE task_jobs SET state='blocked',lease_until=NULL,updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND task_id=$3 AND claim_id=$4",
            [ctx.tenantId, ctx.userId, task.id, claim.id],
          )
          await office(db, ctx, task, false)
        })
      } catch {
        /* Lost claim or access: never overwrite a newer result or retry a charged request. */
      }
    } finally {
      clearInterval(heartbeat)
    }
  }
  async function reconcile(ctx) {
    if (!operations?.reconcile) return
    const tasks = await scoped(ctx, async (db) => {
      const current = await readBoard(db, ctx)
      return (current?.board.tasks || [])
        .filter(
          (task) => task.dept === 'app-agent' && task.status === 'working' && task.runtimeTaskId,
        )
        .map((task) => structuredClone(task))
    })
    for (const task of tasks) {
      try {
        await operations.reconcile(ctx, task)
      } catch (error) {
        // Keep polling the known task; only submission failures block a new run.
        // Match the submission as well as its runtime id so a delayed failure cannot
        // overwrite a newer user-authorized continuation of that same runtime task.
        try {
          await scoped(ctx, async (db) => {
            const current = await readBoard(db, ctx)
            const stored = current?.board.tasks.find((item) => item.id === task.id)
            if (
              stored?.status !== 'working' ||
              stored.runtimeTaskId !== task.runtimeTaskId ||
              stored.runtimeSubmissionId !== task.runtimeSubmissionId
            )
              return
            stored.statusSyncError = error.expose ? error.message : '运营服务暂时无法连接'
            stored.lastStatusSyncAt = new Date().toISOString()
            stored.executionNote = '运营进度暂时无法核对，稍后自动重试；不会重复提交。'
            await saveBoard(db, ctx, current.board)
          })
        } catch {
          /* Access may have been revoked while the status request was in flight. */
        }
      }
    }
  }
  return {
    async tick() {
      const members = (
        await pool.query(
          "SELECT tenant_id,user_id FROM memberships WHERE role IN ('owner','admin')",
        )
      ).rows
      // Reconcile all members before any long model call so one company's work cannot hide another's completion.
      for (const member of members)
        await reconcile({ tenantId: member.tenant_id, userId: member.user_id })
      for (const member of members) {
        const ctx = { tenantId: member.tenant_id, userId: member.user_id }
        const claim = await claimNext(ctx)
        if (claim) {
          await execute(ctx, claim)
          return true
        }
      }
      return false
    },
  }
}

export function registerDepartmentEngine(app, options) {
  const engine = createDepartmentEngine(options)
  let timer,
    running = false,
    stopped = false
  const tick = async () => {
    if (running || stopped) return
    running = true
    try {
      await engine.tick()
    } catch {
      app.log.warn('Department task execution deferred')
    } finally {
      running = false
    }
  }
  if (options.env.NODE_ENV !== 'test') {
    app.addHook('onReady', async () => {
      timer = setInterval(() => void tick(), 3000)
      timer.unref()
      void tick()
    })
    app.addHook('onClose', async () => {
      stopped = true
      clearInterval(timer)
    })
  }
  return engine
}
