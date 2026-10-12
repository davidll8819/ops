import test from 'node:test'
import assert from 'node:assert/strict'
import { attachmentContext, withAttachments, archiveTask } from '../apps/api/src/task-assets.mjs'
import { defaultPolicy, resolveCapability } from '../apps/api/src/operations/policy.mjs'
import { runtimeOutput } from '../apps/api/src/operations/task-tracking.mjs'
import { createModelWebTools } from '../apps/api/src/research/model-web.mjs'

test('department capabilities inherit, override and respect disabled capabilities', () => {
  const p=defaultPolicy();p.tiers.fast='chat';p.tiers.image='company-image';p.tiers.search='gemini-3.5-flash'
  assert.equal(resolveCapability(p,'design','image').model,'company-image')
  p.departments.design.capabilities.image.model='design-image'
  assert.equal(resolveCapability(p,'design','image').model,'design-image')
  assert.equal(resolveCapability(p,'secretary','text').model,'chat')
  assert.equal(resolveCapability(p,'secretary','search').model,'gemini-3.5-flash')
  assert.throws(()=>resolveCapability(p,'archive','search'),/尚未启用/)
  p.departments.design.capabilities.image.enabled=false
  assert.throws(()=>resolveCapability(p,'design','image'),/尚未启用/)
})
test('attachment contents are scoped to both company and user, then enter model input', async()=>{
  const db={query:async(sql,args)=>{
    assert.match(sql,/tenant_id=\$2 AND user_id=\$3/)
    assert.deepEqual(args,['a','company','owner'])
    return {rows:[{id:'a',name:'brief.txt',mime:'text/plain',data:Buffer.from('产品颜色是蓝色')}]}
  }}
  const a=await attachmentContext(db,{tenantId:'company',userId:'owner'},['a'])
  assert.match(withAttachments('按附件设计',a).at(-1).text,/产品颜色是蓝色/)
  assert.equal(a.refs[0].name,'brief.txt')
  await assert.rejects(attachmentContext({query:async()=>({rows:[]})},{},['other']),/无权访问/)
})
test('completed outputs archive once and quota exhaustion preserves task result',async()=>{
  let inserts=0
  const db={query:async(sql)=>{if(sql.startsWith('INSERT'))inserts++;return {rows:[{total:0}]}}}
  const task={title:'设计报告',summary:'完成稿',status:'completed'}
  assert.equal(await archiveTask(db,{},task),true)
  assert.equal(await archiveTask(db,{},task),false)
  assert.equal(inserts,1)
  const full={title:'报告',summary:'保留成果',status:'completed'}
  assert.equal(await archiveTask({query:async()=>({rows:[{total:100*1024*1024}]})},{},full),false)
  assert.equal(full.summary,'保留成果');assert.match(full.archiveNote,/已满/)
})
test('native search models send actual native tool requests and retain cited sources',async()=>{
  for(const model of ['gemini-3.5-flash','gemini-2.5-pro','grok-4.3']){
    const web=createModelWebTools({model,call:async({body,allowFallback})=>{
      assert.equal(body.tools[0].type,'openrouter:web_search');assert.equal(body.tools[0].parameters.engine,'native');assert.equal(allowFallback,false)
      return {choices:[{message:{content:'新闻',annotations:[{type:'url_citation',url_citation:{url:'https://example.org/news',title:'Source'}}]}}]}
    }})
    const result=await web.search('公开新闻');assert.equal(result[0].url,'https://example.org/news')
  }
})
test('runtime outputs extract real artifacts without executable URL schemes',()=>{
  const result=runtimeOutput([{content:[{text:'已生成分镜'},{structured_output:{medias:[{type:'VIDEO',url:'https://example.org/video.mp4'},{type:'IMAGE',url:'javascript:alert(1)'}]}}]}])
  assert.equal(result.text,'已生成分镜');assert.deepEqual(result.media,[{type:'VIDEO',url:'https://example.org/video.mp4'}])
})
