import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makePool, transaction } from '../apps/api/src/db.mjs'
export async function migrate(pool) {
  await transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(51011001)')
    await db.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())',
    )
    for (const name of (await readdir(new URL('./migrations/', import.meta.url)))
      .filter((n) => n.endsWith('.sql'))
      .sort()) {
      if ((await db.query('SELECT name FROM schema_migrations WHERE name=$1', [name])).rows.length)
        continue
      await db.query(await readFile(new URL(`./migrations/${name}`, import.meta.url), 'utf8'))
      await db.query('INSERT INTO schema_migrations(name) VALUES($1)', [name])
    }
  })
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const pool = await makePool()
  try {
    await migrate(pool)
    console.log('Migrations completed')
  } finally {
    await pool.end()
  }
}
