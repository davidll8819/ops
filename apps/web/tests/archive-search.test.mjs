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
        name: 'archive-chat-test',
        resolveId: (id) => (id === '/__search.js' ? id : undefined),
        load: (id) =>
          id === '/__search.js'
            ? `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {DepartmentChat} from '/src/saas/DepartmentChat.tsx';const root=createRoot(document.getElementById('root'));window.mountChat=(base='/api/tenants/test')=>flushSync(()=>root.render(React.createElement(DepartmentChat,{base,department:'archive',archiveDocuments:true,openSettings:()=>{}})));window.ready=true;`
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
const opt = { skip: process.env.ARCHIVE_UI_BROWSER_TESTS !== '1' }
const heldComparison = () => ({
  id: 'comparison-held',
  createdAt: '2026-10-17T00:00:00Z',
  oldVersion: { ...doc('a'), parserVersion: 'v1', ocr: false },
  newVersion: { ...doc('b'), parserVersion: 'v1', ocr: false },
  algorithmVersion: 'text-diff-1',
  stats: { added: 0, removed: 0, modified: 0, unchanged: 1 },
  overview: '未变化1块',
  warnings: [],
  hunks: [],
})
test(
  'a comparison started before archive scope cannot activate after archive scope is enabled',
  opt,
  async () => {
    const p = await page()
    let held, entered
    const started = new Promise((r) => (entered = r))
    try {
      await p.route('**/api/**', (r) => {
        if (r.request().method() === 'POST') {
          held = r
          entered()
          return
        }
        return responder(r)
      })
      await p.evaluate(() => window.mountChat())
      await p.getByLabel('旧版文档', { exact: true }).selectOption('a')
      await p.getByLabel('新版文档', { exact: true }).selectOption('b')
      await p.getByRole('button', { name: '开始比对', exact: true }).click()
      await started
      await p.getByRole('checkbox', { name: '检索已归档资料', exact: true }).check()
      const response = p.waitForResponse((r) => r.request().method() === 'POST')
      await held.fulfill({ json: { comparison: heldComparison() } })
      await (await response).finished()
      await p.getByRole('button', { name: '开始比对', exact: true }).waitFor()
      assert.equal(
        await p.getByRole('checkbox', { name: '检索已归档资料', exact: true }).isChecked(),
        true,
      )
      assert.equal(await p.getByRole('button', { name: '退出比对问答', exact: true }).count(), 0)
    } finally {
      await p.close()
    }
  },
)
test(
  'archive answer in flight locks comparison controls and historical activation while keeping result visible',
  opt,
  async () => {
    const p = await page()
    let held, entered
    const started = new Promise((r) => (entered = r))
    try {
      await p.route('**/api/**', (r) => {
        if (r.request().method() === 'POST') {
          held = r
          entered()
          return
        }
        return responder(r, {
          revision: 1,
          messages: [
            { id: 'old', role: 'assistant', text: '历史比对', comparison: heldComparison() },
          ],
        })
      })
      await p.evaluate(() => window.mountChat())
      await p.getByLabel('旧版文档', { exact: true }).selectOption('a')
      await p.getByLabel('新版文档', { exact: true }).selectOption('b')
      await p.getByRole('checkbox', { name: '检索已归档资料', exact: true }).check()
      await p.getByRole('textbox', { name: '工作要求', exact: true }).fill('借阅期限')
      await p.getByRole('button', { name: '发送', exact: true }).click()
      await started
      assert.equal(
        await p.getByRole('button', { name: '开始比对', exact: true }).isEnabled(),
        false,
      )
      assert.equal(
        await p.getByRole('button', { name: '查看本次比对', exact: true }).isEnabled(),
        false,
      )
      assert.equal(await p.getByLabel('旧版文档', { exact: true }).isEnabled(), false)
      await held.fulfill({ json: { revision: 2, messages: [message] } })
      await p.getByText('借阅期限为9天。[1]', { exact: true }).waitFor()
      assert.equal(
        await p.getByRole('checkbox', { name: '检索已归档资料', exact: true }).isChecked(),
        true,
      )
    } finally {
      await p.close()
    }
  },
)
test(
  'archived search and comparison scope are mutually exclusive without clearing draft',
  opt,
  async () => {
    const p = await page()
    try {
      const c = {
        id: 'comparison-1',
        createdAt: '2026-10-17T00:00:00Z',
        oldVersion: { ...doc('a'), parserVersion: 'v1', ocr: false },
        newVersion: { ...doc('b'), parserVersion: 'v1', ocr: false },
        algorithmVersion: 'text-diff-1',
        stats: { added: 0, removed: 0, modified: 0, unchanged: 1 },
        overview: '未变化1块',
        warnings: [],
        hunks: [],
      }
      await p.route('**/api/**', (r) =>
        r.request().method() === 'POST' ? r.fulfill({ json: { comparison: c } }) : responder(r),
      )
      await p.evaluate(() => window.mountChat())
      await p.getByRole('textbox', { name: '工作要求', exact: true }).fill('保留当前草稿')
      await p.getByLabel('旧版文档', { exact: true }).selectOption('a')
      await p.getByLabel('新版文档', { exact: true }).selectOption('b')
      await p.getByRole('button', { name: '开始比对', exact: true }).click()
      await p.getByRole('button', { name: '退出比对问答', exact: true }).waitFor()
      await p.getByRole('checkbox', { name: '检索已归档资料', exact: true }).check()
      assert.equal(await p.getByRole('button', { name: '退出比对问答', exact: true }).count(), 0)
      await p.getByRole('button', { name: '开始比对', exact: true }).click()
      await p.getByRole('button', { name: '退出比对问答', exact: true }).waitFor()
      assert.equal(
        await p.getByRole('checkbox', { name: '检索已归档资料', exact: true }).isChecked(),
        false,
      )
      assert.equal(
        await p.getByRole('textbox', { name: '工作要求', exact: true }).inputValue(),
        '保留当前草稿',
      )
    } finally {
      await p.close()
    }
  },
)
const doc = (id) => ({
  fileId: id,
  name: `${id}.docx`,
  extractionId: 'extract-' + id,
  sha256: 'hash-' + id,
  state: 'ready',
  kind: 'docx',
  size: 20,
  createdAt: '',
  mime: '',
  warnings: [],
  blockCount: 1,
})
const ref = {
  query: '借阅期限是多少',
  matchedCount: 1,
  records: [
    {
      id: 'record-a',
      archiveNumber: 'ZL-2026-000002',
      filename: '正式制度.docx',
      fileId: 'a',
      extractionId: 'extract-a',
      sha256: 'hash-a',
    },
  ],
}
const citation = {
  id: '1',
  fileId: 'a',
  extractionId: 'extract-a',
  sha256: 'hash-a',
  filename: 'a.docx',
  blockId: 'p1',
  location: '段落 1',
  quote: '借阅期限为9天。',
  archiveRecordId: 'record-a',
  archiveNumber: 'ZL-2026-000002',
  archiveName: '正式制度.docx',
}
const message = {
  id: 'answer',
  role: 'assistant',
  text: '借阅期限为9天。[1]',
  archiveSearch: ref,
  citations: [citation],
  documentCoverage: '匹配1份，本轮使用1份相关档案摘录。',
}
async function page() {
  if (!browser) {
    http = httpServer((req, res) => {
      if (req.url === '/test') {
        res.setHeader('Content-Type', 'text/html')
        res.end('<div id="root"></div><script type="module" src="/__search.js"></script>')
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
const responder = (route, conversation = { revision: 0, messages: [] }) => {
  const path = new URL(route.request().url()).pathname
  return route.fulfill({
    json: path.endsWith('/conversation')
      ? conversation
      : path.endsWith('/documents')
        ? { items: [doc('a'), doc('b')] }
        : { items: [] },
  })
}
test(
  'archive conversation toggle sends archiveSearch without selected files, retains draft and restores normal file mode',
  opt,
  async () => {
    const p = await page()
    try {
      const payloads = []
      await p.route('**/api/**', (r) => {
        if (r.request().method() === 'POST') {
          payloads.push(r.request().postDataJSON())
          return r.fulfill({ json: { revision: payloads.length, messages: [message] } })
        }
        return responder(r)
      })
      await p.evaluate(() => {
        localStorage.setItem('office:archive-selection:/api/tenants/test', '["a"]')
        window.mountChat()
      })
      await p.getByRole('textbox', { name: '工作要求', exact: true }).fill('借阅期限是多少')
      await p.getByRole('checkbox', { name: '检索已归档资料', exact: true }).check()
      assert.equal(
        await p.getByRole('textbox', { name: '工作要求', exact: true }).inputValue(),
        '借阅期限是多少',
      )
      await p.getByRole('button', { name: '发送', exact: true }).click()
      await p.getByText('借阅期限为9天。[1]', { exact: true }).waitFor()
      assert.equal(payloads[0].archiveSearch, true)
      assert.equal('fileIds' in payloads[0], false)
      await p.getByRole('checkbox', { name: '检索已归档资料', exact: true }).uncheck()
      await p.getByRole('textbox', { name: '工作要求', exact: true }).fill('继续读取选中文档')
      await p.getByRole('button', { name: '发送', exact: true }).click()
      await p.waitForFunction(() => document.querySelector('textarea').value === '')
      assert.deepEqual(payloads[1].fileIds, ['a'])
      assert.equal('archiveSearch' in payloads[1], false)
    } finally {
      await p.close()
    }
  },
)
test(
  'restored archive answers label record number, location and original quote with validated source preview',
  opt,
  async () => {
    const p = await page()
    try {
      await p.route('**/api/**', (r) => {
        if (new URL(r.request().url()).pathname.endsWith('/documents/a'))
          return r.fulfill({
            json: {
              document: {
                ...doc('a'),
                blocks: [{ id: 'p1', location: '段落 1', text: '借阅期限为9天。' }],
              },
            },
          })
        return responder(r, { revision: 1, messages: [message] })
      })
      await p.evaluate(() => window.mountChat())
      await p.getByText('借阅期限为9天。[1]', { exact: true }).waitFor()
      const source = p.locator('summary').filter({ hasText: 'ZL-2026-000002' })
      await source.waitFor()
      assert.match(await source.innerText(), /a\.docx.*段落 1/)
      await source.click()
      await p.getByRole('button', { name: '查看该位置正文', exact: true }).click()
      await p.locator('.archive-source-block').waitFor()
      assert.equal(await p.locator('blockquote').innerText(), '借阅期限为9天。')
      assert.ok(await p.getByText('正式制度.docx', { exact: false }).count())
    } finally {
      await p.close()
    }
  },
)
test(
  'archive search pending mode is locked, no-hit state is honest and tenant changes discard late private answers',
  opt,
  async () => {
    const p = await page()
    let pending, entered
    const started = new Promise((r) => (entered = r))
    try {
      await p.route('**/api/**', (r) => {
        if (r.request().method() === 'POST') {
          pending = r
          entered()
          return
        }
        return responder(r)
      })
      await p.evaluate(() => window.mountChat())
      await p.getByRole('checkbox', { name: '检索已归档资料', exact: true }).check()
      await p.getByRole('textbox', { name: '工作要求', exact: true }).fill('火星轨道')
      await p.getByRole('button', { name: '发送', exact: true }).click()
      await started
      assert.equal(
        await p.getByRole('checkbox', { name: '检索已归档资料', exact: true }).isEnabled(),
        false,
      )
      await pending.fulfill({
        json: {
          revision: 1,
          messages: [
            {
              ...message,
              text: '本轮未找到可用的相关正式档案摘录。',
              archiveSearch: { query: '火星轨道', matchedCount: 0, records: [] },
              citations: [],
            },
          ],
        },
      })
      await p.getByText('本轮未找到可用的相关正式档案摘录。', { exact: true }).waitFor()
      assert.equal(await p.locator('.archive-citation').count(), 0)
      await p.unroute('**/api/**')
      let oldRoute, oldEntered
      const oldStarted = new Promise((r) => (oldEntered = r))
      await p.route('**/api/**', (r) => {
        if (r.request().method() === 'POST') {
          oldRoute = r
          oldEntered()
          return
        }
        return responder(r)
      })
      await p.getByRole('textbox', { name: '工作要求', exact: true }).fill('借阅期限')
      await p.getByRole('button', { name: '发送', exact: true }).click()
      await oldStarted
      await p.evaluate(() => window.mountChat('/api/tenants/other'))
      await oldRoute.fulfill({ json: { revision: 2, messages: [message] } })
      await p.getByRole('textbox', { name: '工作要求', exact: true }).fill('新企业草稿')
      assert.equal(await p.getByText('借阅期限为9天。[1]', { exact: true }).count(), 0)
      assert.equal(
        await p.getByRole('textbox', { name: '工作要求', exact: true }).inputValue(),
        '新企业草稿',
      )
    } finally {
      await p.close()
    }
  },
)
