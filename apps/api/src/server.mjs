import { makePool } from './db.mjs'
import { connectCache } from './cache.mjs'
import { awsAgents } from './agents.mjs'
import { buildApp } from './app.mjs'
const pool = await makePool()
const cache = await connectCache(process.env.REDIS_URL)
const app = await buildApp({ pool, cache, agents: awsAgents(process.env) })
await app.listen({
  port: Number(process.env.PORT || 3000),
  host: process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1',
})
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    await app.close()
    await pool.end()
    await cache.quit()
    process.exit(0)
  })
