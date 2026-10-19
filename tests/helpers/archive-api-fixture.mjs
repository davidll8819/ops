import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { randomUUID } from 'node:crypto'
import { migrate } from '../../database/migrate.mjs'
import { buildApp } from '../../apps/api/src/app.mjs'
import { hash } from '../../apps/api/src/auth.mjs'
import { defaultPolicy } from '../../apps/api/src/operations/policy.mjs'
import { encryptConfig } from '../../apps/api/src/operations/security.mjs'
import { makeDocx } from './archive-fixtures.mjs'
class Cache {
  values = new Map()
  async get(k) {
    return this.values.get(k) || null
  }
  async set(k, v, opts = {}) {
    if (opts.NX && this.values.has(k)) return null
    this.values.set(k, v)
    return 'OK'
  }
  async del(k) {
    return Number(this.values.delete(k))
  }
  async eval(_script, { keys }) {
    const count = Number((await this.get(keys[0])) || 0) + 1
    await this.set(keys[0], String(count))
    return count
  }
}
export async function setup(documentParser, options = {}) {
  const pg = new PGlite()
  await pg.waitReady
  let tail = Promise.resolve()
  let leased = false
  const query = async (sql, params) => {
    const result = params ? await pg.query(sql, params) : (await pg.exec(sql)).at(-1)
    return { ...result, rowCount: result?.affectedRows || 0 }
  }
  const pool = {
    query,
    connect: async () => {
      const previous = tail
      let release
      tail = new Promise((resolve) => (release = resolve))
      await previous
      leased = true
      return {
        query,
        release: () => {
          leased = false
          release()
        },
      }
    },
  }
  await migrate(pool)
  const alice = randomUUID(),
    bob = randomUUID(),
    tenant = randomUUID(),
    other = randomUUID(),
    cache = new Cache()
  for (const id of [alice, bob]) {
    await query('INSERT INTO users(id,subject,email) VALUES($1,$2,$3)', [
      id,
      id,
      `${id}@test.invalid`,
    ])
    await cache.set(
      `session:${hash(id)}`,
      JSON.stringify({ userId: id, email: `${id}@test.invalid`, csrf: id }),
    )
  }
  for (const id of [tenant, other]) {
    await query('INSERT INTO tenants(id,name) VALUES($1,$2)', [id, 'Synthetic tenant'])
    await query("INSERT INTO memberships VALUES($1,$2,'owner')", [id, alice])
    await query("INSERT INTO memberships VALUES($1,$2,'member')", [id, bob])
  }
  const key = Buffer.alloc(32, 9),
    policy = defaultPolicy()
  policy.tiers.fast = 'archive-test-model'
  policy.departments.archive.tier = 'fast'
  policy.departments.archive.enabled = true
  await query(
    'INSERT INTO operations_settings(tenant_id,encrypted_config,updated_by) VALUES($1,$2,$3)',
    [
      tenant,
      encryptConfig({ ...policy, credentials: { ai: 'synthetic-key' } }, key, tenant),
      alice,
    ],
  )
  const requests = []
  let answer = () => JSON.stringify({ claims: [], notFound: true })
  const app = await buildApp({
    pool,
    cache,
    agents: { models: [], rates: {} },
    staticRoot: null,
    documentParser,
    operationsDriver: options.operationsDriver,
    env: {
      APP_ORIGIN: 'https://archive.test',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      OPERATIONS_CONFIG_KEY: key.toString('base64'),
    },
    modelFetch: async (_url, options) => {
      assert.equal(leased, false, 'model transport must run outside a database transaction')
      const body = JSON.parse(options.body)
      requests.push(body)
      const content = await answer(body)
      if (content instanceof Response) return content
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  })
  const base = `/api/tenants/${tenant}`,
    request = (method, path, payload, user = alice) =>
      app.inject({
        method,
        url: path.startsWith('/api/') ? path : `${base}${path}`,
        payload,
        headers: {
          cookie: `office_session=${user}`,
          origin: 'https://archive.test',
          'x-csrf-token': user,
        },
      })
  const upload = async (name, bytes, user = alice) => {
    const response = await request(
      'POST',
      '/files',
      { name, mime: 'application/octet-stream', content: bytes.toString('base64') },
      user,
    )
    assert.equal(response.statusCode, 200, response.body)
    return response.json().id
  }
  return {
    pg,
    query,
    pool,
    app,
    alice,
    bob,
    tenant,
    other,
    base,
    request,
    upload,
    requests,
    setAnswer: (fn) => (answer = fn),
    close: async () => {
      await app.close()
      await pg.close()
    },
  }
}
export async function ready(h, name, paragraphs) {
  const id = await h.upload(name, await makeDocx({ paragraphs }))
  const response = await h.request('POST', `/archive/documents/${id}/parse`, {})
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().document.state, 'ready', response.body)
  return id
}
