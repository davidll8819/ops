// Run an ALREADY BUILT original service with keys injected into its environment.
// Example: node --env-file=.env scripts/run-operations-service.mjs <tenant UUID> ai
import { readFile } from 'node:fs/promises'
import { resolve,delimiter } from 'node:path'
import {pathToFileURL} from 'node:url'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { gatewayToken } from '../apps/api/src/operations/policy.mjs'
export function operationsLaunch(root,tenantId,service,entry,env=process.env){
  z.uuid().parse(tenantId);z.enum(['ai','server']).parse(service)
  if (!entry?.bridgeSecret || !entry?.jwtSecret || !entry?.internalToken) throw new Error('Missing operator runtime binding')
  const inherited=Object.fromEntries(Object.entries(env).filter(([key])=>['path','home','tmpdir','lang','tz','node_env','systemroot','windir','temp','tmp','userprofile','localappdata','appdata','comspec','pathext','programfiles'].includes(key.toLowerCase())))
  const pathKey=Object.keys(inherited).find(key=>key.toLowerCase()==='path')||'PATH'
  if(entry.ffmpegBin)inherited[pathKey]=entry.ffmpegBin+delimiter+(inherited[pathKey]||'')
  const cwd=resolve(root,'integrations/aitoearn/source/project/aitoearn-backend')
  return {args:[resolve(cwd,`dist/apps/aitoearn-${service}/src/main.js`),'-c',resolve(root,'.local/operations',tenantId,`${service}.yaml`)],cwd,env:{...inherited,OFFICE_JWT_SECRET:entry.jwtSecret,OFFICE_INTERNAL_TOKEN:entry.internalToken,OFFICE_BRIDGE_SECRET:entry.bridgeSecret,OFFICE_MODEL_GATEWAY_TOKEN:gatewayToken(entry.bridgeSecret,tenantId),FOURYI_API_KEY_FILE:'',SERVER_RELAY_API_KEY_FILE:''}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const tenantId=z.uuid().parse(process.argv[2]),service=z.enum(['ai','server']).parse(process.argv[3]),registry=JSON.parse(await readFile(process.env.OPERATIONS_RUNTIMES_FILE,'utf8')),launch=operationsLaunch(process.cwd(),tenantId,service,registry[tenantId])
 const child=spawn(process.execPath,launch.args,{cwd:launch.cwd,env:launch.env,stdio:'inherit',windowsHide:true})
 for (const signal of ['SIGTERM','SIGINT']) process.on(signal,() => child.kill(signal))
 child.on('error',()=>{process.exitCode=1})
 child.on('exit',code => { process.exitCode = code ?? 1 })
}
