import { makePool } from '../apps/api/src/db.mjs'
import { migrate } from './migrate.mjs'
const pool = await makePool()
try {
  await migrate(pool)
  const password = process.env.APP_DB_PASSWORD
  if (!password || !/^[a-zA-Z0-9]{32,}$/.test(password))
    throw new Error('APP_DB_PASSWORD must be a generated alphanumeric secret')
  const exists = (await pool.query("SELECT 1 FROM pg_roles WHERE rolname='office_app'")).rows.length
  // Fixed role name and strictly validated literal; never concatenate untrusted SQL.
  await pool.query(
    `${exists ? 'ALTER' : 'CREATE'} ROLE office_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
  )
  await pool.query('GRANT CONNECT ON DATABASE office TO office_app')
  await pool.query('GRANT USAGE ON SCHEMA public TO office_app')
  await pool.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO office_app')
  await pool.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO office_app')
  await pool.query('REVOKE ALL ON schema_migrations FROM office_app')
  console.log('Database initialized; application role cannot bypass row-level security')
} finally {
  await pool.end()
}
