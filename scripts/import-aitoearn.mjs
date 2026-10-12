// Import the actual working copy, including its local 4YI improvements, without
// importing installed dependencies, credentials, databases or runtime output.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { parse, stringify } from 'yaml'

const source = resolve(process.argv[2] || '')
if (!process.argv[2]) throw new Error('Pass the local AiToEarn checkout path')
const destination = resolve('integrations/aitoearn/source')
try {
  await lstat(destination)
  if (!process.argv.includes('--resume')) throw new Error('Import destination exists; refusing to overwrite local integration changes')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
const paths = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: source, maxBuffer: 10 * 1024 * 1024 }).toString().split('\0').filter(Boolean))]
const manifest = { sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source }).toString().trim(), importedAt: new Date().toISOString(), files: [], excluded: [] }
function redact(value, key = '') {
  if (Array.isArray(value)) return value.map(v => redact(v))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]))
  if (/api.?key|secret|password|token$|accesskey|privatekey|mongo.*uri/i.test(key)) return ''
  if (typeof value === 'string' && /^(mongodb|https?):\/\//.test(value)) {
    try { const url = new URL(value); url.username = ''; url.password = ''; return url.toString() } catch { return '' }
  }
  return value
}
for (const path of paths.sort()) {
  if (!/^(project\/aitoearn-(backend|web)\/|README[^/]*\.md$|DOCKER_DEPLOYMENT[^/]*\.md$|LICENSE[^/]*$|scripts\/|nginx\/)/.test(path)) continue
  if (/(^|\/)(node_modules|dist|\.next|\.nx|coverage|\.secrets|\.claude-session|test-results)(\/|$)|(^|\/)\.env|local\.config|\.pem$|\.key$/.test(path)) { manifest.excluded.push(path); continue }
  const src = resolve(source, path)
  let content
  try {
    if (!(await lstat(src)).isFile()) { manifest.excluded.push(path); continue }
    content = await readFile(src)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // Sparse checkout files (including the upstream license) remain in Git.
    const state = execFileSync('git', ['ls-files', '-t', '--', path], { cwd: source }).toString()
    if (!state.startsWith('S ')) { manifest.excluded.push(path); continue }
    content = execFileSync('git', ['show', `HEAD:${path}`], { cwd: source, maxBuffer: 100 * 1024 * 1024 })
  }
  let output = path
  if (/\/config\/config\.ya?ml$/.test(path)) {
    output += '.example'
    const dest = resolve(destination, output)
    await mkdir(dirname(dest), { recursive: true })
    const sanitized = Buffer.from(stringify(redact(parse(content.toString()))))
    await writeFile(dest, sanitized)
    manifest.files.push({ path: output, sanitized: true, sha256: createHash('sha256').update(sanitized).digest('hex'), bytes: sanitized.length })
    continue
  }
  const dest = resolve(destination, output)
  await mkdir(dirname(dest), { recursive: true })
  try {
    const existing = await readFile(dest)
    if (!existing.equals(content)) throw new Error(`Integration file differs: ${output}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await writeFile(dest, content)
  }
  manifest.files.push({ path: output, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length })
}
await writeFile(resolve(destination, '../source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ imported: manifest.files.length, excluded: manifest.excluded.length, sourceCommit: manifest.sourceCommit }))
