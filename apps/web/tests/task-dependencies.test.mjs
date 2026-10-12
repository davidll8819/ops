import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

let server, taskDependencies, taskRunState, taskStateLabel, isOperationsNavigation
before(async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
  })
  ;({ taskDependencies, taskRunState, taskStateLabel, isOperationsNavigation } =
    await server.ssrLoadModule('/src/saas/task-dependencies.ts'))
})
after(async () => {
  await server?.close()
})
const task = (id, status = 'queued', extra = {}) => ({
  id,
  status,
  title: id,
  dept: 'app-agent',
  engine: 'department-v1',
  ...extra,
})

test('operations can start only after every prerequisite really completes', () => {
  const video = task('video', 'queued', { dependsOn: ['research', 'design'] })
  const research = task('research', 'completed'),
    design = task('design', 'working')
  const before = structuredClone([video, research, design])
  assert.deepEqual(taskRunState(video, before), {
    available: true,
    prerequisitesReady: false,
    canRun: false,
  })
  for (const status of [
    'draft',
    'queued',
    'working',
    'approval',
    'review',
    'authorized',
    'revision',
    'blocked',
  ])
    assert.equal(taskRunState(video, [research, { ...design, status }]).canRun, false, status)
  assert.equal(taskRunState(video, [research, { ...design, status: 'completed' }]).canRun, true)
  assert.deepEqual(before, [video, research, design])
})

test('missing prerequisites are visible and cannot be treated as complete', () => {
  const video = task('video', 'blocked', { dependsOn: ['missing'] })
  assert.deepEqual(taskDependencies(video, [video]), [
    { id: 'missing', task: undefined, ready: false },
  ])
  assert.equal(taskStateLabel(undefined), '任务记录缺失')
  assert.equal(taskRunState(video, [video]).canRun, false)
})

test('runtime work in progress or with an unknown submission cannot be started twice', () => {
  for (const status of [
    'working',
    'completed',
    'draft',
    'approval',
    'review',
    'authorized',
    'revision',
  ])
    assert.equal(
      taskRunState(task('video', status, { runtimeTaskId: 'accepted' }), []).available,
      false,
      status,
    )
  for (const status of ['queued', 'blocked'])
    assert.equal(taskRunState(task('video', status, { runtimePending: true }), []).canRun, false)
  assert.equal(
    taskRunState(task('video', 'blocked', { runtimeTaskId: 'failed-run' }), []).canRun,
    true,
  )
  assert.equal(taskRunState(task('video'), []).canRun, true)
})

test('design-image recovery respects prerequisite completion and existing images', () => {
  const design = task('design', 'completed', {
    title: '制作参考图',
    dept: 'new-agent-7',
    dependsOn: ['research'],
  })
  assert.equal(taskRunState(design, [task('research', 'blocked')]).canRun, false)
  assert.equal(taskRunState(design, [task('research', 'completed')]).canRun, true)
  assert.equal(
    taskRunState({ ...design, images: [{ fileId: 'image' }] }, [task('research', 'completed')])
      .available,
    false,
  )
})

test('only an explicit navigation instruction bypasses the secretary planner', () => {
  for (const text of [
    '打开运营工作台',
    '请帮我打开一下运营工作台！',
    '进入运营工作台',
    'Open operations workspace',
    'Please open the operations workspace.',
  ])
    assert.equal(isOperationsNavigation(text), true, text)
  for (const text of [
    '让叶凡制作一条视频',
    '交给运营工作台做视频',
    '安排叶凡生成视频，然后让设计部先做参考图',
    '打开运营工作台帮我做视频',
    'Ask Ye Fan to produce a video',
    'Use operations to make a video',
  ])
    assert.equal(isOperationsNavigation(text), false, text)
})
