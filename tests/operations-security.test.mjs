import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { SignJWT } from 'jose'
import { encryptConfig, decryptConfig, signBridge, verifyBridge } from '../apps/api/src/operations/security.mjs'
const source = await readFile(new URL('../integrations/aitoearn/source/project/aitoearn-backend/libs/common/src/office-bridge.ts', import.meta.url), 'utf8')
const { officeBridge, bridgeHeaders, officeRelayCredentials } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`)
const config = { tenantId: 'bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb', secret: 'bridge-test-secret-at-least-32-characters', revision: 3, officeOrigin: 'https://office.test' }
const jwtSecret = 'another-only-test-secret-at-least-32-characters'
async function run(req, jwtTenant = config.tenantId) {
  let next = false, status = 200, body
  const token = await new SignJWT({ id: '0123456789abcdef01234567', officeTenantId: jwtTenant }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('2m').sign(new TextEncoder().encode(jwtSecret))
  req.headers = { authorization: `Bearer ${token}`, ...req.headers }
  const res = { status(n) { status = n; return this }, json(value) { body = value; return this } }
  await officeBridge(config, jwtSecret)(req, res, () => { next = true })
  return { next, status, body }
}
test('credentials use authenticated encryption bound to the tenant', () => {
  const key = randomBytes(32), value = { aiKey: 'only-a-test-key' }
  const ciphertext = encryptConfig(value, key, 'tenant-a')
  assert.ok(!ciphertext.includes(value.aiKey))
  assert.deepEqual(decryptConfig(ciphertext, key, 'tenant-a'), value)
  assert.throws(() => decryptConfig(ciphertext, key, 'tenant-b'))
  assert.throws(() => decryptConfig(ciphertext, randomBytes(32), 'tenant-a'))
})
test('signatures bind content, method, path and freshness', () => {
  const body = { items: ['a'], content: { title: 'approved' } }
  const headers = signBridge(config.secret, 'POST', '/publish', body)
  assert.equal(verifyBridge(config.secret, 'POST', '/publish', body, headers), true)
  assert.deepEqual(headers, bridgeHeaders(config.secret, 'POST', '/publish', body, headers['x-office-time']))
  for (const [method, path, data] of [['DELETE','/publish',body],['POST','/other',body],['POST','/publish',{ ...body, items: ['b'] }]])
    assert.equal(verifyBridge(config.secret, method, path, data, headers), false)
  assert.equal(verifyBridge(config.secret, 'POST','/publish',body,signBridge(config.secret,'POST','/publish',body,'1')), false)
})
test('original runtime blocks direct publish, retries, engagement and MCP bypass', async () => {
  for (const path of ['/v2/channels/publish/flows','/v2/channels/publish/tasks/a/retry','/v2/channels/engagement/comment','/publish/video'])
    assert.equal((await run({ method: 'POST', path, body: {} })).status, 403)
  for (const name of ['publishChannelTaskNow','updateChannelPublishAt','requestChannelPublishUpdate','submitChannelEngagementComment','callChannelEngagementFunction']) {
    const result = await run({ method: 'POST', path: '/channels/mcp', body: { jsonrpc:'2.0', id: 1, method:'tools/call', params:{ name, arguments:{} } } })
    assert.equal(result.next, false); assert.equal(result.body.result.isError, true)
  }
  assert.equal((await run({method:'POST',path:'/channels/mcp',body:[]})).status,400)
})
test('approved payload alone can reach publishing; edited payload is rejected', async () => {
  const path = '/v2/channels/publish/flows', body = { flowId:'stable-id',content:{title:'Reviewed'},items:[{accountId:'a'}] }
  const headers = signBridge(config.secret, 'POST', path, body)
  assert.equal((await run({ method:'POST',path,body,headers })).next, true)
  assert.equal((await run({ method:'POST',path,body:{...body,content:{title:'Changed'}},headers })).status,403)
})
test('MCP publication returns pending approval status through the authenticated Office workflow', async () => {
  const original = globalThis.fetch; const calls=[]
  globalThis.fetch = async (url, options) => { calls.push({url, options}); return Response.json({id:'flow-123',state:'pending',result:null}) }
  try {
    const req = { method:'POST',path:'/channels/mcp',body:{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'createChannelPublishFlow',arguments:{content:{title:'Video'},publishAt:'2026-10-11T00:00:00Z',items:[{platform:'youtube',accountId:'a'}]}}} }
    const result = await run(req)
    assert.equal(result.next,false); assert.match(result.body.result.content[0].text,/Awaiting user approval/)
    assert.equal(calls.length,1); assert.ok(calls[0].url.endsWith(`/integrations/aitoearn/${config.tenantId}/publications`))
    assert.equal((await run({...req,headers:{}}, 'other-tenant')).status,403)
    assert.equal(calls.length,1)
    globalThis.fetch=async()=>{throw new Error('network offline')}
    const unknown = (await run(req)).body.result
    assert.equal(unknown.isError,true)
    assert.match(unknown.content[0].text,/unknown/)
    assert.doesNotMatch(unknown.content[0].text,/Nothing has been published/)
  } finally {globalThis.fetch=original}
})
test('runtime handshake is tenant-bound and signed; native login is disabled', async () => {
  assert.equal((await run({method:'GET',path:'/office-bridge/status'})).status,403)
  const result=await run({method:'GET',path:'/office-bridge/status',headers:signBridge(config.secret,'GET','/office-bridge/status',null)})
  assert.deepEqual(result.body,{version:4,tenantId:config.tenantId,revision:3,publishMode:'manual',draining:false})
  assert.equal((await run({method:'POST',path:'/user/register',body:{}})).status,403)
})

test('signed runtime drain blocks new tasks while existing status reads stay available',async()=>{
 const middleware=officeBridge(config,jwtSecret)
 async function invoke(method,path,body,signed=false){
  let status=200,result,next=false
  const req={method,path,body,headers:signed?bridgeHeaders(config.secret,method,path,body??null):{}}
  await middleware(req,{status(n){status=n;return this},json(v){result=v;return this}},()=>{next=true})
  return {status,result,next}
 }
 assert.equal((await invoke('POST','/office-bridge/drain',{draining:true})).status,403)
 await invoke('POST','/office-bridge/drain',{draining:true},true)
 assert.equal((await invoke('GET','/office-bridge/status',undefined,true)).result.draining,true)
 assert.equal((await invoke('POST','/agent/tasks',{prompt:'new'})).status,503)
 assert.equal((await invoke('GET','/agent/tasks/old')).next,true)
 await invoke('POST','/office-bridge/drain',{draining:false},true)
 assert.equal((await invoke('POST','/agent/tasks',{prompt:'new'})).next,true)
})

test('deployed runtime retrieves rotated Relay credentials with tenant-bound signatures',async () => {
  const original=globalThis.fetch
  let key='first-relay-key'
  globalThis.fetch=async (url,options) => {
    assert.equal(url,`${config.officeOrigin}/integrations/aitoearn/${config.tenantId}/relay-config`)
    assert.ok(verifyBridge(config.secret,'GET',new URL(url).pathname,null,options.headers))
    return Response.json({serverUrl:'https://aitoearn.cn/api',apiKey:key})
  }
  try {
    assert.equal((await officeRelayCredentials(config)).apiKey,'first-relay-key')
    key='rotated-relay-key'
    assert.equal((await officeRelayCredentials(config)).apiKey,key)
    globalThis.fetch=async () => Response.json({serverUrl:'https://other.test',apiKey:key})
    await assert.rejects(officeRelayCredentials(config),/Invalid/)
  } finally {globalThis.fetch=original}
})
