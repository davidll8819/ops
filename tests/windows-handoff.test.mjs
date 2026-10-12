import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { checkSkillPackages } from '../scripts/check-skill-packages.mjs'

test('skill handoff detects missing and tampered archives and rejects traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-packages-'))
  try {
    await mkdir(join(root, 'skills/catalog'), { recursive: true })
    await mkdir(join(root, 'skills/packages'), { recursive: true })
    const bytes = Buffer.from('download-only fixture')
    const download = {
      status: 'downloaded',
      packagePath: 'skills/packages/example.zip',
      packageBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    const save = async (d) =>
      writeFile(
        join(root, 'skills/catalog/catalog.json'),
        JSON.stringify({ items: [{ download: d }, { download: d }] }),
      )
    await save(download)
    assert.deepEqual((await checkSkillPackages(root)).missing, [download.packagePath])
    await writeFile(join(root, download.packagePath), bytes)
    assert.deepEqual(await checkSkillPackages(root, { hashes: true }), {
      rows: 2,
      packages: 1,
      missing: [],
      invalid: [],
    })
    await writeFile(join(root, download.packagePath), Buffer.alloc(bytes.length))
    assert.deepEqual((await checkSkillPackages(root, { hashes: true })).invalid, [
      download.packagePath,
    ])
    await save({ ...download, packagePath: '../private.zip' })
    await assert.rejects(checkSkillPackages(root), /Invalid skill archive path/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('migration CLI executes on native platform paths instead of silently exiting', () => {
  const env = {
    ...process.env,
    PGHOST: '127.0.0.1',
    PGPORT: '1',
    PGUSER: 'fixture',
    PGPASSWORD: 'fixture',
    PGDATABASE: 'fixture',
  }
  delete env.DATABASE_URL
  delete env.PGSSLROOTCERT
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../database/migrate.mjs', import.meta.url))],
    { env, encoding: 'utf8', timeout: 10000 },
  )
  assert.ifError(result.error)
  assert.notEqual(result.status, 0, 'unreachable fixture database must fail, not skip migrations')
  assert.match(result.stderr, /ECONNREFUSED|EPERM|EACCES|timeout/i)
})
