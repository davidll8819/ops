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
          const root = createRoot(document.getElementById('root'));
          window.selections = [];
          window.mountDocuments = (disabled = false) => flushSync(() => root.render(React.createElement(ArchiveDocuments, {
            base: '/api/tenants/test', disabled,
            onSelectionChange: (ids, ready) => window.selections.push({ ids, ready })
          })));
          window.mountSources = (citation, coverage = '') => flushSync(() => root.render(React.createElement(ArchiveSources, {
            base: '/api/tenants/test', citations: [citation], coverage
          })));
          window.mountEmployeeDialog = async () => {
            await import('/src/index.css');
            await import('/src/saas/saas.css');
            const { EmployeeDialog } = await import('/src/saas/EmployeeDialog.tsx');
            const { TEAM_ROSTER } = await import('/src/data/team.ts');
            const noop = () => {};
            flushSync(() => root.render(React.createElement(EmployeeDialog, {
              employee: TEAM_ROSTER.find((item) => item.id === 'file-agent'),
              base: '/api/tenants/test', close: noop, openSettings: noop, openSkills: noop,
              openOperations: noop, onTool: noop, tasks: [], onRun: noop,
              onTaskOperations: noop, busyTask: '', canEdit: true,
            })));
          };
          window.harnessReady = true;
        `
        },
      },
    ],
  })
  helpers = await server.ssrLoadModule('/src/saas/archive-documents.ts')
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
  const waiting = [],
    queued = []
  await page.route('**/api/tenants/test/**', (route) => {
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
    return new Promise((resolve) => waiting.push({ path, method, resolve }))
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

test('selection restores only unique ready private files and never sends more than four', () => {
  const documents = ['a', 'b', 'c', 'd', 'e'].map((id) => ready(id))
  documents.push(ready('pending', { state: 'processing' }))
  assert.deepEqual(
    helpers.selectedArchiveFiles(['a', 'a', 'missing', 'pending', 'b', 'c', 'd', 'e'], documents),
    ['a', 'b', 'c', 'd'],
  )
  assert.deepEqual(helpers.toggleArchiveFile(['a', 'b', 'c', 'd'], 'e', documents), {
    ids: ['a', 'b', 'c', 'd'],
    error: '最多选择 4 份文档',
  })
  assert.deepEqual(helpers.toggleArchiveFile(['a', 'b'], 'a', documents), { ids: ['b'], error: '' })
  assert.deepEqual(helpers.toggleArchiveFile([], 'pending', documents), {
    ids: [],
    error: '文档解析完成后才能选择',
  })
})

test('an older list, source, or tenant request cannot replace the current private view', () => {
  const gate = helpers.createArchiveRequestScope()
  const first = gate.begin()
  const second = gate.begin()
  assert.equal(first(), false)
  assert.equal(second(), true)
  gate.invalidate()
  assert.equal(second(), false)
  assert.equal(gate.begin()(), true)
})

test('historical citation opens a block only when identity hash location and saved quote agree', () => {
  const citation = {
    id: '1',
    fileId: 'a',
    extractionId: 'extract-1',
    sha256: 'hash-1',
    filename: 'a.docx',
    blockId: 'p1',
    location: '正文第 1 段',
    quote: '预算 50 万元',
  }
  const detail = {
    ...ready('a'),
    blocks: [{ id: 'p1', location: '正文第 1 段', text: '本次预算 50 万元。' }],
  }
  assert.deepEqual(helpers.matchingCitationBlock(citation, detail), detail.blocks[0])
  for (const patch of [
    { fileId: 'b' },
    { extractionId: 'new' },
    { sha256: 'new' },
    { state: 'failed' },
  ])
    assert.equal(helpers.matchingCitationBlock(citation, { ...detail, ...patch }), null)
  for (const patch of [
    { location: '伪造页码' },
    { blockId: 'missing' },
    { quote: '预算 90 万元' },
    { quote: '' },
  ])
    assert.equal(helpers.matchingCitationBlock({ ...citation, ...patch }, detail), null)
  assert.ok(helpers.matchingCitationBlock({ ...citation, quote: '预算\n50 万元' }, detail))
})

test('invalid persisted selection is ignored without exposing document names or crashing', () => {
  assert.deepEqual(helpers.readArchiveSelection('{broken'), [])
  assert.deepEqual(helpers.readArchiveSelection('{"name":"secret.docx"}'), [])
  assert.deepEqual(helpers.readArchiveSelection('["a",4,"b","a"]'), ['a', 'b'])
})

// Omitting the employee opt-in (including the existing OCR reuse) must keep the old chat.
test('document tools are explicitly opted into the file-agent conversation only', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  const { DepartmentChat } = await server.ssrLoadModule('/src/saas/DepartmentChat.tsx')
  const props = { base: '/api/tenants/one', department: 'archive', openSettings() {} }
  const plain = renderToStaticMarkup(React.createElement(DepartmentChat, props))
  assert.doesNotMatch(plain, /上传文档/)
  const enabled = renderToStaticMarkup(
    React.createElement(DepartmentChat, { ...props, archiveDocuments: true }),
  )
  assert.match(enabled, /上传文档/)
  assert.match(enabled, /DOCX/)
  const ocr = renderToStaticMarkup(
    React.createElement(DepartmentChat, {
      ...props,
      archiveDocuments: true,
      image: 'data:image/png;base64,x',
    }),
  )
  assert.doesNotMatch(ocr, /上传文档/)
})

test('saved evidence and document previews render untrusted content as text with honest coverage and locations', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  const { ArchiveSources } = await server.ssrLoadModule('/src/saas/ArchiveSources.tsx')
  const { ArchiveDocumentText } = await server.ssrLoadModule('/src/saas/ArchiveDocuments.tsx')
  const citation = {
    id: '1',
    fileId: 'private/file',
    extractionId: 'e',
    sha256: 'h',
    filename: '<img src=x>',
    blockId: 'b',
    location: '采购明细!B4:D4',
    quote: '<script>alert(1)</script>',
  }
  const sources = renderToStaticMarkup(
    React.createElement(ArchiveSources, {
      base: '/api/tenants/one',
      citations: [citation],
      coverage: '仅检索了部分片段 <b>非全文</b>',
    }),
  )
  assert.match(sources, /\[1\] &lt;img src=x&gt; · 采购明细!B4:D4/)
  assert.match(sources, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(sources, /仅检索了部分片段 &lt;b&gt;非全文&lt;\/b&gt;/)
  assert.match(sources, /\/files\/private%2Ffile\/download/)
  assert.doesNotMatch(sources, /<script>|<img|<b>/)
  const preview = renderToStaticMarkup(
    React.createElement(ArchiveDocumentText, {
      document: {
        ...ready('a', { kind: 'xlsx', warnings: ['使用保存值 <unsafe>'] }),
        blocks: [{ id: 'b', location: '预算!A2:A2', text: '=SUM(A1) <iframe>' }],
      },
    }),
  )
  assert.match(preview, /预算!A2:A2/)
  assert.match(preview, /公式使用文件中保存的结果，不重新计算/)
  assert.match(preview, /使用保存值 &lt;unsafe&gt;/)
  assert.match(preview, /=SUM\(A1\) &lt;iframe&gt;/)
})

const browserOptions = { skip: !process.env.ARCHIVE_UI_BROWSER_TESTS, timeout: 30000 }

test('saved OCR evidence keeps its recognition caveat after conversation reload', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  const { ArchiveSources } = await server.ssrLoadModule('/src/saas/ArchiveSources.tsx')
  const { ArchiveDocumentText } = await server.ssrLoadModule('/src/saas/ArchiveDocuments.tsx')
  const citation = {
    id: '1',
    fileId: 'scan',
    extractionId: 'e',
    sha256: 'h',
    filename: 'scan.png',
    blockId: 'b',
    location: '图片第 1 页（OCR）',
    quote: '金额 500 元',
    method: 'ocr',
    page: 1,
  }
  const saved = renderToStaticMarkup(
    React.createElement(ArchiveSources, {
      base: '/api/tenants/test',
      citations: JSON.parse(JSON.stringify([citation])),
    }),
  )
  assert.match(saved, /识别文字摘录（OCR）/)
  assert.match(saved, /识别可能有误/)
  assert.match(saved, /数字、手写或模糊内容/)
  assert.doesNotMatch(saved, /<img/)
  const detail = renderToStaticMarkup(
    React.createElement(ArchiveDocumentText, {
      document: {
        ...ready('scan', { kind: 'image', ocr: true }),
        blocks: [
          {
            id: 'b',
            location: citation.location,
            text: '<unsafe> 金额 500 元',
            method: 'ocr',
            page: 1,
          },
        ],
      },
    }),
  )
  assert.match(detail, /识别可能有误/)
  assert.match(detail, /&lt;unsafe&gt;/)
})

test(
  'a new image is listed and OCR progress polls while the parse POST is pending',
  browserOptions,
  async () => {
    const { page, take } = await componentPage()
    const path = '/api/tenants/test/archive/documents'
    const unparsed = ready('scan', {
      name: 'scan.PNG',
      mime: 'image/png',
      kind: null,
      state: 'unparsed',
      extractionId: null,
      sha256: null,
    })
    try {
      await page.clock.install()
      await page.evaluate(() => window.mountDocuments())
      await reply(await take(path), { items: [] })
      assert.match(await page.locator('input[type=file]').getAttribute('accept'), /\.png/)
      assert.match(await page.locator('.archive-document-body').innerText(), /旧版已就绪 PDF/)
      await page.locator('input[type=file]').setInputFiles({
        name: 'scan.PNG',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from('synthetic raster'),
      })
      const upload = await take('/api/tenants/test/files', 'POST')
      assert.equal(upload.request().postDataJSON().mime, 'image/png')
      await reply(upload, { id: 'scan' })
      await reply(await take(path), { items: [unparsed] })
      const parse = await take(`${path}/scan/parse`, 'POST')
      assert.equal(await page.getByRole('checkbox').count(), 1)
      assert.equal(await page.getByRole('checkbox').isDisabled(), true)
      await page.clock.fastForward(2500)
      await reply(await take(`${path}/scan`), {
        document: {
          ...unparsed,
          state: 'processing',
          progress: { stage: 'ocr', page: 2, totalPages: 3 },
          blocks: [],
        },
      })
      await page.getByText('正在识别（OCR）· 第 2 / 3 页', { exact: false }).first().waitFor()
      await page.clock.fastForward(2500)
      await reply(await take(`${path}/scan`), {
        document: {
          ...ready('scan', { name: 'scan.PNG', mime: 'image/png', kind: 'image', ocr: true }),
          blocks: [],
        },
      })
      await page.waitForFunction(() => document.querySelector('input[type=checkbox]')?.checked)
      assert.match(await page.locator('.archive-file-list').innerText(), /OCR/)
      await reply(parse, { document: ready('scan', { kind: 'image', ocr: true }) })
      await reply(await take(path), { items: [ready('scan', { kind: 'image', ocr: true })] })
    } finally {
      await page.close()
    }
  },
)

test(
  'JPEG and WebP uploads use canonical MIME despite the browser MIME',
  browserOptions,
  async () => {
    for (const [name, mime] of [
      ['photo.JPEG', 'image/jpeg'],
      ['photo.webp', 'image/webp'],
    ]) {
      const { page, take } = await componentPage()
      try {
        await page.evaluate(() => window.mountDocuments())
        await reply(await take('/api/tenants/test/archive/documents'), { items: [] })
        assert.match(await page.locator('input[type=file]').getAttribute('accept'), /\.jpeg/)
        await page.locator('input[type=file]').setInputFiles({
          name,
          mimeType: 'image/incorrect',
          buffer: Buffer.from('synthetic raster'),
        })
        const upload = await take('/api/tenants/test/files', 'POST')
        assert.equal(upload.request().postDataJSON().mime, mime)
        await upload.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'fixture upload rejected' }),
        })
      } finally {
        await page.close()
      }
    }
  },
)

test('finishing an earlier parse keeps a newer upload busy', browserOptions, async () => {
  const { page, take } = await componentPage()
  const path = '/api/tenants/test/archive/documents'
  try {
    await page.evaluate(() => window.mountDocuments())
    await reply(await take(path), { items: [] })
    const uploadInput = page.locator('input[type=file]')
    await uploadInput.setInputFiles({ name: 'a.docx', mimeType: '', buffer: Buffer.from('a') })
    await reply(await take('/api/tenants/test/files', 'POST'), { id: 'a' })
    await reply(await take(path), { items: [ready('a', { state: 'unparsed' })] })
    const firstParse = await take(`${path}/a/parse`, 'POST')
    await uploadInput.setInputFiles({ name: 'b.docx', mimeType: '', buffer: Buffer.from('b') })
    const secondUpload = await take('/api/tenants/test/files', 'POST')
    assert.equal(await uploadInput.isDisabled(), true)
    await reply(firstParse, { document: ready('a') })
    await reply(await take(path), { items: [ready('a')] })
    await page.getByRole('checkbox').waitFor({ state: 'visible' })
    await page.waitForFunction(() => document.querySelector('input[type=checkbox]')?.checked)
    assert.equal(
      await uploadInput.isDisabled(),
      true,
      'a prior parse cannot clear another upload status',
    )
    await secondUpload.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'fixture rejected' }),
    })
  } finally {
    await page.close()
  }
})

test(
  'failed OCR can retry and reports real extraction progress before POST completion',
  browserOptions,
  async () => {
    const { page, take } = await componentPage()
    const path = '/api/tenants/test/archive/documents'
    try {
      await page.clock.install()
      await page.evaluate(() => window.mountDocuments())
      await reply(await take(path), {
        items: [ready('scan', { state: 'failed', error: '请重新扫描后重试', kind: 'pdf' })],
      })
      await page.getByRole('button', { name: '重试解析', exact: true }).click()
      const parse = await take(`${path}/scan/parse`, 'POST')
      assert.equal(
        await page.getByRole('button', { name: '正在解析…', exact: true }).isDisabled(),
        true,
      )
      await page.clock.fastForward(2500)
      await reply(await take(`${path}/scan`), {
        document: {
          ...ready('scan', {
            state: 'processing',
            kind: 'pdf',
            progress: { stage: 'extracting', page: 3, totalPages: 5 },
          }),
          blocks: [],
        },
      })
      await page.getByText('正在解析…· 第 3 / 5 页', { exact: false }).waitFor()
      await reply(parse, { document: ready('scan', { kind: 'pdf', ocr: true }) })
      await reply(await take(path), { items: [ready('scan', { kind: 'pdf', ocr: true })] })
      await page.waitForFunction(() => document.querySelector('input[type=checkbox]')?.checked)
    } finally {
      await page.close()
    }
  },
)

test(
  'OCR image previews require a matching source identity and remain bounded',
  browserOptions,
  async () => {
    const { page, take } = await componentPage()
    const citation = {
      id: '1',
      fileId: 'private/scan',
      extractionId: 'e',
      sha256: 'h',
      filename: 'scan.png',
      blockId: 'b',
      location: '图片第 1 页（OCR）',
      quote: '金额 500 元',
      method: 'ocr',
      page: 1,
    }
    const source = {
      ...ready('private/scan', {
        name: 'scan.png',
        mime: 'image/png',
        extractionId: 'e',
        sha256: 'h',
        kind: 'image',
        ocr: true,
      }),
      blocks: [
        { id: 'b', location: citation.location, text: '金额 500 元。', method: 'ocr', page: 1 },
      ],
    }
    try {
      await page.setViewportSize({ width: 878, height: 669 })
      await page.evaluate((value) => window.mountSources(value), citation)
      assert.equal(await page.locator('img').count(), 0)
      assert.match(await page.locator('.archive-sources').innerText(), /识别可能有误/)
      await page.locator('summary').click()
      await page.getByRole('button', { name: '查看该位置正文', exact: true }).click()
      await reply(await take('/api/tenants/test/archive/documents/private%2Fscan'), {
        document: { ...source, sha256: 'wrong' },
      })
      await page.getByText('当前提取版本或来源位置与历史引用不一致', { exact: false }).waitFor()
      assert.equal(await page.locator('img').count(), 0)
      await page.getByRole('button', { name: '查看该位置正文', exact: true }).click()
      await reply(await take('/api/tenants/test/archive/documents/private%2Fscan'), {
        document: source,
      })
      await page.locator('.archive-source-block').waitFor()
      assert.equal(
        await page.locator('img').count(),
        1,
        'verified image source offers the original raster',
      )
      assert.equal(
        await page.locator('img').getAttribute('src'),
        '/api/tenants/test/files/private%2Fscan/preview',
      )
      const style = await page.locator('img').evaluate((element) => ({
        maxWidth: getComputedStyle(element).maxWidth,
        maxHeight: getComputedStyle(element).maxHeight,
      }))
      assert.equal(style.maxWidth, '100%')
      assert.equal(style.maxHeight, '200px')
      await page.evaluate((value) => window.mountSources({ ...value, sha256: 'changed' }), citation)
      assert.equal(
        await page.locator('img').count(),
        0,
        'changed saved identity clears the old original preview',
      )
    } finally {
      await page.close()
    }
  },
)

test(
  'document image preview verifies the requested ready extraction before showing an original',
  browserOptions,
  async () => {
    const { page, take } = await componentPage()
    const path = '/api/tenants/test/archive/documents'
    const document = {
      ...ready('scan', { name: 'scan.webp', kind: 'image', mime: 'image/webp', ocr: true }),
      blocks: [],
    }
    try {
      await page.evaluate(() => window.mountDocuments())
      await reply(await take(path), { items: [document] })
      await page.getByRole('button', { name: '预览正文', exact: true }).click()
      await reply(await take(`${path}/scan`), { document: { ...document, extractionId: 'other' } })
      await page
        .getByText('文档身份核对失败，请刷新列表后重试预览。', { exact: false })
        .waitFor({ timeout: 2000 })
      assert.equal(await page.locator('img').count(), 0)
      await page.getByRole('button', { name: '重试', exact: true }).click()
      await reply(await take(`${path}/scan`), { document })
      await page.locator('.archive-preview img').waitFor({ state: 'attached' })
      assert.equal(
        await page.locator('img').getAttribute('src'),
        '/api/tenants/test/files/scan/preview',
      )
    } finally {
      await page.close()
    }
  },
)
test(
  'a delayed processing list cannot deselect an upload selected by a newer ready poll',
  browserOptions,
  async () => {
    const { page, take } = await componentPage()
    const path = '/api/tenants/test/archive/documents'
    const unparsed = ready('a', { state: 'unparsed', extractionId: null, sha256: null })
    const processing = { ...unparsed, state: 'processing' }
    try {
      await page.clock.install()
      await page.evaluate(() => window.mountDocuments())
      await reply(await take(path), { items: [unparsed] })
      await page.getByRole('button', { name: '解析文档', exact: true }).click()
      await reply(await take(`${path}/a/parse`, 'POST'), { document: processing })
      await reply(await take(path), { items: [processing] })
      await page.getByText('正在解析…', { exact: false }).first().waitFor()
      await page.getByRole('button', { name: '刷新状态', exact: true }).click()
      const delayedList = await take(path)
      await page.clock.fastForward(2500)
      await reply(await take(`${path}/a`), { document: { ...ready('a'), blocks: [] } })
      const checkbox = page.getByRole('checkbox')
      await page.waitForFunction(() => document.querySelector('input[type=checkbox]')?.checked)
      await reply(delayedList, { items: [processing] })
      await page.getByText('正在读取文档列表…', { exact: true }).waitFor({ state: 'detached' })
      assert.equal(
        await checkbox.isChecked(),
        true,
        'late processing list must retain the auto-selected ready upload',
      )
      assert.match(await page.locator('.archive-file-list').innerText(), /已就绪/)
      assert.deepEqual(await page.evaluate(() => window.selections.at(-1)), {
        ids: ['a'],
        ready: true,
      })
      await page.getByRole('button', { name: '刷新状态', exact: true }).click()
      await reply(await take(path), { items: [processing] })
      await page.getByText('正在读取文档列表…', { exact: true }).waitFor({ state: 'detached' })
      assert.equal(
        await checkbox.isChecked(),
        true,
        'even a subsequent processing snapshot must preserve immutable ready evidence',
      )
    } finally {
      await page.close()
    }
  },
)

test(
  'equivalent citation objects preserve pending source previews and changed evidence is retryable',
  browserOptions,
  async () => {
    const { page, take } = await componentPage()
    const citation = {
      id: '1',
      fileId: 'a',
      extractionId: 'extract-1',
      sha256: 'hash-1',
      filename: 'a.docx',
      blockId: 'p1',
      location: '正文第 1 段',
      quote: '预算 50 万元',
    }
    const source = {
      ...ready('a'),
      blocks: [{ id: 'p1', location: '正文第 1 段', text: '本次预算 50 万元。' }],
    }
    try {
      await page.evaluate((value) => window.mountSources(value), citation)
      await page.locator('summary').click()
      await page.getByRole('button', { name: '查看该位置正文', exact: true }).click()
      const pending = await take('/api/tenants/test/archive/documents/a')
      await page.evaluate((value) => window.mountSources({ ...value }, '刷新后的对话'), citation)
      await page.getByText('刷新后的对话', { exact: true }).waitFor()
      await reply(pending, { document: source })
      const finished = await page
        .waitForFunction(
          () => document.querySelector('.archive-citation button')?.disabled === false,
          null,
          { timeout: 2000 },
        )
        .then(
          () => true,
          () => false,
        )
      assert.equal(finished, true, 'replacing equal citation objects must not strand loading=true')
      assert.match(await page.locator('.archive-source-block').innerText(), /本次预算 50 万元/)
      await page.getByRole('button', { name: '查看该位置正文', exact: true }).click()
      const oldEvidence = await take('/api/tenants/test/archive/documents/a')
      await page.evaluate(
        (value) =>
          window.mountSources(
            { ...value, blockId: 'p2', location: '正文第 2 段', quote: '预算 90 万元' },
            '证据已更换',
          ),
        citation,
      )
      await page.getByText('证据已更换', { exact: true }).waitFor()
      assert.equal(
        await page.locator('.archive-citation button').isDisabled(),
        false,
        'changed evidence must reset pending preview state',
      )
      if (!(await page.locator('details').evaluate((element) => element.open)))
        await page.locator('summary').click()
      await page.getByRole('button', { name: '查看该位置正文', exact: true }).click()
      const newEvidence = await take('/api/tenants/test/archive/documents/a')
      await reply(oldEvidence, { document: source })
      assert.equal(
        await page.locator('.archive-source-block').count(),
        0,
        'old request must not populate changed evidence',
      )
      assert.equal(await page.locator('blockquote').innerText(), '预算 90 万元')
      await reply(newEvidence, {
        document: {
          ...ready('a'),
          blocks: [{ id: 'p2', location: '正文第 2 段', text: '调整后的预算 90 万元。' }],
        },
      })
      await page.getByText('调整后的预算 90 万元。', { exact: true }).waitFor()
    } finally {
      await page.close()
    }
  },
)

test(
  'a later known-file poll does not discard a full list containing a newly uploaded file',
  browserOptions,
  async () => {
    const { page, take } = await componentPage()
    const path = '/api/tenants/test/archive/documents'
    const unparsed = ready('a', { state: 'unparsed', extractionId: null, sha256: null })
    const processing = { ...unparsed, state: 'processing' }
    try {
      await page.clock.install()
      await page.evaluate(() => window.mountDocuments())
      await reply(await take(path), { items: [unparsed] })
      await page.getByRole('button', { name: '解析文档', exact: true }).click()
      await reply(await take(`${path}/a/parse`, 'POST'), { document: processing })
      await reply(await take(path), { items: [processing] })
      await page.getByText('正在解析…', { exact: false }).first().waitFor()
      await page.locator('input[type=file]').setInputFiles({
        name: 'b.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: Buffer.from('synthetic upload bytes'),
      })
      await reply(await take('/api/tenants/test/files', 'POST'), { id: 'b' })
      await reply(await take(path), {
        items: [processing, ready('b', { state: 'unparsed', extractionId: null, sha256: null })],
      })
      await reply(await take(`${path}/b/parse`, 'POST'), { document: ready('b') })
      const newFileList = await take(path)
      await page.clock.fastForward(2500)
      await reply(await take(`${path}/a`), { document: { ...ready('a'), blocks: [] } })
      await page.waitForFunction(() => document.querySelector('input[type=checkbox]')?.checked)
      await reply(newFileList, { items: [processing, ready('b')] })
      await page.getByText('正在读取文档列表…', { exact: true }).waitFor({ state: 'detached' })
      assert.equal(
        await page.getByRole('checkbox').count(),
        2,
        'a full list must still discover newly uploaded files after an overlapping poll',
      )
      assert.deepEqual(
        await page
          .getByRole('checkbox')
          .evaluateAll((inputs) => inputs.map((input) => input.checked)),
        [true, true],
      )
      assert.deepEqual(await page.evaluate(() => window.selections.at(-1)), {
        ids: ['a', 'b'],
        ready: true,
      })
      assert.doesNotMatch(await page.locator('.archive-file-list').innerText(), /正在解析/)
    } finally {
      await page.close()
    }
  },
)

test(
  'collapsing and submission retain selected files while hidden document states continue updating',
  browserOptions,
  async () => {
    const { page, take } = await componentPage()
    const path = '/api/tenants/test/archive/documents'
    try {
      await page.setViewportSize({ width: 878, height: 669 })
      await page.evaluate(() => window.mountDocuments())
      await reply(await take(path), { items: [ready('a'), ready('b', { state: 'processing' })] })
      await page.getByRole('checkbox').first().check()
      assert.equal(
        await page.getByRole('alert').count(),
        0,
        'selecting a ready document must not create an error',
      )
      const expandedHeight = (await page.locator('.archive-documents').boundingBox()).height
      const collapse = page.getByRole('button', { name: '收起文档', exact: true })
      assert.equal(await collapse.count(), 1, 'the document panel must offer a collapse control')
      await collapse.click()
      assert.equal(await page.locator('input[type=file]').isVisible(), false)
      assert.match(await page.locator('.archive-panel-heading').innerText(), /已选 1\/4/)
      assert.ok(
        (await page.locator('.archive-documents').boundingBox()).height < expandedHeight / 2,
        'collapsed tools must return meaningful vertical space to the conversation',
      )
      await page.getByRole('button', { name: '展开文档', exact: true }).click()
      assert.equal(await page.getByRole('checkbox').first().isChecked(), true)
      await page.evaluate(() => window.mountDocuments(true))
      await page.getByRole('button', { name: '展开文档', exact: true }).waitFor()
      assert.equal(
        await page.locator('input[type=file]').isVisible(),
        false,
        'submitting a question must collapse document tools',
      )
      await page.evaluate(() => window.mountDocuments(false))
      assert.equal(
        await page.getByRole('button', { name: '展开文档', exact: true }).count(),
        1,
        'the reply must leave document tools collapsed',
      )
      await reply(await take(`${path}/b`), { document: { ...ready('b'), blocks: [] } })
      await page.waitForFunction(
        () =>
          document.querySelector('.archive-file-list')?.textContent.includes('正在解析') === false,
      )
      assert.deepEqual(await page.evaluate(() => window.selections.at(-1)), {
        ids: ['a'],
        ready: true,
      })
      await page.getByRole('button', { name: '展开文档', exact: true }).click()
      assert.equal(await page.getByRole('checkbox').first().isChecked(), true)
      assert.equal(
        await page.getByRole('checkbox').nth(1).isDisabled(),
        false,
        'the ready poll must keep updating hidden file controls',
      )
      assert.doesNotMatch(await page.locator('.archive-file-list').innerText(), /正在解析/)
    } finally {
      await page.close()
    }
  },
)

test(
  'the actual employee popup gives document answers readable space with the full composer visible',
  browserOptions,
  async () => {
    const { page, take } = await componentPage()
    try {
      await page.setViewportSize({ width: 878, height: 669 })
      await page.evaluate(() => window.mountEmployeeDialog())
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
            name: '赵雅梦',
            color: 0x9b6dd7,
            department: '资料室',
            departmentKey: 'archive',
            departmentEn: 'Records',
            responsibility: '整理各部门日常流程、资料归档',
            role: 'employee',
            chatInstructions: '',
            models: { text: model, search: model, image: model, video: model },
            skills: [],
          },
        ],
      })
      await reply(await take('/api/tenants/test/archive/documents'), { items: [ready('a')] })
      await reply(await take('/api/tenants/test/departments/archive/conversation'), {
        revision: 1,
        messages: [
          {
            id: 'answer',
            role: 'assistant',
            text: '已核对文档中的预算与交付安排。\n'.repeat(20),
            citations: [
              {
                id: '1',
                fileId: 'a',
                extractionId: 'extract-1',
                sha256: 'hash-1',
                filename: 'a.docx',
                blockId: 'p1',
                location: '正文第 1 段',
                quote: '预算 50 万元',
              },
            ],
          },
        ],
      })
      await page.getByRole('button', { name: '收起文档', exact: true }).click()
      const layout = await page.evaluate(() => {
        const selectors = [
          '.employee-dialog',
          '.employee-dialog-header',
          '.employee-dialog-nav',
          '.employee-dialog-body',
          '.employee-chat-view',
          '.employee-responsibility',
          '.department-chat',
          '.archive-chat-pane > .heading-row',
          '.archive-documents',
          '.department-messages',
          '.department-chat form',
          '.department-chat form label',
          '.department-chat textarea',
          '.department-chat-actions',
        ]
        return Object.fromEntries(
          selectors.map((selector) => {
            const element = document.querySelector(selector),
              box = element.getBoundingClientRect(),
              style = getComputedStyle(element)
            return [
              selector,
              {
                top: box.top,
                bottom: box.bottom,
                height: box.height,
                clientHeight: element.clientHeight,
                scrollHeight: element.scrollHeight,
                padding: style.padding,
                margin: style.margin,
                display: style.display,
              },
            ]
          }),
        )
      })
      console.log('employee popup layout', JSON.stringify(layout))
      assert.ok(
        layout['.department-messages'].height >= 260,
        `document answers need at least 260px in the real popup; got ${layout['.department-messages'].height}`,
      )
      assert.ok(
        layout['.employee-dialog-body'].scrollHeight <=
          layout['.employee-dialog-body'].clientHeight + 1,
        'collapsed document chat must fit its modal body without clipping the composer',
      )
      assert.ok(
        layout['.department-chat textarea'].height >= 130,
        'archive input needs at least 130px at 878x669',
      )
      const panes = await page
        .locator('.archive-workspace, .archive-chat-pane')
        .evaluateAll((elements) =>
          elements.map((element) => ({
            x: element.getBoundingClientRect().x,
            width: element.getBoundingClientRect().width,
          })),
        )
      assert.ok(
        panes[1].x >= panes[0].x + panes[0].width,
        'archive conversation must be on the right',
      )
      const send = await page.getByRole('button', { name: '发送', exact: true }).boundingBox()
      assert.ok(
        send.y + send.height <= layout['.employee-dialog-body'].bottom,
        'the whole Send button must remain inside the visible dialog body',
      )
    } finally {
      await page.close()
    }
  },
)
