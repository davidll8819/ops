import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { createServer as createHttpServer } from 'node:http'

let server, helpers, browser, browserServer, browserOrigin
before(async () => {
  server = await createServer({
    configFile: false,
    resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
    esbuild: { jsx: 'automatic' },
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    plugins: [
      {
        name: 'archive-component-test-entry',
        resolveId(id) {
          if (id === '/__archive_component_test__.js') return id
        },
        load(id) {
          if (id !== '/__archive_component_test__.js') return
          return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { flushSync } from 'react-dom';
          import { ArchiveDocuments } from '/src/saas/ArchiveDocuments.tsx';
          import { ArchiveSources } from '/src/saas/ArchiveSources.tsx';
          import { ArchiveComparison } from '/src/saas/ArchiveComparison.tsx';
          import { DepartmentChat } from '/src/saas/DepartmentChat.tsx';
          window.summaries = [];
          window.mountComparison = (documents, base = '/api/tenants/test') => flushSync(() => root.render(React.createElement(ArchiveComparison, { key: base, base, documents, onActiveChange: () => {}, onSummary: value => window.summaries.push(value.id) })));
          window.mountChat = (base = '/api/tenants/test') => flushSync(() => root.render(React.createElement(DepartmentChat, { base, department: 'archive', archiveDocuments: true, openSettings: () => {} }))); 
          const root = createRoot(document.getElementById('root'));
          window.selections = [];
          window.mountDocuments = (disabled = false) => flushSync(() => root.render(React.createElement(ArchiveDocuments, {
            base: '/api/tenants/test', disabled,
            onSelectionChange: (ids, ready) => window.selections.push({ ids, ready })
          })));
          window.mountSources = (citation, coverage = '') => flushSync(() => root.render(React.createElement(ArchiveSources, {
            base: '/api/tenants/test', citations: [citation], coverage
          })));
          window.mountEmployeeDialog = async (tasks = []) => {
            await import('/src/index.css');
            await import('/src/saas/saas.css');
            const { EmployeeDialog } = await import('/src/saas/EmployeeDialog.tsx');
            const { TEAM_ROSTER } = await import('/src/data/team.ts');
            const noop = () => {};
            flushSync(() => root.render(React.createElement(EmployeeDialog, {
              employee: TEAM_ROSTER.find((item) => item.id === 'file-agent'),
              base: '/api/tenants/test', close: noop, openSettings: noop, openSkills: noop,
              openOperations: noop, onTool: noop, tasks, onRun: noop,
              onTaskOperations: noop, busyTask: '', canEdit: true,
            })));
          };
          window.harnessReady = true;
        `
        },
      },
    ],
  })
  helpers = await server.ssrLoadModule('/src/saas/archive-comparisons.ts')
})
after(async () => {
  await browser?.close()
  await new Promise((resolve) => (browserServer ? browserServer.close(resolve) : resolve()))
  await server?.close()
})

async function componentPage() {
  if (!browser) {
    browserServer = createHttpServer((request, response) => {
      if (request.url === '/__archive_test__') {
        response.setHeader('Content-Type', 'text/html')
        response.end(
          '<div id="root"></div><script type="module" src="/__archive_component_test__.js"></script>',
        )
      } else server.middlewares(request, response)
    })
    await new Promise((resolve) => browserServer.listen(0, '127.0.0.1', resolve))
    browserOrigin = `http://127.0.0.1:${browserServer.address().port}`
    const { chromium } = await import('playwright')
    browser = await chromium.launch({
      headless: true,
      channel: process.env.ARCHIVE_UI_BROWSER_CHANNEL || 'msedge',
    })
  }
  const page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const waiting = [],
    queued = []
  await page.route('**/api/tenants/**', (route) => {
    const waiter = waiting.findIndex(
      (item) =>
        item.path === new URL(route.request().url()).pathname &&
        item.method === route.request().method(),
    )
    if (waiter >= 0) waiting.splice(waiter, 1)[0].resolve(route)
    else queued.push(route)
  })
  const take = (path, method = 'GET') => {
    const index = queued.findIndex(
      (route) =>
        new URL(route.request().url()).pathname === path && route.request().method() === method,
    )
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0])
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Missing request: ' + method + ' ' + path)),
        5000,
      )
      waiting.push({
        path,
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
      })
    })
  }
  await page.goto(`${browserOrigin}/__archive_test__`)
  await page.waitForFunction(() => window.harnessReady)
  return { page, take }
}
const reply = (route, data) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
const ready = (fileId, patch = {}) => ({
  fileId,
  name: `${fileId}.docx`,
  mime: '',
  size: 12,
  createdAt: '',
  extractionId: 'extract-1',
  sha256: 'hash-1',
  kind: 'docx',
  state: 'ready',
  error: null,
  warnings: [],
  blockCount: 1,
  ...patch,
})

const source = (id) => ({
  fileId: id,
  name: `${id}.docx`,
  extractionId: 'extract-1',
  sha256: 'hash-1',
  parserVersion: 'v1',
  kind: 'docx',
  ocr: false,
})
const comparison = (oldId = 'a', newId = 'b', id = 'comparison-1') => ({
  id,
  createdAt: '2026-10-17T00:00:00Z',
  oldVersion: source(oldId),
  newVersion: source(newId),
  algorithmVersion: 'text-diff-1',
  stats: { added: 0, removed: 0, modified: 1, unchanged: 51 },
  overview: '修改 1 段，未变化 51 段',
  warnings: ['部分内容来自 OCR'],
  hunks: [
    {
      id: 'h1',
      type: 'modified',
      granularity: 'inline',
      old: { blockId: 'p1', location: '正文第 1 段', text: '<script>old</script>' },
      new: { blockId: 'p2', location: '正文第 2 段', text: '<script>new</script>' },
      oldSegments: [
        { text: '<script>', changed: false },
        { text: 'old', changed: true },
        { text: '</script>', changed: false },
      ],
      newSegments: [
        { text: '<script>', changed: false },
        { text: 'new', changed: true },
        { text: '</script>', changed: false },
      ],
    },
    ...Array.from({ length: 51 }, (_, i) => ({
      id: `h${i + 2}`,
      type: 'equal',
      granularity: 'block',
      old: { blockId: `p${i + 2}`, location: `正文第 ${i + 2} 段`, text: `相同内容 ${i}` },
      new: { blockId: `p${i + 3}`, location: `正文第 ${i + 3} 段`, text: `相同内容 ${i}` },
      oldSegments: [{ text: `相同内容 ${i}`, changed: false }],
      newSegments: [{ text: `相同内容 ${i}`, changed: false }],
    })),
  ],
})
const browserOptions = { skip: !process.env.ARCHIVE_UI_BROWSER_TESTS, timeout: 30000 }

test('comparison pair is ordered, requires distinct ready files, and accepts identical extraction hashes', () => {
  const docs = [ready('a'), ready('b'), ready('pending', { state: 'processing' })]
  assert.equal(helpers.validComparisonPair('a', 'b', docs), true)
  assert.equal(helpers.validComparisonPair('b', 'a', docs), true)
  assert.equal(helpers.validComparisonPair('a', 'a', docs), false)
  assert.equal(helpers.validComparisonPair('a', 'pending', docs), false)
  assert.equal(helpers.validComparisonPair('', 'b', docs), false)
})

test('diff pages contain at most fifty full hunks and hide unchanged rows by default', () => {
  const value = comparison()
  assert.deepEqual(helpers.comparisonPage(value.hunks, false, 0), [value.hunks[0]])
  assert.equal(helpers.comparisonPage(value.hunks, true, 0).length, 50)
  assert.deepEqual(helpers.comparisonPage(value.hunks, true, 1), value.hunks.slice(50))
})

test('lightweight history references do not retain full diff bodies or warnings', () => {
  const value = comparison()
  const reference = helpers.comparisonReference(value)
  assert.equal(reference.id, value.id)
  assert.deepEqual(reference.oldVersion, value.oldVersion)
  assert.deepEqual(reference.stats, value.stats)
  assert.equal('hunks' in reference, false)
  assert.equal('warnings' in reference, false)
})

test('rendered diff escapes original text, labels sides and locations, and retains inline marks', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  const { ArchiveComparisonResult } = await server.ssrLoadModule('/src/saas/ArchiveComparison.tsx')
  const html = renderToStaticMarkup(
    React.createElement(ArchiveComparisonResult, { comparison: comparison() }),
  )
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /<del>old<\/del>/)
  assert.match(html, /<ins>new<\/ins>/)
  for (const text of ['旧版', '新版', 'a.docx', 'b.docx', '正文第 1 段', '正文第 2 段', '修改'])
    assert.ok(html.includes(text))
})

test(
  'comparison creates ordered pair, displays immediate overview and pages unchanged rows',
  browserOptions,
  async () => {
    const { page, take } = await componentPage()
    try {
      await page.evaluate((docs) => window.mountComparison(docs), [ready('a'), ready('b')])
      await reply(await take('/api/tenants/test/archive/comparisons'), { items: [] })
      await page.getByLabel('旧版文档', { exact: true }).selectOption('a')
      await page.getByLabel('新版文档', { exact: true }).selectOption('a')
      assert.equal(
        await page.getByRole('button', { name: '开始比对', exact: true }).isDisabled(),
        true,
      )
      await page.getByLabel('新版文档', { exact: true }).selectOption('b')
      await page.getByRole('button', { name: '开始比对', exact: true }).click()
      const request = await take('/api/tenants/test/archive/comparisons', 'POST')
      assert.deepEqual(request.request().postDataJSON(), { oldFileId: 'a', newFileId: 'b' })
      await reply(request, { comparison: comparison() })
      await page.getByText('修改 1 段，未变化 51 段', { exact: true }).first().waitFor()
      assert.equal(await page.locator('.archive-comparison-hunk').count(), 1)
      assert.equal(await page.locator('script').count(), 1, 'only the harness script is executable')
      await page.getByLabel('显示未变化内容', { exact: true }).check()
      assert.equal(await page.locator('.archive-comparison-hunk').count(), 50)
      await page.getByRole('button', { name: '下一页', exact: true }).click()
      assert.equal(await page.locator('.archive-comparison-hunk').count(), 2)
      await page.getByRole('button', { name: '总结改动', exact: true }).click()
      assert.deepEqual(await page.evaluate(() => window.summaries), ['comparison-1'])
    } finally {
      await page.close()
    }
  },
)

test(
  'changing pairs and tenants rejects late create and detail results; history can reopen',
  browserOptions,
  async () => {
    const { page, take } = await componentPage()
    const docs = [ready('a'), ready('b'), ready('c')]
    try {
      await page.evaluate((value) => window.mountComparison(value), docs)
      await reply(await take('/api/tenants/test/archive/comparisons'), { items: [comparison()] })
      await page.getByLabel('旧版文档', { exact: true }).selectOption('a')
      await page.getByLabel('新版文档', { exact: true }).selectOption('b')
      await page.getByRole('button', { name: '开始比对', exact: true }).click()
      const late = await take('/api/tenants/test/archive/comparisons', 'POST')
      await page.getByLabel('新版文档', { exact: true }).selectOption('c')
      await reply(late, { comparison: comparison() })
      assert.equal(await page.locator('.archive-comparison-result').count(), 0)

      await page.getByRole('button', { name: /a.docx → b.docx/ }).click()
      const detail = await take('/api/tenants/test/archive/comparisons/comparison-1')
      await reply(detail, { comparison: comparison() })
      await page.locator('.archive-comparison-result').waitFor()
      assert.equal(await page.getByLabel('新版文档', { exact: true }).inputValue(), 'b')
      await page.getByRole('button', { name: /a.docx → b.docx/ }).click()
      const oldTenant = await take('/api/tenants/test/archive/comparisons/comparison-1')
      await page.evaluate((value) => window.mountComparison(value, '/api/tenants/other'), docs)
      await reply(await take('/api/tenants/other/archive/comparisons'), { items: [] })
      await reply(oldTenant, { comparison: comparison() })
      assert.equal(await page.locator('.archive-comparison-result').count(), 0)
    } finally {
      await page.close()
    }
  },
)

test(
  'long Zhao profile instructions and task records stay scrollable outside the chat tab',
  browserOptions,
  async () => {
    const { page, take } = await componentPage()
    try {
      await page.setViewportSize({ width: 878, height: 669 })
      await page.evaluate(() =>
        window.mountEmployeeDialog(
          Array.from({ length: 16 }, (_, index) => ({
            id: `task-${index}`,
            title: `任务 ${index}`,
            dept: 'file-agent',
            due: '2026-10-17',
            status: 'draft',
          })),
        ),
      )
      const model = {
        enabled: true,
        configured: true,
        model: 'test',
        fallback: '',
        source: 'company',
      }
      await reply(await take('/api/tenants/test/employees'), {
        employees: [
          {
            id: 'file-agent',
            chatInstructions: '需要完整阅读的工作指令。\n'.repeat(160),
            models: { text: model, search: model, image: model, video: model },
            skills: [],
          },
        ],
      })
      await reply(await take('/api/tenants/test/archive/documents'), { items: [] })
      await reply(await take('/api/tenants/test/archive/comparisons'), { items: [] })
      await reply(await take('/api/tenants/test/departments/archive/conversation'), {
        revision: 0,
        messages: [],
      })
      await page.getByRole('button', { name: '员工档案', exact: true }).click()
      await page.getByText('查看当前工作指令', { exact: true }).click()
      async function assertScrollable(view) {
        const metrics = await page.locator('.employee-dialog-body').evaluate((element) => {
          const style = getComputedStyle(element)
          element.scrollTop = element.scrollHeight
          return {
            overflowY: style.overflowY,
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            scrollTop: element.scrollTop,
          }
        })
        console.log('Zhao tab scroll', view, JSON.stringify(metrics))
        assert.ok(
          ['auto', 'scroll'].includes(metrics.overflowY),
          `${view} needs a user-scrollable body`,
        )
        assert.ok(metrics.scrollHeight > metrics.clientHeight, `${view} fixture must overflow`)
        assert.ok(metrics.scrollTop > 0, `${view} scroll reaches lower content`)
      }
      await assertScrollable('profile')
      await page.getByRole('button', { name: /任务记录/ }).click()
      await assertScrollable('tasks')
      await page.getByRole('button', { name: '对话', exact: true }).click()
      assert.equal(
        await page
          .locator('.employee-dialog-body')
          .evaluate((element) => getComputedStyle(element).overflowY),
        'hidden',
        'chat retains its independently scrolling columns',
      )
    } finally {
      await page.close()
    }
  },
)

test(
  'one-click summary preserves draft, followups carry comparison ID, failure retains diff, and exit restores ordinary chat',
  browserOptions,
  async () => {
    const { page, take } = await componentPage()
    try {
      await page.evaluate(() => window.mountChat())
      await reply(await take('/api/tenants/test/archive/documents'), {
        items: [ready('a'), ready('b')],
      })
      await reply(await take('/api/tenants/test/archive/comparisons'), { items: [] })
      await reply(await take('/api/tenants/test/departments/archive/conversation'), {
        revision: 0,
        messages: [],
      })
      await page.getByRole('textbox', { name: '工作要求', exact: true }).fill('保留的草稿')
      await page.getByLabel('旧版文档', { exact: true }).selectOption('a')
      await page.getByLabel('新版文档', { exact: true }).selectOption('b')
      await page.getByRole('button', { name: '开始比对', exact: true }).click()
      await reply(await take('/api/tenants/test/archive/comparisons', 'POST'), {
        comparison: comparison(),
      })
      await page.getByRole('button', { name: '总结改动', exact: true }).click()
      const summary = await take('/api/tenants/test/departments/archive/chat', 'POST')
      assert.deepEqual(summary.request().postDataJSON(), {
        text: '总结改动',
        revision: 0,
        comparisonId: 'comparison-1',
      })
      await reply(summary, {
        revision: 1,
        messages: [{ id: 'm1', role: 'assistant', text: '总结完成', comparison: comparison() }],
      })
      await page.getByText('总结完成', { exact: true }).waitFor()
      assert.equal(
        await page.getByRole('textbox', { name: '工作要求', exact: true }).inputValue(),
        '保留的草稿',
      )
      await page.getByRole('button', { name: '归档建议', exact: true }).click()
      await page.getByRole('heading', { name: '分类与归档建议', exact: true }).waitFor()
      assert.equal(await page.locator('.archive-comparison-result').isVisible(), false)
      await page.getByRole('button', { name: '查看本次比对', exact: true }).click()
      await reply(await take('/api/tenants/test/archive/comparisons/comparison-1'), {
        comparison: comparison(),
      })
      await page.locator('.archive-comparison-result').waitFor()
      await page.getByRole('button', { name: '发送', exact: true }).click()
      const follow = await take('/api/tenants/test/departments/archive/chat', 'POST')
      assert.equal(follow.request().postDataJSON().comparisonId, 'comparison-1')
      assert.equal('fileIds' in follow.request().postDataJSON(), false)
      await follow.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: '模型暂不可用' }),
      })
      await page.getByRole('alert').waitFor()
      assert.equal(await page.locator('.archive-comparison-result').count(), 1)
      await page.getByRole('button', { name: '退出比对问答', exact: true }).click()
      await page.getByRole('button', { name: '发送', exact: true }).click()
      const ordinary = await take('/api/tenants/test/departments/archive/chat', 'POST')
      assert.equal('comparisonId' in ordinary.request().postDataJSON(), false)
      await reply(ordinary, { revision: 2, messages: [] })
      await page
        .getByRole('button', { name: '查看本次比对', exact: true })
        .waitFor({ state: 'detached' })
    } finally {
      await page.close()
    }
  },
)

test(
  'a summary resolving after pair change cannot replace conversation or clear the current draft',
  browserOptions,
  async () => {
    const { page, take } = await componentPage()
    try {
      await page.evaluate(() => window.mountChat())
      await reply(await take('/api/tenants/test/archive/documents'), {
        items: [ready('a'), ready('b'), ready('c')],
      })
      await reply(await take('/api/tenants/test/archive/comparisons'), { items: [] })
      await reply(await take('/api/tenants/test/departments/archive/conversation'), {
        revision: 0,
        messages: [],
      })
      await page.getByLabel('旧版文档', { exact: true }).selectOption('a')
      await page.getByLabel('新版文档', { exact: true }).selectOption('b')
      await page.getByRole('button', { name: '开始比对', exact: true }).click()
      await reply(await take('/api/tenants/test/archive/comparisons', 'POST'), {
        comparison: comparison(),
      })
      await page.getByRole('button', { name: '总结改动', exact: true }).click()
      const pending = await take('/api/tenants/test/departments/archive/chat', 'POST')
      await page.getByRole('textbox', { name: '工作要求', exact: true }).fill('新的草稿')
      await page.getByLabel('新版文档', { exact: true }).selectOption('c')
      await reply(pending, {
        revision: 1,
        messages: [{ id: 'stale', role: 'assistant', text: '过期总结' }],
      })
      await page.getByRole('button', { name: '发送', exact: true }).waitFor()
      assert.equal(await page.getByText('过期总结', { exact: true }).count(), 0)
      assert.equal(
        await page.getByRole('textbox', { name: '工作要求', exact: true }).inputValue(),
        '新的草稿',
      )
      assert.equal(await page.locator('.archive-active-comparison').count(), 0)
      assert.equal(await page.locator('.archive-comparison-result').count(), 0)
      await page.getByRole('button', { name: '发送', exact: true }).click()
      const nextSend = await take('/api/tenants/test/departments/archive/chat', 'POST')
      const submitted = nextSend.request().postDataJSON()
      if (submitted.revision !== 1) {
        await nextSend.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: '对话已更新，请刷新后重试' }),
        })
      } else {
        await reply(nextSend, {
          revision: 2,
          messages: [{ id: 'next', role: 'assistant', text: '新问题已回答' }],
        })
      }
      assert.equal(
        submitted.revision,
        1,
        'the next send must use the server revision saved by the obsolete summary',
      )
      assert.equal('comparisonId' in submitted, false)
      assert.equal(submitted.text, '新的草稿')
      await page.getByText('新问题已回答', { exact: true }).waitFor()
      assert.equal(await page.locator('.archive-active-comparison').count(), 0)
    } finally {
      await page.close()
    }
  },
)

test(
  'archive popup keeps a right-side conversation and large reachable composer at desktop and mobile sizes',
  browserOptions,
  async () => {
    const { page, take } = await componentPage()
    try {
      await page.setViewportSize({ width: 878, height: 669 })
      await page.evaluate(() => window.mountEmployeeDialog())
      await reply(await take('/api/tenants/test/employees'), { employees: [] })
      await reply(await take('/api/tenants/test/archive/documents'), {
        items: [ready('a'), ready('b')],
      })
      await reply(await take('/api/tenants/test/archive/comparisons'), { items: [] })
      await reply(await take('/api/tenants/test/departments/archive/conversation'), {
        revision: 0,
        messages: [],
      })
      await page.getByLabel('旧版文档', { exact: true }).selectOption('a')
      await page.getByLabel('新版文档', { exact: true }).selectOption('b')
      await page.getByRole('button', { name: '开始比对', exact: true }).click()
      await reply(await take('/api/tenants/test/archive/comparisons', 'POST'), {
        comparison: comparison(),
      })
      await page.locator('.archive-active-comparison').waitFor()
      for (const [width, height, logMinimum, inputMinimum] of [
        [878, 669, 260, 130],
        [1440, 900, 380, 150],
        [390, 844, 80, 110],
      ]) {
        await page.setViewportSize({ width, height })
        const geometry = await page.evaluate(() => {
          const box = (selector) => {
            const element = document.querySelector(selector),
              value = element.getBoundingClientRect()
            return {
              x: value.x,
              y: value.y,
              right: value.right,
              bottom: value.bottom,
              width: value.width,
              height: value.height,
              scrollHeight: element.scrollHeight,
              clientHeight: element.clientHeight,
            }
          }
          return {
            popup: box('.employee-dialog'),
            workspace: box('.archive-workspace'),
            chat: box('.archive-chat-pane'),
            log: box('.department-messages'),
            input: box('textarea'),
            send: box('form .primary'),
            body: box('.employee-dialog-body'),
            overflow: document.documentElement.scrollWidth > innerWidth,
          }
        })
        console.log('comparison popup geometry', width, height, JSON.stringify(geometry))
        assert.ok(
          geometry.log.height >= logMinimum,
          `log at ${width}x${height}: ${geometry.log.height}`,
        )
        assert.ok(
          geometry.input.height >= inputMinimum,
          `input at ${width}x${height}: ${geometry.input.height}`,
        )
        assert.ok(geometry.send.bottom <= geometry.body.bottom, 'Send remains fully visible')
        assert.equal(geometry.overflow, false, 'no page overflow')
        assert.ok(
          geometry.body.scrollHeight <= geometry.body.clientHeight + 1,
          'the modal body must not clip the composer',
        )
        if (width >= 760)
          assert.ok(geometry.chat.x >= geometry.workspace.right, 'chat is on the right')
      }
    } finally {
      await page.close()
    }
  },
)

test(
  'an obsolete tenant reply cannot transfer its saved revision into the new tenant conversation',
  browserOptions,
  async () => {
    const { page, take } = await componentPage()
    const first = '/api/tenants/test',
      second = '/api/tenants/other'
    try {
      await page.evaluate(() => window.mountChat())
      await reply(await take(`${first}/archive/documents`), { items: [] })
      await reply(await take(`${first}/archive/comparisons`), { items: [] })
      await reply(await take(`${first}/departments/archive/conversation`), {
        revision: 4,
        messages: [],
      })
      await page.getByRole('textbox', { name: '工作要求', exact: true }).fill('旧企业问题')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      const obsolete = await take(`${first}/departments/archive/chat`, 'POST')
      await page.evaluate((base) => window.mountChat(base), second)
      await reply(await take(`${second}/archive/documents`), { items: [] })
      await reply(await take(`${second}/archive/comparisons`), { items: [] })
      await reply(await take(`${second}/departments/archive/conversation`), {
        revision: 0,
        messages: [],
      })
      await page.getByRole('textbox', { name: '工作要求', exact: true }).fill('新企业草稿')
      await reply(obsolete, {
        revision: 5,
        messages: [{ id: 'private', role: 'assistant', text: '旧企业私有回复' }],
      })
      await page.getByRole('button', { name: '发送', exact: true }).click()
      const current = await take(`${second}/departments/archive/chat`, 'POST')
      assert.equal(current.request().postDataJSON().revision, 0)
      assert.equal(current.request().postDataJSON().text, '新企业草稿')
      assert.equal(await page.getByText('旧企业私有回复', { exact: true }).count(), 0)
      await reply(current, {
        revision: 1,
        messages: [{ id: 'current', role: 'assistant', text: '新企业已回答' }],
      })
      await page.getByText('新企业已回答', { exact: true }).waitFor()
    } finally {
      await page.close()
    }
  },
)
