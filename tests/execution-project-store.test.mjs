import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { migrate } from '../database/migrate.mjs'
import { createExecutionService } from '../apps/api/src/execution/service.mjs'

test('project limits count decoded snapshot bytes and reject over-quota restore without replacing files or conversation', async () => {
  const pg = new PGlite()
  await pg.waitReady
  const query = async (sql, params) =>
    params ? pg.query(sql, params) : (await pg.exec(sql)).at(-1)
  const pool = { connect: async () => ({ query, release() {} }) }
  try {
    await migrate(pool)
    const tenantId = randomUUID(),
      userId = randomUUID(),
      ctx = { tenantId, userId }
    await query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenantId, 'quota fixture'])
    await query('INSERT INTO users(id,subject,email) VALUES($1,$2,$3)', [
      userId,
      'quota-user',
      'quota@example.test',
    ])
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'owner')", [
      tenantId,
      userId,
    ])
    const service = createExecutionService({
      pool,
      env: {},
      driver: { status: async () => ({ available: true }) },
    })
    const initial = await service.create(ctx)
    const projectId = initial.workspace.id,
      projectCtx = { ...ctx, projectId }
    assert.equal((await service.create(ctx)).workspace.id, projectId)
    for (let i = 1; i < 20; i++) await service.newProject(ctx, `Project ${i}`)
    await assert.rejects(service.newProject(ctx, 'Project 21'), { statusCode: 409 })
    assert.equal((await service.projects(ctx)).projects.length, 20)
    const binary = [
      { path: 'binary.dat', contentBase64: Buffer.from([0, 128, 255]).toString('base64') },
    ]
    await query('UPDATE employee_workspaces SET files=$2 WHERE id=$1', [
      projectId,
      JSON.stringify(binary),
    ])
    const small = await service.saveVersion(projectCtx, { label: 'binary bytes', revision: 0 })
    assert.equal(small.version.bytes, 3)
    await assert.rejects(
      query('UPDATE employee_project_versions SET label=$2 WHERE id=$1', [
        small.version.id,
        'tampered',
      ]),
    )
    await query('DELETE FROM employee_project_versions WHERE id=$1', [small.version.id])
    // Canonical base64 for eight 1 MiB files. PostgreSQL TOAST compresses this
    // fixture, keeping a real 256 MiB decoded boundary test inexpensive.
    await query(
      "UPDATE employee_workspaces SET files=(SELECT jsonb_agg(jsonb_build_object('path','file-'||n||'.dat','contentBase64',repeat('A',1398102)||'==')) FROM generate_series(1,8) n) WHERE id=$1",
      [projectId],
    )
    const large = await service.saveVersion(projectCtx, { label: '8 MiB snapshot', revision: 0 })
    assert.equal(large.version.bytes, 8 * 1024 * 1024)
    await query(
      "INSERT INTO employee_project_versions(id,workspace_id,tenant_id,user_id,label,kind,source_revision,files) SELECT md5($1::uuid::text||n)::uuid,workspace_id,tenant_id,user_id,'quota '||n,'manual',source_revision,files FROM employee_project_versions CROSS JOIN generate_series(1,31) n WHERE id=$1",
      [large.version.id],
    )
    const messages = [{ role: 'user', text: 'must survive quota failure' }]
    await query(
      'UPDATE employee_workspaces SET files=$2,messages=$3,revision=1,conversation_revision=3 WHERE id=$1',
      [projectId, JSON.stringify(binary), JSON.stringify(messages)],
    )
    await assert.rejects(
      service.saveVersion(projectCtx, { label: 'over byte quota', revision: 1 }),
      { statusCode: 409 },
    )
    await assert.rejects(service.restoreVersion(projectCtx, large.version.id, 1), {
      statusCode: 409,
    })
    const untouched = (
      await query(
        'SELECT files,messages,revision,conversation_revision FROM employee_workspaces WHERE id=$1',
        [projectId],
      )
    ).rows[0]
    assert.deepEqual(untouched, { files: binary, messages, revision: 1, conversation_revision: 3 })
    const saved = await service.versions(projectCtx)
    assert.equal(saved.versions.length, 32)
    assert.equal(
      saved.versions.reduce((sum, version) => sum + version.bytes, 0),
      256 * 1024 * 1024,
    )
  } finally {
    await pg.close()
  }
})

