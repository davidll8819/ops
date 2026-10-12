import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

let server, api, readApiResponse, setCsrf
before(async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
  })
  ;({ api, readApiResponse, setCsrf } = await server.ssrLoadModule('/src/saas/api.ts'))
})
after(async () => {
  await server?.close()
})
const contentType = 'application/x-office-response+ndjson; charset=utf-8'
const response = (frames) =>
  new Response(frames.map(JSON.stringify).join('\n') + '\n', {
    headers: { 'content-type': contentType },
  })

test('JSON responses remain compatible and JSON errors still reject', async () => {
  assert.deepEqual(await readApiResponse(Response.json({ ok: true })), { ok: true })
  await assert.rejects(
    readApiResponse(Response.json({ error: '无权限' }, { status: 403 })),
    /无权限/,
  )
})

test('heartbeats are ignored, UTF-8 split across chunks survives, final data is returned', async () => {
  const encoded = new TextEncoder().encode(
    JSON.stringify({ type: 'heartbeat' }) +
      '\n' +
      JSON.stringify({ type: 'result', status: 200, data: { text: '任务完成' } }) +
      '\n',
  )
  const stream = new ReadableStream({
    start(controller) {
      for (const byte of encoded) controller.enqueue(new Uint8Array([byte]))
      controller.close()
    },
  })
  assert.deepEqual(
    await readApiResponse(new Response(stream, { headers: { 'content-type': contentType } })),
    { text: '任务完成' },
  )
})

test('HTTP 200 with an error final frame never appears successful', async () => {
  await assert.rejects(
    readApiResponse(
      response([
        { type: 'heartbeat' },
        { type: 'result', status: 502, data: { error: '模型结果未知，勿重复提交' } },
      ]),
    ),
    /模型结果未知/,
  )
})

test('missing final frame, invalid protocol and broken streams reject with no retry advice', async () => {
  for (const frames of [
    [{ type: 'heartbeat' }],
    [{ type: 'result', status: 200 }],
    [{ type: 'result', status: '200', data: {} }],
    [{ type: 'unexpected' }],
  ])
    await assert.rejects(readApiResponse(response(frames)), /任务可能仍在处理.*勿重复提交/)
  const stream = new ReadableStream({
    start(controller) {
      controller.error(new Error('socket disconnected'))
    },
  })
  await assert.rejects(
    readApiResponse(new Response(stream, { headers: { 'content-type': contentType } })),
    /勿重复提交/,
  )
})

test('final 401 dispatches the existing unauthorized event', async () => {
  const previous = globalThis.window,
    events = []
  globalThis.window = { dispatchEvent: (event) => events.push(event.type) }
  try {
    await assert.rejects(
      readApiResponse(response([{ type: 'result', status: 401, data: { error: '登录过期' } }])),
      /登录过期/,
    )
    assert.deepEqual(events, ['office:unauthorized'])
  } finally {
    globalThis.window = previous
  }
})

test('API negotiates explicitly, keeps CSRF, and never repeats a failed paid request', async () => {
  const previous = globalThis.fetch
  let calls = 0
  setCsrf('csrf-test')
  globalThis.fetch = async (_path, options) => {
    calls++
    assert.match(options.headers.Accept, /application\/x-office-response\+ndjson/)
    assert.equal(options.headers['X-CSRF-Token'], 'csrf-test')
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.method, 'POST')
    return response([{ type: 'heartbeat' }])
  }
  try {
    await assert.rejects(api('/api/tenants/a/secretary/chat', { text: 'work' }), /勿重复提交/)
    assert.equal(calls, 1)
    globalThis.fetch = async () => {
      calls++
      throw new Error('network')
    }
    await assert.rejects(api('/api/tenants/a/secretary/chat', { text: 'work' }), /勿重复提交/)
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = previous
    setCsrf('')
  }
})
