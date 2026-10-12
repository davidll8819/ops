import { isIP } from 'node:net'
import { fail } from '../db.mjs'
import { publicURL } from '../research/web.mjs'

const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

function parseURL(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      throw new Error('Invalid media URL')
    return url
  } catch {
    throw fail(502, '运营服务返回的素材地址无效，请检查素材存储配置')
  }
}

function loopback(url) {
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  return host === 'localhost' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'))
}

function localBinding(entry) {
  try {
    return loopback(parseURL(entry.serverUrl)) && loopback(parseURL(entry.aiUrl))
  } catch {
    return false
  }
}

function privateUploadHost(url) {
  if (loopback(url)) return true
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  if (isIP(host) !== 4) return false
  const [a, b] = host.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function publicMediaURL(value, allowHttp = false) {
  const url = parseURL(value)
  try {
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      !host.includes('.') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      (url.protocol !== 'https:' && !allowHttp)
    )
      throw new Error('Not a public media URL')
    publicURL(url.href)
    // Keep signatures and the runtime's configured URL intact; this is not a read probe.
    return value
  } catch {
    throw fail(502, '运营素材缺少模型可读取的公网地址，请检查素材域名和读取权限配置')
  }
}

function uploadURL(value, entry) {
  const url = parseURL(value)
  if (localBinding(entry) && privateUploadHost(url)) return url.href
  return publicMediaURL(value)
}

function imageInput(item) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    item.content?.image_url?.url || '',
  )
  if (!match) throw fail(400, '运营图片附件格式无效，请重新选择图片')
  const [, mime, base64] = match
  const bytes = Buffer.from(base64, 'base64')
  if (!bytes.length || bytes.toString('base64') !== base64)
    throw fail(400, '运营图片附件编码无效，请重新选择图片')
  const stem =
    String(item.name || item.id || 'reference')
      .replace(/\.[^.]*$/, '')
      .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '_')
      .slice(0, 96) || 'reference'
  return { bytes, mime, filename: `${stem}.${extensions[mime]}` }
}

// Attachments have already passed tenant/user access checks in attachmentContext.
// Uploading a copy does not submit an Agent task or change any storage permissions.
export async function prepareOperationsAttachments({
  driver,
  entry,
  attachments,
  fetcher = fetch,
}) {
  const items = attachments?.items || []
  if (!Array.isArray(items) || items.length > 4) throw fail(400, '每次最多使用 4 个附件')
  const prepared = items.map((item) => {
    if (item.content?.type === 'text' && typeof item.content.text === 'string')
      return { content: { type: 'text', text: item.content.text } }
    if (item.content?.type !== 'image_url') throw fail(400, '运营任务不支持此附件类型')
    return imageInput(item)
  })
  if (
    prepared.reduce(
      (total, item) => total + (item.bytes?.length || Buffer.byteLength(item.content.text)),
      0,
    ) >
    8 * 1024 * 1024
  )
    throw fail(400, '附件总大小不能超过 8 MB')

  const blocks = []
  for (const item of prepared) {
    if (item.content) {
      blocks.push(item.content)
      continue
    }
    const signed = await driver.request(entry, 'server', '/assets/uploadSign', {
      method: 'POST',
      body: { filename: item.filename, type: 'userMedia', size: item.bytes.length },
    })
    if (typeof signed?.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(signed.id))
      throw fail(502, '运营服务未返回有效的素材标识')
    const allowHttp = process.env.NODE_ENV !== 'production' && localBinding(entry)
    // Fail before uploading when the runtime only supplies an internal/browser-login URL.
    const mediaURL = publicMediaURL(signed.url, allowHttp)
    const putURL = uploadURL(signed.uploadUrl, entry)
    let response
    try {
      response = await fetcher(putURL, {
        method: 'PUT',
        body: item.bytes,
        headers: { 'content-type': item.mime, 'content-length': String(item.bytes.length) },
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      })
      if (!response.ok || response.redirected) throw new Error('Upload rejected')
    } catch {
      throw fail(502, '运营素材上传未完成，请检查素材存储配置后重试；任务尚未提交')
    } finally {
      await response?.body?.cancel().catch(() => {})
    }
    const confirmed = await driver.request(entry, 'server', `/assets/${signed.id}/confirm`, {
      method: 'POST',
      body: {},
    })
    if (
      confirmed?.id !== signed.id ||
      confirmed.status !== 'confirmed' ||
      confirmed.userId !== entry.userId
    )
      throw fail(502, '运营服务尚未确认该企业的素材上传，任务尚未提交')
    const confirmedURL = publicMediaURL(confirmed.url, allowHttp)
    if (confirmedURL !== mediaURL) throw fail(502, '运营素材确认地址不一致，任务尚未提交')
    blocks.push({ type: 'image', source: { type: 'url', url: confirmedURL } })
  }
  return blocks
}
