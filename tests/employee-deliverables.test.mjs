import test from 'node:test'
import assert from 'node:assert/strict'
import { zipFiles } from '../apps/api/src/skill-upload.mjs'

const load = () => import('../apps/api/src/execution/deliverables.mjs').catch(() => ({}))
const file = (path, content) => ({ path, contentBase64: Buffer.from(content).toString('base64') })
const snapshot = (files = [file('index.html', '<title>作品</title>Hello')], extra = {}) => ({
  name: 'project',
  revision: 7,
  updatedAt: '2026-10-15T00:00:00.000Z',
  activeRunId: null,
  files,
  ...extra,
})
const ctx = { tenantId: 'tenant-one', userId: 'user-one', role: 'owner' }
const tokenOf = (issued) => issued.url.split('/')[2]
const exposed = (status) => (error) => error.statusCode === status && error.expose === true

test('deliverable list exposes only HTML entries and snapshot metadata, with root index first', async () => {
  const { listDeliverables } = await load()
  assert.equal(typeof listDeliverables, 'function', 'deliverable listing must exist')
  assert.deepEqual(listDeliverables(null), { workspace: null, entries: [] })
  const files = [
    file('z.html', '<title>Z</title>'),
    file('a/二.htm', '<title>二</title>'),
    file('index.html', '<title>首页 &amp; &#x4F60;&#22909;</title>'),
    file('README.md', '# User notes'),
    file('invalid.html', [0xff, 0xfe]),
    file('style.css', 'body{}'),
    file('test/demo.html', '<title>Test</title>'),
  ]
  const result = listDeliverables(snapshot(files, { activeRunId: 'running' }))
  assert.deepEqual(result.workspace, {
    name: 'project',
    revision: 7,
    updatedAt: '2026-10-15T00:00:00.000Z',
    activeRunId: 'running',
  })
  assert.deepEqual(result.entries, [
    {
      path: 'index.html',
      title: '首页 & 你好',
      size: Buffer.byteLength('<title>首页 &amp; &#x4F60;&#22909;</title>'),
    },
    { path: 'a/二.htm', title: '二', size: Buffer.byteLength('<title>二</title>') },
    { path: 'z.html', title: 'Z', size: 16 },
  ])
  assert.doesNotMatch(JSON.stringify(result), /contentBase64|README/)
})

test('HTML titles are plain text, bounded by characters, and fall back to paths', async () => {
  const { listDeliverables } = await load()
  assert.equal(typeof listDeliverables, 'function')
  const result = listDeliverables(
    snapshot([
      file('a.html', '<TITLE>  A <b>B</b> &quot;C&quot; &apos;D&apos; &nbsp; </TITLE>'),
      file('b.html', `<title>${'龙'.repeat(90)}</title>`),
      file('c.html', '<p>No title</p>'),
      file('d.html', '<title>  </title>'),
    ]),
  )
  assert.deepEqual(
    result.entries.map((entry) => entry.title),
    ['A B "C" \'D\'', '龙'.repeat(80), 'c.html', 'd.html'],
  )
})

test('delivery filtering preserves static assets and excludes hidden, dependency, test and build metadata', async () => {
  const { deliveryFiles } = await load()
  assert.equal(typeof deliveryFiles, 'function')
  const allowed = [
    'index.html',
    'page.htm',
    'css/style.css',
    'src/app.js',
    'module.mjs',
    'data.json',
    'image.PNG',
    'a.jpeg',
    'a.jpg',
    'a.gif',
    'a.webp',
    'a.avif',
    'a.svg',
    'a.ico',
    'a.woff',
    'a.woff2',
    'a.ttf',
    'a.otf',
    'a.mp3',
    'a.wav',
    'a.ogg',
    'a.mp4',
    'a.webm',
  ]
  const excluded = [
    '.env.json',
    '.private/x.html',
    'node_modules/x/index.html',
    'test/index.html',
    'tests/demo.js',
    '__tests__/x.json',
    'x.test.js',
    'x.spec.mjs',
    'package.json',
    'package-lock.json',
    'nested/package.json',
    'README.md',
    'output.log',
    'source.ts',
    'report.pdf',
    'server/index.js',
    'backend/main.mjs',
    'logs/events.json',
    'server.js',
    'nested/server.mjs',
  ]
  const files = [...allowed, ...excluded].map((path) => file(path, path))
  assert.deepEqual(deliveryFiles(files), files.slice(0, allowed.length))
  assert.deepEqual(deliveryFiles([]), [])
})

test('delivery files inherit canonical path, file count, per-file and total snapshot limits', async () => {
  const { deliveryFiles } = await load()
  assert.equal(typeof deliveryFiles, 'function')
  for (const files of [
    [file('../index.html', '')],
    [file('index.html', ''), file('index.html', '')],
    [{ path: 'index.html', contentBase64: '%%%=' }],
    Array.from({ length: 201 }, (_, i) => file(`${i}.html`, '')),
    [file('large.html', Buffer.alloc(1024 * 1024 + 1))],
    Array.from({ length: 9 }, (_, i) => file(`${i}.png`, Buffer.alloc(1024 * 1024))),
  ])
    assert.throws(() => deliveryFiles(files), exposed(400))
})

test('preview issue freezes one revision and keeps public metadata free of files and owner details', async () => {
  const { createPreviewStore } = await load()
  assert.equal(typeof createPreviewStore, 'function')
  const store = createPreviewStore({ now: () => 1000, ttlMs: 5000 })
  const input = snapshot([
    file('作品 one/index.html', '<title>Original</title>'),
    file('style.css', 'before'),
  ])
  const owner = { ...ctx }
  const issued = store.issue(owner, input, '作品 one/index.html')
  assert.match(
    issued.url,
    /^\/project-preview\/[A-Za-z0-9_-]{43}\/%E4%BD%9C%E5%93%81%20one\/index.html$/,
  )
  assert.deepEqual(Object.keys(issued).sort(), ['entry', 'expiresAt', 'revision', 'title', 'url'])
  assert.equal(issued.expiresAt, '1970-01-01T00:00:06.000Z')
  assert.equal(issued.revision, 7)
  assert.equal(issued.entry, '作品 one/index.html')
  assert.equal(issued.title, 'Original')
  input.files[0].contentBase64 = Buffer.from('mutated').toString('base64')
  input.files.push(file('new.html', 'new'))
  input.revision = 8
  owner.tenantId = 'other-tenant'
  const found = store.lookup(tokenOf(issued), '作品 one/index.html')
  assert.equal(found.buffer.toString(), '<title>Original</title>')
  assert.deepEqual(found.ctx, { tenantId: 'tenant-one', userId: 'user-one' })
  assert.equal(found.mime, 'text/html; charset=utf-8')
  assert.equal(found.entry, '作品 one/index.html')
  assert.equal(found.title, 'Original')
  assert.equal(found.token, tokenOf(issued))
  assert.equal(found.expiresAt, issued.expiresAt)
  found.buffer.fill(0)
  found.ctx.tenantId = 'attempted mutation'
  assert.equal(
    store.lookup(tokenOf(issued), '作品 one/index.html').buffer.toString(),
    '<title>Original</title>',
  )
  assert.equal(store.lookup(tokenOf(issued), 'style.css').buffer.toString(), 'before')
  assert.equal(store.lookup(tokenOf(issued), 'style.css').ctx.tenantId, 'tenant-one')
  assert.throws(() => store.lookup(tokenOf(issued), 'new.html'), exposed(404))
})

test('preview lookup rejects traversal and aliases and never decodes a path a second time', async () => {
  const { createPreviewStore } = await load()
  assert.equal(typeof createPreviewStore, 'function')
  const store = createPreviewStore()
  const issued = store.issue(
    ctx,
    snapshot([
      file('index.html', 'ok'),
      file('encoded%2Fname.js', 'literal'),
      file('.private/key.json', 'private'),
      file('tests/test.js', 'test'),
    ]),
    'index.html',
  )
  for (const path of [
    '../index.html',
    '/index.html',
    'a/../index.html',
    'a\\index.html',
    'a//index.html',
    './index.html',
    'a./index.html',
    'C:/index.html',
    'CON.html',
    'index.html\0',
  ]) {
    assert.throws(
      () => store.lookup(tokenOf(issued), path),
      (error) => error.expose === true && [400, 404].includes(error.statusCode),
      path,
    )
  }
  assert.equal(store.lookup(tokenOf(issued), 'encoded%2Fname.js').buffer.toString(), 'literal')
  for (const path of ['encoded/name.js', '%69ndex.html', '.private/key.json', 'tests/test.js'])
    assert.throws(() => store.lookup(tokenOf(issued), path), exposed(404))
  assert.throws(() => store.lookup('unknown', 'index.html'), exposed(404))
})

test('previews serve exact assets belonging to that token with web MIME types', async () => {
  const { createPreviewStore } = await load()
  assert.equal(typeof createPreviewStore, 'function')
  const store = createPreviewStore()
  const one = store.issue(
    ctx,
    snapshot([
      file('index.html', 'one'),
      file('main.mjs', 'export default 1'),
      file('image.png', [0, 255, 1]),
    ]),
    'index.html',
  )
  const two = store.issue(
    { tenantId: 'other', userId: 'other' },
    snapshot([file('index.html', 'two'), file('second.js', 'two')]),
    'index.html',
  )
  assert.equal(store.lookup(tokenOf(one), 'main.mjs').mime, 'text/javascript; charset=utf-8')
  assert.deepEqual(store.lookup(tokenOf(one), 'image.png').buffer, Buffer.from([0, 255, 1]))
  assert.equal(store.lookup(tokenOf(one), 'image.png').mime, 'image/png')
  assert.equal(store.lookup(tokenOf(two), 'index.html').buffer.toString(), 'two')
  assert.throws(() => store.lookup(tokenOf(one), 'second.js'), exposed(404))
})

test('preview sessions expire at their deadline', async () => {
  const { createPreviewStore } = await load()
  assert.equal(typeof createPreviewStore, 'function')
  let current = 10
  const store = createPreviewStore({ now: () => current, ttlMs: 50 })
  const issued = store.issue(ctx, snapshot(), 'index.html')
  current = 59
  assert.ok(store.lookup(tokenOf(issued), 'index.html'))
  current = 60
  assert.throws(() => store.lookup(tokenOf(issued), 'index.html'), exposed(410))
})

test('preview store limits each user to two sessions even across tenant memberships', async () => {
  const { createPreviewStore } = await load()
  assert.equal(typeof createPreviewStore, 'function')
  const store = createPreviewStore()
  const first = store.issue(ctx, snapshot(), 'index.html')
  const second = store.issue({ ...ctx, tenantId: 'two' }, snapshot(), 'index.html')
  const third = store.issue(ctx, snapshot(), 'index.html')
  assert.throws(() => store.lookup(tokenOf(first), 'index.html'), exposed(404))
  assert.ok(store.lookup(tokenOf(second), 'index.html'))
  assert.ok(store.lookup(tokenOf(third), 'index.html'))
})

test('preview store evicts the oldest sessions at the global count and decoded-byte caps', async () => {
  const { createPreviewStore } = await load()
  assert.equal(typeof createPreviewStore, 'function')
  for (const options of [{ maxSessions: 2 }, { maxBytes: 7 }]) {
    const store = createPreviewStore(options)
    const ids = ['one', 'two', 'three'].map((userId) =>
      store.issue({ ...ctx, userId }, snapshot([file('index.html', 'abc')]), 'index.html'),
    )
    assert.throws(() => store.lookup(tokenOf(ids[0]), 'index.html'), exposed(404))
    assert.equal(store.lookup(tokenOf(ids[1]), 'index.html').buffer.toString(), 'abc')
    assert.equal(store.lookup(tokenOf(ids[2]), 'index.html').buffer.toString(), 'abc')
  }
})

test('preview byte accounting excludes filtered files, reclaims expired data, and rejects one oversized session', async () => {
  const { createPreviewStore } = await load()
  assert.equal(typeof createPreviewStore, 'function')
  let current = 0
  const store = createPreviewStore({ now: () => current, ttlMs: 10, maxBytes: 4 })
  const first = store.issue(
    ctx,
    snapshot([file('index.html', 'abcd'), file('tests/x.js', 'excluded')]),
    'index.html',
  )
  assert.throws(
    () => store.issue(ctx, snapshot([file('index.html', 'abcde')]), 'index.html'),
    exposed(413),
  )
  assert.ok(store.lookup(tokenOf(first), 'index.html'))
  current = 10
  const next = store.issue(ctx, snapshot([file('index.html', 'abcd')]), 'index.html')
  assert.ok(store.lookup(tokenOf(next), 'index.html'))
  assert.throws(
    () => store.lookup(tokenOf(first), 'index.html'),
    (error) => [404, 410].includes(error.statusCode),
  )
})

test('only a present, valid UTF-8 HTML entry may be selected for preview or download', async () => {
  const { createPreviewStore, productZip } = await load()
  assert.equal(typeof createPreviewStore, 'function')
  assert.equal(typeof productZip, 'function')
  const input = snapshot([
    file('index.html', 'ok'),
    file('app.js', 'code'),
    file('bad.html', [0xff]),
  ])
  for (const entry of ['../index.html', 'app.js', 'missing.html', 'bad.html']) {
    assert.throws(
      () => createPreviewStore().issue(ctx, input, entry),
      (error) => error.expose && [400, 404].includes(error.statusCode),
    )
    await assert.rejects(
      productZip(input, entry),
      (error) => error.expose && [400, 404].includes(error.statusCode),
    )
  }
})

test('preview security headers isolate scripts, restrict asset URLs to this token, and allow opaque-origin modules', async () => {
  const { previewHeaders } = await load()
  assert.equal(typeof previewHeaders, 'function')
  const token = 'a'.repeat(43)
  const headers = previewHeaders({ origin: 'https://office.example', token })
  const directives = Object.fromEntries(
    headers['content-security-policy']
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter(([key]) => key)
      .map(([key, ...values]) => [key, values]),
  )
  const prefix = `https://office.example/project-preview/${token}/`
  assert.deepEqual(directives['default-src'], ["'none'"])
  assert.deepEqual(directives.sandbox, ['allow-scripts'])
  assert.deepEqual(directives['script-src'], [prefix, "'unsafe-inline'"])
  assert.deepEqual(directives['style-src'], [prefix, "'unsafe-inline'"])
  for (const type of ['img-src', 'media-src', 'font-src'])
    assert.deepEqual(directives[type], [prefix, 'data:'])
  for (const type of [
    'connect-src',
    'worker-src',
    'frame-src',
    'object-src',
    'base-uri',
    'form-action',
  ])
    assert.deepEqual(directives[type], ["'none'"])
  assert.deepEqual(directives['frame-ancestors'], ["'self'"])
  assert.equal(headers['referrer-policy'], 'no-referrer')
  assert.equal(headers['x-content-type-options'], 'nosniff')
  assert.equal(headers['cache-control'], 'no-store')
  assert.equal(headers['cross-origin-resource-policy'], 'cross-origin')
  assert.equal(headers['access-control-allow-origin'], '*')
  assert.equal(headers['access-control-allow-credentials'], undefined)
})

test('product ZIP contains only launch instructions and byte-identical static website assets', async () => {
  const { productZip } = await load()
  assert.equal(typeof productZip, 'function')
  const html = '<title>用户作品</title><img src="../image.png">'
  const input = snapshot([
    file('展示 one/a&\'\".html', html),
    file('image.png', [0, 255, 19]),
    file('app.mjs', 'export default 42'),
    file('README.md', 'user original README'),
    file('tests/index.html', 'test'),
    file('package.json', '{}'),
    file('.env.json', 'secret'),
  ])
  const before = structuredClone(input)
  const buffer = await productZip(input, '展示 one/a&\'\".html')
  assert.ok(Buffer.isBuffer(buffer))
  const { files } = await zipFiles(buffer)
  assert.deepEqual(
    [...files.keys()].sort(),
    [
      '使用说明.txt',
      '打开作品.html',
      'website/展示 one/a&\'\".html',
      'website/image.png',
      'website/app.mjs',
    ].sort(),
  )
  assert.equal(files.get('website/展示 one/a&\'\".html').toString(), html)
  assert.deepEqual(files.get('website/image.png'), Buffer.from([0, 255, 19]))
  assert.equal(files.get('website/app.mjs').toString(), 'export default 42')
  const launcher = files.get('打开作品.html').toString()
  const href = /href="([^"]+)"/.exec(launcher)?.[1]
  assert.ok(href)
  assert.equal(
    decodeURIComponent(href.replaceAll('&#39;', "'").replaceAll('&amp;', '&')),
    'website/展示 one/a&\'\".html',
  )
  assert.doesNotMatch(launcher, /<script\b/i)
  const guide = files.get('使用说明.txt').toString()
  assert.match(guide, /解压/)
  assert.match(guide, /打开作品\.html/)
  assert.match(guide, /python(?:3)? -m http\.server/)
  assert.match(guide, /模块/)
  assert.deepEqual(input, before)
})
