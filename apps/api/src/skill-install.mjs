import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import yazl from 'yazl'
import { zipFiles, MAX_PACKAGE } from './skill-upload.mjs'
import { fail } from './db.mjs'

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const safePath = (path) =>
  typeof path === 'string' &&
  path.length > 0 &&
  !path.startsWith('/') &&
  !/[\\:\x00-\x1f]/.test(path) &&
  path.split('/').every((p) => p && p !== '.' && p !== '..')
let active = 0

export async function prepareCatalogSkill(id, { root = projectRoot, catalog } = {}) {
  if (active >= 2) throw fail(429, '已有技能正在安装，请稍后再试')
  active++
  try {
    catalog ??= JSON.parse(await readFile(resolve(root, 'skills/catalog/catalog.json'), 'utf8'))
    const item = catalog.items.find((i) => i.id === id)
    if (!item) throw fail(404, '技能目录中没有这一项')
    const d = item.download
    if (d.status !== 'downloaded') throw fail(409, '技能文件尚未下载完成')
    if (
      !safePath(d.packagePath) ||
      !d.packagePath.startsWith('skills/packages/') ||
      !safePath(d.skillFile) ||
      !(d.skillRoot === '.' || safePath(d.skillRoot))
    )
      throw fail(409, '技能文件对应关系无效，请重新核对目录')
    const allowed = await realpath(resolve(root, 'skills/packages'))
    let archivePath
    try {
      archivePath = await realpath(resolve(root, d.packagePath))
    } catch {
      throw fail(409, '本地技能包缺失，请恢复下载文件')
    }
    if (!archivePath.startsWith(allowed + sep) || (await stat(archivePath)).size > 64 * 1024 * 1024)
      throw fail(409, '技能包路径或大小不符合要求')
    const bytes = await readFile(archivePath)
    if (digest(bytes) !== d.sha256) throw fail(409, '技能包校验失败，请重新下载对应文件')
    const prefix = d.skillRoot === '.' ? '' : d.skillRoot + '/'
    if (d.skillFile !== prefix + 'SKILL.md') throw fail(409, '技能文件对应关系无效，请重新核对目录')
    const repositoryRoot = d.skillFile.includes('/') ? d.skillFile.split('/')[0] + '/' : ''
    const { files, expandedBytes } = await zipFiles(bytes, {
      maxFiles: 1000,
      select(path) {
        if (path.startsWith(prefix)) return path.slice(prefix.length) || null
        const relative = path.startsWith(repositoryRoot) ? path.slice(repositoryRoot.length) : ''
        if (/^(LICENSE|LICENCE|COPYING|NOTICE)(\.[^/]*)?$/i.test(relative))
          return '_source/' + relative
        return null
      },
    })
    const skill = files.get('SKILL.md')
    if (!skill || digest(Buffer.from(new TextDecoder().decode(skill))) !== d.skillSha256)
      throw fail(409, '技能说明校验失败，请重新核对下载包')
    const zip = new yazl.ZipFile()
    const output = new Promise((resolveOutput, reject) => {
      const chunks = []
      let size = 0
      zip.on('error', reject)
      zip.outputStream.on('error', reject)
      zip.outputStream.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_PACKAGE) {
          zip.outputStream.destroy()
          reject(fail(413, '所选技能打包后超过 6 MB，暂不能安装'))
          return
        }
        chunks.push(chunk)
      })
      zip.outputStream.on('end', () => resolveOutput(Buffer.concat(chunks)))
    })
    for (const [path, data] of files)
      zip.addBuffer(data, path, { mtime: new Date('2000-01-01T00:00:00Z'), mode: 0o100600 })
    zip.end()
    const buffer = await output
    return {
      name: item.name,
      description: item.descriptionZh,
      version: (d.commit || d.sha256).slice(0, 12),
      kind: item.kind === 'workflow' ? 'workflow' : 'capability',
      filename: item.name + '.zip',
      format: 'zip',
      buffer,
      skillFile: 'SKILL.md',
      fileCount: files.size,
      expandedBytes,
      sha256: digest(buffer),
      catalogId: item.id,
      catalogSource: item.source,
      provenance: {
        sourceUrl: d.sourceUrl,
        sourceSha256: d.sha256,
        sourceSkillFile: d.skillFile,
        commit: d.commit || null,
        historical: !!d.historical,
        descriptionEn: item.descriptionEn,
      },
    }
  } catch (err) {
    if (err.statusCode) throw err
    throw fail(409, '技能包读取失败，请核对下载文件')
  } finally {
    active--
  }
}
