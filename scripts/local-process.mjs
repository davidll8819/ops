import { spawn } from 'node:child_process'
import { readFile, writeFile, open, mkdir, unlink } from 'node:fs/promises'
const pidFile = '.local/server.pid'
let pid
try {
  pid = Number(await readFile(pidFile, 'utf8'))
} catch {}
let running = false
if (pid)
  try {
    process.kill(pid, 0)
    running = true
  } catch {}
if (process.argv[2] === 'stop') {
  // The pid record is only created by this launcher. Verify the service before signalling it.
  if (running) {
    const response = await fetch('http://localhost:3000/health/live').catch(() => null)
    if (response?.ok) {
      process.kill(pid, 'SIGTERM')
      for (let n = 0; n < 30; n++) {
        try {
          process.kill(pid, 0)
        } catch {
          running = false
          break
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      if (running) throw new Error('Local service is still stopping; retry shortly')
    } else throw new Error('Recorded process is not responding as this service; inspect manually')
  }
  await unlink(pidFile).catch(() => {})
  console.log('Local application stopped; data preserved')
} else {
  if (running) {
    console.log('Local application is already running: http://localhost:3000')
    process.exit(0)
  }
  await mkdir('.local', { recursive: true })
  const log = await open('.local/server.log', 'a', 0o600)
  const child = spawn(process.execPath, ['--env-file=.env', 'apps/api/src/server.mjs'], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
  })
  child.unref()
  await writeFile(pidFile, String(child.pid), { mode: 0o600 })
  await log.close()
  let ready = false
  for (let n = 0; n < 30; n++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const r = await fetch('http://localhost:3000/health/ready')
      if (r.ok) {
        ready = true
        break
      }
    } catch {}
  }
  if (!ready) throw new Error('Application did not become ready. See .local/server.log')
  console.log('Ready: http://localhost:3000')
}
