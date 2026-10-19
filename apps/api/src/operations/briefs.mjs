import { randomUUID } from 'node:crypto'
import { fail } from '../db.mjs'
export const briefView = (r) => ({
  id: r.id,
  title: r.title,
  text: r.text,
  messages: r.messages,
  sourceMessageId: r.source_message_id,
  sourceRevision: r.source_revision,
  createdAt: r.created_at,
})
export async function readBrief(db, ctx, id) {
  const row = (
    await db.query('SELECT * FROM operations_briefs WHERE id=$1 AND tenant_id=$2 AND user_id=$3', [
      id,
      ctx.tenantId,
      ctx.userId,
    ])
  ).rows[0]
  if (!row) throw fail(404, '交接方案不存在')
  return briefView(row)
}
export async function saveBrief(db, ctx, { messageId, revision }) {
  // Lock the conversation so the saved provenance and revision cannot diverge.
  const current = (
    await db.query(
      "SELECT messages,revision FROM department_conversations WHERE tenant_id=$1 AND user_id=$2 AND department='content_ops' FOR UPDATE",
      [ctx.tenantId, ctx.userId],
    )
  ).rows[0]
  if (!current || current.revision !== revision) throw fail(409, '对话已更新，请刷新对话后交接')
  const index = current.messages.findIndex((m) => m.id === messageId && m.role === 'assistant')
  if (index < 0) throw fail(404, '回复不存在')
  const existing = (
    await db.query(
      'SELECT * FROM operations_briefs WHERE tenant_id=$1 AND user_id=$2 AND source_message_id=$3',
      [ctx.tenantId, ctx.userId, messageId],
    )
  ).rows[0]
  if (existing) return briefView(existing)
  const messages = current.messages
    .slice(Math.max(0, index - 21), index + 1)
    .map(({ id, role, text }) => ({ id, role, text }))
  const text = messages
    .map((m) => `${m.role === 'user' ? '工作要求' : '叶凡方案'}：\n${m.text}`)
    .join('\n\n')
  if (text.length > 200000) throw fail(409, '交接内容过长，请拆分工作要求；原文没有被截断')
  const title = (messages.findLast((m) => m.role === 'user')?.text || '叶凡工作方案').slice(0, 80)
  const row = (
    await db.query(
      'INSERT INTO operations_briefs(id,tenant_id,user_id,source_message_id,source_revision,title,text,messages) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [
        randomUUID(),
        ctx.tenantId,
        ctx.userId,
        messageId,
        revision,
        title,
        text,
        JSON.stringify(messages),
      ],
    )
  ).rows[0]
  return briefView(row)
}
