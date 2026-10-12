import { attachmentContext, withAttachments } from './task-assets.mjs'
import { parseSecretaryReply } from './secretary-reply.mjs'
import { plannedTasks, enqueueResearch } from './research/plan.mjs'
import { assignedInstructions } from './workspace-services.mjs'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { emptyBoard, applyAction, departments } from '../../../packages/secretary/model.mjs'
import { fail } from './db.mjs'
import { createModelGateway, loadPolicy } from './operations/gateway.mjs'
import { preferencesSchema, defaultPreferences, secretaryPrompt } from './secretary-preferences.mjs'
const key = z.string().min(1).max(80)
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v)
const actionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('send'),
      text: z.string().trim().min(1).max(4000),
      intent: z.enum(['plan', 'remind', 'report', 'meeting']),
      language: z.enum(['zh', 'en']),
    })
    .strict(),
  z
    .object({
      type: z.literal('edit'),
      batchId: key,
      tasks: z
        .array(
          z
            .object({
              id: key,
              title: z.string().trim().min(1).max(120),
              dept: z.enum(departments.map((d) => d.id)),
              due: day,
            })
            .strict(),
        )
        .min(1)
        .max(10),
    })
    .strict(),
  z.object({ type: z.literal('dispatch'), batchId: key }).strict(),
  z
    .object({
      type: z.enum(['approve', 'reject']),
      taskId: key,
      feedback: z.string().trim().max(1000).optional(),
    })
    .strict(),
])
export function registerSecretary(app, scoped, { pool, env, fetcher }) {
  const call = createModelGateway({ pool, env, fetcher })
  const path = '/api/tenants/:tenantId/secretary'
  app.get(path, (req) =>
    scoped(req, async (db, tenant, ctx) => {
      const { rows } = await db.query(
        'SELECT revision,board,preferences FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2',
        [ctx.tenantId, ctx.userId],
      )
      return rows[0]
        ? { ...rows[0], preferences: preferencesSchema.parse(rows[0].preferences) }
        : { revision: 0, board: emptyBoard(), preferences: defaultPreferences() }
    }),
  )
  app.put(`${path}/preferences`, (req) =>
    scoped(req, async (db, tenant, ctx) => {
      const preferences = preferencesSchema.parse(req.body)
      await db.query(
        'INSERT INTO secretary_workspaces(tenant_id,user_id,preferences) VALUES($1,$2,$3) ON CONFLICT(tenant_id,user_id) DO UPDATE SET preferences=$3,updated_at=now()',
        [ctx.tenantId, ctx.userId, JSON.stringify(preferences)],
      )
      return { preferences }
    }),
  )
  app.post(`${path}/chat`, async (req) => {
    const input = z
      .object({
        revision: z.number().int().nonnegative(),
        requireTasks: z.boolean().default(false),
        attachmentIds: z.array(z.uuid()).max(4).default([]),
        lastUserMessageId: z.string().max(80).optional(),
        text: z.string().trim().min(1).max(4000),
        language: z.enum(['zh', 'en']),
        intent: z.enum(['plan', 'remind', 'report', 'meeting']),
      })
      .strict()
      .parse(req.body)
    const snapshot = await scoped(
      req,
      async (db, tenant, ctx) => {
        const { policy } = await loadPolicy(db, ctx.tenantId, env)
        const row = (
          await db.query(
            'SELECT revision,board,preferences FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2',
            [ctx.tenantId, ctx.userId],
          )
        ).rows[0] || { revision: 0, board: emptyBoard(), preferences: {} }
        if (
          row.revision !== input.revision &&
          input.lastUserMessageId !==
            (row.board.messages.findLast((m) => m.role === 'user')?.id || '')
        )
          throw fail(409, '对话已在其他页面更新，请刷新后重试')
        return {
          ctx,
          policy,
          ...row,
          instructions: await assignedInstructions(db, ctx.tenantId, 'secretary'),
          attachments: await attachmentContext(
            db,
            ctx,
            input.attachmentIds.length
              ? input.attachmentIds
              : (input.intent === 'plan' && !row.board.messages.at(-1)?.batchId ? (row.board.messages.filter((m) => m.role === 'user').at(-1)?.attachments || []) : []).map(
                  (a) => a.id,
                ),
          ),
          preferences: preferencesSchema.parse(row.preferences),
        }
      },
      ['owner', 'admin'],
    )
    const { ctx, policy, board, preferences } = snapshot
    const response = await call({
      ctx,
      policy,
      department: 'secretary',
      path: '/api/v1/chat/completions',
      body: {
        messages: [
          {
            role: 'system',
            content:
              secretaryPrompt(preferences, input.language, board, input.intent) +
              snapshot.instructions +
              (input.requireTasks
                ? '\n本次操作是生成任务分工：必须返回上述 JSON，tasks 至少一项，brief 包含此前已确认的完整要求；不可只声称已经安排。'
                : ''),
          },
          ...board.messages.slice(-20).map((m) => ({ role: m.role, content: m.text })),
          { role: 'user', content: withAttachments(input.text, snapshot.attachments) },
        ],
        max_tokens: 4096,
      },
    })
    const rawText = response.choices?.[0]?.message?.content
    let text, tasks
    try {
      const parsed = parseSecretaryReply(rawText, {
        finishReason: response.choices?.[0]?.finish_reason,
      })
      text = parsed.reply
      tasks = parsed.tasks
      if (input.requireTasks && !tasks.length)
        throw fail(502, '没有生成可派发的任务分工，请补充必要信息后重试')
    } catch (error) {
      // Keep the instruction and failure visible; do not lose a paid response silently.
      await scoped(
        req,
        async (db) => {
          await db.query(
            'INSERT INTO secretary_workspaces(tenant_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [ctx.tenantId, ctx.userId],
          )
          const current = (
            await db.query(
              'SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',
              [ctx.tenantId, ctx.userId],
            )
          ).rows[0]
          const time = new Date().toISOString()
          const reason = error.expose ? error.message : '秘书任务清单暂时无法读取'
          current.board.lastReplyError = { time, message: reason, requestText: input.text }
          current.board.messages.push(
            {
              id: randomUUID(),
              role: 'user',
              text: input.text,
              time,
              attachments: snapshot.attachments.refs,
            },
            {
              id: randomUUID(),
              role: 'assistant',
              text: `任务尚未创建：${reason}。你的要求已保存，可以重新整理任务。`,
              textEn:
                'The task was not created because its reply could not be read. Your instructions are saved; you can regenerate the task plan.',
              time,
            },
          )
          const pending = new Set(
            current.board.batches.filter((b) => b.status === 'draft').map((b) => b.id),
          )
          current.board.messages = current.board.messages.filter(
            (m, i) => i >= current.board.messages.length - 200 || pending.has(m.batchId),
          )
          await db.query(
            'UPDATE secretary_workspaces SET board=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',
            [ctx.tenantId, ctx.userId, JSON.stringify(current.board)],
          )
        },
        ['owner', 'admin'],
      )
      throw error
    }
    if (!tasks.length && /(?:已经?|已)(?:经)?(?:安排|派发|提交|下发|开工)|草稿已经提交/.test(text))
      text +=
        input.language === 'en'
          ? '\n\nSystem record: this reply did not create or dispatch any task. Refer to the task cards for actual execution.'
          : '\n\n系统记录：这条回复没有创建或派发任务。实际执行情况以任务卡片为准。'
    // Task progress can change during the model call. Only a concurrent user message invalidates its context.
    return scoped(
      req,
      async (db) => {
        await db.query(
          'INSERT INTO secretary_workspaces(tenant_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [ctx.tenantId, ctx.userId],
        )
        const current = (
          await db.query(
            'SELECT revision,board,preferences FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',
            [ctx.tenantId, ctx.userId],
          )
        ).rows[0]
        if (
          current.board.messages.findLast((m) => m.role === 'user')?.id !==
          board.messages.findLast((m) => m.role === 'user')?.id
        )
          throw fail(409, '对话已在其他页面更新，请刷新后重试')
        if (tasks.length) delete current.board.lastReplyError
        if (
          tasks.length &&
          (current.board.tasks.length + tasks.length > 500 ||
            current.board.tasks.filter((t) => t.status === 'draft').length + tasks.length > 40)
        )
          throw fail(409, '请先处理已有任务草稿')
        const batchId = tasks.length ? randomUUID() : undefined
        if (batchId) {
          current.board.batches.push({ id: batchId, status: 'draft' })
          current.board.tasks.push(
            ...plannedTasks(tasks, {
              batchId,
              language: input.language,
              brief: [
                ...board.messages.slice(-6).map((m) => `${m.role}: ${m.text}`),
                `user: ${input.text}`,
              ]
                .join('\n')
                .slice(-12000),
            }).map((task) => ({
              ...task,
              attachmentIds: snapshot.attachments.refs.map((a) => a.id),
            })),
          )
        }
        if (
          current.board.tasks.length > 500 ||
          current.board.tasks.filter((t) => t.status === 'draft').length > 40
        )
          throw fail(409, '请先处理已有任务草稿')
        const time = new Date().toISOString()
        current.board.messages.push(
          {
            id: randomUUID(),
            role: 'user',
            text: input.text,
            time,
            attachments: snapshot.attachments.refs,
          },
          { id: randomUUID(), role: 'assistant', text, time, batchId },
        )
        const pending = new Set(
          current.board.batches.filter((b) => b.status === 'draft').map((b) => b.id),
        )
        current.board.messages = current.board.messages.filter(
          (m, i) => i >= current.board.messages.length - 200 || pending.has(m.batchId),
        )
        await db.query(
          'UPDATE secretary_workspaces SET board=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',
          [ctx.tenantId, ctx.userId, JSON.stringify(current.board)],
        )
        return {
          revision: current.revision + 1,
          board: current.board,
          preferences: preferencesSchema.parse(current.preferences),
        }
      },
      ['owner', 'admin'],
    )
  })
  app.post(path, (req) =>
    scoped(
      req,
      async (db, tenant, ctx) => {
        const { revision, action, today } = z
          .object({ revision: z.number().int().nonnegative(), action: actionSchema, today: day })
          .strict()
          .parse(req.body)
        await db.query(
          'INSERT INTO secretary_workspaces(tenant_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [ctx.tenantId, ctx.userId],
        )
        const {
          rows: [current],
        } = await db.query(
          'SELECT revision,board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',
          [ctx.tenantId, ctx.userId],
        )
        if (current.revision !== revision) throw fail(409, '任务已在其他页面更新，请刷新任务后重试')
        if (
          current.board.tasks.length >= 500 &&
          action.type === 'send' &&
          ['plan', 'meeting'].includes(action.intent)
        )
          throw fail(409, '任务库已满，请联系管理员归档')
        const board = applyAction(current.board, action, {
          id: randomUUID,
          today,
          time: new Date().toISOString(),
        })
        if (action.type === 'dispatch') await enqueueResearch(db, ctx, board, action.batchId)
        await db.query(
          'UPDATE secretary_workspaces SET board=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',
          [ctx.tenantId, ctx.userId, JSON.stringify(board)],
        )
        await db.query(
          'INSERT INTO audit_events(id,tenant_id,user_id,action) VALUES($1,$2,$3,$4)',
          [randomUUID(), ctx.tenantId, ctx.userId, `secretary.${action.type}`],
        )
        return { revision: revision + 1, board }
      },
      ['owner', 'admin'],
    ),
  )
}
