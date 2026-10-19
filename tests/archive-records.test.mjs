import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setup, ready } from './helpers/archive-api-fixture.mjs'
const draftUrl = (id) => `/archive/filings/${id}/record`,
  detailUrl = (id) => `/archive/records/${id}`
const metadata = {
  title: '资料借阅制度',
  department: '资料室',
  category: '制度流程',
  tags: ['借阅', '归档'],
  note: '核对原件后登记。',
}
async function source(h, name = '制度.docx') {
  const fileId = await ready(h, name, ['资料借阅须登记。'])
  h.setAnswer((body) => {
    const s = JSON.parse(body.messages.at(-1).content).sources[0]
    return JSON.stringify({
      ...metadata,
      note: undefined,
      reason: '规定资料借阅流程。',
      needsReview: false,
      citations: [{ sourceId: s.sourceId, quote: s.text }],
    })
  })
  const r = await h.request('POST', `/archive/documents/${fileId}/filing`, {})
  assert.equal(r.statusCode, 200, r.body)
  return r.json().suggestion
}
async function save(h, s, revision = 0, fields = metadata) {
  const r = await h.request('POST', draftUrl(s.id), { revision, metadata: fields })
  assert.equal(r.statusCode, 200, r.body)
  return r.json().record
}
test('archive record draft edits, confirmation and private retrieval preserve source/model suggestion and stable identity', async () => {
  const h = await setup()
  try {
    const s = await source(h)
    assert.equal((await h.request('GET', draftUrl(s.id))).json().record, null)
    const a = await save(h, s)
    assert.equal(a.state, 'draft')
    assert.equal(a.revision, 1)
    assert.equal(a.archiveNumber, s.archiveNumber)
    assert.equal(a.source.fileId, s.source.fileId)
    assert.equal((await h.request('GET', '/archive/records')).json().total, 0)
    const edited = {
      ...metadata,
      title: '核对后的制度',
      tags: ['借阅', '内部'],
      department: '程序部',
    }
    const b = await save(h, s, 1, edited)
    assert.equal(b.revision, 2)
    assert.equal(b.id, a.id)
    assert.equal(b.filename, `核对后的制度_${s.archiveNumber}.docx`)
    assert.equal(b.directory, `程序部/制度流程/${s.archiveYear}`)
    assert.deepEqual((await h.request('GET', draftUrl(s.id))).json().record, b)
    assert.equal(
      (await h.request('POST', detailUrl(b.id) + '/confirm', { revision: 1 })).statusCode,
      409,
    )
    const confirm = await h.request('POST', detailUrl(b.id) + '/confirm', { revision: 2 })
    assert.equal(confirm.statusCode, 200, confirm.body)
    const c = confirm.json().record
    assert.equal(c.state, 'archived')
    assert.equal(c.confirmedBy, h.alice)
    assert.ok(c.archivedAt)
    assert.deepEqual(c.metadata, edited)
    assert.deepEqual(
      (await h.request('POST', detailUrl(c.id) + '/confirm', { revision: 2 })).json().record,
      c,
    )
    assert.deepEqual((await h.request('GET', detailUrl(c.id))).json().record, c)
    assert.equal(
      (await h.request('POST', draftUrl(s.id), { revision: 2, metadata })).statusCode,
      409,
    )
    assert.equal((await h.request('GET', detailUrl(c.id), undefined, h.bob)).statusCode, 404)
    assert.equal(
      (await h.request('GET', `/api/tenants/${h.other}${detailUrl(c.id)}`)).statusCode,
      404,
    )
    assert.equal((await h.request('GET', '/archive/records', undefined, h.bob)).json().total, 0)
    assert.equal(h.requests.length, 1, 'registration never calls a model')
    assert.deepEqual(
      (await h.request('GET', `/archive/documents/${s.source.fileId}/filing`)).json().suggestion,
      s,
    )
    await assert.rejects(
      h.query("UPDATE archive_records SET metadata='{}' WHERE id=$1", [c.id]),
      /immutable/i,
    )
    await assert.rejects(h.query('DELETE FROM archive_records WHERE id=$1', [c.id]), /immutable/i)
  } finally {
    await h.close()
  }
})
test('archive concurrent first edits, revisions, validation, unready suggestion and source drift fail closed', async () => {
  const h = await setup()
  try {
    const s = await source(h)
    const pair = await Promise.all([
      h.request('POST', draftUrl(s.id), { revision: 0, metadata }),
      h.request('POST', draftUrl(s.id), {
        revision: 0,
        metadata: { ...metadata, title: '另一编辑' },
      }),
    ])
    assert.deepEqual(pair.map((r) => r.statusCode).sort(), [200, 409])
    const r = pair.find((r) => r.statusCode === 200).json().record
    assert.equal(
      (await h.request('POST', draftUrl(s.id), { revision: 0, metadata })).statusCode,
      409,
    )
    for (const bad of [
      { ...metadata, tags: [] },
      { ...metadata, title: '' },
      { ...metadata, department: '../../x' },
      { ...metadata, archiveNumber: 'fake' },
      { ...metadata, tags: ['x'.repeat(21)] },
    ])
      assert.equal(
        (await h.request('POST', draftUrl(s.id), { revision: 1, metadata: bad })).statusCode,
        400,
      )
    const safe = await save(h, s, 1, { ...metadata, title: '../CON:<x>\\a' })
    assert.ok(!/[<>:"/\\|?*]/.test(safe.filename))
    assert.equal((await h.request('GET', detailUrl(safe.id))).statusCode, 404)
    await h.query('UPDATE workspace_files SET data=$2 WHERE id=$1', [
      s.source.fileId,
      Buffer.from('changed'),
    ])
    assert.equal(
      (await h.request('POST', detailUrl(r.id) + '/confirm', { revision: 2 })).statusCode,
      409,
    )
    assert.equal((await h.request('GET', draftUrl(s.id))).statusCode, 409)
    assert.equal(
      (await h.request('POST', draftUrl(s.id), { revision: 2, metadata })).statusCode,
      409,
    )
    assert.equal(
      (await h.request('POST', draftUrl(randomUUID()), { revision: 0, metadata })).statusCode,
      404,
    )
    assert.equal(h.requests.length, 1)
  } finally {
    await h.close()
  }
})
test('archived retrieval filters categories, exact tags, literal keywords and paginates only owned formal entries', async () => {
  const h = await setup()
  try {
    const s = await source(h)
    const a = await save(h, s, 0, { ...metadata, title: '100%_制度', tags: ['内部', '归档'] })
    await h.request('POST', detailUrl(a.id) + '/confirm', { revision: 1 })
    const s2 = await source(h, '项目.docx'),
      b = await save(h, s2, 0, {
        ...metadata,
        title: '项目资料',
        category: '项目资料',
        tags: ['内部项目'],
      })
    await h.request('POST', detailUrl(b.id) + '/confirm', { revision: 1 })
    for (const [q, n] of [
      ['', 2],
      ['?category=制度流程&tag=内部', 1],
      ['?tag=内', 0],
      ['?q=%_', 1],
      ['?q=' + a.filename, 1],
      ['?category=项目资料&tag=内部', 0],
      ['?page=2', 0],
    ]) {
      const r = await h.request('GET', '/archive/records' + encodeURI(q))
      assert.equal(r.statusCode, 200, r.body)
      assert.equal(r.json().items.length, n, q)
      assert.equal(r.json().pageSize, 20)
      assert.ok(r.json().items.every((x) => !x.evidence))
    }
    assert.equal((await h.request('GET', '/archive/records?page=0')).statusCode, 400)
    assert.equal((await h.request('GET', '/archive/records?category=unknown')).statusCode, 400)
    await h.query('CREATE ROLE records_reader')
    await h.query('GRANT SELECT ON archive_records TO records_reader')
    await h.query('SET ROLE records_reader')
    assert.equal((await h.query('SELECT * FROM archive_records')).rows.length, 0)
    await h.query(
      "SELECT set_config('app.tenant_id',$1,false),set_config('app.user_id',$2,false)",
      [h.tenant, h.bob],
    )
    assert.equal((await h.query('SELECT * FROM archive_records')).rows.length, 0)
    await h.query('RESET ROLE')
    const other = await source(h, '未登记.docx')
    await assert.rejects(
      h.query(
        "INSERT INTO archive_records(id,tenant_id,user_id,suggestion_id,metadata,filename) VALUES($1,$2,$3,$4,'{}','x')",
        [randomUUID(), h.tenant, h.bob, other.id],
      ),
      /foreign key/i,
    )
  } finally {
    await h.close()
  }
})

test('formal archive pagination spans twenty item boundary and concurrent confirmations return one stable record', async () => {
  const h = await setup()
  try {
    const ids = []
    for (let i = 0; i < 21; i++) {
      const s = await source(h, `分页${i}.docx`),
        r = await save(h, s, 0, { ...metadata, title: `制度${i}` })
      const responses = await Promise.all([
        h.request('POST', detailUrl(r.id) + '/confirm', { revision: 1 }),
        h.request('POST', detailUrl(r.id) + '/confirm', { revision: 1 }),
      ])
      for (const response of responses) assert.equal(response.statusCode, 200, response.body)
      assert.deepEqual(responses[0].json().record, responses[1].json().record)
      ids.push(r.id)
    }
    const first = (await h.request('GET', '/archive/records')).json(),
      second = (await h.request('GET', '/archive/records?page=2')).json()
    assert.equal(first.total, 21)
    assert.equal(first.items.length, 20)
    assert.equal(second.items.length, 1)
    assert.equal(new Set([...first.items, ...second.items].map((r) => r.id)).size, 21)
    assert.equal((await h.query('SELECT count(*)::int n FROM archive_records')).rows[0].n, 21)
    await h.query('UPDATE workspace_files SET data=$2 WHERE id=$1', [
      first.items[0].source.fileId,
      Buffer.from('changed'),
    ])
    assert.equal((await h.request('GET', detailUrl(first.items[0].id))).statusCode, 409)
    assert.equal((await h.request('GET', '/archive/records')).json().total, 21)
  } finally {
    await h.close()
  }
})
