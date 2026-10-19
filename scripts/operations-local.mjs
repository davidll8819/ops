// Local Windows lifecycle for the already configured, dedicated production runtime.
import {mkdir,open} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFile,spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {z} from 'zod'
import {MongoClient} from 'mongodb'
import {operationsLaunch} from './run-operations-service.mjs'
import {createOperationsDriver} from '../apps/api/src/operations/driver.mjs'
const run=promisify(execFile)
export async function stopOperations({drain,active,stop}){
 await drain(true)
 try{
  if(await active())throw Object.assign(Error('制作任务正在运行，请等待完成后再停止服务'),{code:'OPERATIONS_BUSY'})
  for(const service of ['ai','server']){
   if(await active())throw Object.assign(Error('制作任务正在运行，请等待完成后再停止服务'),{code:'OPERATIONS_BUSY'})
   await stop(service)
  }
 }catch(error){await drain(false).catch(()=>{});throw error}
}
export function matchesRuntime(process,launch){
 const tokens=String(process.CommandLine||'').match(/"[^"]*"|\S+/g)?.map(x=>x.replace(/^"|"$/g,''))||[]
 const same=(a,b)=>String(a).replaceAll('\\','/').toLowerCase()===String(b).replaceAll('\\','/').toLowerCase()
 const configIndex=tokens.indexOf('-c')
 return same(process.Name,'node.exe')&&tokens.some(x=>same(x,launch.args[0]))&&configIndex>0&&same(tokens[configIndex+1],launch.args[2])
}
async function processes(){
 const {stdout}=await run('powershell.exe',['-NoProfile','-Command',`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`],{windowsHide:true})
 const value=stdout.trim()?JSON.parse(stdout):[]
 return Array.isArray(value)?value:[value]
}
async function main(){
 if(process.platform!=='win32')throw Error('This local lifecycle command requires Windows')
 const action=z.enum(['start','stop','status']).parse(process.argv[2]),tenant=z.uuid().parse(process.argv[3])
 const root=resolve('.'),driver=createOperationsDriver(process.env),entry=await driver.binding(tenant)
 if(!entry)throw Error('Prepare this enterprise runtime first')
 const logDir=resolve(root,'.local/operations',tenant,'logs');await mkdir(logDir,{recursive:true})
 if(action==='stop'){
  const mongo=await new MongoClient(entry.infrastructure.mongodb.uri,{serverSelectionTimeoutMS:5000}).connect()
  try{
   const db=mongo.db(entry.infrastructure.mongodb.dbName)
   await stopOperations({
    drain:draining=>driver.request(entry,'ai','/office-bridge/drain',{method:'POST',body:{draining},signed:true}),
    active:async()=>await db.collection('contentGenerationTask').countDocuments({status:'running',deletedAt:null})+await db.collection('aiLogs').countDocuments({status:'generating'}),
    stop:async service=>{
     const launch=operationsLaunch(root,tenant,service,entry),found=(await processes()).filter(p=>matchesRuntime(p,launch))
     if(found.length>1)throw Error('Multiple runtime processes need inspection')
     if(found[0]){
      if(!(await processes()).some(p=>p.ProcessId===found[0].ProcessId&&matchesRuntime(p,launch)))throw Error('Process identity changed')
      await run('taskkill.exe',['/PID',String(found[0].ProcessId),'/T','/F'],{windowsHide:true})
      console.log(`${service} stopped`)
     }
    },
   })
  }finally{await mongo.close()}
  console.log('Dedicated databases and saved media retained')
  return
 }
 if(action==='start'){
  // Compose files contain references to private environment values, never CLI secrets.
  const running=await processes()
  if(!['server','ai'].some(service=>running.some(p=>matchesRuntime(p,operationsLaunch(root,tenant,service,entry)))))
   await run('docker',['compose','--env-file',resolve('.local/production-runtime/infra.private.env'),'-f',resolve('.local/production-runtime/compose.yaml'),'up','-d','--pull','never'],{windowsHide:true})
 }
 for(const service of ['server','ai']){
  const launch=operationsLaunch(root,tenant,service,entry),found=(await processes()).filter(p=>matchesRuntime(p,launch))
  if(found.length>1)throw Error(`Multiple ${service} instances found; inspect before changing them`)
  if(action==='start'&&!found.length){
   const out=await open(resolve(logDir,service+'.out.log'),'a'),err=await open(resolve(logDir,service+'.err.log'),'a')
   try{
    const child=spawn(process.execPath,launch.args,{cwd:launch.cwd,env:launch.env,detached:true,windowsHide:true,stdio:['ignore',out.fd,err.fd]})
    await new Promise((ok,fail)=>{child.once('spawn',ok);child.once('error',fail)})
    child.unref();console.log(`${service} started (PID ${child.pid})`)
   }finally{await out.close();await err.close()}
  }
 }
 if(action!=='stop'){
  let error
  for(let i=0;i<(action==='start'?30:1);i++){
   try{
    if(action==='start')await driver.request(entry,'ai','/office-bridge/drain',{method:'POST',body:{draining:false},signed:true})
    await driver.ready(tenant);console.log('Both services ready; bridge v4, manual publication');return
   }catch(e){error=e}
   if(action==='start')await new Promise(r=>setTimeout(r,1000))
  }
  throw Error(`Runtime not ready; inspect ${logDir}. ${error?.message||''}`)
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().catch(error=>{console.error(error.code==='OPERATIONS_BUSY'?error.message:'Local runtime command failed; inspect the enterprise runtime logs. Credentials were not printed.');process.exitCode=1})
}
