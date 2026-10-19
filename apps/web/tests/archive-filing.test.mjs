import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createServer as httpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
let vite, helpers, browser, http, origin
before(async () => {
  vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    esbuild: { jsx: 'automatic' },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    plugins: [
      {
        name: 'filing-test',
        resolveId: (id) => (id === '/__filing.js' ? id : undefined),
        load(id) {
          if (id !== '/__filing.js') return
          return `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {ArchiveFiling} from '/src/saas/ArchiveFiling.tsx';import {ArchiveDocuments} from '/src/saas/ArchiveDocuments.tsx';const root=createRoot(document.getElementById('root'));window.mount=(documents,selectedIds,base='/api/tenants/test')=>flushSync(()=>root.render(React.createElement(ArchiveFiling,{base,documents,selectedIds,disabled:false})));window.mountDocuments=()=>flushSync(()=>root.render(React.createElement(ArchiveDocuments,{base:'/api/tenants/test',disabled:false,onSelectionChange:()=>{}})));window.ready=true;`
        },
      },
    ],
  })
  helpers = await vite.ssrLoadModule('/src/saas/archive-filing.ts').catch(() => ({}))
})
after(async () => {
  await browser?.close()
  await new Promise((r) => (http ? http.close(r) : r()))
  await vite?.close()
})
const doc = (id = 'a') => ({
  fileId: id,
  name: `${id}.docx`,
  extractionId: `extract-${id}`,
  sha256: `hash-${id}`,
  kind: 'docx',
  state: 'ready',
  size: 12,
  createdAt: '',
  mime: '',
  warnings: [],
  error: null,
  blockCount: 1,
})
const suggestion = (id = 'a') => ({
  id: `filing-${id}`,
  state: 'ready',
  source: { ...doc(id), parserVersion: '1', ocr: false },
  archiveNumber: `ZL-2026-${id}`,
  archiveYear: '2026',
  createdAt: '',
  updatedAt: '',
  result: {
    title: '借阅制度',
    department: '资料室',
    category: '制度流程',
    tags: ['借阅', '归档'],
    reason: '规定借阅流程。',
    needsReview: false,
    citations: [],
    coverage: '全部已提取正文',
    warnings: [],
    recommendedName: `借阅制度_ZL-2026-${id}.docx`,
    directory: '资料室/制度流程/2026',
    relativePath: `资料室/制度流程/2026/借阅制度_ZL-2026-${id}.docx`,
  },
})
test('filing export includes only current matching ready documents and marks incomplete recommendation scope', () => {
  assert.equal(typeof helpers.filingDirectoryText, 'function')
  const a = suggestion('a'),
    b = suggestion('b')
  const text = helpers.filingDirectoryText(
    [doc('a'), doc('b')],
    [a, { ...b, source: { ...b.source, sha256: 'stale' } }],
  )
  assert.match(text, /1\/2/)
  assert.match(text, /建议/)
  assert.match(text, /借阅制度_ZL-2026-a/)
  assert.ok(!text.includes('ZL-2026-b'))
  assert.match(text, /hash-a/)
  assert.match(text, /借阅/)
  assert.equal(helpers.matchesFilingSuggestion(a, doc('b')), false)
  assert.equal(helpers.matchesFilingSuggestion(a, doc('a')), true)
})
const opt = { skip: process.env.ARCHIVE_UI_BROWSER_TESTS !== '1' }
async function page() {
  if (!browser) {
    http = httpServer((req, res) => {
      if (req.url === '/test') {
        res.setHeader('Content-Type', 'text/html')
        res.end('<div id="root"></div><script type="module" src="/__filing.js"></script>')
      } else vite.middlewares(req, res)
    })
    await new Promise((r) => http.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${http.address().port}`
    const { chromium } = await import('playwright')
    browser = await chromium.launch({
      headless: true,
      channel: process.env.ARCHIVE_UI_BROWSER_CHANNEL || 'msedge',
    })
  }
  const p = await browser.newPage()
  p.setDefaultTimeout(5000)
  await p.goto(origin + '/test')
  await p.waitForFunction(() => window.ready)
  return p
}
test(
  'existing document workspace exposes filing tool for selected uploaded documents',
  opt,
  async () => {
    const p = await page()
    try {
      await p.route('**/api/**', (r) => r.fulfill({ json: { items: [doc('a')] } }))
      await p.evaluate(() => window.mountDocuments())
      await p.getByRole('button', { name: '归档建议', exact: true }).click()
      assert.ok(await p.getByRole('heading', { name: '分类与归档建议' }).isVisible())
    } finally {
      await p.close()
    }
  },
)
test(
  'filing renders cached recommendations and a sequential generation with downloadable directory',
  opt,
  async () => {
    const p = await page()
    const requests = []
    try {
      await p.route('**/api/**', async (route) => {
        const id = new URL(route.request().url()).pathname.split('/').at(-2)
        requests.push(`${route.request().method()}:${id}`)
        await route.fulfill({
          json: {
            suggestion: route.request().method() === 'GET' && id === 'b' ? null : suggestion(id),
          },
        })
      })
      await p.evaluate((d) => window.mount(d, ['a', 'b']), [doc('a'), doc('b')])
      await p.getByText('ZL-2026-a', { exact: true }).waitFor()
      await p.getByRole('button', { name: '生成归档建议', exact: true }).click()
      await p.getByText('ZL-2026-b', { exact: true }).waitFor()
      assert.deepEqual(
        requests.filter((r) => r.startsWith('POST')),
        ['POST:b'],
      )
      assert.ok(await p.getByText('借阅制度_ZL-2026-a.docx', { exact: true }).isVisible())
      const download = p.waitForEvent('download')
      await p.getByRole('button', { name: '下载归档目录', exact: true }).click()
      assert.equal((await download).suggestedFilename(), '归档目录-建议.txt')
      assert.equal(
        await p.getByRole('button', { name: '生成归档建议', exact: true }).isEnabled(),
        false,
      )
    } finally {
      await p.close()
    }
  },
)
test(
  'filing failure stays visible; stale selection response is excluded and stops later paid calls',
  opt,
  async () => {
    const p = await page()
    let release, entered
    const started = new Promise((r) => (entered = r)),
      pending = new Promise((r) => (release = r))
    const posts = []
    try {
      await p.route('**/api/**', async (route) => {
        const id = new URL(route.request().url()).pathname.split('/').at(-2)
        if (route.request().method() === 'POST') {
          posts.push(id)
          entered()
          await pending
          await route.fulfill({ json: { suggestion: suggestion(id) } }).catch(() => {})
        } else await route.fulfill({ json: { suggestion: null } })
      })
      await p.evaluate((d) => window.mount(d, ['a', 'b']), [doc('a'), doc('b')])
      await p.getByRole('button', { name: '生成归档建议', exact: true }).click()
      await started
      await p.evaluate((d) => window.mount(d, ['c']), [doc('c')])
      release()
      await p.getByText('c.docx', { exact: true }).waitFor()
      assert.equal(await p.getByText('ZL-2026-a', { exact: true }).count(), 0)
      assert.deepEqual(posts, ['a'])
      await p.unroute('**/api/**')
      await p.route('**/api/**', (route) =>
        route.fulfill(
          route.request().method() === 'POST'
            ? { status: 502, json: { error: '模型服务未完成请求' } }
            : { json: { suggestion: null } },
        ),
      )
      await p.getByRole('button', { name: '生成归档建议', exact: true }).click()
      await p.getByRole('alert').filter({ hasText: '模型服务未完成请求' }).waitFor()
      assert.equal(
        await p.getByRole('button', { name: '生成归档建议', exact: true }).isEnabled(),
        true,
      )
    } finally {
      release?.()
      await p.close()
    }
  },
)
test(
  'filing rejects source mismatches and tenant changes discard old saved responses',
  opt,
  async () => {
    const p = await page()
    try {
      await p.route('**/api/**', (route) =>
        route.fulfill({
          json: {
            suggestion: {
              ...suggestion('a'),
              source: { ...suggestion('a').source, sha256: 'wrong' },
            },
          },
        }),
      )
      await p.evaluate((d) => window.mount(d, ['a']), [doc('a')])
      await p.getByRole('alert').filter({ hasText: '来源' }).waitFor()
      assert.equal(await p.getByText('ZL-2026-a', { exact: true }).count(), 0)
      await p.unroute('**/api/**')
      let oldRoute, arrived
      const arrival = new Promise((r) => (arrived = r))
      await p.route('**/api/**', (route) => {
        if (route.request().url().includes('/old/')) {
          oldRoute = route
          arrived()
          return
        }
        return route.fulfill({ json: { suggestion: suggestion('b') } })
      })
      await p.evaluate((d) => window.mount(d, ['a'], '/api/tenants/old'), [doc('a')])
      await arrival
      await p.evaluate((d) => window.mount(d, ['b'], '/api/tenants/new'), [doc('b')])
      await p.getByText('ZL-2026-b', { exact: true }).waitFor()
      await oldRoute.fulfill({ json: { suggestion: suggestion('a') } })
      assert.equal(await p.getByText('ZL-2026-a', { exact: true }).count(), 0)
    } finally {
      await p.close()
    }
  },
)
