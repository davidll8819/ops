import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { migrate } from '../database/migrate.mjs'
import { transaction } from '../apps/api/src/db.mjs'
import { defaultPolicy } from '../apps/api/src/operations/policy.mjs'
import { encryptConfig } from '../apps/api/src/operations/security.mjs'
import { createOperationsTasks } from '../apps/api/src/operations/task-service.mjs'
import { createDepartmentEngine } from '../apps/api/src/department-engine.mjs'
import { plannedTasks, enqueueResearch } from '../apps/api/src/research/plan.mjs'

test('design -> operations -> records uses durable handoffs without a browser', async (t) => {
  const pg = new PGlite()
  await pg.waitReady
  const query = async (sql, params) => {
    const result = params ? await pg.query(sql, params) : (await pg.exec(sql)).at(-1)
    return { ...result, rowCount: result?.affectedRows || 0 }
  }
  let tail = Promise.resolve()
  const pool = {
    query,
    connect: async () => {
      const previous = tail
      let release
      tail = new Promise((r) => {
        release = r
      })
      await previous
      return { query, release }
    },
  }
  await migrate(pool)
  const ctx = { tenantId: randomUUID(), userId: randomUUID() }
  const otherUser = randomUUID(),
    otherTenant = randomUUID()
  for (const id of [ctx.userId, otherUser])
    await query('INSERT INTO users(id,subject,email) VALUES($1,$2,$3)', [
      id,
      id,
      `${id}@example.test`,
    ])
  for (const id of [ctx.tenantId, otherTenant])
    await query('INSERT INTO tenants(id,name) VALUES($1,$2)', [id, 'Handoff fixture'])
  for (const [tenant, user] of [
    [ctx.tenantId, ctx.userId],
    [otherTenant, ctx.userId],
    [ctx.tenantId, otherUser],
  ])
    await query("INSERT INTO memberships VALUES($1,$2,'owner')", [tenant, user])
  const key = Buffer.alloc(32, 9),
    env = { NODE_ENV: 'test', OPERATIONS_CONFIG_KEY: key.toString('base64') }
  const policy = defaultPolicy()
  policy.tiers.fast = 'fixture-text'
  policy.tiers.cheap = 'fixture-text'
  policy.tiers.video = 'fixture-video'
  const config = { ...policy, credentials: { ai: 'isolated-fixture-key' } }
  await query(
    'INSERT INTO operations_settings(tenant_id,encrypted_config,updated_by) VALUES($1,$2,$3)',
    [ctx.tenantId, encryptConfig(config, key, ctx.tenantId), ctx.userId],
  )
  const read = async () =>
    (
      await query('SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2', [
        ctx.tenantId,
        ctx.userId,
      ])
    ).rows[0].board
  const save = (board) =>
    query(
      'INSERT INTO secretary_workspaces(tenant_id,user_id,board) VALUES($1,$2,$3) ON CONFLICT(tenant_id,user_id) DO UPDATE SET board=$3',
      [ctx.tenantId, ctx.userId, JSON.stringify(board)],
    )
  let state = 'running',
    missingId = false,
    offline = false,
    pollFailure = false,
    duringPoll
  const submissions = [],
    modelCalls = [],
    uploads = []
  const runtimeId = '0123456789abcdef01234567'
  const driver = {
    ready: async (tenant) => {
      assert.equal(tenant, ctx.tenantId)
      if (offline)
        throw Object.assign(new Error('企业独立运行服务尚未部署'), {
          expose: true,
          statusCode: 503,
        })
      return {
        tenantId: tenant,
        userId: ctx.userId,
        serverUrl: 'https://runtime.example.test',
        aiUrl: 'https://ai.example.test',
      }
    },
    request: async (_entry, service, path, options) => {
      if (service === 'server' && path === '/assets/uploadSign')
        return {
          id: 'asset-fixture',
          url: 'https://media.example.test/reference.png',
          uploadUrl: 'https://upload.example.test/reference.png',
        }
      if (service === 'server' && path === '/assets/asset-fixture/confirm')
        return {
          id: 'asset-fixture',
          status: 'confirmed',
          userId: ctx.userId,
          url: 'https://media.example.test/reference.png',
        }
      assert.equal(service, 'ai')
      if (options?.stream) {
        submissions.push(options.body)
        return new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                missingId
                  ? 'data: {"type":"text","text":"processing"}\n\n'
                  : `data: {"type":"init","taskId":"${runtimeId}"}\n\n`,
              ),
            )
            c.close()
          },
        })
      }
      assert.equal(path, `/agent/tasks/${runtimeId}`)
      if (pollFailure) throw Error('temporary polling outage')
      if (duringPoll) {
        const hook = duringPoll
        duringPoll = undefined
        await hook()
      }
      return {
        status: state,
        messages: [
          { type: 'text', text: '咖啡视频已完成' },
          { type: 'VIDEO', url: 'https://media.example.test/coffee.mp4' },
        ],
      }
    },
  }
  const operations = createOperationsTasks({
    pool,
    env,
    driver,
    uploadFetch: async (url, options) => {
      uploads.push({ url, options })
      return new Response(null, { status: 200 })
    },
  })
  const engine = () =>
    createDepartmentEngine({
      pool,
      env,
      operations,
      fetcher: async (_url, options) => {
        const body = JSON.parse(options.body)
        modelCalls.push(body)
        return Response.json({
          choices: [
            {
              message: {
                content:
                  modelCalls.length === 1
                    ? '交接标记-咖啡分镜：0-2秒杯口冒汽，2-5秒镜头推近。'
                    : '已按部门归档咖啡视频及设计方案。',
              },
            },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 20 },
        })
      },
    })
  const make = () =>
    plannedTasks(
      [
        {
          title: '生成咖啡视频',
          dept: 'app-agent',
          brief: '沿用设计分镜制作5秒视频',
          dependsOn: [1],
        },
        { title: '咖啡创意分镜文字稿', dept: 'new-agent-7', brief: '只需文字脚本与分镜' },
        { title: '保存成片说明', dept: 'file-agent', brief: '归档已完成视频', dependsOn: [0] },
      ],
      { batchId: randomUUID(), brief: '咖啡视频' },
    )
  const dispatch = async (tasks) => {
    const board = { tasks, messages: [], batches: [{ id: tasks[0].batchId, status: 'queued' }] }
    tasks.forEach((task) => {
      task.status = 'queued'
    })
    await transaction(
      pool,
      async (db) => {
        await enqueueResearch(db, ctx, board, tasks[0].batchId)
        await save(board)
      },
      ctx,
    )
  }
  try {
    await t.test('unconfirmed and out-of-scope tasks cannot invoke the runtime', async () => {
      const tasks = make()
      await save({ tasks, messages: [], batches: [] })
      await assert.rejects(operations.start(ctx, { secretaryTaskId: tasks[0].id }), /尚未派发/)
      await assert.rejects(
        operations.start({ ...ctx, userId: otherUser }, { secretaryTaskId: tasks[0].id }),
        /不存在/,
      )
      await assert.rejects(
        operations.start({ ...ctx, tenantId: otherTenant }, { secretaryTaskId: tasks[0].id }),
        /不存在/,
      )
      assert.equal(await engine().tick(), false)
      assert.equal(submissions.length, 0)
    })
    await t.test(
      'reverse array order waits, then delivers actual text once and continues archiving',
      async () => {
        const tasks = make(),
          [video, design, archive] = tasks
        await dispatch(tasks)
        await assert.rejects(operations.start(ctx, { secretaryTaskId: video.id }), /等待前置/)
        assert.equal(submissions.length, 0)
        assert.equal(await engine().tick(), true)
        let board = await read()
        assert.equal(board.tasks.find((t) => t.id === design.id).status, 'completed')
        assert.equal(board.tasks.find((t) => t.id === video.id).status, 'queued')
        assert.equal(submissions.length, 0)
        await Promise.all([engine().tick(), engine().tick()])
        assert.equal(submissions.length, 1)
        assert.ok(Array.isArray(submissions[0].prompt))
        assert.match(submissions[0].prompt[0].text, /交接标记-咖啡分镜/)
        board = await read()
        const active = board.tasks.find((t) => t.id === video.id)
        assert.equal(active.status, 'working')
        assert.equal(active.runtimeTaskId, runtimeId)
        assert.equal(active.receivedInputs[0].taskId, design.id)
        assert.equal(board.tasks.find((t) => t.id === archive.id).status, 'queued')
        await assert.rejects(operations.start(ctx, { secretaryTaskId: video.id }), /正在执行/)
        pollFailure = true
        await engine().tick()
        assert.equal((await read()).tasks.find((t) => t.id === video.id).status, 'working')
        assert.equal(submissions.length, 1)
        pollFailure = false
        state = 'completed'
        await engine().tick()
        board = await read()
        assert.equal(board.tasks.find((t) => t.id === video.id).status, 'completed')
        assert.equal(board.tasks.find((t) => t.id === archive.id).status, 'completed')
        assert.match(JSON.stringify(modelCalls.at(-1).messages), /coffee.mp4/)
        assert.ok(board.tasks.find((t) => t.id === archive.id).archiveFileId)
        await engine().tick()
        assert.equal(submissions.length, 1)
      },
    )
    await t.test(
      'unavailable runtime keeps predecessor output and reports the true blocker',
      async () => {
        await query('DELETE FROM task_jobs')
        const tasks = make()
        tasks.splice(2)
        tasks[1].status = 'completed'
        tasks[1].summary = '仍然保留的设计稿'
        tasks[0].status = 'queued'
        await save({ tasks, messages: [], batches: [] })
        await query(
          "INSERT INTO task_jobs(tenant_id,user_id,task_id,state) VALUES($1,$2,$3,'queued')",
          [ctx.tenantId, ctx.userId, tasks[0].id],
        )
        offline = true
        await engine().tick()
        const board = await read()
        assert.equal(board.tasks[0].status, 'blocked')
        assert.match(board.tasks[0].executionNote, /尚未部署/)
        assert.equal(board.tasks[1].summary, '仍然保留的设计稿')
        assert.equal(submissions.length, 1)
        assert.equal(await engine().tick(), false)
        offline = false
      },
    )
    await t.test(
      'lost runtime id never causes automatic or manual duplicate paid submissions',
      async () => {
        await query('DELETE FROM task_jobs')
        const tasks = make().slice(0, 2)
        tasks[1].status = 'completed'
        tasks[1].summary = '可执行分镜'
        tasks[0].status = 'queued'
        await save({ tasks, messages: [], batches: [] })
        await query(
          "INSERT INTO task_jobs(tenant_id,user_id,task_id,state) VALUES($1,$2,$3,'queued')",
          [ctx.tenantId, ctx.userId, tasks[0].id],
        )
        missingId = true
        await engine().tick()
        const task = (await read()).tasks[0]
        assert.equal(task.status, 'blocked')
        assert.equal(task.runtimePending, true)
        assert.match(task.executionNote, /待核对/)
        assert.equal(submissions.length, 2)
        assert.equal(await engine().tick(), false)
        await assert.rejects(operations.start(ctx, { secretaryTaskId: task.id }), /待核对/)
        assert.equal(submissions.length, 2)
      },
    )
    await t.test(
      'real predecessor image bytes reach the runtime through its asset upload protocol',
      async () => {
        await query('DELETE FROM task_jobs')
        missingId = false
        const tasks = make().slice(0, 2),
          fileId = randomUUID()
        const bytes = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=',
          'base64',
        )
        await query(
          'INSERT INTO workspace_files(id,tenant_id,user_id,name,mime,data) VALUES($1,$2,$3,$4,$5,$6)',
          [fileId, ctx.tenantId, ctx.userId, 'reference.png', 'image/png', bytes],
        )
        tasks[1].status = 'completed'
        tasks[1].summary = '参考图片已生成'
        tasks[1].images = [{ fileId, name: 'reference.png', mime: 'image/png' }]
        tasks[0].status = 'queued'
        await save({ tasks, messages: [], batches: [] })
        const stream = await operations.start(ctx, { secretaryTaskId: tasks[0].id })
        for await (const chunk of stream) assert.ok(chunk.length)
        assert.equal(uploads.length, 1)
        assert.deepEqual(uploads[0].options.body, bytes)
        assert.equal(uploads[0].options.headers.authorization, undefined)
        assert.deepEqual(submissions.at(-1).prompt[1], {
          type: 'image',
          source: { type: 'url', url: 'https://media.example.test/reference.png' },
        })
        assert.ok((await read()).tasks[0].receivedInputs[0].fileIds.includes(fileId))
      },
    )
    await t.test(
      'a delayed status response cannot finish a newer continuation of the same runtime task',
      async () => {
        const original = (await read()).tasks[0]
        state = 'completed'
        duringPoll = async () => {
          const board = await read()
          board.tasks[0].runtimeSubmissionId = 'new-submission'
          board.tasks[0].runtimePending = true
          board.tasks[0].status = 'working'
          await save(board)
        }
        await operations.syncRuntime(ctx, original.runtimeTaskId)
        const current = (await read()).tasks[0]
        assert.equal(current.status, 'working')
        assert.equal(current.runtimeSubmissionId, 'new-submission')
        assert.equal(current.runtimePending, true)
        assert.equal(current.finishedAt, undefined)
      },
    )
  } finally {
    await pg.close()
  }
})
