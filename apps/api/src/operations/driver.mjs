import { readFile } from 'node:fs/promises'
import { SignJWT } from 'jose'
import { signBridge } from './security.mjs'
import { fail } from '../db.mjs'
// Only an operator-owned file may assign private runtimes. Tenant inputs cannot select internal URLs.
export function createOperationsDriver(env) {
  async function binding(tenantId) {
    if (!env.OPERATIONS_RUNTIMES_FILE) return null
    const entries = JSON.parse(await readFile(env.OPERATIONS_RUNTIMES_FILE, 'utf8'))
    const entry = entries[tenantId]
    if (!entry) return null
    if (!entry.serverUrl || !entry.aiUrl || !entry.userId || !entry.jwtSecret || !entry.bridgeSecret) throw fail(503, '运营服务配置不完整')
    // An upstream instance has global provider credentials: sharing it would cross tenant boundaries.
    for (const [id, other] of Object.entries(entries)) {
      if (id !== tenantId && [other.serverUrl, other.aiUrl].some(url => [entry.serverUrl, entry.aiUrl].includes(url)))
        throw fail(503, '企业运行服务必须相互隔离')
    }
    return { ...entry, tenantId }
  }
  async function request(entry, service, path, { method = 'GET', body, signed = false, stream = false } = {}) {
    const origin = service === 'ai' ? entry.aiUrl : entry.serverUrl
    const jwt = await new SignJWT({ id: entry.userId, officeTenantId: entry.tenantId }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(stream ? '2h' : '5m').sign(new TextEncoder().encode(entry.jwtSecret))
    const res = await fetch(`${origin.replace(/\/$/, '')}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(stream ? 3600000 : 30000),
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json', ...(signed ? signBridge(entry.bridgeSecret, method, path, body ?? null) : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) { await res.body?.cancel(); throw fail(502, '运营服务请求失败，请检查运行服务配置') }
    if (stream) {
      if (!res.headers.get('content-type')?.includes('text/event-stream')) { await res.body?.cancel(); throw fail(502, '运营服务没有返回任务事件流') }
      return res.body
    }
    const data = await res.json()
    if (data.code !== undefined && data.code !== 0 && data.code !== 200) throw fail(502, '运营服务返回错误，请检查任务状态')
    return data.data ?? data
  }
  async function ready(tenantId) {
    const entry = await binding(tenantId)
    if (!entry) throw fail(503, '企业独立运行服务尚未部署')
    for (const service of ['server', 'ai']) {
      const info = await request(entry, service, '/office-bridge/status', { signed: true })
      if (info.version !== 4 || info.tenantId !== tenantId || info.publishMode !== 'manual')
        throw fail(503, '运营服务版本或企业配置尚未同步')
    }
    return entry
  }
  return { binding, ready, request }
}
