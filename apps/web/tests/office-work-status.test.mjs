import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

let server, deriveOfficeWorkStatuses, roster, departmentIds

before(async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
  })
  ;({ deriveOfficeWorkStatuses } = await server.ssrLoadModule('/src/saas/office-work-status.ts'))
  ;({ TEAM_ROSTER: roster } = await server.ssrLoadModule('/src/data/team.ts'))
  ;({ departmentIds } = await server.ssrLoadModule('/src/saas/departments.ts'))
})

after(async () => {
  await server?.close()
})

const ready = () => ({
  departments: Object.values(departmentIds).map((id) => ({
    id,
    enabled: true,
    ready: true,
    active: false,
  })),
})
const task = (status, extras = {}) => ({
  id: status,
  title: `${status} task`,
  dept: 'new-agent-7',
  status,
  ...extras,
})

test('all nine ready colleagues, including intern and records, are idle green without tasks', () => {
  const actual = deriveOfficeWorkStatuses({ tasks: [] }, ready())
  assert.equal(Object.keys(actual).length, 9)
  for (const member of roster) {
    assert.equal(actual[member.id].status, 'idle', member.id)
    assert.equal(actual[member.id].label, '空闲')
    assert.equal(actual[member.id].color, 0x4a9c59)
  }
})

test('configuration loading, disabled and missing model are distinguishable gray states', () => {
  const initial = deriveOfficeWorkStatuses({ tasks: [] }, null)
  assert.ok(
    Object.values(initial).every(
      (value) => value.status === 'unknown' && value.label === '状态查询中',
    ),
  )
  const config = ready()
  config.departments.find((item) => item.id === 'compliance').enabled = false
  config.departments.find((item) => item.id === 'archive').ready = false
  config.departments = config.departments.filter((item) => item.id !== 'design')
  const actual = deriveOfficeWorkStatuses({ tasks: [] }, config)
  assert.equal(actual['data-agent'].label, '未启用')
  assert.equal(actual['file-agent'].label, '待配置')
  assert.equal(actual['new-agent-7'].label, '状态查询中')
  for (const id of ['data-agent', 'file-agent', 'new-agent-7'])
    assert.equal(actual[id].color, 0x8a9299)
})

test('a persisted working task is red even before configuration has loaded', () => {
  const actual = deriveOfficeWorkStatuses({ tasks: [task('working')] }, undefined)['new-agent-7']
  assert.equal(actual.status, 'working')
  assert.equal(actual.color, 0xdc4646)
  assert.equal(actual.taskId, 'working')
})

test('working wins over newer pending, queued and completed tasks regardless of array order', () => {
  const tasks = [
    task('working', { updatedAt: '2026-10-11T11:00:00Z' }),
    task('completed', { updatedAt: '2026-10-11T12:00:00Z' }),
    task('approval', { updatedAt: '2026-10-11T13:00:00Z' }),
    task('queued', { updatedAt: '2026-10-11T14:00:00Z' }),
  ]
  for (let offset = 0; offset < tasks.length; offset++) {
    const rotated = tasks.slice(offset).concat(tasks.slice(0, offset))
    assert.equal(
      deriveOfficeWorkStatuses({ tasks: rotated }, ready())['new-agent-7'].taskId,
      'working',
    )
  }
})

test('waiting tasks are yellow with truthful labels; queued is not reported as working', () => {
  for (const [status, label] of Object.entries({
    draft: '等待确认',
    approval: '等待确认',
    review: '待查看',
    revision: '待修改',
    blocked: '待处理',
    queued: '等待执行',
    authorized: '等待发布',
  })) {
    const actual = deriveOfficeWorkStatuses({ tasks: [task(status)] }, ready())['new-agent-7']
    assert.equal(actual.label, label, status)
    assert.equal(actual.color, 0xd6a329)
    assert.notEqual(actual.status, 'working')
  }
})

test('completion returns a ready department to green but does not hide other waiting work', () => {
  const tasks = [task('completed')]
  assert.equal(deriveOfficeWorkStatuses({ tasks }, ready())['new-agent-7'].status, 'idle')
  tasks.push(task('queued'))
  assert.equal(deriveOfficeWorkStatuses({ tasks }, ready())['new-agent-7'].status, 'queued')
  tasks.push(task('approval'))
  assert.equal(deriveOfficeWorkStatuses({ tasks }, ready())['new-agent-7'].status, 'pending')
})

test('direct model requests turn secretary and intern red without task records', () => {
  const config = ready()
  for (const id of ['secretary', 'intern'])
    config.departments.find((item) => item.id === id).active = true
  const actual = deriveOfficeWorkStatuses(
    { tasks: [task('approval', { dept: 'new-agent-9' })] },
    config,
  )
  assert.equal(actual.marvis.status, 'working')
  assert.equal(actual['new-agent-9'].status, 'working')
  assert.equal(
    actual['new-agent-9'].taskId,
    undefined,
    'pending task must not be presented as executing',
  )
  assert.equal(actual['review-agent'].status, 'idle')
})

test('each employee uses their own department status and task assignment', () => {
  for (const member of roster) {
    const config = ready()
    config.departments.find((item) => item.id === departmentIds[member.id]).active = true
    const actual = deriveOfficeWorkStatuses({ tasks: [] }, config)
    assert.equal(actual[member.id].status, 'working', member.id)
    assert.equal(Object.values(actual).filter((item) => item.status === 'working').length, 1)
  }
})

test('derivation does not mutate the board or configuration', () => {
  const board = { tasks: [task('queued'), task('working')] },
    config = ready()
  const before = structuredClone({ board, config })
  deriveOfficeWorkStatuses(board, config)
  assert.deepEqual({ board, config }, before)
})
