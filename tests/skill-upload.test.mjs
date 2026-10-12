import test from 'node:test'
import assert from 'node:assert/strict'
import { crc32, deflateRawSync } from 'node:zlib'
import { inspectSkillUpload } from '../apps/api/src/skill-upload.mjs'

export const skillText =
  '---\nname: test-skill\ndescription: Test description\nversion: "1.2.0"\n---\n\n# Test skill\nRead the supplied document and summarize it.\n'
// Build small ZIP fixtures, including deliberately hostile metadata, without executing contents.
export function zipFixture(entries) {
  const chunks = [],
    central = []
  let offset = 0
  for (const {
    name,
    text = skillText,
    attrs = 0,
    brokenCrc = false,
    compressed = false,
  } of entries) {
    const path = Buffer.from(name),
      raw = Buffer.from(text),
      data = compressed ? deflateRawSync(raw) : raw
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(compressed ? 8 : 0, 8)
    head.writeUInt32LE(brokenCrc ? 123 : crc32(raw), 14)
    head.writeUInt32LE(data.length, 18)
    head.writeUInt32LE(raw.length, 22)
    head.writeUInt16LE(path.length, 26)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50)
    dir.writeUInt16LE(0x0314, 4)
    dir.writeUInt16LE(20, 6)
    head.copy(dir, 10, 8, 28)
    dir.writeUInt32LE(attrs >>> 0, 38)
    dir.writeUInt32LE(offset, 42)
    chunks.push(head, path, data)
    central.push(dir, path)
    offset += head.length + path.length + data.length
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, directory, end])
}
const payload = (buffer, filename = 'skill.zip') => ({
  filename,
  kind: 'workflow',
  contentBase64: Buffer.from(buffer).toString('base64'),
})

test('plain Markdown and ZIP preserve identity, version and ancillary files without executing', async () => {
  const md = await inspectSkillUpload(payload(skillText, 'custom.md'))
  assert.equal(md.name, 'test-skill')
  assert.equal(md.version, '1.2.0')
  assert.equal(md.fileCount, 1)
  const zip = await inspectSkillUpload(
    payload(
      zipFixture([
        { name: 'example/SKILL.md', compressed: true },
        { name: 'example/scripts/tool.sh', text: 'exit 99\n' },
      ]),
    ),
  )
  assert.equal(zip.fileCount, 2)
  assert.equal(zip.kind, 'workflow')
  assert.equal(zip.skillFile, 'example/SKILL.md')
})
test('rejects traversal, absolute paths, symlinks, duplicate paths and corrupt CRCs', async () => {
  for (const entry of [
    { name: '../SKILL.md' },
    { name: '/SKILL.md' },
    { name: 'nested\\SKILL.md' },
    { name: 'SKILL.md', attrs: 0xa1ff0000 },
    { name: 'SKILL.md', brokenCrc: true },
  ]) {
    await assert.rejects(
      inspectSkillUpload(payload(zipFixture([entry]))),
      (e) => e.statusCode === 400,
    )
  }
  for (const names of [
    ['SKILL.md', 'SKILL.md'],
    ['SKILL.md', 'skill.md'],
    ['SKILL.md', 'a/SKILL.md'],
    ['SKILL.md', 'file', 'file/child'],
  ])
    await assert.rejects(
      inspectSkillUpload(payload(zipFixture(names.map((name) => ({ name }))))),
      (e) => e.statusCode === 400,
    )
})
test('rejects malformed manifests, missing skill, invalid base64 and oversized expansion', async () => {
  for (const text of [
    'hello',
    '---\nname: no-description\n---\nBody',
    '---\nname: a\nname: b\ndescription: d\n---\nBody',
    '---\nname: a\ndescription: &a [*a]\n---\nBody',
  ])
    await assert.rejects(inspectSkillUpload(payload(text, 'SKILL.md')), (e) => e.statusCode === 400)
  await assert.rejects(
    inspectSkillUpload({ filename: 'x.md', kind: 'capability', contentBase64: 'bad!' }),
    (e) => e.statusCode === 400,
  )
  await assert.rejects(
    inspectSkillUpload(payload(zipFixture([{ name: 'README.md' }]))),
    (e) => e.statusCode === 400,
  )
  await assert.rejects(
    inspectSkillUpload(
      payload(
        zipFixture([
          { name: 'SKILL.md' },
          { name: 'huge.txt', text: 'x'.repeat(11 * 1024 * 1024), compressed: true },
        ]),
      ),
    ),
    (e) => e.statusCode === 413,
  )
  await assert.rejects(
    inspectSkillUpload(
      payload(zipFixture(Array.from({ length: 201 }, (_, n) => ({ name: `file${n}`, text: '' })))),
    ),
    (e) => e.statusCode === 400,
  )
})
