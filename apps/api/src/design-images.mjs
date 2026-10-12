import { withAttachments } from './task-assets.mjs'
import { resolveCapability } from './operations/policy.mjs'
import { request } from 'node:https'
import { resolvePublic } from './research/web.mjs'
import { fail } from './db.mjs'
const MAX_IMAGE = 6 * 1024 * 1024
export function needsDesignImage(task) {
  if (task.dept !== 'new-agent-7') return false
  const title = task.title || ''
  const text = `${title}\n${task.request || task.summary || ''}`
  if (
    /仅(?:需|要)?(?:文字|文案|提示词|设计说明)|只(?:需|要)?(?:写|提供|输出)?(?:文字|提示词|设计说明)|text[- ]only|prompt only/i.test(
      title,
    )
  )
    return false
  return /图片|生图|画图|绘制|插画|海报|视觉稿|参考图|设计稿|封面|配图|静态图|logo|illustration|poster|image|artwork|cover design/i.test(
    text,
  )
}
export function imageBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.length > MAX_IMAGE)
    throw fail(502, '图片文件为空、无效或超过 6 MB')
  let mime, ext
  if (
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    bytes.subarray(12, 16).toString() === 'IHDR'
  ) {
    mime = 'image/png'
    ext = 'png'
  } else if (
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  ) {
    mime = 'image/jpeg'
    ext = 'jpg'
  } else if (
    bytes.subarray(0, 4).toString() === 'RIFF' &&
    bytes.subarray(8, 12).toString() === 'WEBP'
  ) {
    mime = 'image/webp'
    ext = 'webp'
  } else throw fail(502, '图片模型没有返回有效的 PNG、JPEG 或 WebP 文件')
  return { bytes, mime, ext }
}
// Only public HTTPS assets; no provider key or cookies are sent to asset hosts.
export async function downloadGeneratedImage(value, redirects = 0) {
  const { u, address } = await resolvePublic(value)
  if (u.protocol !== 'https:') throw fail(502, '图片地址必须使用 HTTPS')
  const result = await new Promise((resolve, reject) => {
    const req = request(
      u,
      {
        headers: { accept: 'image/png,image/jpeg,image/webp', 'accept-encoding': 'identity' },
        lookup: (_host, options, cb) =>
          cb(null, options.all ? [{ address, family: 4 }] : address, 4),
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          resolve({ redirect: new URL(res.headers.location, u).href })
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(fail(502, '生成图片暂时无法下载，请核对任务后重试'))
          return
        }
        let size = 0
        const chunks = []
        res.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_IMAGE) {
            req.destroy(fail(502, '生成图片超过 6 MB'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => resolve({ bytes: Buffer.concat(chunks) }))
        res.on('error', reject)
      },
    )
    const timer = setTimeout(() => req.destroy(fail(504, '生成图片下载超时')), 30000)
    req.on('close', () => clearTimeout(timer))
    req.on('error', reject)
    req.end()
  })
  if (result.redirect) {
    if (redirects >= 3) throw fail(502, '图片重定向次数过多')
    return downloadGeneratedImage(result.redirect, redirects + 1)
  }
  return imageBytes(result.bytes)
}
export async function generateDesignImage({
  call,
  ctx,
  policy,
  task,
  instructions = '',
  attachments,
  reader = downloadGeneratedImage,
}) {
  const imageModel = resolveCapability(policy, 'design', 'image').model
  const plan = await call({
    ctx,
    policy,
    department: 'design',
    path: '/api/v1/chat/completions',
    body: {
      messages: [
        {
          role: 'system',
          content: `你是设计部负责人。将用户的图片任务整理成一段可直接提交给图片模型的绘图提示词，保留用户指定的内容、文字、风格和比例。只输出提示词，不输出说明书，不声称已经生成图片。不擅自增加分辨率或承诺工具不支持的规格。${instructions}`,
        },
        { role: 'user', content: withAttachments(`${task.title}\n${task.request || task.summary}`,attachments) },
      ],
      max_tokens: 1200,
    },
  })
  const prompt = plan.choices?.[0]?.message?.content
  if (typeof prompt !== 'string' || !prompt.trim()) throw fail(502, '未能生成有效的图片提示词')
  const result = await call({
    ctx,
    policy,
    department: 'design',
    path: '/api/v1/images/generations',
    allowFallback: false,
    body: { prompt: prompt.slice(0, 16000), n: 1 },
  })
  const item = result.data?.[0]
  let asset
  if (typeof item?.b64_json === 'string') {
    if (
      item.b64_json.length > Math.ceil(MAX_IMAGE / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(item.b64_json)
    )
      throw fail(502, '图片模型返回的图片编码无效')
    const bytes = Buffer.from(item.b64_json, 'base64')
    if (bytes.toString('base64') !== item.b64_json) throw fail(502, '图片模型返回的图片编码无效')
    asset = imageBytes(bytes)
  } else if (typeof item?.url === 'string') asset = await reader(item.url)
  else throw fail(502, '图片模型未返回图片，任务尚未完成；请核对模型服务状态后重试')
  return { ...asset, prompt, model: imageModel }
}
