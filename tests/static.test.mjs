import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../apps/api/src/app.mjs'
test('static files retain valid content types after rebuild while API remains protected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-static-'))
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<!doctype html><title>test</title>')
  const app = await buildApp({
    pool: {},
    cache: {},
    agents: { models: [] },
    env: { APP_ORIGIN: 'http://localhost:3000', LOG_LEVEL: 'silent' },
    staticRoot: root,
  })
  try {
    await app.ready()
    // A new build adds a hashed filename while the API process stays running.
    await writeFile(join(root, 'assets', 'new-hash.js'), 'export const ready = true')
    const js = await app.inject('/assets/new-hash.js')
    assert.equal(js.statusCode, 200)
    assert.match(js.headers['content-type'], /javascript/)
    assert.match(js.headers['cache-control'], /public/)
    assert.equal((await app.inject('/api/me')).statusCode, 401)
    assert.equal((await app.inject('/assets/missing.js')).statusCode, 404)
    assert.equal((await app.inject('/workspace')).statusCode, 200)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
