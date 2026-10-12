import test from 'node:test'
import assert from 'node:assert/strict'
import { runOutlinedResearch } from '../apps/api/src/research/outlined-agent.mjs'

const section = (n) => ({
  title: `主题 ${n}`,
  questions: [`问题 ${n}`],
  query: `query ${n}`,
})
const response = (value, finish_reason = 'stop') => ({
  choices: [{ finish_reason, message: { content: JSON.stringify(value) } }],
})
function fixture({
  count = 1,
  results = 2,
  failReads = [],
  report: changeReport,
  plan,
  truncated,
} = {}) {
  const outline = Array.from({ length: count }, (_, index) => section(index + 1))
  const timeline = [],
    steps = [],
    sources = new Map()
  let modelCalls = 0,
    reads = 0
  const web = {
    sources,
    async search(query) {
      timeline.push(`search:${query}`)
      const found = []
      for (let index = 0; index < results; index++) {
        const id = `S${sources.size + 1}`
        const source = {
          id,
          url: `https://example.com/${id}`,
          title: `Source ${id}`,
          snippet: 'Search excerpt only',
          retrievedAt: '2026-10-11T00:00:00.000Z',
          read: false,
        }
        sources.set(source.url, source)
        found.push(source)
      }
      return found
    },
    async read(url) {
      reads++
      const source = sources.get(url)
      timeline.push(`read:${source.id}`)
      if (failReads.includes(source.id)) throw Error('fixture failure')
      source.read = true
      source.readAt = '2026-10-11T00:01:00.000Z'
      return { ...source, text: `Public evidence ${source.id}` }
    },
  }
  const options = {
    task: { title: '任务标题', request: '用户的具体调研目标' },
    instructions: 'Fixture skill reference',
    web,
    step: async (name, detail, data) => {
      timeline.push(`step:${name}`)
      steps.push({ name, detail, data })
    },
    call: async (messages) => {
      modelCalls++
      assert.match(messages[0].content, /Fixture skill reference/)
      assert.match(messages[1].content, /用户的具体调研目标/)
      if (modelCalls === 1) {
        timeline.push('model:outline')
        return response(plan || { sections: outline }, truncated === 'plan' ? 'length' : 'stop')
      }
      timeline.push('model:report')
      assert.match(messages[1].content, /Public evidence/)
      const latest = steps.filter((step) => step.data).at(-1).data.researchOutline
      const available = [...sources.values()].filter((source) => source.read)
      const value = {
        summary: `结论 [${available[0].id}]`,
        findings: latest
          .map(
            (item) =>
              `${item.title}\n${item.sourceIds.length ? `事实 [${item.sourceIds[0]}]` : '证据不足'}`,
          )
          .join('\n'),
        analysis: `推断 [${available[0].id}]`,
        recommendations: '建议进行下一轮验证',
        limitations: '样本有限',
      }
      return response(
        changeReport ? changeReport(value) : value,
        truncated === 'report' ? 'length' : 'stop',
      )
    },
  }
  return { options, steps, timeline, counts: () => ({ modelCalls, reads }) }
}

test('research builds and persists a goal-specific outline before searching, then reports real evidence', async () => {
  const f = fixture({ count: 2 })
  const result = await runOutlinedResearch(f.options)
  assert.deepEqual(f.timeline.slice(0, 3), [
    'step:正在制定调研目录',
    'model:outline',
    'step:调研目录已生成',
  ])
  const firstSaved = f.steps.find((step) => step.name === '调研目录已生成')
  assert.ok(firstSaved.data.researchOutline.every((item) => item.status === 'pending'))
  assert.deepEqual(
    result.researchOutline.map((item) => item.status),
    ['completed', 'completed'],
  )
  assert.equal(result.sources.length, 4)
  assert.ok(result.sources.every((source) => source.read && !('text' in source)))
  assert.match(result.report, /调研目录/)
  assert.match(result.report, /问题 1/)
  assert.match(result.report, /https:\/\/example.com\/S1/)
  assert.match(result.report, /2026-10-11T00:01:00.000Z/)
  assert.deepEqual(f.counts(), { modelCalls: 2, reads: 4 })
})

test('a failed read tries the next source, and failed sections remain visibly limited', async () => {
  const f = fixture({ count: 2, failReads: ['S1', 'S3', 'S4'] })
  const result = await runOutlinedResearch(f.options)
  assert.deepEqual(result.researchOutline[0].sourceIds, ['S2'])
  assert.equal(result.researchOutline[1].status, 'blocked')
  assert.match(result.researchOutline[1].limitation, /未能读取/)
  assert.match(result.report, /实际检索局限/)
  assert.match(result.report, /S3：网页无法读取/)
  assert.deepEqual(
    result.sources.map((source) => source.id),
    ['S2'],
  )
  assert.ok(f.timeline.indexOf('read:S2') > f.timeline.indexOf('read:S1'))
})

test('missing search provenance or all failed reads cannot produce a completed report', async () => {
  for (const fixtureOptions of [{ results: 0 }, { failReads: ['S1', 'S2'] }]) {
    const f = fixture(fixtureOptions)
    await assert.rejects(runOutlinedResearch(f.options), /尚未读取有效来源/)
    assert.equal(f.counts().modelCalls, 1)
    assert.equal(f.steps.at(-1).data.researchOutline[0].status, 'blocked')
  }
  const f = fixture()
  f.options.web.search = async () => [{ id: 'S999', url: 'https://invented.example/report' }]
  await assert.rejects(runOutlinedResearch(f.options), /尚未读取有效来源/)
  assert.equal(f.counts().reads, 0)
})

test('search errors persist the current section failure before stopping without synthesis', async () => {
  const f = fixture({ count: 2 })
  f.options.web.search = async () => {
    throw Error('fixture gateway unavailable')
  }
  await assert.rejects(runOutlinedResearch(f.options), /fixture gateway/)
  assert.deepEqual(
    f.steps.at(-1).data.researchOutline.map((item) => item.status),
    ['blocked', 'pending'],
  )
  assert.match(f.steps.at(-1).detail, /已配置模型未能完成/)
  assert.equal(f.counts().modelCalls, 1)
})

test('outline validation rejects malformed or oversized plans before any searches', async () => {
  for (const plan of [
    { sections: [] },
    { sections: [section(1), section(2), section(3), section(4)] },
    { sections: [section(1), section(1)] },
    { sections: [{ ...section(1), questions: [] }] },
    { sections: [{ ...section(1), query: 'x'.repeat(301) }] },
    { sections: [{ ...section(1), action: 'publish' }] },
    { sections: [section(1)], answer: 'unsupported' },
  ]) {
    const f = fixture({ plan })
    await assert.rejects(runOutlinedResearch(f.options), /调研目录/)
    assert.ok(!f.timeline.some((event) => event.startsWith('search:')))
  }
})

test('report rejects invented and unread citations, invented links, missing chapters and truncated output', async () => {
  for (const changeReport of [
    (value) => ({ ...value, summary: '伪造 [S99]' }),
    (value) => ({ ...value, summary: '搜索摘要 [S3]' }),
    (value) => ({ ...value, summary: '假链接 https://invented.example/report [S1]' }),
    (value) => ({ ...value, findings: '缺少目录 [S1]' }),
    (value) => ({ ...value, findings: '主题 1\n没有来源' }),
    (value) => ({ ...value, analysis: '' }),
  ]) {
    const f = fixture({ results: 3, report: changeReport })
    await assert.rejects(runOutlinedResearch(f.options), /报告/)
  }
  for (const truncated of ['plan', 'report']) {
    const f = fixture({ truncated })
    await assert.rejects(runOutlinedResearch(f.options), /未完整返回/)
  }
})

test('three outline groups stay within three searches and six read attempts', async () => {
  const f = fixture({ count: 3, results: 5, failReads: ['S1'] })
  const result = await runOutlinedResearch(f.options)
  assert.equal(f.timeline.filter((event) => event.startsWith('search:')).length, 3)
  assert.equal(f.counts().reads, 6)
  assert.equal(result.sources.length, 5)
  assert.ok(result.researchOutline.every((item) => item.status === 'completed'))
})
