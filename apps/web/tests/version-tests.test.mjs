import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canDeliverTest, testFeedback, testRequestRejected } from '../src/saas/version-tests.ts'

const passed = {
  id: 'run-1',
  versionId: 'version-1',
  versionLabel: '第一版',
  sourceRevision: 7,
  snapshotSha256: 'a'.repeat(64),
  state: 'passed',
  exitCode: 0,
  counts: { tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0 },
  timedOut: false,
  truncated: false,
  finishedAt: '2026-10-15T00:00:00Z',
  detail: '',
  stdout: '',
  stderr: '',
  cases: [],
}

test('known request rejections release pending recovery while unknown outcomes retain it', () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429])
    assert.equal(testRequestRejected(Object.assign(new Error('rejected'), { status })), true)
  for (const failure of [
    new Error('network disconnected'),
    new Error('missing final response'),
    Object.assign(new Error('request timeout outcome unknown'), { status: 408 }),
    Object.assign(new Error('server failed after start'), { status: 500 }),
    Object.assign(new Error('gateway disconnected'), { status: 502 }),
  ])
    assert.equal(testRequestRejected(failure), false)
})

test('delivery requires the shown latest complete pass for the same saved snapshot', () => {
  assert.equal(canDeliverTest(passed, 'version-1', 'a'.repeat(64)), true)
  for (const state of [
    'running',
    'failed',
    'no_tests',
    'timed_out',
    'interrupted',
    'error',
    'incomplete',
  ])
    assert.equal(canDeliverTest({ ...passed, state }, 'version-1', 'a'.repeat(64)), false)
  assert.equal(canDeliverTest(null, 'version-1', 'a'.repeat(64)), false)
  assert.equal(canDeliverTest(passed, 'version-2', 'a'.repeat(64)), false)
  assert.equal(canDeliverTest(passed, 'version-1', 'b'.repeat(64)), false)
  assert.equal(canDeliverTest({ ...passed, snapshotSha256: '' }, 'version-1', ''), false)
})

test('zero, skipped, todo, cancelled, truncated or missing evidence never enables delivery', () => {
  for (const patch of [
    { counts: null },
    { counts: { ...passed.counts, tests: 0, passed: 0 } },
    { counts: { ...passed.counts, passed: 1 } },
    ...['failed', 'cancelled', 'skipped', 'todo'].map((key) => ({
      counts: { ...passed.counts, [key]: 1 },
    })),
    { exitCode: 1 },
    { exitCode: null },
    { timedOut: true },
    { truncated: true },
    { finishedAt: null },
  ])
    assert.equal(canDeliverTest({ ...passed, ...patch }, 'version-1', 'a'.repeat(64)), false)
})

test('feedback preserves version/run context and bounds hostile-volume output for a chat draft', () => {
  const text = testFeedback(
    {
      ...passed,
      state: 'failed',
      detail: 'assertion failed',
      stdout: 'x'.repeat(50000),
      stderr: 'real stderr',
    },
    'version-1',
    '第一版',
  )
  assert.match(text, /version-1/)
  assert.match(text, /run-1/)
  assert.match(text, /assertion failed/)
  assert.match(text, /real stderr/)
  assert.match(text, /截取/)
  assert.ok(text.length <= 7000)
  assert.match(testFeedback(null, 'version-empty', '无测试版'), /version-empty/)
})
