import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'
import * as gateway from '../apps/api/src/operations/gateway.mjs'
import {defaultPolicy} from '../apps/api/src/operations/policy.mjs'
test('private runtime catalog exposes its text alias and only enterprise-selected media with real capabilities',()=>{
 const policy=defaultPolicy();policy.tiers.fast='claude-haiku-4.5';policy.tiers.image='alibaba/wan2.6-image';policy.tiers.video='wan-2.7'
 const result=gateway.runtimeModelCatalog([{id:'claude-haiku-4.5',type:'chat'},{id:'other-video',type:'video'},{id:'wan-2.7',type:'video',video_image_input:false},{id:'alibaba/wan2.6-image',type:'image'}],policy)
 assert.deepEqual(result.map(m=>m.id),['office-content-ops','alibaba/wan2.6-image','wan-2.7']);assert.equal(result[2].video_image_input,false);assert.equal(result[0].type,'chat')
})
test('Office alias survives discovery as the allowed agent model while ordinary Claude deployments stay unchanged',async()=>{
 const raw=await readFile(new URL('../integrations/aitoearn/source/project/aitoearn-backend/apps/aitoearn-ai/src/core/ai/libs/fouryi/fouryi-models.util.ts',import.meta.url),'utf8')
 const getKind=raw.slice(raw.indexOf('export function getFourYiModelKind'),raw.indexOf('export async function loadFourYiModels'))
 const tail=raw.slice(raw.indexOf('export function toFourYiVideoModel'))
 const code=stripTypeScriptTypes(getKind+tail,{mode:'transform'}).replaceAll('export function','function')
 const apply=new Function('AiLogChannel','FourYiModelKind',code+';return applyFourYiModels')({FourYi:'4yi'},{Chat:'chat',Image:'image',Video:'video'})
 const settings={officeBridge:{tenantId:'test'},ai:{models:{video:{}},draftGeneration:{planner:{defaultModel:'office-content-ops'}}},agent:{models:['office-content-ops'],defaultModel:'office-content-ops',backgroundModel:'office-content-ops',thinkModel:'office-content-ops'}}
 const model=id=>({id,type:'chat',resolutions:[],durations:[],aspect_ratios:[]})
 apply(settings,[model('office-content-ops')]);assert.deepEqual(settings.agent.models,['office-content-ops']);assert.equal(settings.agent.defaultModel,'office-content-ops')
 apply(settings,[{...model('alibaba/wan2.6-image'),type:'image'}]);assert.equal(settings.ai.models.image.edit[0]?.name,'alibaba/wan2.6-image')
 delete settings.officeBridge;apply(settings,[model('claude-haiku-4.5')]);assert.deepEqual(settings.agent.models,['claude-haiku-4.5'])
})
