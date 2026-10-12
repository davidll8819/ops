// Build only committed/tracked source plus catalog-verified skill archives. Never package the workspace wholesale.
import { execFileSync } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import yazl from 'yazl'
import { checkSkillPackages } from './check-skill-packages.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const report = await checkSkillPackages(root, { hashes: true })
if (report.missing.length || report.invalid.length)
  throw new Error('Skill package verification failed')
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
if (!tracked.includes('Start-Windows.cmd'))
  throw new Error('Stage the reviewed release source first')
const catalog = JSON.parse(await readFile(resolve(root, 'skills/catalog/catalog.json'), 'utf8'))
const paths = new Set([
  ...tracked,
  ...catalog.items
    .filter((s) => s.download?.status === 'downloaded')
    .map((s) => s.download.packagePath),
])
const forbidden =
  /(^|\/)(?:\.git|\.local|\.secrets|node_modules|\.terraform|dist)(\/|$)|(^|\/)\.env(?!\.example$)(?:\.|$)|\.(?:dump|backup|db|sqlite|log|tfstate|tfplan)(?:\.|$)|\.tfvars$|(^|\/)backend\.hcl$/i
for (const name of paths) {
  if (forbidden.test(name) || name.split('/').includes('..') || name.startsWith('/'))
    throw new Error(`Private or unsafe release path: ${name}`)
  if (!(await lstat(resolve(root, name))).isFile())
    throw new Error(`Non-regular release file: ${name}`)
}
const out = resolve(root, '.local/releases')
await mkdir(out, { recursive: true })
const filename = 'wishtaday-windows-20261012.zip'
const target = resolve(out, filename)
const zip = new yazl.ZipFile()
const writing = pipeline(zip.outputStream, createWriteStream(target))
for (const name of [...paths].sort()) {
  const dest = `ops/${name}`
  if (name.endsWith('.cmd'))
    zip.addBuffer(
      Buffer.from((await readFile(resolve(root, name), 'utf8')).replace(/\r?\n/g, '\r\n')),
      dest,
    )
  else zip.addFile(resolve(root, name), dest)
}
zip.end()
await writing
const hash = createHash('sha256')
for await (const chunk of createReadStream(target)) hash.update(chunk)
await writeFile(resolve(out, 'SHA256SUMS.txt'), `${hash.digest('hex')}  ${filename}\n`)
console.log(
  JSON.stringify({
    file: target,
    sourceFiles: tracked.length,
    skillArchives: report.packages,
    catalogRows: report.rows,
  }),
)
