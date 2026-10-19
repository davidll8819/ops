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
        name: 'ops-test',
        resolveId: (id) => (id === '/__ops.js' ? id : undefined),
        load: (id) =>
          id === '/__ops.js'
            ? `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {DepartmentChat} from '/src/saas/DepartmentChat.tsx';import {OperationsWorkspace} from '/src/saas/operations/OperationsWorkspace.tsx';const root=createRoot(document.getElementById('root'));window.mount=(mode='ops',base='/api/tenants/a',handoff)=>flushSync(()=>root.render(React.createElement(mode==='chat'?DepartmentChat:OperationsWorkspace,{base,department:'content_ops',canEdit:true,openSettings:()=>{},onOperations:brief=>{window.handed=brief},handoff})));window.mountEmployee=async()=>{await import('/src/index.css');await import('/src/saas/saas.css');const {EmployeeDialog}=await import('/src/saas/EmployeeDialog.tsx');const {TEAM_ROSTER}=await import('/src/data/team.ts');const noop=()=>{};flushSync(()=>root.render(React.createElement(EmployeeDialog,{employee:TEAM_ROSTER.find(x=>x.id==='app-agent'),base:'/api/tenants/a',close:noop,openSettings:noop,openSkills:noop,openOperations:noop,onTool:noop,tasks:[],onRun:noop,onTaskOperations:noop,busyTask:'',canEdit:true})));};window.ready=true;`
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
const opt = { skip: process.env.OPERATIONS_UI_BROWSER_TESTS !== '1' }
test(
  'actual YeFan popup keeps readable history, input and send reachable at laptop/mobile sizes',
  opt,
  async () => {
    const p = await page()
    try {
      await p.route('**/api/**', respond)
      for (const size of [
        { width: 878, height: 668 },
        { width: 390, height: 760 },
      ]) {
        await p.setViewportSize(size)
        await p.evaluate(() => window.mountEmployee())
        await p.getByRole('button', { name: '发送', exact: true }).waitFor()
        const box = await p.evaluate(() => {
          const r = (e) => {
            const x = e.getBoundingClientRect()
            return { top: x.top, bottom: x.bottom, height: x.height }
          }
          return {
            log: r(document.querySelector('.department-messages')),
            input: r(document.querySelector('textarea')),
            send: r([...document.querySelectorAll('button')].find((b) => b.textContent === '发送')),
          }
        })
        assert.ok(box.send.bottom <= size.height - 8, JSON.stringify(box))
        assert.ok(box.input.height >= 110, JSON.stringify(box))
        assert.ok(box.log.height >= 180, JSON.stringify(box))
      }
    } finally {
      await p.close()
    }
  },
)
async function page() {
  if (!http) {
    http = httpServer((req, res) =>
      req.url === '/test'
        ? (res.setHeader('content-type', 'text/html'),
          res.end('<div id="root"></div><script type="module" src="/__ops.js"></script>'))
        : vite.middlewares(req, res, () => {
            res.statusCode = 404
            res.end()
          }),
    )
    await new Promise((r) => http.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${http.address().port}`
    browser = await (
      await import('playwright')
    ).chromium.launch({ headless: true, channel: 'msedge' })
  }
  const p = await browser.newPage()
  p.setDefaultTimeout(8000)
  await p.goto(origin + '/test')
  await p.waitForFunction(() => window.ready)
  return p
}
const brief = {
  id: 'brief-a',
  title: '产品视频',
  text: '原始要求：30秒，不发布\n叶凡：分镜',
  sourceMessageId: 'answer',
  sourceRevision: 3,
  createdAt: '2026-10-17T00:00:00Z',
  messages: [],
}

test('selected video format reaches submission and restores with its saved task', opt, async () => {
  const p = await page()
  let body
  try {
    await p.route('**/api/**', (r) => {
      const u = r.request().url()
      if (r.request().method() === 'POST' && u.endsWith('/tasks')) {
        body = r.request().postDataJSON()
        return r.fulfill({
          contentType: 'text/event-stream',
          body: 'data: {"taskId":"aaaaaaaaaaaaaaaaaaaaaaaa"}\n\n',
        })
      }
      if (u.includes('/submissions/'))
        return r.fulfill({
          json: { submission: { state: 'submitted', runtimeTaskId: 'a'.repeat(24) } },
        })
      if (u.endsWith('/tasks/' + 'a'.repeat(24)))
        return r.fulfill({
          json: {
            status: 'completed',
            videoFormat: { ratio: '9:16', resolution: '1080p' },
            messages: [{ text: '保存的竖屏任务' }],
          },
        })
      return respond(r)
    })
    await p.evaluate(() => window.mount())
    await p.getByRole('checkbox', { name: '指定视频规格' }).check()
    await p.getByLabel('视频比例', { exact: true }).selectOption('9:16')
    await p.getByLabel('视频分辨率', { exact: true }).selectOption('1080p')
    await p.getByRole('textbox', { name: '工作要求', exact: true }).fill('咖啡视频，不发布')
    await p.getByRole('button', { name: '开始制作', exact: true }).click()
    await p.getByText('保存的竖屏任务', { exact: true }).waitFor()
    assert.deepEqual(body.videoFormat, { ratio: '9:16', resolution: '1080p' })
    await p.getByRole('button', { name: '新建任务', exact: true }).click()
    assert.equal(await p.getByRole('checkbox', { name: '指定视频规格' }).isChecked(), false)
    await p.evaluate(() =>
      window.mount('ops', '/api/tenants/a', {
        id: 'restore-format',
        text: '',
        runtimeTaskId: 'a'.repeat(24),
      }),
    )
    await p.getByText('保存的竖屏任务', { exact: true }).waitFor()
    assert.equal(await p.getByLabel('视频比例', { exact: true }).inputValue(), '9:16')
    assert.equal(await p.getByLabel('视频分辨率', { exact: true }).inputValue(), '1080p')
    await p.getByRole('checkbox', { name: '指定视频规格' }).uncheck()
    await p
      .getByRole('textbox', { name: '工作要求', exact: true })
      .fill('按工作要求，取消之前指定的规格')
    await p.getByRole('button', { name: '继续这个任务', exact: true }).click()
    await p.getByText('保存的竖屏任务', { exact: true }).waitFor()
    assert.equal(body.videoFormat, null)
  } finally {
    await p.close()
  }
})

test('saved video previews show actual dimensions and fail a mismatched format', opt, async () => {
  const p = await page()
  try {
    await p.route('**/api/**', (r) =>
      r
        .request()
        .url()
        .endsWith('/tasks/' + 'a'.repeat(24))
        ? r.fulfill({
            json: {
              status: 'completed',
              messages: [
                {
                  text: JSON.stringify({
                    status: 'SUCCESS',
                    videoUrl: 'https://example.test/saved.mp4',
                    specification: {
                      requested: { ratio: '9:16', resolution: '720p' },
                      actual: { width: 1920, height: 1080 },
                      matches: false,
                    },
                  }),
                },
              ],
            },
          })
        : respond(r),
    )
    await p.evaluate(() =>
      window.mount('ops', '/api/tenants/a', {
        id: 'mismatch',
        text: '',
        runtimeTaskId: 'a'.repeat(24),
      }),
    )
    await p.getByText('实际：1920 × 1080', { exact: true }).waitFor()
    assert.equal(
      await p.getByText('视频规格未通过，请核对成品；不会自动重新生成。', { exact: true }).count(),
      1,
    )
    assert.equal(await p.getByText('视频规格验收通过', { exact: true }).count(), 0)
  } finally {
    await p.close()
  }
})
test(
  'a temporary missing reservation after network failure never enables a second paid request',
  opt,
  async () => {
    const p = await page()
    let posts = 0
    try {
      await p.route('**/api/**', (r) => {
        const u = r.request().url()
        if (r.request().method() === 'POST' && u.endsWith('/tasks')) {
          posts++
          return r.fulfill({ status: 502, json: { message: 'proxy lost response' } })
        }
        if (u.includes('/submissions/'))
          return r.fulfill({ status: 404, json: { message: 'not found yet' } })
        return respond(r)
      })
      await p.evaluate(() => window.mount())
      await p.getByRole('textbox', { name: '工作要求', exact: true }).fill('preview')
      await p.getByRole('button', { name: '开始制作', exact: true }).click()
      await p.getByRole('button', { name: '核对提交记录', exact: true }).waitFor()
      assert.equal(
        await p.getByRole('button', { name: '开始制作', exact: true }).isEnabled(),
        false,
      )
      assert.equal(posts, 1)
    } finally {
      await p.close()
    }
  },
)
test('late stop response cannot reload the old task after selecting a new one', opt, async () => {
  const p = await page()
  let held, entered
  const started = new Promise((r) => (entered = r))
  try {
    await p.route('**/api/**', (r) => {
      const u = r.request().url()
      if (u.endsWith('/abort')) {
        held = r
        entered()
        return
      }
      if (u.endsWith('/tasks'))
        return r.fulfill({
          json: { list: [{ id: 'e'.repeat(24), title: '任务B', status: 'completed' }] },
        })
      if (u.endsWith('/tasks/' + 'd'.repeat(24)))
        return r.fulfill({ json: { status: 'running', messages: [{ text: '任务A记录' }] } })
      if (u.endsWith('/tasks/' + 'e'.repeat(24)))
        return r.fulfill({ json: { status: 'completed', messages: [{ text: '任务B记录' }] } })
      return respond(r)
    })
    await p.evaluate(() =>
      window.mount('ops', '/api/tenants/a', {
        id: 'start',
        text: 'A',
        runtimeTaskId: 'd'.repeat(24),
      }),
    )
    await p.getByText('正在制作，可查看实时记录', { exact: true }).waitFor()
    await p.getByRole('button', { name: '停止制作', exact: true }).click()
    await started
    await p.getByRole('button', { name: /任务B ·/ }).click()
    await p.getByText('任务B记录', { exact: true }).waitFor()
    const res = p.waitForResponse((r) => r.url().endsWith('/abort'))
    await held.fulfill({ json: { requested: true } })
    await (await res).finished()
    await p.getByRole('button', { name: '核对提交记录', exact: true }).click()
    assert.equal(await p.getByText('任务A记录', { exact: true }).count(), 0)
  } finally {
    await p.close()
  }
})
test(
  'recovering a saved submission restores its source even when chat has expired',
  opt,
  async () => {
    const p = await page()
    try {
      await p.route('**/api/**', (r) => {
        const u = r.request().url()
        if (u.endsWith('/submissions'))
          return r.fulfill({
            json: {
              items: [
                { requestId: 'request-saved', state: 'submitted', createdAt: brief.createdAt },
              ],
            },
          })
        if (u.includes('/submissions/'))
          return r.fulfill({
            json: {
              submission: { state: 'submitted', runtimeTaskId: 'f'.repeat(24), briefId: brief.id },
            },
          })
        if (u.endsWith('/briefs/' + brief.id)) return r.fulfill({ json: { brief } })
        if (u.endsWith('/tasks/' + 'f'.repeat(24)))
          return r.fulfill({ json: { status: 'completed', messages: [{ text: '成品' }] } })
        return respond(r)
      })
      await p.evaluate(() => window.mount())
      await p.getByRole('button', { name: /request-/ }).click()
      await p.getByText('方案来源 · 叶凡对话', { exact: true }).waitFor()
      await p.getByText('查看保存的工作要求与方案原文', { exact: true }).click()
      assert.match(await p.locator('.ops-brief-source pre').innerText(), /30秒，不发布/)
    } finally {
      await p.close()
    }
  },
)
async function respond(r) {
  const url = r.request().url()
  if (url.endsWith('/employees')) return r.fulfill({ json: { employees: [] } })
  return r.fulfill({
    json: url.endsWith('/status')
      ? { ready: true, reason: 'ready' }
      : url.endsWith('/conversation')
        ? { revision: 3, messages: [{ id: 'answer', role: 'assistant', text: '已拟定分镜' }] }
        : url.endsWith('/briefs')
          ? { brief }
          : url.includes('/accounts')
            ? { list: [] }
            : { items: [], list: [] },
  })
}
test(
  'YeFan can draft all three kinds and hand a saved reply off without generation',
  opt,
  async () => {
    const p = await page()
    let posts = []
    try {
      await p.route('**/api/**', (r) => {
        if (r.request().method() === 'POST')
          posts.push([r.request().url(), r.request().postDataJSON()])
        return respond(r)
      })
      await p.evaluate(() => window.mount('chat'))
      await p.getByRole('button', { name: '视频脚本与分镜', exact: true }).click()
      assert.match(
        await p.getByRole('textbox', { name: '工作要求', exact: true }).inputValue(),
        /时长/,
      )
      await p.getByRole('button', { name: '带入运营工作台', exact: true }).click()
      await p.waitForFunction(() => window.handed)
      assert.equal(await p.evaluate(() => window.handed.id), 'brief-a')
      assert.equal(posts.length, 1)
      assert.equal(posts[0][1].revision, 3)
      assert.equal(posts[0][1].messageId, 'answer')
    } finally {
      await p.close()
    }
  },
)
test(
  'handoff waits for click; EOF queries real status and shows image/video previews',
  opt,
  async () => {
    const p = await page()
    let posts = 0
    try {
      await p.route('**/api/**', (r) => {
        const u = r.request().url()
        if (r.request().method() === 'POST' && u.endsWith('/tasks')) {
          posts++
          return r.fulfill({
            contentType: 'text/event-stream',
            body: 'data: ' + JSON.stringify({ taskId: 'a'.repeat(24), text: '已接收' }) + '\n\n',
          })
        }
        if (u.includes('/submissions/'))
          return r.fulfill({
            json: { submission: { state: 'submitted', runtimeTaskId: 'a'.repeat(24) } },
          })
        if (u.endsWith('/tasks/' + 'a'.repeat(24)))
          return r.fulfill({
            json: {
              status: 'completed',
              messages: [
                {
                  text: '制作完成',
                  medias: [
                    { type: 'IMAGE', url: 'https://assets.test/a.png' },
                    { type: 'VIDEO', url: 'https://assets.test/a.mp4' },
                  ],
                },
              ],
            },
          })
        return respond(r)
      })
      await p.evaluate(
        (b) => window.mount('ops', '/api/tenants/a', { id: 'handoff', text: '先做预览', brief: b }),
        brief,
      )
      await p.getByText('方案来源 · 叶凡对话', { exact: true }).waitFor()
      assert.equal(posts, 0)
      await p.getByRole('button', { name: '开始制作', exact: true }).click()
      await p.getByText('制作已完成，请验收成果', { exact: true }).waitFor()
      assert.equal(posts, 1)
      assert.equal(await p.locator('.ops-assets img').count(), 1)
      assert.equal(await p.locator('.ops-assets video').count(), 1)
    } finally {
      await p.close()
    }
  },
)
test('uncertain submission blocks a fresh request and offers recovery', opt, async () => {
  const p = await page()
  let posts = 0
  try {
    await p.route('**/api/**', (r) => {
      const u = r.request().url()
      if (r.request().method() === 'POST' && u.endsWith('/tasks')) {
        posts++
        return r.fulfill({ status: 502, json: { message: '连接断开' } })
      }
      if (u.includes('/submissions/'))
        return r.fulfill({ json: { submission: { state: 'uncertain', runtimeTaskId: null } } })
      return respond(r)
    })
    await p.evaluate(() => window.mount())
    await p.getByRole('textbox', { name: '工作要求', exact: true }).fill('生成视频')
    await p.getByRole('button', { name: '开始制作', exact: true }).click()
    await p.getByText('提交结果待核对，请勿重复生成', { exact: true }).waitFor()
    assert.equal(await p.getByRole('button', { name: '开始制作', exact: true }).isEnabled(), false)
    await p.getByRole('button', { name: '核对提交记录', exact: true }).click()
    assert.equal(posts, 1)
    assert.equal(await p.getByRole('button', { name: '新建任务', exact: true }).count(), 0)
  } finally {
    await p.close()
  }
})
test(
  'SSE ending while runtime runs is not completion; later real status completes it',
  opt,
  async () => {
    const p = await page()
    let completed = false
    try {
      await p.route('**/api/**', (r) => {
        const u = r.request().url()
        if (r.request().method() === 'POST' && u.endsWith('/tasks'))
          return r.fulfill({
            contentType: 'text/event-stream',
            body: 'data: ' + JSON.stringify({ taskId: 'b'.repeat(24) }) + '\n\n',
          })
        if (u.includes('/submissions/'))
          return r.fulfill({
            json: { submission: { state: 'submitted', runtimeTaskId: 'b'.repeat(24) } },
          })
        if (u.endsWith('/tasks/' + 'b'.repeat(24)))
          return r.fulfill({
            json: {
              status: completed ? 'completed' : 'running',
              messages: [{ text: 'runtime log' }],
            },
          })
        return respond(r)
      })
      await p.evaluate(() => window.mount())
      await p.getByRole('textbox', { name: '工作要求', exact: true }).fill('制作')
      await p.getByRole('button', { name: '开始制作', exact: true }).click()
      await p.getByText('正在制作，可查看实时记录', { exact: true }).waitFor()
      assert.equal(await p.getByText('制作已完成，请验收成果', { exact: true }).count(), 0)
      assert.equal(
        await p.getByRole('button', { name: '继续这个任务', exact: true }).isEnabled(),
        false,
      )
      completed = true
      await p.getByRole('button', { name: '核对提交记录', exact: true }).click()
      await p.getByText('制作已完成，请验收成果', { exact: true }).waitFor()
    } finally {
      await p.close()
    }
  },
)
test('a delayed handoff task cannot replace a newer handoff or another tenant', opt, async () => {
  const p = await page()
  let held, entered
  const started = new Promise((r) => (entered = r))
  try {
    await p.route('**/api/**', (r) => {
      if (
        r
          .request()
          .url()
          .endsWith('/tasks/' + 'c'.repeat(24))
      ) {
        held = r
        entered()
        return
      }
      return respond(r)
    })
    await p.evaluate(() =>
      window.mount('ops', '/api/tenants/a', {
        id: 'old',
        text: '旧交接',
        runtimeTaskId: 'c'.repeat(24),
      }),
    )
    await started
    await p.evaluate(() =>
      window.mount('ops', '/api/tenants/a', { id: 'new', text: '新的工作要求' }),
    )
    const response = p.waitForResponse((r) => r.url().endsWith('/tasks/' + 'c'.repeat(24)))
    await held.fulfill({ json: { status: 'completed', messages: [{ text: '过期内容' }] } })
    await (await response).finished()
    assert.equal(
      await p.getByRole('textbox', { name: '工作要求', exact: true }).inputValue(),
      '新的工作要求',
    )
    assert.equal(await p.getByText('过期内容', { exact: true }).count(), 0)
    await p.evaluate(() => window.mount('ops', '/api/tenants/other'))
    assert.equal(await p.getByRole('textbox', { name: '工作要求', exact: true }).inputValue(), '')
    assert.equal(await p.getByText('过期内容', { exact: true }).count(), 0)
  } finally {
    await p.close()
  }
})
test('selecting a slow task cancels the old running task poll', opt, async () => {
  const p = await page()
  let aRequests = 0,
    held,
    entered
  const started = new Promise((r) => (entered = r))
  try {
    await p.clock.install()
    await p.route('**/api/**', (r) => {
      const u = r.request().url()
      if (u.endsWith('/tasks'))
        return r.fulfill({
          json: { list: [{ id: 'e'.repeat(24), title: '慢任务B', status: 'completed' }] },
        })
      if (u.endsWith('/tasks/' + 'd'.repeat(24))) {
        aRequests++
        return r.fulfill({ json: { status: 'running', messages: [{ text: 'A正在制作' }] } })
      }
      if (u.endsWith('/tasks/' + 'e'.repeat(24))) {
        held = r
        entered()
        return
      }
      return respond(r)
    })
    await p.evaluate(() =>
      window.mount('ops', '/api/tenants/a', {
        id: 'old-poll',
        text: 'A',
        runtimeTaskId: 'd'.repeat(24),
      }),
    )
    await p.getByText('正在制作，可查看实时记录', { exact: true }).waitFor()
    await p.getByRole('button', { name: /慢任务B ·/ }).click()
    await started
    await p.clock.runFor(6000)
    assert.equal(aRequests, 1)
    await held.fulfill({ json: { status: 'completed', messages: [{ text: '慢任务B结果' }] } })
    await p.getByText('慢任务B结果', { exact: true }).waitFor()
  } finally {
    await p.close()
  }
})
