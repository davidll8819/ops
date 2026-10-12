import { makePool, transaction } from '../apps/api/src/db.mjs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
const tenantId = z.string().uuid().parse(process.argv[2])
if (process.argv[3] !== '--grant-manual')
  throw new Error(
    'Usage: npm run db:enterprise -- TENANT_UUID --grant-manual (operator database credentials required)',
  )
const pool = await makePool()
try {
  await transaction(pool, async (db) => {
    const { rowCount } = await db.query(
      "UPDATE tenants SET plan='enterprise',subscription_status='manual' WHERE id=$1",
      [tenantId],
    )
    if (!rowCount) throw new Error('Tenant not found')
    await db.query(
      "INSERT INTO audit_events(id,tenant_id,action) VALUES($1,$2,'enterprise.manually_granted')",
      [randomUUID(), tenantId],
    )
  })
  console.log('Enterprise entitlement granted and audited; no payment collected')
} finally {
  await pool.end()
}
