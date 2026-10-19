import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setup } from './helpers/archive-api-fixture.mjs'
test('YeFan handoff preserves exact historical requirements privately without another model call', async () => {
  const h = await setup()
  try {
    const messages = [
      { id: randomUUID(), role: 'user', text: '30秒，抖音，不发布' },
      { id: randomUUID(), role: 'assistant', text: '第一版分镜与验收标准' },
      { id: randomUUID(), role: 'user', text: '后来要求改成15秒' },
      { id: randomUUID(), role: 'assistant', text: '第二版' },
    ]
    await h.query(
      "INSERT INTO department_conversations(tenant_id,user_id,department,messages,revision) VALUES($1,$2,'content_ops',$3,2)",
      [h.tenant, h.alice, JSON.stringify(messages)],
    )
    const payload = { messageId: messages[1].id, revision: 2 }
    const created = await h.request('POST', '/operations/briefs', payload)
    assert.equal(created.statusCode, 200, created.body)
    const brief = created.json().brief
    assert.equal(brief.sourceRevision, 2)
    assert.equal(brief.sourceMessageId, messages[1].id)
    assert.deepEqual(brief.messages, messages.slice(0, 2))
    assert.match(brief.text, /30秒/)
    assert.doesNotMatch(brief.text, /15秒/)
    assert.equal((await h.request('POST', '/operations/briefs', payload)).json().brief.id, brief.id)
    assert.equal((await h.request('GET', `/operations/briefs/${brief.id}`)).statusCode, 200)
    assert.equal(
      (await h.request('GET', `/operations/briefs/${brief.id}`, undefined, h.bob)).statusCode,
      404,
    )
    assert.equal(
      (await h.request('GET', `/api/tenants/${h.other}/operations/briefs/${brief.id}`)).statusCode,
      404,
    )
    assert.equal(
      (await h.request('POST', '/operations/briefs', { ...payload, revision: 1 })).statusCode,
      409,
    )
    assert.equal(
      (await h.request('POST', '/operations/briefs', { ...payload, messageId: messages[0].id }))
        .statusCode,
      404,
    )
    assert.equal((await h.request('POST', '/operations/briefs', payload, h.bob)).statusCode, 403)
    assert.equal(h.requests.length, 0)
    await assert.rejects(
      h.query("UPDATE operations_briefs SET title='changed' WHERE id=$1", [brief.id]),
      /immutable/i,
    )
  } finally {
    await h.close()
  }
})
test('YeFan handoff rejects oversized context without truncation', async () => {
  const h = await setup()
  try {
    const id = randomUUID()
    await h.query(
      "INSERT INTO department_conversations(tenant_id,user_id,department,messages,revision) VALUES($1,$2,'content_ops',$3,1)",
      [
        h.tenant,
        h.alice,
        JSON.stringify([
          { id: randomUUID(), role: 'user', text: 'x'.repeat(200000) },
          { id, role: 'assistant', text: '方案' },
        ]),
      ],
    )
    const r = await h.request('POST', '/operations/briefs', { messageId: id, revision: 1 })
    assert.equal(r.statusCode, 409, r.body)
    assert.match(r.body, /截断/)
  } finally {
    await h.close()
  }
})
test('saved source includes all twenty prior model-context messages plus the current turn', async () => {
  const h = await setup()
  try {
    const messages = Array.from({ length: 22 }, (_, i) => ({
      id: randomUUID(),
      role: i % 2 ? 'assistant' : 'user',
      text: i === 0 ? '最早仍在模型上下文内的约束：不得发布' : `message ${i}`,
    }))
    await h.query(
      "INSERT INTO department_conversations(tenant_id,user_id,department,messages,revision) VALUES($1,$2,'content_ops',$3,1)",
      [h.tenant, h.alice, JSON.stringify(messages)],
    )
    const r = await h.request('POST', '/operations/briefs', {
      messageId: messages.at(-1).id,
      revision: 1,
    })
    assert.equal(r.statusCode, 200, r.body)
    assert.deepEqual(r.json().brief.messages, messages)
    assert.match(r.json().brief.text, /最早仍在模型上下文内/)
  } finally {
    await h.close()
  }
})
