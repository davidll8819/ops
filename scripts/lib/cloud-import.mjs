import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { transaction } from '../../apps/api/src/db.mjs'

export class CloudImportError extends Error {}

const identifier = /^[a-z_][a-z0-9_]*$/
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const quoted = (name) => {
  if (!identifier.test(name)) throw new CloudImportError('Unsupported database identifier')
  return `public."${name}"`
}
const discardPrefix = (text) => {
  let rest = text
  for (;;) {
    const next = rest.replace(/^\s+/, '').replace(/^--[^\n]*(?:\n|$)/, '')
      .replace(/^\\(?:un)?restrict [A-Za-z0-9]+\s*(?:\n|$)/, '')
    if (next === rest) return rest
    rest = next
  }
}

// pg_dump's column INSERT format has no executable expressions in its values.
// Parse quotes before splitting so multiline prompts and literal semicolons survive.
export function dumpStatements(sql) {
  const statements = []
  let start = 0, quote = '', escape = false, comment = false
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (comment) { if (c === '\n') comment = false; continue }
    if (quote) {
      if (escape && c === '\\') { i++; continue }
      if (c === quote) {
        if (sql[i + 1] === quote) i++
        else quote = ''
      }
      continue
    }
    if (c === '-' && sql[i + 1] === '-') { comment = true; i++; continue }
    if (c === "'" || c === '"') {
      quote = c
      escape = c === "'" && /(?:^|[^a-z0-9_])[eE]$/.test(sql.slice(Math.max(0, i - 2), i))
      continue
    }
    if (c === '\\') {
      const end = sql.indexOf('\n', i)
      const line = sql.slice(i, end === -1 ? sql.length : end)
      if (discardPrefix(sql.slice(start, i)) || !/^\\(?:un)?restrict [A-Za-z0-9]+\s*$/.test(line))
        throw new CloudImportError('Unsupported psql command in data dump')
      i = end === -1 ? sql.length : end
      continue
    }
    if (c === ';') {
      const statement = discardPrefix(sql.slice(start, i + 1)).trim()
      if (statement) statements.push(statement)
      start = i + 1
    }
  }
  if (quote || discardPrefix(sql.slice(start)).trim()) throw new CloudImportError('Incomplete data dump statement')
  return statements
}

function literalValues(text) {
  let i = 0, values = 0
  const whitespace = () => { while (/\s/.test(text[i] || '') && i < text.length) i++ }
  for (;;) {
    whitespace()
    const escaped = /^[eE]'/.test(text.slice(i, i + 2))
    if (escaped) i++
    if (text[i] === "'") {
      i++
      let closed = false
      while (i < text.length) {
        const c = text[i++]
        if (escaped && c === '\\') { i++; continue }
        if (c === "'") {
          if (text[i] === "'") i++
          else { closed = true; break }
        }
      }
      if (!closed) throw new CloudImportError('Incomplete literal in data dump')
    } else {
      const token = text.slice(i).match(/^(?:NULL|true|false|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?=\s|,|$)/)
      if (!token) throw new CloudImportError('Only literal INSERT values are allowed in data dumps')
      i += token[0].length
    }
    values++
    whitespace()
    if (i === text.length) return values
    if (text[i++] !== ',') throw new CloudImportError('Unsupported expression in data dump')
  }
}

export function validateDump(sql, tables, sequences) {
  const rows = [], sequenceRestarts = [], counts = Object.fromEntries([...tables.keys()].map((name) => [name, 0]))
  for (const statement of dumpStatements(sql)) {
    // These are dump session preferences, never execute them in the import transaction.
    if (/^SET (?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout|transaction_timeout) = 0;$/.test(statement)
      || /^SET (?:client_encoding = 'UTF8'|standard_conforming_strings = on|check_function_bodies = false|xmloption = content|client_min_messages = warning|row_security = off);$/.test(statement)
      || statement === "SELECT pg_catalog.set_config('search_path', '', false);") continue
    const sequence = statement.match(/^SELECT pg_catalog\.setval\('public\.([a-z_][a-z0-9_]*)', (\d+), (true|false)\);$/)
    if (sequence) {
      if (!sequences.has(sequence[1])) throw new CloudImportError('Unknown sequence in data dump')
      const next = BigInt(sequence[2]) + (sequence[3] === 'true' ? 1n : 0n)
      if (next < 1n || next > 9223372036854775807n) throw new CloudImportError('Invalid sequence value')
      if (sequenceRestarts.some((item) => item.name === sequence[1])) throw new CloudImportError('Duplicate sequence value')
      sequenceRestarts.push({ name: sequence[1], next: String(next) })
      continue
    }
    const insert = statement.match(/^INSERT INTO public\.([a-z_][a-z0-9_]*) \(([^)]+)\) (?:OVERRIDING SYSTEM VALUE )?VALUES \(([\s\S]*)\);$/)
    if (!insert || !tables.has(insert[1])) throw new CloudImportError('Dump contains an unsupported statement or table')
    const columns = insert[2].split(',').map((name) => name.trim().replace(/^"([a-z_][a-z0-9_]*)"$/, '$1'))
    if (new Set(columns).size !== columns.length || columns.some((name) => !tables.get(insert[1]).has(name)))
      throw new CloudImportError('Dump contains an unsupported column')
    if (literalValues(insert[3]) !== columns.length) throw new CloudImportError('Dump column and value counts differ')
    counts[insert[1]]++
    rows.push(statement)
  }
  if (!counts.users || !counts.tenants || !counts.memberships) throw new CloudImportError('Data dump has no workspace owner data')
  return { rows, sequenceRestarts, counts }
}

export function importIdentity({ adminUserId, cognitoSub, adminEmail }) {
  if (!uuid.test(adminUserId || '') || !uuid.test(cognitoSub || '')) throw new CloudImportError('Explicit original user ID and verified Cognito subject are required')
  const email = String(adminEmail || '').trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CloudImportError('A verified administrator email is required')
  return { adminUserId, cognitoSub, adminEmail: email }
}

export async function importCloudData(pool, bytes, { sha256, ...mapping }) {
  const identity = importIdentity(mapping)
  if (!/^[a-f0-9]{64}$/.test(sha256 || '') || createHash('sha256').update(bytes).digest('hex') !== sha256)
    throw new CloudImportError('Data dump checksum does not match')
  const sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const requiredMigrations = (await readdir(new URL('../../database/migrations/', import.meta.url))).filter((name) => name.endsWith('.sql')).sort()
  return transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(51011001)')
    await db.query('SET LOCAL statement_timeout = 0')
    await db.query("SET LOCAL lock_timeout = '15s'")
    await db.query('SET LOCAL standard_conforming_strings = on')
    await db.query('SET LOCAL search_path = public, pg_catalog')
    const applied = (await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((row) => row.name)
    if (JSON.stringify(applied) !== JSON.stringify(requiredMigrations)) throw new CloudImportError('Run the current schema migration before data import')
    const tables = (await db.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'schema_migrations' ORDER BY c.relname")).rows
    const names = new Set(tables.map((table) => table.relname))
    const columns = new Map(tables.map((table) => [table.relname, new Set()]))
    for (const row of (await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'")).rows)
      columns.get(row.table_name)?.add(row.column_name)
    const sequences = new Set((await db.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'")).rows.map((row) => row.relname))
    const data = validateDump(sql, columns, sequences)
    if (!names.has('users') || !names.has('memberships')) throw new CloudImportError('Unsupported target database')
    // Locks cover the emptiness check, RLS changes, import and identity mapping.
    await db.query(`LOCK TABLE ${tables.map((table) => quoted(table.relname)).join(',')} IN ACCESS EXCLUSIVE MODE`)
    for (const table of tables) {
      await db.query(`ALTER TABLE ${quoted(table.relname)} NO FORCE ROW LEVEL SECURITY`)
      await db.query(`ALTER TABLE ${quoted(table.relname)} DISABLE ROW LEVEL SECURITY`)
      if ((await db.query(`SELECT 1 FROM ${quoted(table.relname)} LIMIT 1`)).rows.length)
        throw new CloudImportError('Target business database must be empty; no data was overwritten')
    }
    for (const statement of data.rows) await db.query(statement)
    for (const table of tables) {
      const total = Number((await db.query(`SELECT count(*) AS total FROM ${quoted(table.relname)}`)).rows[0].total)
      if (total !== data.counts[table.relname]) throw new CloudImportError('Imported row count differs from the dump')
    }
    const owner = (await db.query("SELECT u.id,u.subject FROM users u WHERE u.id=$1 AND EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.role='owner')", [identity.adminUserId])).rows[0]
    if (!owner?.subject?.startsWith('local:')) throw new CloudImportError('The explicit original administrator must own a local workspace')
    if ((await db.query("SELECT 1 FROM users WHERE subject NOT LIKE 'local:%' LIMIT 1")).rows.length)
      throw new CloudImportError('Source contains non-local identities; an explicit identity migration is required')
    // Preserve IDs and foreign keys, but never let a person claim a local account by email.
    await db.query('UPDATE users SET subject=$2,email=$3 WHERE id=$1', [identity.adminUserId, identity.cognitoSub, identity.adminEmail])
    const lockedUsers = await db.query("UPDATE users SET subject='disabled-local:' || id::text WHERE id<>$1 AND subject LIKE 'local:%'", [identity.adminUserId])
    // ALTER SEQUENCE is transactional; setval() is not, so failures also restore counters.
    for (const sequence of data.sequenceRestarts) await db.query(`ALTER SEQUENCE ${quoted(sequence.name)} RESTART WITH ${sequence.next}`)
    for (const table of tables) {
      if (table.relrowsecurity) await db.query(`ALTER TABLE ${quoted(table.relname)} ENABLE ROW LEVEL SECURITY`)
      if (table.relforcerowsecurity) await db.query(`ALTER TABLE ${quoted(table.relname)} FORCE ROW LEVEL SECURITY`)
    }
    const restored = (await db.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname<>'schema_migrations' ORDER BY c.relname")).rows
    if (JSON.stringify(tables) !== JSON.stringify(restored)) throw new CloudImportError('Row-level security restoration did not match')
    return { tables: data.counts, importedRows: Object.values(data.counts).reduce((a, b) => a + b, 0), lockedLocalUsers: lockedUsers.rowCount }
  })
}
