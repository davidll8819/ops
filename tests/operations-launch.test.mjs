import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
test('native runtime config retains an explicit loopback host',async()=>{
 const source=await readFile(new URL('../integrations/aitoearn/source/project/aitoearn-backend/libs/common/src/config.ts',import.meta.url),'utf8')
 const module=stripTypeScriptTypes(source,{mode:'transform'}).replace("from 'zod'",`from '${pathToFileURL(resolve('node_modules/zod/index.js')).href}'`)
 const {baseConfig}=await import('data:text/javascript;base64,'+Buffer.from(module).toString('base64'))
 assert.equal(baseConfig.parse({host:'127.0.0.1',port:3302}).host,'127.0.0.1')
 assert.equal(baseConfig.parse({}).host,'0.0.0.0')
})
test('runtime launch uses compiled source path and absolute config with a restricted Windows environment',async()=>{
 const {operationsLaunch}=await import('../scripts/run-operations-service.mjs')
 const root=resolve('.'),entry={bridgeSecret:'bridge',jwtSecret:'jwt',internalToken:'internal',ffmpegBin:resolve('.local/production-runtime/ffmpeg/bin')}
 const launch=operationsLaunch(root,'74c7972b-41e9-4720-aaf4-465c686293b5','ai',entry,{PATH:'system-path',SystemRoot:'C:/Windows',TEMP:'temp',SECRET_OTHER:'must-not-inherit'})
 assert.ok(launch.args[0].replaceAll('\\','/').endsWith('dist/apps/aitoearn-ai/src/main.js'));assert.equal(launch.args[2],resolve('.local/operations/74c7972b-41e9-4720-aaf4-465c686293b5/ai.yaml'));assert.equal(launch.env.SystemRoot,'C:/Windows');assert.equal(launch.env.SECRET_OTHER,undefined);assert.ok(launch.env.PATH.startsWith(entry.ffmpegBin));assert.equal(launch.env.OFFICE_JWT_SECRET,'jwt')
})

test('embedded model router honors the configured loopback host',async()=>{
 const source=await readFile(new URL('../integrations/aitoearn/source/project/aitoearn-backend/apps/aitoearn-ai/src/core/agent/claude-code-router/claude-code-router.service.ts',import.meta.url),'utf8')
 const method=source.slice(source.indexOf('  private buildConfigFile('),source.indexOf('  private startChildProcess(')).replace('private buildConfigFile','function buildConfigFile')
 const js=stripTypeScriptTypes(method,{mode:'transform'})
 const build=new Function('config','CLAUDE_CODE_ROUTER_PROVIDER_NAME',js+'; return buildConfigFile')({host:'127.0.0.1'},'office')
 assert.equal(build({baseUrl:'http://127.0.0.1/gateway',apiKey:'test',models:['office-content-ops']}).HOST,'127.0.0.1')
})

test('Windows router loads its private session config instead of the desktop user config',async()=>{
 const source=await readFile(new URL('../integrations/aitoearn/source/project/aitoearn-backend/apps/aitoearn-ai/src/core/agent/claude-code-router/claude-code-router.service.ts',import.meta.url),'utf8')
 const method=source.slice(source.indexOf('  private startChildProcess('),source.indexOf('  private removePidFile(')).replace('private startChildProcess','function startChildProcess')
 let options
 const start=new Function('spawn','process',stripTypeScriptTypes(method,{mode:'transform'})+';return startChildProcess')((_cmd,_args,opts)=>{options=opts;return {stdout:{on(){}},stderr:{on(){}},on(){}}},{env:{USERPROFILE:'desktop-user'}})
 start.call({sessionDir:'private-session',logger:{debug(){}}},'router-cli')
 assert.equal(options.env.USERPROFILE,'private-session');assert.equal(options.env.HOME,'private-session');assert.equal(options.windowsHide,true)
})

test('agent SDK also isolates the Windows home directory',async()=>{
 const source=await readFile(new URL('../integrations/aitoearn/source/project/aitoearn-backend/apps/aitoearn-ai/src/core/agent/services/agent-runtime.service.ts',import.meta.url),'utf8')
 const a=source.indexOf('      env: {',source.indexOf('const queryOptions'))
 const code=source.slice(a+'      env: '.length,source.indexOf('\n      mcpServers,',a)).trim().replace(/,$/,'')
 const build=new Function('process','return function(){return '+code+'}')({env:{USERPROFILE:'desktop-user'}})
 assert.equal(build.call({sessionDir:'private-agent'}).USERPROFILE,'private-agent')
})
