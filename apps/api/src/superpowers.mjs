import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { zipFiles, MAX_PACKAGE } from './skill-upload.mjs'
import { fail } from './db.mjs'

export async function prepareSuperpowers() {
  const root = new URL('../../../skills/bundles/', import.meta.url)
  const metadata = JSON.parse(await readFile(new URL('superpowers.json', root), 'utf8'))
  const buffer = await readFile(new URL('superpowers.zip', root))
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  if (buffer.length > MAX_PACKAGE || sha256 !== metadata.sha256)
    throw fail(409, 'Superpowers 安装包校验失败，请恢复随应用提供的技能包')
  const { files, expandedBytes } = await zipFiles(buffer, { maxFiles: 1000 })
  if (!files.has('skills/using-superpowers/SKILL.md') || !files.has('LICENSE'))
    throw fail(409, 'Superpowers 安装包不完整')
  return {
    name: 'superpowers',
    description: '官方开发技能集：需求澄清、设计、计划、测试、调试、评审与交付验证。',
    version: metadata.version,
    kind: 'workflow',
    filename: 'superpowers.zip',
    format: 'zip',
    buffer,
    skillFile: 'SKILL.md',
    fileCount: files.size,
    expandedBytes,
    sha256,
    catalogId: 'official:obra/superpowers',
    catalogSource: 'obra/superpowers',
    provenance: {
      sourceUrl: metadata.sourceUrl,
      commit: metadata.commit,
      sourceSha256: metadata.sourceSha256,
      license: metadata.license,
      modules: metadata.modules,
    },
  }
}
