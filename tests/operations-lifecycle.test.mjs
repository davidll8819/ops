import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as lifecycle from '../scripts/operations-local.mjs'
const {matchesRuntime}=lifecycle
const launch={args:['C:\\office\\dist\\ai\\src\\main.js','-c','C:\\office\\.local\\tenant-a\\ai.yaml']}
test('lifecycle only controls the exact compiled entry and enterprise config',()=>{
 const process={Name:'node.exe',CommandLine:'"C:\\Program Files\\nodejs\\node.exe" "C:\\office\\dist\\ai\\src\\main.js" -c "C:\\office\\.local\\tenant-a\\ai.yaml"'}
 assert.equal(matchesRuntime(process,launch),true)
 for(const modified of [{...process,Name:'other.exe'},{...process,CommandLine:process.CommandLine.replace('tenant-a','tenant-b')},{...process,CommandLine:process.CommandLine.replace('main.js','other.js')},{...process,CommandLine:process.CommandLine.replace('-c','-x')}])assert.equal(matchesRuntime(modified,launch),false)
})
test('ordinary stop drains new submissions and refuses active or newly arrived work',async()=>{
 for(const counts of [[1],[0,1]]){
  const events=[];let i=0
  await assert.rejects(()=>lifecycle.stopOperations({drain:async x=>events.push(['drain',x]),active:async()=>counts[Math.min(i++,counts.length-1)],stop:async s=>events.push(['stop',s])}),/运行|active/i)
  assert.deepEqual(events,[['drain',true],['drain',false]])
 }
})
test('idle shutdown stops AI before its supporting server',async()=>{
 const events=[]
 await lifecycle.stopOperations({drain:async x=>events.push(['drain',x]),active:async()=>0,stop:async s=>events.push(['stop',s])})
 assert.deepEqual(events,[['drain',true],['stop','ai'],['stop','server']])
})
