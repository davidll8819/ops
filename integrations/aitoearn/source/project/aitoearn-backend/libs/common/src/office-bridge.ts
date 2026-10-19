import type { NextFunction, Request, Response } from 'express'
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface OfficeBridgeConfig {
  tenantId: string
  revision: number
  secret: string
  officeOrigin: string
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function bridgeHeaders(secret: string, method: string, path: string, body: unknown, time = String(Date.now())) {
  return {
    'x-office-time': time,
    'x-office-signature': createHmac('sha256', secret).update(`${time}\n${method}\n${path}\n${canonical(body)}`).digest('hex'),
  }
}

function signed(config: OfficeBridgeConfig, req: Request): boolean {
  const time = String(req.headers['x-office-time'] || '')
  const signature = String(req.headers['x-office-signature'] || '')
  if (!/^\d+$/.test(time) || Math.abs(Date.now() - Number(time)) > 60000 || !/^[a-f0-9]{64}$/.test(signature)) return false
  const expected = bridgeHeaders(config.secret, req.method, req.path, req.body ?? null, time)['x-office-signature']
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
}

function isOfficeUser(req: Request, tenantId: string, jwtSecret: string): boolean {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
    const [header, data, signature] = token.split('.')
    if (JSON.parse(Buffer.from(header, 'base64url').toString()).alg !== 'HS256') return false
    const expected = createHmac('sha256', jwtSecret).update(`${header}.${data}`).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString())
    return payload.officeTenantId === tenantId && typeof payload.id === 'string' && payload.exp > Date.now() / 1000
  }
  catch { return false }
}

// Installed before Nest controllers. Applies to legacy, REST, Relay and MCP publishing entry points.
export function officeBridge(config: OfficeBridgeConfig | undefined, jwtSecret: string) {
  let draining = false
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!config) return next()
    if (req.path === '/office-bridge/status') {
      if (!signed(config, req)) return res.status(403).json({ error: 'Office signature required' })
      return res.json({ version: 4, tenantId: config.tenantId, revision: config.revision, publishMode: 'manual', draining })
    }
    if (req.path === '/office-bridge/drain') {
      if (req.method !== 'POST' || !signed(config, req)) return res.status(403).json({ error: 'Office signature required' })
      if (typeof req.body?.draining !== 'boolean') return res.status(400).json({ error: 'Expected a draining flag' })
      draining = req.body.draining
      return res.json({ draining })
    }
    if (draining && req.method === 'POST' && ['/agent/tasks', '/ai/image/generate', '/ai/image/edit', '/ai/image/generate/async', '/ai/image/edit/async'].includes(req.path.replace(/\/$/, '')))
      return res.status(503).json({ error: 'Runtime is draining; new production requests are paused' })
    if (/config[-/]?manager|config[-/]?editor|public-share|(?:register|signup|login|auto-login)(?:\/|$)/i.test(req.path))
      return res.status(403).json({ error: 'Use the Office workspace' })
    const publishing = /publish|engagement/i.test(req.path)
    if (publishing && !['GET', 'HEAD'].includes(req.method)) {
      if (req.method !== 'POST' || req.path.replace(/\/$/, '') !== '/v2/channels/publish/flows' || !signed(config, req))
        return res.status(403).json({ error: 'Publication must use the authenticated Office workflow' })
    }
    if (/mcp(?:\/|$)/i.test(req.path)) {
      if (Array.isArray(req.body)) return res.status(400).json({ error: 'MCP batches are disabled in Office mode' })
      const rpc = req.body
      if (rpc?.method === 'tools/call') {
        if (!isOfficeUser(req, config.tenantId, jwtSecret)) return res.status(403).json({ error: 'Office identity required' })
        const name = String(rpc.params?.name || '')
        if (name === 'createChannelPublishFlow') {
          try {
            const body = { ...rpc.params.arguments }
            delete body.flowId
            if (body.context) { body.context = { ...body.context }; delete body.context.source }
            const path = `/integrations/aitoearn/${config.tenantId}/publications`
            const response = await fetch(`${config.officeOrigin.replace(/\/$/, '')}${path}`, {
              method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
              headers: { 'content-type': 'application/json', ...bridgeHeaders(config.secret, 'POST', path, body) },
              body: JSON.stringify(body),
            })
            if (!response.ok) throw new Error('workflow unavailable')
            const proposal = await response.json() as { id: string, state: string, result?: unknown }
            return res.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ status: proposal.state, flowId: proposal.id, result: proposal.result, message: proposal.state === 'submitted' ? 'Approved and submitted. Query the flow receipt for the platform result; submission is not publication success.' : proposal.state === 'pending' ? 'Awaiting user approval in the Office workbench. Nothing has been submitted; do not retry or bypass approval.' : 'Check this flow receipt. Do not create a duplicate publish request.' }) }] } })
          }
          catch {
            return res.json({ jsonrpc: '2.0', id: rpc.id, result: { isError: true, content: [{ type: 'text', text: 'Publication result is unknown. Check Office records before any retry; do not create a duplicate request.' }] } })
          }
        }
        if (!/^(list|get|verify)/i.test(name) && /publish|engagement|comment|schedule/i.test(name))
          return res.json({ jsonrpc: '2.0', id: rpc.id, result: { isError: true, content: [{ type: 'text', text: 'This action is not connected to the Office workflow.' }] } })
      }
    }
    return next()
  }
}

/** Fetch current tenant-owned Relay credentials for each operation; never cache or log keys. */
export async function officeRelayCredentials(config: OfficeBridgeConfig): Promise<{ serverUrl: string, apiKey: string }> {
  const path = `/integrations/aitoearn/${config.tenantId}/relay-config`
  const response = await fetch(`${config.officeOrigin.replace(/\/$/, '')}${path}`, {
    headers: bridgeHeaders(config.secret, 'GET', path, null), redirect: 'error', signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error('Company relay is unavailable')
  const data = await response.json() as { serverUrl: string, apiKey: string }
  if (!['https://aitoearn.cn/api', 'https://aitoearn.ai/api'].includes(data.serverUrl) || typeof data.apiKey !== 'string' || !data.apiKey) throw new Error('Invalid company relay configuration')
  return { serverUrl: data.serverUrl, apiKey: data.apiKey }
}
