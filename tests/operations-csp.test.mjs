import {test} from 'node:test'
import assert from 'node:assert/strict'
import * as media from '../apps/api/src/operations/media-origins.mjs'
test('preview CSP only permits operator-configured HTTPS or loopback storage origins',()=>{
 assert.deepEqual(media.mediaOrigins({a:{infrastructure:{assets:{cdnEndpoint:'http://127.0.0.1:19000/office-content'}}},b:{infrastructure:{assets:{cdnEndpoint:'https://media.example/assets'}}}}),['http://127.0.0.1:19000','https://media.example'])
 for(const cdnEndpoint of ['http://192.168.1.2:9000/bucket','file:///private','https://user:secret@example.com/a','https://example.com/?token=secret'])assert.throws(()=>media.mediaOrigins({a:{infrastructure:{assets:{cdnEndpoint}}}}))
 assert.deepEqual(media.mediaOrigins({}),[])
})
