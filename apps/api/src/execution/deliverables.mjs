import { randomBytes } from 'node:crypto'
import yazl from 'yazl'
import { validateFiles, validatePath } from '../../../execution/files.mjs'

const mimeTypes = Object.freeze({
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
})
const excludedDirectories = new Set([
  'node_modules',
  'test',
  'tests',
  '__tests__',
  'server',
  'backend',
  'logs',
])
const extension = (path) => path.split('.').at(-1).toLowerCase()
const isHtml = (path) => /\.html?$/i.test(path)
const fail = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode, expose: true })
const encodedPath = (path) => path.split('/').map(encodeURIComponent).join('/')
const htmlEscape = (value) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  )

function utf8(file) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(file.contentBase64, 'base64'),
    )
  } catch {
    return null
  }
}

/** Files are still a validated workspace snapshot; only browser-deliverable assets leave it. */
export function deliveryFiles(files) {
  return validateFiles(files).filter((file) => {
    const parts = file.path.toLowerCase().split('/')
    const name = parts.at(-1)
    return (
      Object.hasOwn(mimeTypes, extension(file.path)) &&
      !parts.some((part) => part.startsWith('.')) &&
      !parts.slice(0, -1).some((part) => excludedDirectories.has(part)) &&
      !/^(?:package(?:-lock)?\.json|server\.(?:m?js))$/.test(name) &&
      !/\.(?:test|spec)\./.test(name) &&
      (!isHtml(file.path) || utf8(file) !== null)
    )
  })
}

function titleOf(file) {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(utf8(file))?.[1] || ''
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  const decoded = title.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (match, entity) => {
      if (entity[0] !== '#') return entities[entity.toLowerCase()]
      const code = /^#x/i.test(entity)
        ? Number.parseInt(entity.slice(2), 16)
        : Number(entity.slice(1))
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : match
    },
  )
  const plain = decoded
    .replace(/<[^>]*>/g, '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return [...(plain || file.path)].slice(0, 80).join('')
}

function entriesOf(files) {
  return files
    .filter((file) => isHtml(file.path))
    .map((file) => ({
      path: file.path,
      title: titleOf(file),
      size: Buffer.from(file.contentBase64, 'base64').length,
    }))
    .sort((a, b) => {
      const aIndex = /^index\.html?$/i.test(a.path)
      const bIndex = /^index\.html?$/i.test(b.path)
      return Number(bIndex) - Number(aIndex) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    })
}

export function listDeliverables(snapshot) {
  if (!snapshot) return { workspace: null, entries: [] }
  return {
    workspace: {
      name: snapshot.name,
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      activeRunId: snapshot.activeRunId ?? null,
    },
    entries: entriesOf(deliveryFiles(snapshot.files)),
  }
}

function selection(snapshot, entry) {
  validatePath(entry)
  if (!isHtml(entry)) throw fail(400, '请选择 HTML 网页成果')
  if (!snapshot) throw fail(404, '未找到可交付的网页成果')
  const files = deliveryFiles(snapshot.files)
  const selected = entriesOf(files).find((item) => item.path === entry)
  if (!selected) throw fail(404, '未找到可交付的网页成果')
  return { files, selected }
}

export function createPreviewStore({
  now = Date.now,
  ttlMs = 900000,
  maxSessions = 16,
  maxBytes = 64 * 1024 * 1024,
} = {}) {
  if (
    typeof now !== 'function' ||
    ![ttlMs, maxSessions, maxBytes].every((value) => Number.isSafeInteger(value) && value > 0)
  )
    throw new TypeError('预览容量和有效期必须为正整数')
  const sessions = new Map()
  let totalBytes = 0
  const remove = (token) => {
    const session = sessions.get(token)
    if (!session) return
    totalBytes -= session.bytes
    sessions.delete(token)
  }
  return {
    issue(ctx, snapshot, entry) {
      const { files, selected } = selection(snapshot, entry)
      const assets = new Map(
        files.map((file) => [file.path, Buffer.from(file.contentBase64, 'base64')]),
      )
      const bytes = [...assets.values()].reduce((total, buffer) => total + buffer.length, 0)
      if (bytes > maxBytes) throw fail(413, '网页成果超出预览容量，请下载后查看')
      const current = now()
      for (const [token, session] of sessions) if (session.deadline <= current) remove(token)
      const owned = [...sessions].filter(([, session]) => session.ctx.userId === ctx.userId)
      while (owned.length >= 2) remove(owned.shift()[0])
      while (sessions.size >= maxSessions || totalBytes + bytes > maxBytes)
        remove(sessions.keys().next().value)
      const token = randomBytes(32).toString('base64url')
      const deadline = current + ttlMs
      const expiresAt = new Date(deadline).toISOString()
      sessions.set(token, {
        ctx: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          ...(snapshot.projectId ? { projectId: snapshot.projectId } : {}),
          ...(snapshot.versionId ? { versionId: snapshot.versionId } : {}),
        },
        assets,
        bytes,
        deadline,
        expiresAt,
        entry,
        title: selected.title,
      })
      totalBytes += bytes
      return {
        url: `/project-preview/${token}/${encodedPath(entry)}`,
        expiresAt,
        revision: snapshot.revision,
        title: selected.title,
        entry,
      }
    },
    lookup(token, path) {
      const session = sessions.get(token)
      if (!session) throw fail(404, '未找到该预览')
      if (session.deadline <= now()) {
        remove(token)
        throw fail(410, '预览已过期，请重新打开')
      }
      // Fastify has already decoded route parameters once. Never decode or normalize again.
      try {
        validatePath(path)
      } catch {
        throw fail(404, '未找到预览文件')
      }
      const buffer = session.assets.get(path)
      if (!buffer) throw fail(404, '未找到预览文件')
      return {
        ctx: { ...session.ctx },
        buffer: Buffer.from(buffer),
        mime: mimeTypes[extension(path)],
        entry: session.entry,
        title: session.title,
        expiresAt: session.expiresAt,
        token,
      }
    },
  }
}

export function previewHeaders({ origin, token }) {
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol) || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw fail(400, '预览地址无效')
  const prefix = `${url.origin}/project-preview/${token}/`
  return {
    'content-security-policy': [
      "default-src 'none'",
      'sandbox allow-scripts',
      `script-src ${prefix} 'unsafe-inline'`,
      `style-src ${prefix} 'unsafe-inline'`,
      `img-src ${prefix} data:`,
      `media-src ${prefix} data:`,
      `font-src ${prefix} data:`,
      "connect-src 'none'",
      "worker-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join('; '),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'cross-origin-resource-policy': 'cross-origin',
    'access-control-allow-origin': '*',
  }
}

export async function productZip(snapshot, entry, delivery = null) {
  const { files, selected } = selection(snapshot, entry)
  const target = htmlEscape(`website/${encodedPath(entry)}`)
  const launcher = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(selected.title)}</title><meta http-equiv="refresh" content="0; url=${target}"></head>
<body><p><a href="${target}">打开作品：${htmlEscape(selected.title)}</a></p><p>若网页没有正常显示，请阅读“使用说明.txt”。</p></body></html>
`
  const guide = `网页成果使用说明

1. 先将整个 ZIP 文件解压到同一个文件夹，不要直接在压缩包内打开网页。
2. 双击“打开作品.html”，即可进入所选作品。website 文件夹保存网页及其静态资源，请保持目录结构。
3. 本成果包只包含可交付的网页文件；网页运行所需的外部服务需另行配置。
4. 部分浏览器限制本地文件使用 JavaScript 模块。如果模块无法加载，可安装 Python，在解压目录打开终端并运行：
   python -m http.server 8000 --bind 127.0.0.1
   然后用浏览器访问 http://127.0.0.1:8000/打开作品.html 。结束后在终端按 Ctrl+C 停止服务。
`
  const zip = new yazl.ZipFile()
  const output = new Promise((resolve, reject) => {
    const chunks = []
    zip.on('error', reject)
    zip.outputStream.on('error', reject)
    zip.outputStream.on('data', (chunk) => chunks.push(chunk))
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
  })
  zip.addBuffer(Buffer.from(launcher), '打开作品.html')
  zip.addBuffer(Buffer.from(guide), '使用说明.txt')
  if (delivery) {
    const explanation = `正式交付：${delivery.label}\n版本：${delivery.versionId}\n\n使用说明\n${delivery.instructions}\n\n已知限制\n${delivery.limitations}\n\n验收来源：用户试玩确认；系统文件检查仅说明文件与静态成果包可用，不代表功能、浏览器兼容性或玩法正确。\n`
    const test = delivery.automatedTest
    const automatic = test ? `\n自动测试\n记录：${test.id}\n版本文件 SHA256：${test.snapshotSha256}\n状态：${test.state}\n用例：${test.counts?.tests ?? '未知'}；通过：${test.counts?.passed ?? '未知'}；失败：${test.counts?.failed ?? '未知'}\n退出码：${test.exitCode ?? '未确认'}\n开始：${test.startedAt}\n结束：${test.finishedAt}\n命令：${test.command}\n${test.detail}\n完整结果与日志见“验收记录.json”。自动测试只证明本版本已有用例的结果，不替代人工试玩或浏览器兼容性测试。\n` : '\n此历史交付无自动测试记录。\n'
    zip.addBuffer(Buffer.from(explanation + automatic), '交付说明.txt')
    zip.addBuffer(Buffer.from(JSON.stringify(delivery, null, 2)), '验收记录.json')
  }
  for (const file of files)
    zip.addBuffer(Buffer.from(file.contentBase64, 'base64'), `website/${file.path}`)
  zip.end()
  return output
}
