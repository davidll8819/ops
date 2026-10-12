import test from 'node:test'
import assert from 'node:assert/strict'
import {
  publicIPv4,
  publicURL,
  resolvePublic,
  createWebTools,
} from '../apps/api/src/research/web.mjs'
import { plannedTasks } from '../apps/api/src/research/plan.mjs'
import { runResearch } from '../apps/api/src/research/agent.mjs'
test('research plans include dependent archival and reject missing/circular prerequisites', () => {
  const input = [
    { title: 'Research', dept: 'review-agent', brief: 'Full brief', due: '2026-10-11' },
  ]
  const tasks = plannedTasks(input, { batchId: 'b', brief: 'fallback' })
  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].status, 'draft')
  assert.equal(tasks[0].request, 'Full brief')
  assert.equal(tasks[1].dept, 'file-agent')
  assert.deepEqual(tasks[1].dependsOn, [tasks[0].id])
  assert.ok(tasks.every((t) => t.requiresConfirmation))
  assert.throws(() => plannedTasks([{ ...input[0], dependsOn: [2] }], {}))
  assert.throws(() =>
    plannedTasks(
      [
        { ...input[0], dependsOn: [1] },
        { ...input[0], dependsOn: [0] },
      ],
      {},
    ),
  )
  assert.throws(() =>
    plannedTasks(
      [
        { ...input[0], dependsOn: [1] },
        { title: 'Archive', dept: 'file-agent' },
      ],
      {},
    ),
  )
})
test('reader rejects private ranges, encoded IPs, non-http URLs and DNS rebinding targets', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '100.64.1.1',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '0.0.0.0',
    '::1',
  ])
    assert.equal(publicIPv4(ip), false, ip)
  assert.equal(publicIPv4('8.8.8.8'), true)
  for (const url of [
    'file:///etc/passwd',
    'http://2130706433/',
    'http://0x7f000001',
    'https://user:pass@example.com',
    'https://[::ffff:127.0.0.1]',
    'https://example.com:3000',
  ])
    assert.throws(() => publicURL(url), url)
  await assert.rejects(
    resolvePublic('https://example.com', async () => [
      { address: '1.1.1.1' },
      { address: '127.0.0.1' },
    ]),
  )
})
test('search uses configured provider, limits calls and only reads actual search results', async () => {
  const calls = []
  const web = createWebTools(
    { provider: 'tavily', apiKey: 'fixture-secret' },
    {
      fetcher: async (url, options) => {
        calls.push({ url, options })
        return Response.json({
          results: [
            { url: 'https://example.com/report', title: 'Evidence', content: 'Snippet' },
            { url: 'http://127.0.0.1/secret', title: 'Unsafe' },
          ],
        })
      },
      reader: async (url) => ({ url, text: 'Evidence body' }),
    },
  )
  await assert.rejects(web.read('https://example.com/report'))
  const found = await web.search('public market data')
  assert.equal(found.length, 1)
  assert.equal(found[0].read, false)
  assert.ok(!JSON.stringify(found).includes('fixture-secret'))
  const page = await web.read(found[0].url)
  assert.equal(page.read, true)
  assert.equal(page.text, 'Evidence body')
  await web.search('second')
  await web.search('third')
  await assert.rejects(web.search('fourth'))
  assert.equal(calls.length, 3)
  assert.throws(() => createWebTools({ provider: 'tavily', apiKey: '' }))
})
test('autonomous agent searches, reads, reports actual sources and refuses invented citations', async () => {
  const makeWeb = () =>
    createWebTools(
      { provider: 'brave', apiKey: 'fixture' },
      {
        fetcher: async () =>
          Response.json({
            web: {
              results: [
                { url: 'https://example.com/report', title: 'Source', description: 'Excerpt' },
              ],
            },
          }),
        reader: async (url) => ({ url, text: 'Real fixture evidence' }),
      },
    )
  const actions = [
    { action: 'search', query: 'public evidence' },
    { action: 'read', url: 'https://example.com/report' },
    {
      action: 'finish',
      summary: 'Summary [S1]',
      findings: 'Facts [S1]',
      analysis: 'Analysis [S1]',
      recommendations: 'Suggestions',
      limitations: 'Only one source',
    },
  ]
  const run = async (items) => {
    const seen = []
    let i = 0
    const output = await runResearch({
      task: { title: 'Research', summary: 'Goal' },
      web: makeWeb(),
      instructions: 'Fixture skill',
      step: async (n, d) => seen.push([n, d]),
      call: async (messages) => {
        assert.match(messages[0].content, /Fixture skill/)
        return { choices: [{ message: { content: JSON.stringify(items[i++]) } }] }
      },
    })
    return { output, seen }
  }
  const { output, seen } = await run(actions)
  assert.equal(output.sources[0].read, true)
  assert.match(output.report, /Facts/)
  assert.ok(seen.some((s) => s[0] === '正在联网搜索'))
  await assert.rejects(run([actions[2]]), /读取有效来源/)
  await assert.rejects(
    run([...actions.slice(0, 2), { ...actions[2], summary: 'Fake [S99]' }]),
    /来源不完整/,
  )
})
