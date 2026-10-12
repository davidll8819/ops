import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import yazl from 'yazl'
import { prepareCatalogSkill } from '../apps/api/src/skill-install.mjs'
import { zipFiles } from '../apps/api/src/skill-upload.mjs'
const sha = (data) => createHash('sha256').update(data).digest('hex')
async function archive(entries) {
  const z = new yazl.ZipFile(),
    chunks = []
  const result = new Promise((resolve, reject) => {
    z.outputStream.on('data', (c) => chunks.push(c))
    z.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    z.on('error', reject)
  })
  for (const [path, data] of entries) z.addBuffer(Buffer.from(data), path)
  z.end()
  return result
}
test('catalog installer selects one skill, keeps companions and licenses, checks both hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-catalog-'))
  try {
    await mkdir(join(root, 'skills/packages'), { recursive: true })
    const text = '---\nname: one\ndescription: One\n---\nDo nothing automatically.\n'
    const zip = await archive([
      ['repo/skills/one/SKILL.md', text],
      ['repo/skills/one/reference.txt', 'reference'],
      ['repo/skills/two/SKILL.md', 'other skill'],
      ['repo/LICENSE', 'license'],
    ])
    await writeFile(join(root, 'skills/packages/repo.zip'), zip)
    const item = {
      id: 'a'.repeat(24),
      name: 'one',
      source: 'test/repo',
      descriptionZh: '测试',
      download: {
        status: 'downloaded',
        packagePath: 'skills/packages/repo.zip',
        skillRoot: 'repo/skills/one',
        skillFile: 'repo/skills/one/SKILL.md',
        sha256: sha(zip),
        skillSha256: sha(text),
      },
    }
    const catalog = { items: [item] }
    const result = await prepareCatalogSkill(item.id, { root, catalog })
    const unpacked = await zipFiles(result.buffer)
    assert.equal(result.fileCount, 3)
    assert.equal(result.catalogId, item.id)
    assert.deepEqual([...unpacked.files.keys()], ['SKILL.md', 'reference.txt', '_source/LICENSE'])
    assert.equal(unpacked.files.get('SKILL.md').toString(), text)
    await assert.rejects(
      prepareCatalogSkill('b'.repeat(24), { root, catalog }),
      (e) => e.statusCode === 404,
    )
    const original = item.download.sha256
    item.download.sha256 = '0'.repeat(64)
    await assert.rejects(prepareCatalogSkill(item.id, { root, catalog }), (e) =>
      e.message.includes('校验失败'),
    )
    item.download.sha256 = original
    item.download.skillSha256 = '0'.repeat(64)
    await assert.rejects(prepareCatalogSkill(item.id, { root, catalog }), (e) =>
      e.message.includes('说明校验失败'),
    )
    item.download.packagePath = '../outside.zip'
    await assert.rejects(
      prepareCatalogSkill(item.id, { root, catalog }),
      (e) => e.statusCode === 409,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
