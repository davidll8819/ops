import { spawn, execFileSync } from 'node:child_process'
import { readFile, writeFile, access, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { parseEnv } from 'node:util'
import { createServer } from 'node:net'
import { checkSkillPackages } from './check-skill-packages.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
const compose = ['compose', '-p', 'wishtaday-local']
const run = (file, args, env = process.env) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(file, args, { cwd: root, env, stdio: 'inherit', windowsHide: false })
    child.once('error', () =>
      reject(new Error(`无法运行 ${file}，请检查安装与 PATH（命令搜索路径）。`)),
    )
    child.once('exit', (code) =>
      code === 0 ? resolveRun() : reject(new Error(`${file} 执行未成功，请查看上方错误。`)),
    )
  })
const freePort = (port) =>
  new Promise((done) => {
    const server = createServer()
    server.once('error', () => done(false))
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
  })
const fingerprint = async () =>
  createHash('sha256')
    .update(await readFile('package-lock.json'))
    .update(process.versions.node.split('.')[0])
    .update(process.platform)
    .update(process.arch)
    .digest('hex')
async function loadLocalEnv() {
  const saved = parseEnv(await readFile('.env', 'utf8'))
  if (
    saved.AUTH_MODE !== 'local' ||
    saved.NODE_ENV !== 'development' ||
    saved.APP_ORIGIN !== 'http://localhost:3000' ||
    saved.PGHOST !== '127.0.0.1' ||
    saved.PGPORT !== '55432' ||
    saved.PGDATABASE !== 'office' ||
    saved.PGUSER !== 'office_app' ||
    saved.DATABASE_URL ||
    saved.REDIS_URL !== 'redis://127.0.0.1:56379' ||
    !saved.LOCAL_DB_PASSWORD ||
    saved.PGPASSWORD !== saved.APP_DB_PASSWORD
  )
    throw new Error(
      '当前 .env 不符合本机默认配置。请按 docs/WINDOWS-SETUP.md 核对，程序不会改写现有配置。',
    )
  const encoded =
    saved.OPERATIONS_CONFIG_KEY ||
    (saved.OPERATIONS_CONFIG_KEY_FILE &&
      (await readFile(saved.OPERATIONS_CONFIG_KEY_FILE, 'utf8')).trim())
  if (!encoded || Buffer.from(encoded, 'base64').length !== 32)
    throw new Error('原主加密密钥缺失或无效。迁移旧数据时请恢复原文件，不要生成新密钥。')
  const env = { ...process.env, ...saved }
  // Shell-level connection variables must not redirect this local launcher to another database.
  delete env.DATABASE_URL
  delete env.PGSSLROOTCERT
  if (!saved.OPERATIONS_CONFIG_KEY) delete env.OPERATIONS_CONFIG_KEY
  env.PORT = '3000'
  return env
}
async function npm(...args) {
  const candidates = [
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ]
  for (const cli of candidates) if (await exists(cli)) return run(process.execPath, [cli, ...args])
  throw new Error('找不到 npm。请安装包含 npm 的官方 Node.js 24。')
}
async function setup() {
  const os = execFileSync('docker', ['info', '--format', '{{.OSType}}'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
  if (os !== 'linux')
    throw new Error('请在 Docker Desktop 中切换到 Linux containers（Linux 容器）。')
  if (!(await exists('.env'))) {
    if ((await exists('.local/operations-config.key')) || (await exists('.local/accounts.json')))
      throw new Error('发现旧私有文件但缺少 .env。请恢复完整迁移资料，不能当作全新安装。')
    console.log('正在创建全新本地账号；如需保留 Mac 数据，请先停止并按迁移章节恢复备份。')
    await run(process.execPath, ['scripts/setup-local.mjs'])
  }
  const env = await loadLocalEnv()
  await npm('ci', '--include=optional')
  const skills = await checkSkillPackages(root, { hashes: true })
  if (skills.missing.length || skills.invalid.length)
    console.log(
      `技能包缺失 ${skills.missing.length} 个、校验异常 ${skills.invalid.length} 个。请从 GitHub Releases 下载完整 Windows 包；办公室仍可启动。`,
    )
  await run('docker', [...compose, 'up', '-d', '--wait'], env)
  await run(process.execPath, ['scripts/bootstrap-local.mjs'], env)
  // POSIX mode 0600 does not protect secrets on Windows; restrict these local files explicitly.
  const identityOutput = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const identitySid = identityOutput.match(/S-\d+(?:-\d+)+/)?.[0]
  if (!identitySid) throw new Error('无法识别当前 Windows 账号的安全标识。')
  const identity = `*${identitySid}`
  await run('icacls', ['.env', '/inheritance:r', '/grant:r', `${identity}:F`])
  await run('icacls', ['.local', '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`])
  await npm('run', 'build')
  await mkdir('.local', { recursive: true })
  await writeFile('.local/windows-ready', await fingerprint())
  console.log('安装完成。账号密码只保存在本机 .local/login.txt。双击 Start-Windows.cmd 使用。')
}
async function start() {
  if (!(await freePort(3000)))
    throw new Error(
      '3000 端口已被占用。若办公室已启动，请直接访问 http://localhost:3000/；不要重复启动。',
    )
  const ready =
    (await exists('.local/windows-ready')) &&
    (await readFile('.local/windows-ready', 'utf8')) === (await fingerprint()) &&
    (await exists('node_modules/fastify/package.json')) &&
    (await exists('apps/web/dist/index.html'))
  if (!ready) await setup()
  const env = await loadLocalEnv()
  await run('docker', [...compose, 'up', '-d', '--wait'], env)
  console.log('运行期间请保留此窗口。停止时先按 Ctrl+C；再运行 Stop-Windows.cmd 停止数据库和缓存。')
  const child = spawn(process.execPath, ['apps/api/src/server.mjs'], {
    cwd: root,
    env,
    stdio: 'inherit',
  })
  let ended = false,
    opening = false
  const startedAt = Date.now()
  const timer = setInterval(async () => {
    if (opening || ended) return
    if (Date.now() - startedAt > 60000) {
      clearInterval(timer)
      console.error(
        '启动一分钟后仍未就绪，请查看本窗口错误。服务仍在运行；按 Ctrl+C 停止后按文档排查。',
      )
      return
    }
    opening = true
    try {
      const response = await fetch('http://localhost:3000/health/ready', {
        signal: AbortSignal.timeout(1500),
      })
      await response.body?.cancel()
      if (response.ok) {
        clearInterval(timer)
        console.log('办公室已就绪：http://localhost:3000/。登录密码见 .local/login.txt。')
        const browser = spawn('cmd.exe', ['/d', '/s', '/c', 'start "" "http://localhost:3000/"'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        browser.on('error', () => console.log('请手动在浏览器打开上述地址。'))
      }
    } catch {
    } finally {
      opening = false
    }
  }, 1000)
  // Windows consoles broadcast Ctrl+C to parent and child; let the server close its connections.
  const onInterrupt = () => console.log('正在停止办公室，请等待当前进程退出。')
  process.on('SIGINT', onInterrupt)
  try {
    await new Promise((done, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        ended = true
        if (code === 0 || signal === 'SIGINT' || code === 130 || code === 3221225786) done()
        else reject(new Error('办公室服务已退出，请查看上方错误。'))
      })
    })
  } finally {
    clearInterval(timer)
    process.off('SIGINT', onInterrupt)
  }
}
try {
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error('请使用 Node.js 24；安装后重新打开此窗口。')
  if (process.argv[2] === 'check') {
    console.log('Node.js 24 与启动脚本检查通过。此检查不会安装依赖、创建配置或启动服务。')
  } else {
    if (process.platform !== 'win32')
      throw new Error('此入口用于 Windows；Mac 请使用 Start-Local.command。')
    if (process.argv[2] === 'setup') {
      if (!(await freePort(3000)))
        throw new Error('请先在运行窗口按 Ctrl+C 停止办公室，再执行安装或更新。')
      await setup()
    } else if (process.argv[2] === 'start') await start()
    else if (process.argv[2] === 'stop') {
      if (!(await freePort(3000)))
        throw new Error('请先在 Start-Windows 窗口按 Ctrl+C 停止应用，然后重新运行停止入口。')
      await run('docker', [...compose, 'stop'], await loadLocalEnv())
      console.log('数据库和缓存已停止，数据卷保留。')
    } else throw new Error('用法：node scripts/windows-local.mjs setup|start|stop|check')
  }
} catch (error) {
  console.error(error.message)
  console.error('排查说明：docs/WINDOWS-SETUP.md。请勿发送 .env、密钥或账号密码。')
  process.exitCode = 1
}
