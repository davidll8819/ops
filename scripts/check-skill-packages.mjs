import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

export async function checkSkillPackages(root, { hashes = false } = {}) {
  const catalog = JSON.parse(await readFile(resolve(root, 'skills/catalog/catalog.json'), 'utf8'))
  const packages = new Map()
  for (const item of catalog.items) {
    const d = item.download
    if (d?.status !== 'downloaded') continue
    if (!/^skills\/packages\/[a-zA-Z0-9_.-]+\.zip$/.test(d.packagePath))
      throw new Error('Invalid skill archive path in catalog')
    const existing = packages.get(d.packagePath)
    if (existing && (existing.sha256 !== d.sha256 || existing.packageBytes !== d.packageBytes))
      throw new Error('Conflicting skill archive metadata')
    packages.set(d.packagePath, d)
  }
  const missing = [],
    invalid = []
  for (const [path, d] of packages) {
    try {
      if (
        (await stat(resolve(root, path))).size !== d.packageBytes ||
        (hashes &&
          createHash('sha256')
            .update(await readFile(resolve(root, path)))
            .digest('hex') !== d.sha256)
      )
        invalid.push(path)
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
      missing.push(path)
    }
  }
  return { rows: catalog.items.length, packages: packages.size, missing, invalid }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await checkSkillPackages(fileURLToPath(new URL('../', import.meta.url)), {
    hashes: true,
  })
  console.log(JSON.stringify(result, null, 2))
  if (result.missing.length || result.invalid.length) process.exitCode = 1
}
