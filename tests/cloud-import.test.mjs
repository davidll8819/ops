import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { migrate } from '../database/migrate.mjs'
import { dumpStatements, validateDump, importCloudData } from '../scripts/lib/cloud-import.mjs'

const owner = '10000000-0000-4000-8000-000000000001'
const other = '10000000-0000-4000-8000-000000000002'
const tenant = '20000000-0000-4000-8000-000000000001'
const cognitoSub = '30000000-0000-4000-8000-000000000001'
const file = '40000000-0000-4000-8000-000000000001'
const text = (value) => `'${value.replaceAll("'", "''")}'`
const prompt = "原始任务; 引号'与多行\n\\restrict ThisIsUserText\n不能改写这些内容"
const dump = `-- PostgreSQL database dump\n\\restrict Abc123\n
SET statement_timeout = 0;
SET standard_conforming_strings = on;
SET row_security = off;
SELECT pg_catalog.set_config('search_path', '', false);
INSERT INTO public.users (id, subject, email) VALUES ('${owner}', 'local:owner@local.test', 'owner@local.test');
INSERT INTO public.users (id, subject, email) VALUES ('${other}', 'local:member@local.test', 'member@local.test');
INSERT INTO public.tenants (id, name, plan) VALUES ('${tenant}', 'Existing enterprise', 'enterprise');
INSERT INTO public.memberships (tenant_id, user_id, role) VALUES ('${tenant}', '${owner}', 'owner');
INSERT INTO public.memberships (tenant_id, user_id, role) VALUES ('${tenant}', '${other}', 'member');
INSERT INTO public.workspace_files (id, tenant_id, user_id, name, mime, data) VALUES ('${file}', '${tenant}', '${owner}', '原始资料.txt', 'text/plain', '\\x00017f80ff');
INSERT INTO public.secretary_workspaces (tenant_id, user_id, board) VALUES ('${tenant}', '${owner}', ${text(JSON.stringify({ messages: [{ text: prompt }], tasks: [], batches: [] }))});
INSERT INTO public.office_events (seq, tenant_id, action) OVERRIDING SYSTEM VALUE VALUES (42, '${tenant}', '{"type":"set_state"}');
SELECT pg_catalog.setval('public.office_events_seq_seq', 42, true);
-- PostgreSQL database dump complete\n\\unrestrict Abc123\n`

const options = (sql = dump, extra = {}) => ({
  sha256: createHash('sha256').update(sql).digest('hex'),
  adminUserId: owner,
  cognitoSub,
  adminEmail: 'real-owner@example.com',
  ...extra,
})
async function database() {
  const pg = new PGlite()
  await pg.waitReady
  const query = async (sql, params) => {
    const result = params ? await pg.query(sql, params) : (await pg.exec(sql)).at(-1)
    return { ...result, rowCount: result?.affectedRows || 0 }
  }
  const pool = { query, connect: async () => ({ query, release() {} }) }
  await migrate(pool)
  return { pg, pool }
}
const rls = async (pool) => (await pool.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname")).rows

test('data dump parser preserves multiline values and rejects executable dump commands', () => {
  const statements = dumpStatements(dump)
  assert.equal(statements.filter((item) => item.startsWith('INSERT')).length, 8)
  assert.ok(statements.some((item) => item.includes('ThisIsUserText')))
  const tables = new Map([['users', new Set(['id'])], ['tenants', new Set(['id'])], ['memberships', new Set(['id'])]])
  for (const invalid of [
    'COMMIT;',
    'CREATE TABLE public.bad(id int);',
    "SELECT pg_catalog.set_config('role', 'postgres', false);",
    "INSERT INTO public.users (id) VALUES (pg_sleep(1));",
    "INSERT INTO public.users (id) VALUES ('safe'); DELETE FROM public.users;",
    'COPY public.users FROM stdin;\n\\.',
    '\\connect another_database\n',
  ]) assert.throws(() => validateDump(invalid, tables, new Set()))
})

test('cloud import preserves IDs, binary files, text and sequence values while mapping only an explicit owner', async () => {
  const { pg, pool } = await database()
  try {
    const flags = await rls(pool)
    const result = await importCloudData(pool, Buffer.from(dump), options())
    assert.equal(result.importedRows, 8)
    assert.equal(result.lockedLocalUsers, 1)
    assert.deepEqual(await rls(pool), flags)
    const users = (await pool.query('SELECT id,subject,email FROM users ORDER BY id')).rows
    assert.deepEqual(users, [
      { id: owner, subject: cognitoSub, email: 'real-owner@example.com' },
      { id: other, subject: `disabled-local:${other}`, email: 'member@local.test' },
    ])
    assert.equal((await pool.query('SELECT user_id FROM workspace_files')).rows[0].user_id, owner)
    assert.equal(Buffer.from((await pool.query('SELECT data FROM workspace_files')).rows[0].data).toString('hex'), '00017f80ff')
    assert.equal((await pool.query('SELECT board FROM secretary_workspaces')).rows[0].board.messages[0].text, prompt)
    assert.equal(Number((await pool.query("SELECT nextval('public.office_events_seq_seq') AS n")).rows[0].n), 43)
    await pool.query('CREATE ROLE import_reader; GRANT USAGE ON SCHEMA public TO import_reader; GRANT SELECT ON workspace_files TO import_reader; SET ROLE import_reader')
    assert.equal((await pool.query('SELECT id FROM workspace_files')).rows.length, 0)
    await pool.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.user_id',$2,false)", [tenant, owner])
    assert.equal((await pool.query('SELECT id FROM workspace_files')).rows.length, 1)
    await pool.query('RESET ROLE')
  } finally { await pg.close() }
})

test('cloud import refuses an occupied target and never overwrites or weakens RLS', async () => {
  const { pg, pool } = await database()
  try {
    await pool.query('INSERT INTO users(id,subject,email) VALUES($1,$2,$3)', [owner, 'existing', 'existing@example.com'])
    const flags = await rls(pool)
    await assert.rejects(importCloudData(pool, Buffer.from(dump), options()), /must be empty/)
    assert.equal((await pool.query('SELECT subject FROM users')).rows[0].subject, 'existing')
    assert.deepEqual(await rls(pool), flags)
  } finally { await pg.close() }
})

test('checksum failures and identity mapping conflicts leave no imported records', async () => {
  const { pg, pool } = await database()
  try {
    const flags = await rls(pool)
    await assert.rejects(importCloudData(pool, Buffer.from(dump + '\n'), options()), /checksum/)
    await assert.rejects(importCloudData(pool, Buffer.from(dump), options(dump, { adminEmail: 'member@local.test' })), /duplicate key/)
    assert.equal((await pool.query('SELECT count(*) AS n FROM users')).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*) AS n FROM workspace_files')).rows[0].n, 0)
    assert.deepEqual(await rls(pool), flags)
  } finally { await pg.close() }
})

test('a wrong explicit administrator mapping rolls back data and preserves all original RLS flags', async () => {
  const { pg, pool } = await database()
  try {
    const flags = await rls(pool)
    await assert.rejects(importCloudData(pool, Buffer.from(dump), options(dump, { adminUserId: other })), /must own a local workspace/)
    assert.equal((await pool.query('SELECT count(*) AS n FROM users')).rows[0].n, 0)
    assert.deepEqual(await rls(pool), flags)
  } finally { await pg.close() }
})

test('a late security restoration failure also rolls back imported rows and identity sequence changes', async () => {
  const { pg, pool } = await database()
  try {
    const flags = await rls(pool)
    const guardedPool = {
      connect: async () => ({
        release() {},
        query: (sql, params) => {
          if (/^ALTER TABLE public\."[^"]+" FORCE ROW LEVEL SECURITY$/.test(sql)) throw new Error('Injected restoration failure')
          return pool.query(sql, params)
        },
      }),
    }
    await assert.rejects(importCloudData(guardedPool, Buffer.from(dump), options()), /Injected restoration failure/)
    assert.equal((await pool.query('SELECT count(*) AS n FROM users')).rows[0].n, 0)
    assert.equal(Number((await pool.query("SELECT nextval('public.office_events_seq_seq') AS n")).rows[0].n), 1)
    assert.deepEqual(await rls(pool), flags)
  } finally { await pg.close() }
})
