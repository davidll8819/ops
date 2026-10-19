import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareSuperpowers } from '../apps/api/src/superpowers.mjs'
import { skillsFromRows, runWithSkills } from '../apps/api/src/skill-runtime.mjs'
import { performDepartmentTask } from '../apps/api/src/secretary-execution.mjs'

const tool = (id, path) => ({
  id,
  type: 'function',
  function: { name: 'read_skill', arguments: JSON.stringify({ path }) },
})
const response = (message) => ({ choices: [{ message }] })
const request = {
  ctx: {},
  policy: {},
  department: 'dev',
  path: '/api/v1/chat/completions',
  body: { messages: [{ role: 'user', content: 'Diagnose a bug' }], max_tokens: 1000 },
}
async function bundle() {
  const pack = await prepareSuperpowers()
  return skillsFromRows([
    {
      id: 'bound-package',
      name: pack.name,
      format: pack.format,
      package_data: pack.buffer,
      skill_file: pack.skillFile,
    },
  ])
}
test('official bundle keeps the full workflow and retrieves referenced documents on demand', async () => {
  const skills = await bundle()
  assert.ok(skills.documents.has('bound-package/skills/systematic-debugging/SKILL.md'))
  assert.ok(
    skills.documents.has('bound-package/skills/test-driven-development/writing-good-tests.md'),
  )
  let step = 0
  const result = await runWithSkills({
    ...request,
    skills,
    call: async (req) => {
      if (step++ === 0) {
        assert.ok(req.body.tools.some((t) => t.function.name === 'read_skill'))
        return response({
          role: 'assistant',
          content: null,
          tool_calls: [tool('a', 'bound-package/skills/systematic-debugging/SKILL.md')],
        })
      }
      assert.equal(req.body.messages.at(-1).role, 'tool')
      assert.equal(
        req.body.messages.at(-1).content,
        skills.documents.get('bound-package/skills/systematic-debugging/SKILL.md'),
      )
      return response({ content: '先复现并查明根因' })
    },
  })
  assert.equal(result.choices[0].message.content, '先复现并查明根因')
  assert.ok(result.skillReads.some((r) => r.path.endsWith('systematic-debugging/SKILL.md')))
})
test('read_skill cannot access unbound packages or disk and records only successful reads', async () => {
  const skills = await bundle()
  let step = 0
  const result = await runWithSkills({
    ...request,
    skills,
    call: async (req) => {
      if (step++ === 0)
        return response({
          content: null,
          tool_calls: [tool('a', '../../.env'), tool('b', 'unbound/skills/secret/SKILL.md')],
        })
      assert.ok(req.body.messages.slice(-2).every((m) => JSON.parse(m.content).error))
      return response({ content: '不可读取' })
    },
  })
  assert.ok(
    result.skillReads.every((r) => !r.path.includes('.env') && !r.path.startsWith('unbound/')),
  )
})
test('official referenced TypeScript and Graphviz sources are readable without executing them', async () => {
  const skills = await bundle()
  const paths = [
    'bound-package/skills/systematic-debugging/condition-based-waiting-example.ts',
    'bound-package/skills/writing-skills/graphviz-conventions.dot',
  ]
  let step = 0
  await runWithSkills({
    ...request,
    skills,
    call: async (req) => {
      if (step++ === 0)
        return response({
          content: null,
          tool_calls: paths.map((path, i) => tool(String(i), path)),
        })
      const results = req.body.messages.slice(-2)
      assert.match(results[0].content, /waitFor/)
      assert.match(results[1].content, /digraph/)
      return response({ content: '文档已读取' })
    },
  })
})
test('repeated tool requests terminate without claiming a completed reply', async () => {
  const skills = await bundle()
  let count = 0
  await assert.rejects(
    runWithSkills({
      ...request,
      skills,
      call: async () => {
        count++
        return response({
          content: 'done',
          tool_calls: [tool('repeat', 'bound-package/skills/brainstorming/SKILL.md')],
        })
      },
    }),
    { statusCode: 502 },
  )
  assert.ok(count <= 7)
})
test('tool continuation retains provider reasoning state required by thinking models', async () => {
  const skills = await bundle()
  let step = 0
  await runWithSkills({
    ...request,
    skills,
    call: async (req) => {
      if (step++ === 0)
        return response({
          role: 'assistant',
          content: null,
          reasoning_content: 'provider-required-continuation-state',
          tool_calls: [tool('thinking', 'bound-package/skills/brainstorming/SKILL.md')],
        })
      assert.equal(
        req.body.messages.at(-2).reasoning_content,
        'provider-required-continuation-state',
      )
      return response({ content: '先澄清需求' })
    },
  })
})
test('skill chat quotes prior public conversation instead of replaying incomplete thinking turns', async () => {
  const skills = await bundle()
  const current = [
    { type: 'text', text: '继续排查' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
  ]
  await runWithSkills({
    ...request,
    body: {
      messages: [
        { role: 'system', content: '员工身份' },
        { role: 'user', content: '保存后白屏' },
        { role: 'assistant', content: '请提供复现步骤' },
        { role: 'user', content: current },
      ],
    },
    skills,
    call: async (req) => {
      assert.equal(req.body.messages[0].content, '员工身份')
      assert.ok(!req.body.messages.some((m) => m.role === 'assistant'))
      assert.match(JSON.stringify(req.body.messages), /保存后白屏/)
      assert.match(JSON.stringify(req.body.messages), /请提供复现步骤/)
      assert.deepEqual(req.body.messages.at(-1).content, current)
      return response({ content: '收到' })
    },
  })
})
test('bootstrap is actually included even when other bound entries fill the prompt budget', async () => {
  const pack = await prepareSuperpowers()
  const rows = ['a', 'b', 'c'].map((id) => ({
    id,
    name: id,
    format: 'md',
    skill_file: 'SKILL.md',
    package_data: Buffer.from('z'.repeat(24000)),
  }))
  rows.push({
    id: 'suite',
    name: pack.name,
    format: pack.format,
    package_data: pack.buffer,
    skill_file: pack.skillFile,
  })
  const skills = await skillsFromRows(rows)
  const bootstrap = skills.documents.get('suite/skills/using-superpowers/SKILL.md')
  assert.ok(skills.instructions.includes(bootstrap))
})
test('an employee with no bindings uses the existing single model request without tools', async () => {
  const skills = await skillsFromRows([])
  let count = 0
  const result = await runWithSkills({
    ...request,
    skills,
    call: async (req) => {
      count++
      assert.equal(req.body.tools, undefined)
      return response({ content: '普通回答' })
    },
  })
  assert.equal(count, 1)
  assert.equal(result.choices[0].message.content, '普通回答')
})
test('department text task can retrieve its bound skill before producing the deliverable', async () => {
  const skills = await bundle()
  let step = 0
  const result = await performDepartmentTask({
    ctx: {},
    policy: {},
    skills,
    task: { dept: 'code-agent', title: '排查', request: '崩溃' },
    inputs: { text: '', attachments: { parts: [] } },
    call: async (req) => {
      if (step++ === 0) {
        assert.ok(req.body.tools?.some((t) => t.function.name === 'read_skill'))
        assert.match(req.body.messages[0].content, /superpowers/)
        return response({
          content: null,
          tool_calls: [tool('read-task', 'bound-package/skills/systematic-debugging/SKILL.md')],
        })
      }
      assert.equal(
        req.body.messages.at(-1).content,
        skills.documents.get('bound-package/skills/systematic-debugging/SKILL.md'),
      )
      return response({ content: '排查计划' })
    },
  })
  assert.equal(result.output, '排查计划')
})
