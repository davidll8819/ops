import { z } from 'zod'

export const SLOW_RESPONSE_TYPE = 'application/x-office-response+ndjson'
// Only JSON-returning model routes use this transport. Existing upstream SSE stays untouched.
export const slowResponseRoutes = new Set([
  '/api/tenants/:tenantId/secretary/chat',
  '/api/tenants/:tenantId/secretary/brief',
  '/api/tenants/:tenantId/secretary/tasks/:id/run',
  '/api/tenants/:tenantId/departments/:department/chat',
  '/api/tenants/:tenantId/departments/:department/messages',
  '/api/tenants/:tenantId/agent-builder',
  '/api/tenants/:tenantId/agents/:agentId/messages',
])

export function responseError(err, req, app) {
  const validation = err instanceof z.ZodError
  const status = validation ? 400 : err.statusCode || 500
  if (status >= 500)
    app.log.error({ code: err.code || err.name, requestId: req.id }, 'Request failed')
  return {
    status,
    data: {
      error: validation
        ? '输入信息不符合要求'
        : status >= 500 && !err.expose
          ? '服务暂时不可用，请稍后重试'
          : err.message,
      requestId: req.id,
    },
  }
}

export function registerSlowResponses(app, { authorize, heartbeatMs = 12000 } = {}) {
  app.addHook('onRoute', (route) => {
    if (route.method !== 'POST' || !slowResponseRoutes.has(route.url)) return
    const handler = route.handler
    route.handler = async function (req, reply) {
      const accepts = String(req.headers.accept || '')
        .split(',')
        .some((part) => {
          const [type, ...parameters] = part.trim().split(';')
          return (
            type === SLOW_RESPONSE_TYPE && !parameters.some((p) => /^\s*q=0(?:\.0*)?\s*$/.test(p))
          )
        })
      if (!accepts) return handler.call(this, req, reply)
      // Existing onRequest authentication/CSRF hooks have already run. Check membership
      // before sending even a heartbeat; each handler retains its own role/object checks.
      await authorize?.(req)
      let streaming = false,
        disconnected = reply.raw.destroyed
      const write = (frame) => {
        if (!disconnected && !reply.raw.destroyed && !reply.raw.writableEnded)
          reply.raw.write(JSON.stringify(frame) + '\n')
      }
      const heartbeat = () => {
        if (
          disconnected ||
          reply.raw.destroyed ||
          reply.raw.writableEnded ||
          (!streaming && reply.sent)
        )
          return
        if (!streaming) {
          // Delay negotiation until the request is actually slow. Fast successes and
          // permission/validation failures retain their normal HTTP status and JSON.
          streaming = true
          reply.hijack()
          for (const [key, value] of Object.entries(reply.getHeaders()))
            if (value !== undefined && key.toLowerCase() !== 'content-length')
              reply.raw.setHeader(key, value)
          reply.raw.removeHeader('content-length')
          reply.raw.setHeader('content-type', `${SLOW_RESPONSE_TYPE}; charset=utf-8`)
          reply.raw.setHeader('cache-control', 'no-store, no-transform')
          reply.raw.setHeader('x-accel-buffering', 'no')
          reply.raw.writeHead(200)
        }
        write({ type: 'heartbeat' })
      }
      const timer = setInterval(heartbeat, heartbeatMs)
      timer.unref()
      const close = () => {
        disconnected = true
        clearInterval(timer)
      }
      reply.raw.once('close', close)
      try {
        // Run exactly once, including after a browser disconnect. The handler owns
        // persistence/metering; a lost connection must not abort or replay paid work.
        const data = await handler.call(this, req, reply)
        if (!streaming) return data
        write({ type: 'result', status: reply.statusCode, data: data ?? null })
      } catch (err) {
        if (!streaming) throw err
        write({ type: 'result', ...responseError(err, req, app) })
      } finally {
        clearInterval(timer)
        reply.raw.off('close', close)
        if (streaming && !disconnected && !reply.raw.destroyed) reply.raw.end()
      }
      return reply
    }
  })
}
