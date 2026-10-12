import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { migrate } from '../database/migrate.mjs'
import { transaction } from '../apps/api/src/db.mjs'
import { createDepartmentEngine } from '../apps/api/src/department-engine.mjs'
import { createResearchEngine } from '../apps/api/src/research/engine.mjs'
import { resolveTaskInputs } from '../apps/api/src/task-dependencies.mjs'
import { performDepartmentTask } from '../apps/api/src/secretary-execution.mjs'
import { plannedTasks, enqueueResearch } from '../apps/api/src/research/plan.mjs'

test('department inputs preserve finished work, reject unfinished dependencies and pass it to the model', async () => {
  const source = {
    id: 'design',
    dept: 'new-agent-7',
    title: '咖啡分镜',
    status: 'completed',
    summary: '镜头一：咖啡上方蒸汽。镜头二：包装细节。',
    imagePrompt: 'warm coffee',
    sources: [{ url: 'https://example.com' }],
  }
  const target = {
    id: 'copy',
    title: '接续文案',
    dept: 'file-agent',
    request: '整理已有分镜',
    dependsOn: ['design'],
  }
  const inputs = await resolveTaskInputs(
    {
      query: async () => {
        throw Error('no files expected')
      },
    },
    {},
    { tasks: [target, source] },
    target,
  )
  assert.match(inputs.text, /咖啡上方蒸汽/)
  assert.equal(inputs.receivedInputs[0].taskId, source.id)
  let messages
  await performDepartmentTask({
    ctx: {},
    policy: {},
    task: target,
    instructions: '',
    inputs,
    call: async (request) => {
      messages = request.body.messages
      return { choices: [{ message: { content: '接续结果' } }] }
    },
  })
  assert.match(messages[1].content, /镜头二/)
  assert.match(messages[0].content, /参考资料/)
  await assert.rejects(
    resolveTaskInputs({}, {}, { tasks: [target, { ...source, status: 'blocked' }] }, target),
    /前置任务需要处理/,
  )
  await assert.rejects(resolveTaskInputs({}, {}, { tasks: [target] }, target), /前置任务不存在/)
  await assert.rejects(
    resolveTaskInputs(
      {},
      {},
      { tasks: [target, { ...source, summary: 'x'.repeat(120001) }] },
      target,
    ),
    /没有被截断/,
  )
  await assert.rejects(
    resolveTaskInputs(
      {},
      {},
      {
        tasks: [
          target,
          { ...source, images: Array.from({ length: 5 }, () => ({ fileId: randomUUID() })) },
        ],
      },
      target,
    ),
    /超过 4 个/,
  )
})

test('durable department queue honors dependencies, engine ownership and uncertain execution', async (t) => {
  const pg = new PGlite()
  await pg.waitReady
  const query = async (sql, params) => {
    if (!params) {
      const items = await pg.exec(sql)
      return { ...items.at(-1), rowCount: items.at(-1)?.affectedRows || 0 }
    }
    const result = await pg.query(sql, params)
    return { ...result, rowCount: result.affectedRows || 0 }
  }
  let release = Promise.resolve()
  const pool = {
    query,
    connect: async () => {
      const previous = release
      let unlock
      release = new Promise((resolve) => {
        unlock = resolve
      })
      await previous
      return { query, release: unlock }
    },
  }
  const ctx = { tenantId: randomUUID(), userId: randomUUID() }
  const env = { NODE_ENV: 'test' }
  await migrate(pool)
  await query('INSERT INTO users(id,subject,email) VALUES($1,$2,$3)', [
    ctx.userId,
    ctx.userId,
    'department@example.test',
  ])
  await query('INSERT INTO tenants(id,name) VALUES($1,$2)', [ctx.tenantId, 'Fixture'])
  await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')", [
    ctx.tenantId,
    ctx.userId,
  ])
  const read = async () =>
    (
      await query('SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2', [
        ctx.tenantId,
        ctx.userId,
      ])
    ).rows[0].board
  const write = async (board) =>
    query(
      'INSERT INTO secretary_workspaces(tenant_id,user_id,board) VALUES($1,$2,$3) ON CONFLICT(tenant_id,user_id) DO UPDATE SET board=$3',
      [ctx.tenantId, ctx.userId, JSON.stringify(board)],
    )
  const reset = async (tasks) => {
    await query('DELETE FROM task_jobs')
    await write({ tasks, messages: [], batches: [] })
  }
  const job = async (task, state = 'queued') =>
    query('INSERT INTO task_jobs(tenant_id,user_id,task_id,state) VALUES($1,$2,$3,$4)', [
      ctx.tenantId,
      ctx.userId,
      task.id,
      state,
    ])
  let starts = 0,
    reconciles = 0,
    received
  const operations = {
    execute: async (_ctx, task, inputs) => {
      starts++
      received = inputs
      assert.ok(task._claimId)
      await transaction(
        pool,
        async (db) => {
          const record = (
            await db.query(
              'SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',
              [ctx.tenantId, ctx.userId],
            )
          ).rows[0]
          const stored = record.board.tasks.find((item) => item.id === task.id)
          stored.status = 'working'
          stored.runtimeTaskId = '0123456789abcdef01234567'
          await db.query(
            'UPDATE secretary_workspaces SET board=$3 WHERE tenant_id=$1 AND user_id=$2',
            [ctx.tenantId, ctx.userId, JSON.stringify(record.board)],
          )
        },
        ctx,
      )
    },
    reconcile: async () => {
      reconciles++
    },
  }
  const engine = () =>
    createDepartmentEngine({
      pool,
      env,
      operations,
      fetcher: async () => {
        throw Error('unexpected paid model')
      },
    })
  try {
    await t.test(
      'a task is not automatically enrolled without a confirmed queue entry',
      async () => {
        await reset([
          { id: 'legacy', dept: 'app-agent', engine: 'department-v1', status: 'queued' },
        ])
        assert.equal(await engine().tick(), false)
        assert.equal(starts, 0)
      },
    )
    await t.test(
      'each worker skips the other engine even when its queue entry is first',
      async () => {
        const research = {
          id: 'research',
          dept: 'review-agent',
          engine: 'research-v1',
          status: 'queued',
        }
        await reset([research])
        await job(research)
        assert.equal(await engine().tick(), false)
        const ops = { id: 'ops', dept: 'app-agent', engine: 'department-v1', status: 'queued' }
        await reset([ops])
        await job(ops)
        assert.equal(
          await createResearchEngine({
            pool,
            env,
            fetcher: async () => {
              throw Error('unexpected paid model')
            },
          }).tick(),
          false,
        )
        assert.equal((await read()).tasks[0].status, 'queued')
        assert.equal(starts, 0)
      },
    )
    await t.test(
      'reverse order waits for design and concurrent workers submit its actual result once',
      async () => {
        const design = {
          id: 'design',
          dept: 'new-agent-7',
          title: '咖啡分镜',
          status: 'working',
          summary: 'draft',
        }
        const ops = {
          id: 'ops',
          dept: 'app-agent',
          engine: 'department-v1',
          title: '生成咖啡视频',
          status: 'queued',
          dependsOn: ['design'],
          summary: '制作视频',
        }
        await reset([ops, design])
        await job(ops)
        assert.equal(await engine().tick(), false)
        assert.match((await read()).tasks[0].executionNote, /等待前置任务完成/)
        design.status = 'blocked'
        await write({ tasks: [ops, design], messages: [], batches: [] })
        assert.equal(await engine().tick(), false)
        assert.match((await read()).tasks[0].executionNote, /前置任务需要处理/)
        design.status = 'completed'
        design.summary = '真实咖啡脚本与三段分镜'
        await write({ tasks: [ops, design], messages: [], batches: [] })
        await Promise.all([engine().tick(), engine().tick()])
        assert.equal(starts, 1)
        assert.match(received.text, /真实咖啡脚本与三段分镜/)
        const saved = (await read()).tasks[0]
        assert.equal(saved.status, 'working')
        assert.equal(saved.receivedInputs[0].taskId, design.id)
        assert.equal(
          (await query("SELECT state FROM task_jobs WHERE task_id='ops'")).rows[0].state,
          'completed',
        )
        assert.equal(await engine().tick(), false)
        assert.ok(reconciles >= 1)
        assert.equal(starts, 1)
      },
    )
    await t.test(
      'an expired claim or unknown submission becomes blocked without a charged retry',
      async () => {
        const ops = {
          id: 'unknown',
          dept: 'app-agent',
          engine: 'department-v1',
          status: 'queued',
          runtimePending: true,
        }
        await reset([ops])
        await job(ops, 'running')
        await query("UPDATE task_jobs SET claim_id=$1,lease_until=now()-interval '1 second'", [
          randomUUID(),
        ])
        assert.equal(await engine().tick(), false)
        let saved = (await read()).tasks[0]
        assert.equal(saved.status, 'blocked')
        assert.equal(saved.runtimePending, true)
        assert.match(saved.executionNote, /结果待核对/)
        assert.equal(await engine().tick(), false)
        assert.equal(starts, 1)
      },
    )
    await t.test(
      'a status outage stays visible and retries only reconciliation of the known runtime',
      async () => {
        const task = {
          id: 'sync',
          dept: 'app-agent',
          status: 'working',
          runtimeTaskId: '0123456789abcdef01234567',
          runtimeSubmissionId: randomUUID(),
        }
        await reset([task])
        let polls = 0,
          offline = true
        const polling = createDepartmentEngine({
          pool,
          env,
          operations: {
            ...operations,
            reconcile: async () => {
              polls++
              if (offline) throw Object.assign(new Error('运营服务连接中断'), { expose: true })
              const board = await read()
              delete board.tasks[0].statusSyncError
              board.tasks[0].executionNote = '运营服务正在执行'
              await write(board)
            },
          },
        })
        assert.equal(await polling.tick(), false)
        let saved = (await read()).tasks[0]
        assert.equal(saved.status, 'working')
        assert.equal(saved.statusSyncError, '运营服务连接中断')
        assert.ok(saved.lastStatusSyncAt)
        assert.match(saved.executionNote, /不会重复提交/)
        offline = false
        assert.equal(await polling.tick(), false)
        saved = (await read()).tasks[0]
        assert.equal(saved.statusSyncError, undefined)
        assert.equal(polls, 2)
        assert.equal(starts, 1)
      },
    )
    await t.test(
      'explicit dispatch enrolls normal and research tasks together, preserving cross-engine dependencies',
      async () => {
        const tasks = plannedTasks(
          [
            { title: 'Design text', dept: 'new-agent-7', brief: '文案' },
            { title: 'Research design', dept: 'review-agent', dependsOn: [0] },
            { title: 'Video', dept: 'app-agent', dependsOn: [0, 1] },
          ],
          { batchId: 'batch', brief: 'fixture' },
        )
        await reset(tasks)
        const board = await read()
        board.tasks.forEach((task) => {
          task.status = 'queued'
        })
        await transaction(pool, (db) => enqueueResearch(db, ctx, board, 'batch'), ctx)
        assert.equal((await query('SELECT count(*)::int n FROM task_jobs')).rows[0].n, 4)
        assert.equal(board.tasks[0].engine, 'department-v1')
        assert.equal(board.tasks[1].engine, 'research-v1')
        assert.equal(board.tasks[2].engine, 'department-v1')
      },
    )
    await t.test(
      'predecessor images use the same owner scoped file access as attachments',
      async () => {
        const id = randomUUID(),
          other = randomUUID(),
          image = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=',
            'base64',
          )
        await query(
          'INSERT INTO workspace_files(id,tenant_id,user_id,name,mime,data) VALUES($1,$2,$3,$4,$5,$6)',
          [id, ctx.tenantId, ctx.userId, 'source.png', 'image/png', image],
        )
        const source = {
          id: 'source',
          title: '真实图片',
          dept: 'new-agent-7',
          status: 'completed',
          summary: '图已完成',
          images: [{ fileId: id }],
        }
        const target = { id: 'target', dependsOn: ['source'], attachmentIds: [id] }
        const board = { tasks: [source, target] }
        const inputs = await resolveTaskInputs({ query }, ctx, board, target)
        assert.equal(inputs.attachments.items.length, 1)
        assert.match(inputs.attachments.parts[0].image_url.url, /^data:image\/png;base64,/)
        await assert.rejects(
          resolveTaskInputs({ query }, { ...ctx, userId: other }, board, target),
          /无权访问/,
        )
      },
    )
  } finally {
    await pg.close()
  }
})
