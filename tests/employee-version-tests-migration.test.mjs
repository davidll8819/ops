import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,readdir} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {PGlite} from '@electric-sql/pglite'
import {migrate} from '../database/migrate.mjs'

test('automatic test migration preserves legacy delivery and project evidence without inventing test success',async()=>{
  const pg=new PGlite();await pg.waitReady
  const query=async(sql,params)=>params?pg.query(sql,params):(await pg.exec(sql)).at(-1)
  const pool={connect:async()=>({query,release(){}})}
  try{
    await query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())')
    const directory=new URL('../database/migrations/',import.meta.url)
    for(const name of (await readdir(directory)).filter(name=>name.endsWith('.sql')&&name<'015_').sort()){
      await query(await readFile(new URL(name,directory),'utf8'))
      await query('INSERT INTO schema_migrations(name) VALUES($1)',[name])
    }
    const tenant=randomUUID(),user=randomUUID(),project=randomUUID(),version=randomUUID(),delivery=randomUUID()
    const files=[{path:'index.html',contentBase64:Buffer.from('<title>旧版五子棋</title>').toString('base64')}]
    const items=[{id:'original',title:'原验收',status:'passed',note:'用户试玩记录'}]
    const evidence={status:'passed',entry:'index.html',snapshotSha256:'a'.repeat(64)}
    await query('INSERT INTO tenants(id,name) VALUES($1,$2)',[tenant,'升级企业'])
    await query('INSERT INTO users(id,subject,email) VALUES($1,$2,$3)',[user,'version-tests-upgrade','tests-upgrade@example.test'])
    await query('INSERT INTO employee_workspaces(id,tenant_id,user_id,name,files,revision,is_default,messages,conversation_revision) VALUES($1,$2,$3,$4,$5,7,true,$6,4)',[project,tenant,user,'五子棋',JSON.stringify(files),JSON.stringify([{role:'user',text:'原工作要求'}])])
    await query("INSERT INTO employee_project_versions(id,workspace_id,tenant_id,user_id,label,kind,source_revision,files) VALUES($1,$2,$3,$4,'原交付版','manual',7,$5)",[version,project,tenant,user,JSON.stringify(files)])
    await query('INSERT INTO employee_project_acceptance(version_id,workspace_id,tenant_id,user_id,revision,entry,items,instructions,limitations,system_check) VALUES($1,$2,$3,$4,2,$5,$6,$7,$8,$9)',[version,project,tenant,user,'index.html',JSON.stringify(items),'原说明','原限制',JSON.stringify(evidence)])
    await query('INSERT INTO employee_project_deliveries(id,version_id,workspace_id,tenant_id,user_id,version_label,source_revision,label,entry,items,system_check,instructions,limitations) VALUES($1,$2,$3,$4,$5,$6,7,$7,$8,$9,$10,$11,$12)',[delivery,version,project,tenant,user,'原交付版','原正式交付','index.html',JSON.stringify(items),JSON.stringify(evidence),'原说明','原限制'])
    const before={}
    for(const table of ['employee_workspaces','employee_project_versions','employee_project_acceptance','employee_project_deliveries'])before[table]=(await query(`SELECT * FROM ${table}`)).rows
    await migrate(pool);await migrate(pool)
    for(const [table,rows] of Object.entries(before)){
      const after=(await query(`SELECT * FROM ${table}`)).rows
      if(table==='employee_project_deliveries'){
        assert.equal(after[0].automated_test,null,'legacy deliveries cannot acquire invented evidence')
        delete after[0].automated_test
      }
      assert.deepEqual(after,rows)
    }
    assert.deepEqual((await query('SELECT * FROM employee_project_test_runs')).rows,[])
    assert.deepEqual((await query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='employee_project_test_runs'")).rows[0],{relrowsecurity:true,relforcerowsecurity:true})
    await assert.rejects(query("UPDATE employee_project_deliveries SET automated_test='{}' WHERE id=$1",[delivery]),/immutable/i)
  }finally{await pg.close()}
})
