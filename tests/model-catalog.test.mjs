import test from 'node:test'
import assert from 'node:assert/strict'
import {classifyModel,modelCatalog} from '../apps/api/src/operations/model-catalog.mjs'
import {defaultPolicy,policySchema} from '../apps/api/src/operations/policy.mjs'
test('capability metadata wins; image understanding is not image generation',()=>{
  assert.deepEqual(classifyModel({id:'custom',input_modalities:['text','image'],output_modalities:['text']}).kinds,['text'])
  assert.deepEqual(classifyModel({id:'gpt-custom',type:'image'}).kinds,['image'])
  assert.deepEqual(classifyModel({id:'private',model_type:'video'}).kinds,['video'])
  assert.deepEqual(classifyModel({id:'custom',architecture:{output_modalities:['text','image']}}).kinds,['image','text'])
  assert.deepEqual(classifyModel({id:'gpt-vision'}).kinds,['text'])
  assert.deepEqual(classifyModel({id:'gpt-image-1'}).kinds,['image'])
  assert.deepEqual(classifyModel({id:'gemini-2.5-flash-image-preview'}).kinds,['image'])
  assert.deepEqual(classifyModel({id:'wan-2.5-t2i'}).kinds,['image'])
  assert.deepEqual(classifyModel({id:'wan-2.5-t2v'}).kinds,['video'])
  assert.deepEqual(classifyModel({id:'grok-imagine-video'}).kinds,['video'])
  assert.deepEqual(classifyModel({id:'text-embedding-3-large'}).kinds,['other'])
  assert.deepEqual(classifyModel({id:'new-unknown-model'}).kinds,['unknown'])
  assert.equal(modelCatalog({data:[null,{}, {id:'gpt-4.1'},{id:'gpt-4.1'}]}).length,1)
})
test('old text-only policy migrates without changing selected models',()=>{
 const p=defaultPolicy(); delete p.tiers.image;delete p.tiers.video;p.tiers.fast='custom-text'
 const current=policySchema.parse(p)
 assert.equal(current.tiers.fast,'custom-text');assert.equal(current.tiers.image,'');assert.equal(current.tiers.video,'')
 assert.throws(()=>policySchema.parse({...current,departments:{...current.departments,secretary:{...current.departments.secretary,tier:'image'}}}))
})
