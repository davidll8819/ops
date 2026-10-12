import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareOperationsAttachments } from '../apps/api/src/operations/task-media.mjs'

const imageBytes = Buffer.from('fixture-image-bytes')
const image = {
  id: 'office-image',
  name: '设计稿.jpg',
  mime: 'image/png',
  content: {
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${imageBytes.toString('base64')}` },
  },
}
const text = {
  id: 'office-text',
  content: { type: 'text', text: '附件原文\n<attachment>已确认的分镜</attachment>' },
}
const entry = {
  userId: 'tenant-runtime-user',
  serverUrl: 'https://server.example.com',
  aiUrl: 'https://ai.example.com',
  jwtSecret: 'must-not-leak',
  bridgeSecret: 'also-private',
}
const mediaURL = 'https://media.example.com/user/media/image.png'
const signedURL = 'https://bucket.s3.example.com/image.png?X-Amz-Signature=fixture'

function harness({ sign = {}, confirm = {}, put } = {}) {
  const calls = []
  const signed = {
    id: 'asset-123',
    path: 'user/media/image.png',
    url: mediaURL,
    uploadUrl: signedURL,
    ...sign,
  }
  return {
    calls,
    driver: {
      async request(actualEntry, service, path, options) {
        assert.equal(service, 'server')
        calls.push({ kind: 'request', path, options })
        if (path === '/assets/uploadSign') return signed
        assert.equal(path, '/assets/asset-123/confirm')
        return {
          id: signed.id,
          url: signed.url,
          status: 'confirmed',
          userId: actualEntry.userId,
          ...confirm,
        }
      },
    },
    fetcher: async (url, options) => {
      calls.push({ kind: 'put', url, options })
      return put ? put(url, options) : new Response(null, { status: 200 })
    },
  }
}

test('attachments use authenticated sign, credential-free binary PUT, then owner-bound confirmation', async () => {
  const h = harness()
  const blocks = await prepareOperationsAttachments({
    ...h,
    entry,
    attachments: { items: [text, image] },
  })
  assert.deepEqual(blocks, [
    text.content,
    { type: 'image', source: { type: 'url', url: mediaURL } },
  ])
  assert.deepEqual(
    h.calls.map((call) => call.kind),
    ['request', 'put', 'request'],
  )
  assert.deepEqual(h.calls[0].options, {
    method: 'POST',
    body: { filename: '设计稿.png', type: 'userMedia', size: imageBytes.length },
  })
  const { options } = h.calls[1]
  assert.equal(h.calls[1].url, signedURL)
  assert.deepEqual(options.body, imageBytes)
  assert.deepEqual(options.headers, {
    'content-type': 'image/png',
    'content-length': String(imageBytes.length),
  })
  assert.equal(options.method, 'PUT')
  assert.equal(options.credentials, 'omit')
  assert.equal(options.redirect, 'error')
  assert.ok(options.signal instanceof AbortSignal)
  assert.doesNotMatch(JSON.stringify(options), /must-not-leak|also-private|authorization|cookie/i)
  assert.deepEqual(h.calls[2].options, { method: 'POST', body: {} })
})

test('text and empty attachments do not make network requests', async () => {
  const h = harness()
  assert.deepEqual(await prepareOperationsAttachments({ ...h, entry }), [])
  assert.deepEqual(
    await prepareOperationsAttachments({ ...h, entry, attachments: { items: [text] } }),
    [text.content],
  )
  assert.equal(h.calls.length, 0)
})

test('invalid or nonpublic model URLs fail before sending image bytes', async () => {
  for (const url of [
    undefined,
    '/api/files/preview',
    'http://localhost/a.png',
    'https://localhost./a.png',
    'https://a.localhost/a.png',
    'https://10.0.1.2/a.png',
    'https://0x7f000001/a.png',
    'https://[::1]/a.png',
    'https://asset.internal/a.png',
    'https://user:pass@media.example.com/a.png',
    'http://media.example.com/a.png',
  ]) {
    const h = harness({ sign: { url } })
    await assert.rejects(
      prepareOperationsAttachments({ ...h, entry, attachments: { items: [image] } }),
      /素材|公网/,
    )
    assert.equal(h.calls.length, 1, String(url))
  }
})

test('upload addresses reject credentials, non-HTTP schemes and private destinations for remote bindings', async () => {
  for (const uploadUrl of [
    'file:///tmp/x',
    'https://user:password@bucket.example.com/a',
    'https://bucket.example.com/a#fragment',
    'http://127.0.0.1:9000/a',
    'https://10.0.0.5/a',
    'http://bucket.example.com/a',
  ]) {
    const h = harness({ sign: { uploadUrl } })
    await assert.rejects(
      prepareOperationsAttachments({ ...h, entry, attachments: { items: [image] } }),
    )
    assert.equal(h.calls.length, 1, uploadUrl)
  }
})

test('local RustFS upload is supported only with a loopback runtime and public result URL', async () => {
  const uploadUrl = 'http://127.0.0.1:9000/bucket/image.png?X-Amz-Signature=fixture'
  const h = harness({ sign: { uploadUrl } })
  const local = { ...entry, serverUrl: 'http://127.0.0.1:3302', aiUrl: 'http://localhost:3310' }
  assert.deepEqual(
    await prepareOperationsAttachments({ ...h, entry: local, attachments: { items: [image] } }),
    [{ type: 'image', source: { type: 'url', url: mediaURL } }],
  )
  assert.equal(h.calls[1].url, uploadUrl)
  const mixed = harness({ sign: { uploadUrl } })
  await assert.rejects(
    prepareOperationsAttachments({
      ...mixed,
      entry: { ...local, aiUrl: entry.aiUrl },
      attachments: { items: [image] },
    }),
  )
  assert.equal(mixed.calls.length, 1)
})

test('production refuses HTTP result URLs even with a local runtime', async () => {
  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const h = harness({ sign: { url: 'http://media.example.com/image.png' } })
    await assert.rejects(
      prepareOperationsAttachments({
        ...h,
        entry: { ...entry, serverUrl: 'http://localhost:3302', aiUrl: 'http://localhost:3310' },
        attachments: { items: [image] },
      }),
      /公网/,
    )
    assert.equal(h.calls.length, 1)
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
})

test('failed, redirected or uncertain PUT never confirms and does not leak signed URLs', async () => {
  for (const put of [
    async () => new Response(null, { status: 403 }),
    async () => new Response(null, { status: 307 }),
    async () => {
      throw new Error(`failed ${signedURL}`)
    },
  ]) {
    const h = harness({ put })
    await assert.rejects(
      prepareOperationsAttachments({ ...h, entry, attachments: { items: [image] } }),
      (error) => {
        assert.match(error.message, /任务尚未提交/)
        assert.doesNotMatch(error.message, /X-Amz|fixture/)
        return true
      },
    )
    assert.equal(h.calls.length, 2)
  }
})

test('provider must confirm the same asset, owner and URL before an image block is returned', async () => {
  for (const confirm of [
    { status: 'pending' },
    { id: 'other-asset' },
    { userId: 'other-tenant' },
    { url: 'https://media.example.com/other.png' },
    { url: 'http://127.0.0.1/private.png' },
  ]) {
    const h = harness({ confirm })
    await assert.rejects(
      prepareOperationsAttachments({ ...h, entry, attachments: { items: [image] } }),
      /确认|公网/,
    )
    assert.equal(h.calls.length, 3)
  }
})

test('invalid attachments are rejected before beginning any upload', async () => {
  for (const item of [
    { content: { type: 'video' } },
    { content: { type: 'image_url', image_url: { url: 'https://office.example.com/private' } } },
    { ...image, content: { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ=' } } },
  ]) {
    const h = harness()
    await assert.rejects(
      prepareOperationsAttachments({ ...h, entry, attachments: { items: [image, item] } }),
      /附件/,
    )
    assert.equal(h.calls.length, 0)
  }
})
