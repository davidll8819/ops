import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,readdir} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {PGlite} from '@electric-sql/pglite'
import {migrate} from '../database/migrate.mjs'

test('acceptance migration preserves saved delivery files and all existing project history',async()=>{
  const pg=new PGlite()
  await pg.waitReady
  const query=async(sql,params)=>params?pg.query(sql,params):(await pg.exec(sql)).at(-1)
  const pool={connect:async()=>({query,release(){}})}
  try {
    await query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())')
    const directory=new URL('../database/migrations/',import.meta.url)
    for(const name of (await readdir(directory)).filter(name=>name.endsWith('.sql')&&name<'014_').sort()) {
      await query(await readFile(new URL(name,directory),'utf8'))
      await query('INSERT INTO schema_migrations(name) VALUES($1)',[name])
    }
    const tenant=randomUUID(),user=randomUUID(),project=randomUUID(),version=randomUUID(),run=randomUUID()
    const files=[{path:'index.html',contentBase64:Buffer.from('<title>原来的五子棋</title>\u0000字节').toString('base64')}]
    const chat=[{role:'user',text:'原项目需求'},{role:'assistant',text:'原项目结果',runId:run}]
    await query('INSERT INTO tenants(id,name) VALUES($1,$2)',[tenant,'原企业'])
    await query('INSERT INTO users(id,subject,email) VALUES($1,$2,$3)',[user,'acceptance-upgrade','upgrade@example.test'])
    await query('INSERT INTO employee_workspaces(id,tenant_id,user_id,name,files,revision,is_default,messages,conversation_revision) VALUES($1,$2,$3,$4,$5,7,true,$6,14)',[project,tenant,user,'原五子棋',JSON.stringify(files),JSON.stringify(chat)])
    await query("INSERT INTO employee_runs(id,workspace_id,tenant_id,user_id,state,request,summary) VALUES($1,$2,$3,$4,'completed','原任务','原记录')",[run,project,tenant,user])
    await query("INSERT INTO employee_project_versions(id,workspace_id,tenant_id,user_id,label,kind,source_revision,files) VALUES($1,$2,$3,$4,'初始交付版','manual',7,$5)",[version,project,tenant,user,JSON.stringify(files)])
    const preserved=['employee_workspaces','employee_project_versions','employee_runs']
    const before={}
    for(const table of preserved) before[table]=(await query(`SELECT * FROM ${table}`)).rows
    await migrate(pool)
    await migrate(pool)
    for(const table of preserved) assert.deepEqual((await query(`SELECT * FROM ${table}`)).rows,before[table])
    for(const table of ['employee_project_acceptance','employee_project_deliveries']) {
      assert.deepEqual((await query(`SELECT * FROM ${table}`)).rows,[])
      const rules=(await query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=$1',[table])).rows[0]
      assert.deepEqual(rules,{relrowsecurity:true,relforcerowsecurity:true})
    }
  } finally {await pg.close()}
})
