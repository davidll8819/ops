import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSecretaryReply } from '../apps/api/src/secretary-reply.mjs'

const task = (overrides = {}) => ({
  title: '调研外卖行业竞品',
  dept: 'review-agent',
  due: '2026-10-11',
  brief: '比较三家外卖平台的公开定价，并注明检索来源。',
  ...overrides,
})
const draft = (overrides = {}) => ({
  reply: '已整理为草稿，请确认分工。',
  tasks: [task()],
  ...overrides,
})
const json = (value) => JSON.stringify(value)
function rejects(text, pattern, options) {
  assert.throws(
    () => parseSecretaryReply(text, options),
    (error) => {
      assert.equal(error.statusCode, 502)
      assert.equal(error.expose, true)
      assert.match(error.message, pattern)
      return true
    },
  )
}

test('secretary reply accepts plain conversation without inventing tasks', () => {
  assert.deepEqual(parseSecretaryReply('  老板，需要比较哪些产品？\n  '), {
    reply: '老板，需要比较哪些产品？',
    tasks: [],
    repaired: false,
    repairs: [],
  })
  assert.deepEqual(parseSecretaryReply('配置示例：{"theme":"purple"}，稍后可以更换。'), {
    reply: '配置示例：{"theme":"purple"}，稍后可以更换。',
    tasks: [],
    repaired: false,
    repairs: [],
  })
})

test('secretary reply extracts one complete root from prose, JSON fences or plain JSON', () => {
  for (const text of [
    json(draft()),
    `收到。\n${json(draft())}\n请核对分工。`,
    `收到。\n\`\`\`json\n${json(draft())}\n\`\`\`\n请确认。`,
  ]) {
    const result = parseSecretaryReply(text)
    assert.equal(result.reply, draft().reply)
    assert.deepEqual(result.tasks, [task({ dependsOn: [], requiresConfirmation: true })])
  }
})

test('secretary reply handles escaped strings and nested display metadata without reading inner plans', () => {
  const value = draft({
    reply: '名称含有 {括号}、[数组] 和 "引号"。\\ 路径仍为文字。',
    presentation: { sample: { reply: '示例不可派发', tasks: [task()] }, badge: 'draft' },
    tasks: [
      task({
        icon: 'research',
        theme: { name: 'purple' },
        requiresConfirmation: false,
        dependsOn: null,
      }),
    ],
  })
  const result = parseSecretaryReply(json(value))
  assert.deepEqual(Object.keys(result).sort(), ['repaired', 'repairs', 'reply', 'tasks'])
  assert.equal(result.reply, value.reply)
  assert.deepEqual(result.tasks, [task({ dependsOn: [], requiresConfirmation: true })])
})

test('secretary reply refuses ambiguous plans and nested protocol objects', () => {
  rejects('{"reply":"草稿", "tasks":[], "tasks":[]}', /重复字段/)
  rejects(`${json(draft())}\n另一方案\n${json(draft())}`, /多份任务清单/)
  rejects(
    `\`\`\`json\n${json(draft())}\n\`\`\`\n\`\`\`json\n${json(draft())}\n\`\`\``,
    /多份任务清单/,
  )
  rejects(json({ data: draft() }), /最外层/)
  rejects(json([draft()]), /最外层/)
  rejects(json({ reply: '只有回复缺少任务字段' }), /最外层/)
  rejects(json({ tasks: [task()] }), /最外层/)
})

test('secretary reply reports malformed and truncated protocol data rather than storing it as chat', () => {
  rejects('收到。{"reply":"草稿", "tasks":[', /未闭合/)
  rejects('{"tasks"', /未闭合/)
  rejects('收到。{"reply":"草稿", "tasks":]}', /括号不匹配/)
  rejects('{"reply":"草稿", "tasks":[],}', /语法无效/)
  rejects("{'reply':'草稿','tasks':[]}", /语法无效/)
  rejects('reply: 草稿, tasks: 待生成', /没有完整/)
  rejects(`${json(draft())}\n还有 {"reply":"另一份", "tasks":[`, /未闭合/)
  for (const finishReason of ['length', 'max_tokens', 'max_output_tokens'])
    rejects(json(draft()), /已被截断/, { finishReason })
  rejects(null, /没有返回有效回复/)
  rejects('   ', /没有返回有效回复/)
})

test('secretary reply validates required task fields and preserves exact business requirements', () => {
  rejects(json(draft({ tasks: [task({ title: '' })] })), /第 1 项任务.*title/)
  rejects(json(draft({ tasks: [task({ dept: '市场调研部' })] })), /dept/)
  for (const due of ['2026-02-29', '2026-10-32', '2026-1-1', null])
    rejects(json(draft({ tasks: [task({ due })] })), /due/)
  rejects(json(draft({ tasks: [task({ brief: 'x'.repeat(12001) })] })), /brief/)
  rejects(json(draft({ tasks: [task({ brief: null })] })), /brief/)
  rejects(json(draft({ tasks: [task({ publishRequired: 'false' })] })), /publishRequired/)
  rejects(json(draft({ tasks: [task({ requiresConfirmation: 'true' })] })), /requiresConfirmation/)
  rejects(json(draft({ tasks: Array.from({ length: 11 }, () => task()) })), /最多 10 项/)
  rejects(json(draft({ reply: '' })), /reply/)
  const leapDay = parseSecretaryReply(json(draft({ tasks: [task({ due: '2028-02-29' })] })))
  assert.equal(leapDay.tasks[0].due, '2028-02-29')
  assert.equal(leapDay.tasks[0].brief, task().brief)
  assert.deepEqual(parseSecretaryReply(json(draft({ tasks: [] }))).tasks, [])
})

test('secretary reply validates dependency references and cycles without guessing replacements', () => {
  for (const dependsOn of [[-1], [0.5], ['0'], 'none'])
    rejects(json(draft({ tasks: [task({ dependsOn })] })), /dependsOn/)
  rejects(json(draft({ tasks: [task({ dependsOn: [1] })] })), /不存在/)
  rejects(json(draft({ tasks: [task({ dependsOn: [0] })] })), /依赖自身/)
  rejects(json(draft({ tasks: [task({ dependsOn: [1] }), task({ dependsOn: [0] })] })), /循环/)
  const result = parseSecretaryReply(
    json(draft({ tasks: [task(), task({ dependsOn: [0] }), task({ dependsOn: [0, 1] })] })),
  )
  assert.deepEqual(
    result.tasks.map((item) => item.dependsOn),
    [[], [0], [0, 1]],
  )
  assert.ok(result.tasks.every((item) => item.requiresConfirmation === true))
})

test('secretary reply repairs only the unescaped text quotes in the observed one-person-company draft', () => {
  const response = `

\`\`\`json
{
  "reply": "好的老板，一人公司调研任务草稿已整理好。默认按"全面调研 + 可落地建议"安排，涵盖商业模式、成功案例、法律税务实操、工具链四个维度，交付完整调研报告及行动方案建议。你确认后即可派发。",
  "tasks": [
    {
      "title": ""一人公司"项目全面调研",
      "dept": "review-agent",
      "due": "2026-10-11",
      "brief": "针对"一人公司"项目进行全面市场调研，交付完整调研报告及可落地行动方案建议。调研维度包括：1）商业模式梳理——一人公司适合的赛道及盈利方式（内容、SaaS、咨询、电商等）；2）国内外成功案例分析——典型一人公司的运营模式、规模、收入结构；3）法律/税务/注册实操指南——国内一人公司注册流程、税务优化、合规要点；4）工具链推荐——一个人高效运转所需的效率工具、自动化方案、AI辅助工具。方向完全开放，不限定具体赛道，先全面摸底再给出建议。交付物：调研报告 + 可落地行动方案。",
      "dependsOn": [],
      "requiresConfirmation": true,
      "publishRequired": false
    }
  ]
}
\`\`\``
  const result = parseSecretaryReply(response, { finishReason: 'stop' })
  assert.equal(result.repaired, true)
  assert.equal(result.tasks[0].title, '"一人公司"项目全面调研')
  assert.equal(result.tasks[0].dept, 'review-agent')
  assert.equal(result.tasks[0].due, '2026-10-11')
  assert.deepEqual(result.tasks[0].dependsOn, [])
  assert.match(result.reply, /按"全面调研 \+ 可落地建议"安排/)
  assert.ok(result.tasks[0].brief.startsWith('针对"一人公司"项目进行全面市场调研'))
  assert.deepEqual(
    result.repairs,
    ['reply', 'tasks[0].title', 'tasks[0].brief'].map((field) => ({
      field,
      type: 'escape_unescaped_quote',
      count: 2,
    })),
  )
})

test('secretary quote repair never fixes structural fields, missing syntax, ambiguity or truncation', () => {
  rejects(
    '{"reply":"收到", "tasks":[{"title":""x"调研","dept":"review-"agent","due":"2026-10-11"}]}',
    /语法无效|未闭合/,
  )
  rejects(
    '{"reply":"收到", "tasks":[{"title":""x"调研","dept":"review-agent","due":"2026-"10-11"}]}',
    /语法无效|未闭合/,
  )
  rejects('{"reply":""x"调研" "tasks":[]}', /语法无效/)
  rejects('{"reply":""x"调研", "tasks":[],}', /语法无效/)
  rejects('{"reply":""x"调研", "tasks":[]', /未闭合/)
  rejects('{"reply":""x"调研", "tasks":[], "tasks":[]}', /重复字段/)
  rejects('{"reply":""x"调研", "tasks":[]}\n{"reply":"另一方案", "tasks":[]}', /多份任务清单/)
  rejects('{"reply":""x"调研", "tasks":[]}', /已被截断/, { finishReason: 'length' })
})
