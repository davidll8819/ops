import { randomUUID } from 'node:crypto'
import { transaction, fail } from '../db.mjs'
// The product's accounting day is Asia/Shanghai, including calls crossing midnight.
export function budgetDay(now = new Date()) { return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0,10) }
export async function budgetSnapshot(db, tenantId, limit) {
  const row = (await db.query('SELECT used_tokens,reserved_tokens FROM model_daily_usage WHERE tenant_id=$1 AND day=$2', [tenantId,budgetDay()])).rows[0]
  const used = Number(row?.used_tokens || 0), reserved = Number(row?.reserved_tokens || 0)
  return { day: budgetDay(), timezone: 'Asia/Shanghai', limit, used, reserved, available: Math.max(0,limit-used-reserved) }
}
export async function reserveTokens(pool, ctx, { department, model, limit, tokens }) {
  const id = randomUUID(), day = budgetDay()
  return transaction(pool, async db => {
    await db.query('INSERT INTO model_daily_usage(tenant_id,day) VALUES($1,$2) ON CONFLICT DO NOTHING', [ctx.tenantId,day])
    const result = await db.query('UPDATE model_daily_usage SET reserved_tokens=reserved_tokens+$3 WHERE tenant_id=$1 AND day=$2 AND used_tokens+reserved_tokens+$3 <= $4 RETURNING day', [ctx.tenantId,day,tokens,limit])
    if (!result.rows.length) throw fail(429, '今日模型额度不足，请等待次日或调整企业限额')
    await db.query('INSERT INTO model_requests(id,tenant_id,user_id,day,department,model,reserved_tokens) VALUES($1,$2,$3,$4,$5,$6,$7)', [id,ctx.tenantId,ctx.userId || null,day,department,model,tokens])
    return id
  }, ctx)
}
export async function settleTokens(pool, ctx, id, state, usage) {
  return transaction(pool, async db => {
    const row = (await db.query("SELECT * FROM model_requests WHERE id=$1 AND tenant_id=$2 AND state='pending' FOR UPDATE", [id,ctx.tenantId])).rows[0]
    if (!row) return
    if (state === 'completed' && (!usage || !Number.isSafeInteger(usage.input) || !Number.isSafeInteger(usage.output) || usage.input < 0 || usage.output < 0)) state = 'unknown'
    if (state !== 'unknown') {
      await db.query('UPDATE model_daily_usage SET reserved_tokens=reserved_tokens-$3,used_tokens=used_tokens+$4 WHERE tenant_id=$1 AND day=$2', [ctx.tenantId,row.day,Number(row.reserved_tokens),state === 'completed' ? usage.input+usage.output : 0])
    }
    await db.query('UPDATE model_requests SET state=$3,input_tokens=$4,output_tokens=$5,finished_at=now() WHERE id=$1 AND tenant_id=$2', [id,ctx.tenantId,state,state === 'completed' ? usage.input : null,state === 'completed' ? usage.output : null])
  }, ctx)
}
