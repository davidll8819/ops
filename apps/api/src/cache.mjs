import { createClient } from 'redis'
export async function connectCache(url) {
  const client = createClient({
    url,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries) => (retries < 3 ? 500 : new Error('Redis unavailable')),
    },
  })
  client.on('error', () => {})
  await client.connect()
  return client
}
export async function throttle(cache, key, limit, seconds) {
  const count = Number(
    await cache.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
      { keys: [key], arguments: [String(seconds)] },
    ),
  )
  return count <= limit
}
