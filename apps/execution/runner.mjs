import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, writeFile, readdir, lstat, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { FILE_LIMITS, validateFiles, validatePath } from './files.mjs'

const root = '/workspace'
const outputLimit = 24000

// This entry point is intentionally unusable as a host execution fallback.
if (
  process.platform !== 'linux' ||
  process.pid !== 1 ||
  process.getuid() !== 1000 ||
  process.cwd() !== root
)
  throw new Error('Execution worker must run as non-root PID 1 in its isolated container')

function stopCommands() {
  // Linux excludes PID 1 and the caller from kill(-1). This also terminates
  // descendants that detached from the shell's original process group.
  try {
    process.kill(-1, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

async function input() {
  const chunks = []
  let length = 0
  for await (const chunk of process.stdin) {
    length += chunk.length
    if (length > 12 * 1024 * 1024) throw new Error('Execution request is too large')
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  validateFiles(value.files)
  if (
    typeof value.command !== 'string' ||
    !value.command.trim() ||
    value.command.length > 16000 ||
    !Number.isInteger(value.timeoutMs) ||
    value.timeoutMs < 100 ||
    value.timeoutMs > 60000
  )
    throw new Error('Execution command or timeout is invalid')
  return value
}

async function collect() {
  const files = []
  let total = 0,
    entries = 0
  async function walk(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      if (++entries > 2000) throw new Error('快照目录条目过多')
      const path = validatePath(prefix ? `${prefix}/${name}` : name)
      const absolute = join(directory, name)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new Error('快照包含符号链接，原有文件快照已保留')
      if (info.isDirectory()) {
        await walk(absolute, path)
        continue
      }
      if (!info.isFile()) throw new Error('快照包含不支持的特殊文件，原有文件快照已保留')
      if (
        files.length >= FILE_LIMITS.count ||
        info.size > FILE_LIMITS.fileBytes ||
        total + info.size > FILE_LIMITS.totalBytes
      )
        throw new Error('执行结果超过文件快照容量，原有文件快照已保留')
      const handle = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        const actual = await handle.stat()
        if (!actual.isFile() || actual.ino !== info.ino || actual.size > FILE_LIMITS.fileBytes)
          throw new Error('文件在快照期间发生变化，原有文件快照已保留')
        const bytes = await handle.readFile()
        total += bytes.length
        if (bytes.length > FILE_LIMITS.fileBytes || total > FILE_LIMITS.totalBytes)
          throw new Error('执行结果超过文件快照容量，原有文件快照已保留')
        files.push({ path, contentBase64: bytes.toString('base64') })
      } finally {
        await handle.close()
      }
    }
  }
  await walk(root)
  return validateFiles(files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
}

async function execute({ command, timeoutMs }) {
  let stdout = Buffer.alloc(0),
    stderr = Buffer.alloc(0),
    truncated = false,
    timedOut = false
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: root,
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: '/tmp',
        TMPDIR: '/tmp',
        LANG: 'C.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const capture = (channel, chunk) => {
      const current = channel === 'stdout' ? stdout : stderr
      const remaining = outputLimit - current.length
      if (chunk.length > remaining) truncated = true
      const next = Buffer.concat([current, chunk.subarray(0, Math.max(0, remaining))])
      if (channel === 'stdout') stdout = next
      else stderr = next
    }
    child.stdout.on('data', (chunk) => capture('stdout', chunk))
    child.stderr.on('data', (chunk) => capture('stderr', chunk))
    const timer = setTimeout(() => {
      timedOut = true
      stopCommands()
    }, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      stopCommands()
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      stopCommands()
      reject(error)
    })
    child.once('close', (code) => resolve({ exitCode: timedOut ? null : code }))
  })
  return {
    ...result,
    stdout: stdout.toString('utf8'),
    stderr: stderr.toString('utf8'),
    timedOut,
    truncated,
  }
}

let result
try {
  const request = await input()
  for (const file of request.files) {
    const absolute = join(root, file.path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, Buffer.from(file.contentBase64, 'base64'), {
      flag: 'wx',
      mode: 0o600,
    })
  }
  result = await execute(request)
  try {
    result.files = await collect()
  } catch (error) {
    result.snapshotError = String(error.message).slice(0, 500)
  }
} catch {
  stopCommands()
  result = {
    exitCode: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false,
    snapshotError: '执行环境未能收集结果，原有文件快照已保留',
  }
}
process.stdout.write(JSON.stringify(result), () => process.exit(0))
