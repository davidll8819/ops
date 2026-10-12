import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { transaction, fail } from './db.mjs'
export async function deliverReminders(pool, now = new Date()) {
  const memberships = (
    await pool.query("SELECT tenant_id,user_id FROM memberships WHERE role IN ('owner','admin')")
  ).rows
  for (const member of memberships)
    await transaction(
      pool,
      async (db) => {
        const ctx = { tenantId: member.tenant_id, userId: member.user_id }
        if (
          !(
            await db.query(
              "SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND role IN ('owner','admin')",
              [ctx.tenantId, ctx.userId],
            )
          ).rows.length
        )
          return
        const rows = (
          await db.query(
            'SELECT * FROM secretary_reminders WHERE tenant_id=$1 AND user_id=$2 AND active=true AND next_at<=$3 FOR UPDATE SKIP LOCKED',
            [ctx.tenantId, ctx.userId, now],
          )
        ).rows
        if (!rows.length) return
        await db.query(
          'INSERT INTO secretary_workspaces(tenant_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [ctx.tenantId, ctx.userId],
        )
        const { board } = (
          await db.query(
            'SELECT board FROM secretary_workspaces WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',
            [ctx.tenantId, ctx.userId],
          )
        ).rows[0]
        for (const row of rows) {
          board.messages.push({
            id: randomUUID(),
            role: 'assistant',
            text: `定时提醒：${row.title}`,
            textEn: `Scheduled reminder: ${row.title}`,
            time: now.toISOString(),
          })
          let next = new Date(row.next_at)
          while (next <= now) next = new Date(next.getTime() + 86400000)
          await db.query(
            'UPDATE secretary_reminders SET last_at=$3,next_at=$4,active=repeat_daily WHERE id=$1 AND tenant_id=$2',
            [row.id, ctx.tenantId, now, next],
          )
        }
        const pending = new Set(board.batches.filter((b) => b.status === 'draft').map((b) => b.id))
        board.messages = board.messages.filter(
          (m, i) => i >= board.messages.length - 200 || pending.has(m.batchId),
        )
        await db.query(
          'UPDATE secretary_workspaces SET board=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND user_id=$2',
          [ctx.tenantId, ctx.userId, JSON.stringify(board)],
        )
      },
      { tenantId: member.tenant_id, userId: member.user_id },
    )
}
export function registerReminders(app, { scoped, pool, env }) {
  const root = '/api/tenants/:tenantId/secretary/reminders'
  app.get(root, (req) =>
    scoped(req, async (db, t, c) => ({
      items: (
        await db.query(
          'SELECT id,title,next_at,repeat_daily,active,last_at FROM secretary_reminders WHERE tenant_id=$1 AND user_id=$2 ORDER BY next_at',
          [c.tenantId, c.userId],
        )
      ).rows,
    })),
  )
  app.post(root, (req) =>
    scoped(
      req,
      async (db, t, c) => {
        const v = z
          .object({
            title: z.string().trim().min(1).max(500),
            nextAt: z.iso.datetime({ offset: true }),
            repeatDaily: z.boolean(),
          })
          .strict()
          .parse(req.body)
        if (
          Date.parse(v.nextAt) <= Date.now() ||
          Date.parse(v.nextAt) > Date.now() + 366 * 86400000
        )
          throw fail(400, '请选择未来一年内的提醒时间')
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [c.userId])
        const count = (
          await db.query(
            'SELECT count(*)::int n FROM secretary_reminders WHERE tenant_id=$1 AND user_id=$2 AND active=true',
            [c.tenantId, c.userId],
          )
        ).rows[0].n
        if (count >= 50) throw fail(409, '最多保留 50 项有效提醒')
        const id = randomUUID()
        await db.query(
          'INSERT INTO secretary_reminders(id,tenant_id,user_id,title,next_at,repeat_daily) VALUES($1,$2,$3,$4,$5,$6)',
          [id, c.tenantId, c.userId, v.title, v.nextAt, v.repeatDaily],
        )
        return { id }
      },
      ['owner', 'admin'],
    ),
  )
  app.post(`${root}/:id/cancel`, (req) =>
    scoped(
      req,
      async (db, t, c) => {
        await db.query(
          'UPDATE secretary_reminders SET active=false WHERE id=$1 AND tenant_id=$2 AND user_id=$3',
          [z.uuid().parse(req.params.id), c.tenantId, c.userId],
        )
        return { saved: true }
      },
      ['owner', 'admin'],
    ),
  )
  // This app's own persisted in-app reminders, not an external messaging service.
  let timer,
    running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await deliverReminders(pool)
    } catch {
      app.log.warn('Reminder delivery deferred')
    } finally {
      running = false
    }
  }
  if (env.NODE_ENV !== 'test') {
    app.addHook('onReady', async () => {
      timer = setInterval(() => void tick(), 30000)
      timer.unref()
      void tick()
    })
    app.addHook('onClose', async () => clearInterval(timer))
  }
}
