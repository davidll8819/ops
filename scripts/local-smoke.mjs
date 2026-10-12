import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const base = 'http://localhost:3000'
const credentials = await readFile('.local/login.txt', 'utf8')
const accounts = [...credentials.matchAll(/Email: (.+)\nPassword: (.+)/g)]
const get = async (path, cookie) => fetch(base + path, { headers: cookie ? { cookie } : {} })
assert.equal((await get('/health/ready')).status, 200)
assert.equal((await get('/api/me')).status, 401)
const home = await (await get('/')).text()
const asset = home.match(/src="(\/assets\/[^\"]+\.js)"/)[1]
const js = await get(asset)
assert.equal(js.status, 200)
assert.match(js.headers.get('content-type'), /javascript/)
const sessions = []
for (const [, email, password] of accounts) {
  const res = await fetch(base + '/auth/local', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email, password }),
  })
  assert.equal(res.status, 200)
  const cookie = res.headers.get('set-cookie').split(';')[0]
  const me = await (await get('/api/me', cookie)).json()
  sessions.push({ cookie, me })
}
assert.equal(sessions[0].me.tenants.length, 2)
assert.equal(sessions[1].me.tenants.length, 1)
const personal = sessions[0].me.tenants.find((t) => t.plan === 'personal')
assert.equal((await get(`/api/tenants/${personal.id}/agents`, sessions[1].cookie)).status, 403)
for (const { cookie, me } of sessions) {
  const out = await fetch(base + '/auth/logout', {
    method: 'POST',
    headers: { cookie, origin: base, 'x-csrf-token': me.csrf, 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(out.status, 200)
  assert.equal((await get('/api/me', cookie)).status, 401)
}
console.log(
  'PASS: real PostgreSQL/Redis readiness, static assets, login, tenant membership isolation, logout',
)
