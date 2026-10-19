import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createServer as httpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
let vite, browser, http, origin
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
        name: 'record-test',
        resolveId: (id) => (id === '/__records.js' ? id : undefined),
        load: (id) =>
          id === '/__records.js'
            ? `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {ArchiveRegistration} from '/src/saas/ArchiveRegistration.tsx';import {ArchiveRegistry} from '/src/saas/ArchiveRegistry.tsx';const root=createRoot(document.getElementById('root'));window.editor=(suggestion,base='/api/tenants/test')=>flushSync(()=>root.render(React.createElement(ArchiveRegistration,{key:base+suggestion.id,base,suggestion,disabled:false})));window.registry=(base='/api/tenants/test')=>flushSync(()=>root.render(React.createElement(ArchiveRegistry,{key:base,base})));window.ready=true;`
            : undefined,
      },
    ],
  })
})
after(async () => {
  await browser?.close()
  await new Promise((r) => (http ? http.close(r) : r()))
  await vite?.close()
})
const suggestion = {
  id: 'suggestion-a',
  state: 'ready',
  source: { fileId: 'file-a', extractionId: 'extract-a', sha256: 'hash-a', name: '原件.docx' },
  archiveNumber: 'ZL-2026-000001',
  archiveYear: '2026',
  result: {
    title: '借阅制度',
    department: '资料室',
    category: '制度流程',
    tags: ['借阅'],
    reason: '制度规定。',
    needsReview: false,
    citations: [],
    coverage: '全部正文',
    warnings: [],
    recommendedName: '借阅制度.docx',
    directory: '资料室/制度流程/2026',
  },
}
const metadata = {
  title: '核对后的制度',
  department: '资料室',
  category: '制度流程',
  tags: ['内部', '借阅'],
  note: '确认内容',
}
const record = {
  id: 'record-a',
  suggestionId: suggestion.id,
  state: 'draft',
  revision: 1,
  metadata,
  archiveNumber: suggestion.archiveNumber,
  archiveYear: '2026',
  filename: '核对后的制度_ZL-2026-000001.docx',
  directory: '资料室/制度流程/2026',
  relativePath: '资料室/制度流程/2026/核对后的制度_ZL-2026-000001.docx',
  source: suggestion.source,
  archivedAt: null,
  confirmedBy: null,
  evidence: suggestion.result,
}
const opt = { skip: process.env.ARCHIVE_UI_BROWSER_TESTS !== '1' }
test(
  'source validation failure on reload blocks saving and confirmation until a successful reload',
  opt,
  async () => {
    const p = await page()
    try {
      let failure = false
      await p.route('**/api/**', (r) =>
        r.fulfill(
          failure ? { status: 409, json: { error: '原文件校验不一致' } } : { json: { record } },
        ),
      )
      await p.evaluate((s) => window.editor(s), suggestion)
      await p.getByRole('button', { name: '修改并归档', exact: true }).click()
      await p.getByLabel('归档主题', { exact: true }).waitFor()
      assert.equal(await p.getByRole('button', { name: '确认归档', exact: true }).isEnabled(), true)
      failure = true
      await p.getByRole('button', { name: '重新载入（会覆盖当前修改）', exact: true }).click()
      await p.getByRole('alert').filter({ hasText: '原文件校验不一致' }).waitFor()
      assert.equal(
        await p.getByRole('button', { name: '确认归档', exact: true }).isEnabled(),
        false,
      )
      assert.equal(
        await p.getByRole('button', { name: '保存归档草稿', exact: true }).isEnabled(),
        false,
      )
      assert.equal(await p.getByLabel('归档主题', { exact: true }).inputValue(), metadata.title)
      failure = false
      await p.getByRole('button', { name: '重新载入（会覆盖当前修改）', exact: true }).click()
      await p.getByRole('button', { name: '确认归档', exact: true }).waitFor()
      await p.waitForFunction(
        () =>
          !Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '确认归档')
            .disabled,
      )
    } finally {
      await p.close()
    }
  },
)
async function page() {
  if (!browser) {
    http = httpServer((req, res) => {
      if (req.url === '/test') {
        res.setHeader('Content-Type', 'text/html')
        res.end('<div id="root"></div><script type="module" src="/__records.js"></script>')
      } else vite.middlewares(req, res)
    })
    await new Promise((r) => http.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${http.address().port}`
    browser = await (
      await import('playwright')
    ).chromium.launch({ headless: true, channel: 'msedge' })
  }
  const p = await browser.newPage()
  p.setDefaultTimeout(5000)
  await p.goto(origin + '/test')
  await p.waitForFunction(() => window.ready)
  return p
}
test(
  'record editor saves edited metadata and confirms only saved revision; formal record persists',
  opt,
  async () => {
    const p = await page()
    try {
      const calls = []
      let saved = null
      await p.route('**/api/**', (r) => {
        calls.push(r.request())
        if (r.request().method() === 'POST') {
          saved = r.request().url().endsWith('/confirm')
            ? {
                ...record,
                state: 'archived',
                archivedAt: '2026-10-17T00:00:00Z',
                confirmedBy: 'user',
              }
            : { ...record, metadata: r.request().postDataJSON().metadata }
        }
        return r.fulfill({ json: { record: saved } })
      })
      await p.evaluate((s) => window.editor(s), suggestion)
      await p.getByRole('button', { name: '修改并归档', exact: true }).click()
      await p.getByLabel('归档主题', { exact: true }).fill(metadata.title)
      await p.getByLabel('归档标签', { exact: true }).fill('内部、借阅')
      await p.getByLabel('归档说明', { exact: true }).fill(metadata.note)
      assert.equal(
        await p.getByRole('button', { name: '确认归档', exact: true }).isEnabled(),
        false,
      )
      await p.getByRole('button', { name: '保存归档草稿', exact: true }).click()
      await p.getByRole('button', { name: '确认归档', exact: true }).waitFor()
      await p.getByRole('button', { name: '确认归档', exact: true }).click()
      await p.getByText('已正式归档', { exact: true }).waitFor()
      assert.equal(calls.filter((c) => c.method() === 'POST').length, 2)
      assert.deepEqual(calls.find((c) => c.url().endsWith('/confirm')).postDataJSON(), {
        revision: 1,
      })
      assert.equal(await p.getByLabel('归档主题', { exact: true }).isEnabled(), false)
    } finally {
      await p.close()
    }
  },
)
test(
  'failed save retains input, dirty edits disable confirmation and late tenant reads cannot overwrite new form',
  opt,
  async () => {
    const p = await page()
    try {
      await p.route('**/api/**', (r) =>
        r.fulfill(
          r.request().method() === 'POST'
            ? { status: 409, json: { error: '草稿已更新' } }
            : { json: { record } },
        ),
      )
      await p.evaluate((s) => window.editor(s), suggestion)
      await p.getByRole('button', { name: '修改并归档', exact: true }).click()
      await p.getByLabel('归档主题', { exact: true }).fill('未保存草稿')
      assert.equal(
        await p.getByRole('button', { name: '确认归档', exact: true }).isEnabled(),
        false,
      )
      await p.getByRole('button', { name: '保存归档草稿', exact: true }).click()
      await p.getByRole('alert').filter({ hasText: '草稿已更新' }).waitFor()
      assert.equal(await p.getByLabel('归档主题', { exact: true }).inputValue(), '未保存草稿')
      let old, entered
      const start = new Promise((r) => (entered = r))
      await p.unroute('**/api/**')
      await p.route('**/api/**', (r) => {
        if (r.request().url().includes('/old/')) {
          old = r
          entered()
          return
        }
        return r.fulfill({ json: { record: null } })
      })
      await p.evaluate((s) => window.editor(s, '/api/tenants/old'), suggestion)
      await p.getByRole('button', { name: '修改并归档', exact: true }).click()
      await start
      await p.evaluate((s) => window.editor(s, '/api/tenants/new'), {
        ...suggestion,
        id: 'new-suggestion',
      })
      await p.getByRole('button', { name: '修改并归档', exact: true }).click()
      await old.fulfill({ json: { record } })
      await p.getByLabel('归档主题', { exact: true }).waitFor()
      assert.equal(await p.getByLabel('归档主题', { exact: true }).inputValue(), '借阅制度')
    } finally {
      await p.close()
    }
  },
)
test(
  'registry combines category tag and keyword, displays validated detail and ignores stale search responses',
  opt,
  async () => {
    const p = await page()
    try {
      const queries = []
      const archived = {
        ...record,
        state: 'archived',
        archivedAt: '2026-10-17T00:00:00Z',
        confirmedBy: 'user',
      }
      await p.route('**/api/**', (r) => {
        const u = new URL(r.request().url())
        queries.push(u)
        return r.fulfill({
          json: u.pathname.endsWith('/record-a')
            ? { record: archived }
            : { items: [archived], total: 1, page: 1, pageSize: 20 },
        })
      })
      await p.evaluate(() => window.registry())
      await p.getByRole('button', { name: '查看档案', exact: true }).waitFor()
      await p.getByLabel('按资料类型', { exact: true }).selectOption('制度流程')
      await p.getByLabel('按标签', { exact: true }).fill('内部')
      await p.getByLabel('档案关键词', { exact: true }).fill('制度')
      await p.getByRole('button', { name: '检索档案', exact: true }).click()
      await p.getByRole('button', { name: '查看档案', exact: true }).click()
      await p.getByRole('link', { name: '下载归档原件', exact: true }).waitFor()
      assert.ok(
        queries.some(
          (u) =>
            u.searchParams.get('category') === '制度流程' &&
            u.searchParams.get('tag') === '内部' &&
            u.searchParams.get('q') === '制度',
        ),
      )
      let stale, entered
      const arrived = new Promise((r) => (entered = r))
      await p.unroute('**/api/**')
      await p.route('**/api/**', (r) => {
        if (new URL(r.request().url()).searchParams.get('q') === '旧查询') {
          stale = r
          entered()
          return
        }
        return r.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 20 } })
      })
      await p.getByLabel('档案关键词', { exact: true }).fill('旧查询')
      await p.getByRole('button', { name: '检索档案', exact: true }).click()
      await arrived
      await p.getByLabel('档案关键词', { exact: true }).fill('新查询')
      await p.getByRole('button', { name: '检索档案', exact: true }).click()
      await p.getByText('没有符合条件的正式档案。', { exact: true }).waitFor()
      await stale.fulfill({ json: { items: [archived], total: 1, page: 1, pageSize: 20 } })
      assert.equal(await p.getByRole('button', { name: '查看档案', exact: true }).count(), 0)
    } finally {
      await p.close()
    }
  },
)
