import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { migrate } from '../database/migrate.mjs'

test('upgrading existing Dragon workspaces preserves project identity, file bytes, private chat and run history', async () => {
  const pg = new PGlite()
  await pg.waitReady
  const query = async (sql, params) => params ? pg.query(sql, params) : (await pg.exec(sql)).at(-1)
  const pool = {connect: async () => ({query,release(){}})}
  try {
    await query('CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz DEFAULT now())')
    const directory = new URL('../database/migrations/', import.meta.url)
    for (const name of (await readdir(directory)).filter(n=>n.endsWith('.sql')&&n<'013_').sort()) {
      await query(await readFile(new URL(name,directory),'utf8'))
      await query('INSERT INTO schema_migrations(name) VALUES($1)',[name])
    }
    const tenant = randomUUID(), otherTenant=randomUUID(), user=randomUUID(), otherUser=randomUUID(), workspace=randomUUID(), run=randomUUID()
    const files=[{path:'index.html',contentBase64:Buffer.from('五子棋\0原始字节').toString('base64')}]
    const messages=[{id:'kept-message',role:'assistant',text:'已有工作记录',runId:run}]
    await query('INSERT INTO tenants(id,name) VALUES($1,$2),($3,$4)',[tenant,'旧企业',otherTenant,'其他企业'])
    await query('INSERT INTO users(id,subject,email) VALUES($1,$2,$3),($4,$5,$6)',[user,'legacy-user','legacy@example.test',otherUser,'other-user','other@example.test'])
    await query('INSERT INTO employee_workspaces(id,tenant_id,user_id,name,files,revision) VALUES($1,$2,$3,$4,$5,$6)',[workspace,tenant,user,'已有五子棋',JSON.stringify(files),7])
    await query("INSERT INTO employee_runs(id,workspace_id,tenant_id,user_id,state,request,summary) VALUES($1,$2,$3,$4,'completed','旧任务','旧结果')",[run,workspace,tenant,user])
    await query("INSERT INTO department_conversations(tenant_id,user_id,department,messages,revision) VALUES($1,$2,'dev',$3,12),($4,$2,'dev',$5,99)",[tenant,user,JSON.stringify(messages),otherTenant,JSON.stringify([{role:'user',text:'其他企业消息'}])])
    await migrate(pool)
    const row=(await query('SELECT * FROM employee_workspaces WHERE id=$1',[workspace])).rows[0]
    assert.equal(row.is_default,true)
    assert.equal(row.name,'已有五子棋')
    assert.equal(row.revision,7)
    assert.deepEqual(row.files,files)
    assert.deepEqual(row.messages,messages)
    assert.equal(row.conversation_revision,12)
    assert.equal((await query('SELECT workspace_id FROM employee_runs WHERE id=$1',[run])).rows[0].workspace_id,workspace)
    // A second migration run must not reimport stale department history over live project chat.
    await query('UPDATE employee_workspaces SET messages=$2,conversation_revision=13 WHERE id=$1',[workspace,JSON.stringify([{role:'user',text:'升级后消息'}])])
    await migrate(pool)
    assert.equal((await query('SELECT conversation_revision FROM employee_workspaces WHERE id=$1',[workspace])).rows[0].conversation_revision,13)
    const second=randomUUID()
    await query('INSERT INTO employee_workspaces(id,tenant_id,user_id,name) VALUES($1,$2,$3,$4)',[second,tenant,user,'第二项目'])
    await assert.rejects(query('INSERT INTO employee_workspaces(id,tenant_id,user_id,is_default) VALUES($1,$2,$3,true)',[randomUUID(),tenant,user]))
    const version=randomUUID()
    await query("INSERT INTO employee_project_versions(id,workspace_id,tenant_id,user_id,label,kind,source_revision,files) VALUES($1,$2,$3,$4,'v1','manual',7,$5)",[version,workspace,tenant,user,JSON.stringify(files)])
    await assert.rejects(query("INSERT INTO employee_project_versions(id,workspace_id,tenant_id,user_id,label,kind,source_revision,files) VALUES($1,$2,$3,$4,'wrong owner','manual',7,$5)",[randomUUID(),workspace,tenant,otherUser,JSON.stringify(files)]))
    await query('CREATE ROLE project_reader')
    await query('GRANT SELECT ON employee_project_versions TO project_reader')
    await query('SET ROLE project_reader')
    assert.equal((await query('SELECT * FROM employee_project_versions')).rows.length,0)
    await query('BEGIN')
    await query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",[tenant,user])
    assert.equal((await query('SELECT id FROM employee_project_versions')).rows[0].id,version)
    await query("SELECT set_config('app.user_id',$1,true)",[otherUser])
    assert.equal((await query('SELECT * FROM employee_project_versions')).rows.length,0)
    await query('ROLLBACK')
    await query('RESET ROLE')
  } finally {
    await pg.close()
  }
})
