import test from 'node:test'
import assert from 'node:assert/strict'
import { productZip } from '../apps/api/src/execution/deliverables.mjs'
import { zipFiles } from '../apps/api/src/skill-upload.mjs'

test('formal package freezes user documentation under constant archive paths without changing website bytes', async () => {
  const html = '<title>Original</title><p>Saved bytes</p>'
  const snapshot = {
    files: [{ path: 'index.html', contentBase64: Buffer.from(html).toString('base64') }],
  }
  const delivery = {
    id: 'delivery',
    versionId: 'fixed-version',
    label: '../../<script>label</script>',
    instructions: 'Use "打开作品.html"\n<text>',
    limitations: '暂无已知限制',
    items: [{ id: 'human', title: '<title>', status: 'passed', note: 'observed' }],
    systemCheck: { status: 'passed' },
  }
  const { files } = await zipFiles(await productZip(snapshot, 'index.html', delivery))
  assert.equal(files.get('website/index.html').toString(), html)
  assert.ok(files.get('交付说明.txt').toString().includes(delivery.label))
  assert.ok(files.get('交付说明.txt').toString().includes(delivery.instructions))
  assert.deepEqual(JSON.parse(files.get('验收记录.json').toString()), delivery)
  assert.deepEqual(
    [...files.keys()].sort(),
    ['website/index.html', '交付说明.txt', '使用说明.txt', '打开作品.html', '验收记录.json'].sort(),
  )
  assert.doesNotMatch(files.get('打开作品.html').toString(), /<script>label/)
})
