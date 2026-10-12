import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { isIP } from 'node:net'
import { fail } from '../db.mjs'
export function publicIPv4(ip) {
  if (isIP(ip) !== 4) return false
  const [a, b, c] = ip.split('.').map(Number)
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  )
}
export function publicURL(value) {
  const u = new URL(value)
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.port ||
    u.hostname === 'localhost' ||
    u.hostname.endsWith('.local') ||
    u.hostname.endsWith('.internal') ||
    (isIP(u.hostname) && !publicIPv4(u.hostname)) ||
    u.hostname.includes(':')
  )
    throw fail(400, '只允许读取公开网页')
  u.hash = ''
  return u
}
export async function resolvePublic(value, resolver = lookup) {
  const u = publicURL(value),
    addresses = await resolver(u.hostname, { all: true, family: 4 })
  if (!addresses.length || addresses.some((a) => !publicIPv4(a.address)))
    throw fail(400, '禁止访问本机或内部网络')
  return { u, address: addresses[0].address }
}
const clean = (s) =>
  String(s)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
// DNS is checked and pinned for each redirect; upstream credentials/cookies are never forwarded.
export async function readPublicPage(value, redirects = 0) {
  const { u, address } = await resolvePublic(value)
  const response = await new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      u,
      {
        headers: {
          'user-agent': 'AI-Office-Research/1.0',
          accept: 'text/html,text/plain',
          'accept-encoding': 'identity',
        },
        lookup: (_host, options, cb) =>
          cb(null, options.all ? [{ address, family: 4 }] : address, 4),
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          resolve({ redirect: new URL(res.headers.location, u).href })
          return
        }
        if (
          res.statusCode !== 200 ||
          !/^text\/(html|plain)/i.test(res.headers['content-type'] || '')
        ) {
          res.resume()
          reject(fail(502, '网页不支持读取或需要登录'))
          return
        }
        let size = 0
        const chunks = []
        res.on('data', (chunk) => {
          size += chunk.length
          if (size > 1048576) {
            req.destroy(fail(502, '网页过大，已停止读取'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () =>
          resolve({ url: u.href, text: clean(Buffer.concat(chunks).toString()).slice(0, 10000) }),
        )
        res.on('error', reject)
      },
    )
    const deadline = setTimeout(() => req.destroy(fail(504, '读取网页超时')), 15000)
    req.on('close', () => clearTimeout(deadline))
    req.on('error', reject)
    req.end()
  })
  if (response.redirect) {
    if (redirects >= 3) throw fail(502, '网页重定向次数过多')
    return readPublicPage(response.redirect, redirects + 1)
  }
  if (!response.text) throw fail(502, '网页没有可读取的正文')
  return response
}
async function jsonLimited(response) {
  if (!response.ok) {
    await response.body?.cancel()
    throw fail(502, '搜索服务未完成请求，请检查搜索密钥或额度')
  }
  let size = 0
  const chunks = []
  for await (const c of response.body) {
    size += c.length
    if (size > 2097152) throw fail(502, '搜索响应过大')
    chunks.push(c)
  }
  return JSON.parse(Buffer.concat(chunks).toString())
}
export function createWebTools(settings, { fetcher = fetch, reader = readPublicPage } = {}) {
  if (!settings.apiKey) throw fail(409, '请先在企业设置中配置联网搜索 API Key')
  let queries = 0,
    reads = 0
  const sources = new Map()
  return {
    sources,
    async search(query) {
      if (++queries > 3) throw fail(409, '本次任务已达到 3 次搜索上限')
      if (typeof query !== 'string' || !query.trim() || query.length > 300)
        throw fail(400, '搜索词不正确')
      let result
      try {
        const options = { redirect: 'error', signal: AbortSignal.timeout(20000) }
        if (settings.provider === 'brave') {
          result = await jsonLimited(
            await fetcher(
              `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
              { ...options, headers: { 'X-Subscription-Token': settings.apiKey } },
            ),
          )
          result = (result.web?.results || []).map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.description,
          }))
        } else {
          result = await jsonLimited(
            await fetcher('https://api.tavily.com/search', {
              ...options,
              method: 'POST',
              headers: {
                authorization: `Bearer ${settings.apiKey}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                query,
                search_depth: 'basic',
                max_results: 5,
                include_answer: false,
                include_raw_content: false,
              }),
            }),
          )
          result = (result.results || []).map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.content,
          }))
        }
      } catch (e) {
        if (e.expose) throw e
        throw fail(502, '联网搜索失败，请检查服务状态')
      }
      const found = []
      for (const item of result.slice(0, 5))
        try {
          const url = publicURL(item.url).href
          if (!sources.has(url))
            sources.set(url, {
              id: `S${sources.size + 1}`,
              url,
              title: String(item.title || url).slice(0, 200),
              snippet: clean(item.snippet || '').slice(0, 2000),
              retrievedAt: new Date().toISOString(),
              read: false,
            })
          found.push(sources.get(url))
        } catch {
          /* Ignore unsafe result URLs. */
        }
      return found
    },
    async read(url) {
      if (++reads > 6) throw fail(409, '本次任务已达到 6 次网页读取上限')
      const source = sources.get(publicURL(url).href)
      if (!source) throw fail(400, '只能读取本次搜索得到的网页')
      try {
        const page = await reader(source.url)
        source.read = true
        source.finalUrl = page.url
        source.readAt = new Date().toISOString()
        return { ...source, text: page.text }
      } catch (e) {
        throw fail(502, e.expose ? e.message : '网页读取失败')
      }
    },
  }
}
