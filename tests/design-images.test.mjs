import test from 'node:test'
import assert from 'node:assert/strict'
import {
  needsDesignImage,
  imageBytes,
  generateDesignImage,
  downloadGeneratedImage,
} from '../apps/api/src/design-images.mjs'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA1sAAAAASUVORK5CYII=',
  'base64',
)
test('design image routing preserves explicit text-only design tasks', () => {
  assert.equal(
    needsDesignImage({ dept: 'new-agent-7', title: '制作「冒热气的咖啡」静态图片' }),
    true,
  )
  assert.equal(
    needsDesignImage({ dept: 'new-agent-7', title: '只输出提示词', summary: '咖啡图片' }),
    false,
  )
  assert.equal(needsDesignImage({ dept: 'code-agent', title: '图片代码' }), false)
})
test('image task calls configured media gateway and returns real bytes, not a design spec', async () => {
  const calls = []
  const r = await generateDesignImage({
    ctx: {},
    policy: { departments: { design: { enabled: true } }, tiers: { image: 'tenant-image' } },
    task: { title: '咖啡图片', request: '白杯子' },
    instructions: '技能说明',
    call: async (x) => {
      calls.push(x)
      return calls.length === 1
        ? { choices: [{ message: { content: 'A white coffee cup with steam' } }] }
        : { data: [{ b64_json: png.toString('base64') }] }
    },
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].path, '/api/v1/images/generations')
  assert.equal(calls[1].allowFallback, false)
  assert.equal(calls[1].body.n, 1)
  assert.equal(r.model, 'tenant-image')
  assert.deepEqual(r.bytes, png)
  assert.match(calls[0].body.messages[0].content, /技能说明/)
})
test('no configured image model incurs no calls; text-only media responses never succeed', async () => {
  let n = 0
  await assert.rejects(
    generateDesignImage({
      policy: { departments: { design: { enabled: true } }, tiers: {} },
      call: async () => {
        n++
      },
    }),
    /图片模型/,
  )
  assert.equal(n, 0)
  await assert.rejects(
    generateDesignImage({
      ctx: {},
      policy: { departments: { design: { enabled: true } }, tiers: { image: 'x' } },
      task: { title: '图片' },
      call: async () => ({ choices: [{ message: { content: 'only text' } }] }),
    }),
    /未返回图片/,
  )
  assert.throws(() => imageBytes(Buffer.from('<svg onload="alert(1)">bad</svg>')), /有效/)
  await assert.rejects(downloadGeneratedImage('https://127.0.0.1/a.png'), /公开|内部/)
  await assert.rejects(downloadGeneratedImage('http://localhost/a.png'), /公开/)
})
test('generated URLs are handed to safe binary reader without credentials', async () => {
  let n = 0
  const r = await generateDesignImage({
    ctx: {},
    policy: { departments: { design: { enabled: true } }, tiers: { image: 'x' } },
    task: { title: '图片' },
    call: async () =>
      ++n === 1
        ? { choices: [{ message: { content: 'coffee' } }] }
        : { data: [{ url: 'https://public.example/image.png' }] },
    reader: async (url) => {
      assert.equal(url, 'https://public.example/image.png')
      return imageBytes(png)
    },
  })
  assert.deepEqual(r.bytes, png)
})
