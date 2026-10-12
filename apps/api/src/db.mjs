import pg from 'pg'
import { readFile } from 'node:fs/promises'
export async function makePool(env = process.env) {
  const ssl = env.PGSSLROOTCERT
    ? { ca: await readFile(env.PGSSLROOTCERT, 'utf8'), rejectUnauthorized: true }
    : undefined
  return new pg.Pool({
    connectionString: env.DATABASE_URL,
    host: env.PGHOST,
    port: Number(env.PGPORT || 5432),
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    ssl,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  })
}
export async function transaction(pool, fn, context) {
  const db = await pool.connect()
  try {
    await db.query('BEGIN')
    if (context)
      await db.query(
        "SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
        [context.tenantId, context.userId],
      )
    const result = await fn(db)
    await db.query('COMMIT')
    return result
  } catch (e) {
    await db.query('ROLLBACK')
    throw e
  } finally {
    db.release()
  }
}
export function fail(statusCode, message) {
  return Object.assign(new Error(message), { statusCode, expose: true })
}
export async function tenantAccess(db, userId, tenantId, roles = ['owner', 'admin', 'member']) {
  const {
    rows: [row],
  } = await db.query(
    'SELECT t.*,m.role FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE t.id=$1 AND m.user_id=$2',
    [tenantId, userId],
  )
  if (!row || !roles.includes(row.role)) throw fail(403, '你没有此企业的访问权限')
  return row
}
