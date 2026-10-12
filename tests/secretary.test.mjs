import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { emptyBoard, applyAction, exampleBoard } from '../packages/secretary/model.mjs'
const ctx = { id: randomUUID, today: '2026-10-11', time: '2026-10-11T12:00:00Z' }
test('local planning can assign the intern and still requires dispatch confirmation', () => {
  for (const [language, text] of [
    ['zh', '请实习生写一份会议摘要'],
    ['en', 'Ask the intern to write meeting minutes'],
  ]) {
    const draft = applyAction(emptyBoard(), { type: 'send', text, language, intent: 'plan' }, ctx)
    assert.equal(draft.tasks.length, 1)
    assert.equal(draft.tasks[0].dept, 'new-agent-9')
    assert.equal(draft.tasks[0].status, 'draft')
    const dispatched = applyAction(draft, { type: 'dispatch', batchId: draft.batches[0].id }, ctx)
    assert.equal(dispatched.tasks[0].status, 'queued')
  }
})
test('local secretary requires confirmation and preserves publishing gate through edits', () => {
  const board = applyAction(
    emptyBoard(),
    { type: 'send', text: '制作视频，发布前确认', language: 'zh', intent: 'plan' },
    ctx,
  )
  assert.equal(board.tasks.length, 3)
  assert.ok(board.tasks.every((t) => t.status === 'draft'))
  const batchId = board.batches[0].id
  const tasks = board.tasks.map((t) => ({
    id: t.id,
    title: t.title + '!',
    dept: t.dept,
    due: '2026-10-12',
  }))
  const edited = applyAction(board, { type: 'edit', batchId, tasks }, ctx)
  assert.equal(edited.tasks[0].publishRequired, true)
  assert.equal(edited.tasks[0].due, '2026-10-12')
  const sent = applyAction(edited, { type: 'dispatch', batchId }, ctx)
  assert.ok(sent.tasks.every((t) => t.status === 'queued'))
  assert.throws(() => applyAction(sent, { type: 'dispatch', batchId }, ctx), /已更新/)
  assert.throws(
    () => applyAction(sent, { type: 'approve', taskId: sent.tasks[0].id }, ctx),
    /无需发布审批/,
  )
  assert.equal(board.tasks[0].status, 'draft')
})
test('approval only authorizes; no publishing or execution side effect', () => {
  const example = exampleBoard(ctx.today)
  const approved = applyAction(example, { type: 'approve', taskId: 'example-approval' }, ctx)
  assert.equal(approved.tasks.find((t) => t.id === 'example-approval').status, 'authorized')
  assert.match(approved.messages.at(-1).text, /尚未发出/)
  assert.throws(
    () => applyAction(approved, { type: 'approve', taskId: 'example-approval' }, ctx),
    /无需发布审批/,
  )
  const rejected = applyAction(
    example,
    { type: 'reject', taskId: 'example-approval', feedback: '调整字幕' },
    ctx,
  )
  assert.equal(rejected.tasks.find((t) => t.id === 'example-approval').feedback, '调整字幕')
  assert.equal(rejected.tasks.find((t) => t.id === 'example-approval').status, 'revision')
  assert.throws(() => applyAction(example, { type: 'approve', taskId: 'example-report' }, ctx))
})
test('reminders and progress never pretend to call departments', () => {
  for (const intent of ['remind', 'report']) {
    const board = applyAction(
      emptyBoard(),
      { type: 'send', text: 'Check today', intent, language: 'en' },
      ctx,
    )
    assert.equal(board.tasks.length, 0)
    assert.match(board.messages.at(-1).textEn, /not connected/)
  }
})
test('long conversations retain undecided task cards', () => {
  let board = applyAction(
    emptyBoard(),
    { type: 'send', text: '整理资料', intent: 'plan', language: 'zh' },
    ctx,
  )
  const batchId = board.batches[0].id
  for (let i = 0; i < 60; i++)
    board = applyAction(
      board,
      { type: 'send', text: '汇报进度', intent: 'report', language: 'zh' },
      ctx,
    )
  assert.ok(board.messages.some((m) => m.batchId === batchId))
  assert.equal(board.tasks[0].status, 'draft')
})
