import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { validateFiles } from '../../../execution/files.mjs'
import { discoverTestFiles, testCommand, validCounts } from './test-evidence.mjs'

const environment = 'Node.js 24 / npm / Python 3；网络关闭；60 秒 / 512 MiB'
const fail = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode, expose: true })
const clipped = (value) => {
  const bytes = Buffer.from(value)
  if (bytes.length <= 24000) return value
  // A truncated UTF-8 code point must not expand beyond the byte output limit.
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 23997))
}

export function createDockerExecution({ env = process.env } = {}) {
  const docker =
    env.EXECUTION_DOCKER ||
    (process.platform === 'win32'
      ? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
      : 'docker')
  const image = env.EXECUTION_IMAGE || 'wishtaday-execution:local'
  const hostEnv = Object.fromEntries(
    ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']
      .filter((key) => env[key] !== undefined)
      .map((key) => [key, env[key]]),
  )

  function run(args, { stdin, timeoutMs = 10000, limit = 16384 } = {}) {
    return new Promise((resolve) => {
      let stdout = Buffer.alloc(0),
        stderr = Buffer.alloc(0),
        timedOut = false,
        overflow = false,
        settled = false
      const child = spawn(docker, args, {
        shell: false,
        windowsHide: true,
        env: hostEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          timedOut,
          overflow,
          ...value,
        })
      }
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
        finish({ code: null })
      }, timeoutMs)
      const capture = (channel, chunk) => {
        const current = channel === 'stdout' ? stdout : stderr
        if (current.length + chunk.length > limit) {
          overflow = true
          child.kill()
          finish({ code: null })
          return
        }
        if (channel === 'stdout') stdout = Buffer.concat([stdout, chunk])
        else stderr = Buffer.concat([stderr, chunk])
      }
      child.stdout.on('data', (chunk) => capture('stdout', chunk))
      child.stderr.on('data', (chunk) => capture('stderr', chunk))
      child.once('error', () => finish({ code: null }))
      child.once('close', (code) => finish({ code }))
      child.stdin.on('error', () => {})
      child.stdin.end(stdin)
    })
  }

  async function status() {
    if (env.EXECUTION_ENABLED !== 'true')
      return { available: false, reason: '项目执行环境未启用', environment }
    const info = await run(['info', '--format', '{{.OSType}}'])
    if (info.code !== 0 || info.stdout.trim() !== 'linux')
      return { available: false, reason: '请启动 Docker Desktop 并切换到 Linux 容器', environment }
    const inspected = await run(['image', 'inspect', '--format', '{{.Os}}', image])
    if (inspected.code !== 0 || inspected.stdout.trim() !== 'linux')
      return { available: false, reason: '执行镜像未构建，请先构建本机项目执行镜像', environment }
    return { available: true, reason: '', environment }
  }

  async function execute({ files, command, timeoutMs = 30000 }) {
    validateFiles(files)
    if (
      typeof command !== 'string' ||
      !command.trim() ||
      command.length > 16000 ||
      command.includes('\0')
    )
      throw fail(400, '命令必须为 1 至 16000 字符的有效文本')
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000)
      throw fail(400, '命令超时必须介于 100 和 60000 毫秒之间')
    const ready = await status()
    if (!ready.available) throw fail(503, ready.reason)
    const name = `wishtaday-execution-${randomUUID()}`
    const args = [
      'run',
      '--name',
      name,
      '--rm',
      '--pull=never',
      '--network=none',
      '--ipc=none',
      '--read-only',
      '--user=1000:1000',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--cpus=1',
      '--memory=512m',
      '--memory-swap=512m',
      '--pids-limit=128',
      '--ulimit=nofile=256:256',
      '--ulimit=core=0:0',
      '--tmpfs=/workspace:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700',
      '--tmpfs=/tmp:rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=0700',
      '--workdir=/workspace',
      '--entrypoint=node',
      '-i',
      image,
      '/opt/execution/runner.mjs',
    ]
    let output
    try {
      output = await run(args, {
        stdin: JSON.stringify({ files, command, timeoutMs }),
        timeoutMs: timeoutMs + 15000,
        limit: 12 * 1024 * 1024,
      })
    } finally {
      // Always remove by our own random name, including Docker CLI timeouts and
      // broken pipes. Stopping only the CLI would leave its container running.
      await run(['rm', '-f', name], { timeoutMs: 10000 })
    }
    const unknown = {
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: output.timedOut,
      truncated: output.overflow,
      snapshotError: '执行结果未能完整收集，原有文件快照已保留；请核对日志后再决定是否重试',
    }
    if (output.code !== 0 || output.overflow || output.timedOut) return unknown
    try {
      const result = JSON.parse(output.stdout)
      if (
        !result ||
        ![null, ...Array.from({ length: 256 }, (_, i) => i)].includes(result.exitCode) ||
        typeof result.stdout !== 'string' ||
        typeof result.stderr !== 'string' ||
        typeof result.timedOut !== 'boolean' ||
        typeof result.truncated !== 'boolean'
      )
        return unknown
      const answer = {
        exitCode: result.exitCode,
        stdout: clipped(result.stdout),
        stderr: clipped(result.stderr),
        timedOut: result.timedOut,
        truncated:
          result.truncated ||
          Buffer.byteLength(result.stdout) > 24000 ||
          Buffer.byteLength(result.stderr) > 24000,
      }
      if (result.snapshotError) answer.snapshotError = String(result.snapshotError).slice(0, 500)
      else if (Array.isArray(result.files)) answer.files = validateFiles(result.files)
      else return unknown
      return answer
    } catch {
      return unknown
    }
  }
  async function test({ files, testFiles, timeoutMs = 60000 }) {
    const discovered = discoverTestFiles(files)
    if (!Array.isArray(testFiles) || !testFiles.length ||
      testFiles.length !== discovered.length || testFiles.some((path, index) => path !== discovered[index]))
      throw fail(400, '测试文件必须与保存版本中的受支持测试一致')
    if (timeoutMs !== 60000) throw fail(400, '自动测试固定60秒超时')
    const { files: _ignored, ...execution } = await execute({ files, command: testCommand(testFiles), timeoutMs })
    let evidence
    try { evidence = JSON.parse(execution.stdout) } catch { /* Missing protocol fails closed. */ }
    if (evidence?.protocol !== 'dragon-node-tests-v1' || !validCounts(evidence.counts) ||
      !Array.isArray(evidence.cases) || !evidence.cases.every(item => item &&
        typeof item.name === 'string' && typeof item.detail === 'string' &&
        ['passed', 'failed', 'skipped', 'todo'].includes(item.status)) ||
      typeof evidence.stdout !== 'string' || typeof evidence.stderr !== 'string' ||
      typeof evidence.summaryComplete !== 'boolean' || typeof evidence.success !== 'boolean' ||
      typeof evidence.truncated !== 'boolean')
      return { ...execution, counts: null, cases: [], summaryComplete: false, success: false }
    return { ...execution, counts: evidence.counts, cases: evidence.cases,
      summaryComplete: evidence.summaryComplete, success: evidence.success,
      stdout: evidence.stdout, stderr: [evidence.stderr, execution.stderr].filter(Boolean).join('\n'),
      truncated: execution.truncated || evidence.truncated }
  }
  return { status, execute, test }
}
