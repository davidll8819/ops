export const FILE_LIMITS = Object.freeze({
  count: 200,
  fileBytes: 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
})

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400, expose: true })
}

export function validatePath(path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 512 ||
    path !== path.normalize('NFC') ||
    /[\\:\x00-\x1f\x7f]/.test(path) ||
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          Buffer.byteLength(part) > 255 ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw invalid('文件路径必须是规范的安全相对路径')
  return path
}

export function validateFiles(files) {
  if (!Array.isArray(files) || files.length > FILE_LIMITS.count)
    throw invalid('工作区最多保存 200 个文件')
  const paths = new Set()
  let total = 0
  for (const file of files) {
    if (
      !file ||
      typeof file !== 'object' ||
      Array.isArray(file) ||
      Object.keys(file).length !== 2 ||
      !Object.hasOwn(file, 'path') ||
      !Object.hasOwn(file, 'contentBase64')
    )
      throw invalid('文件快照格式无效')
    const path = validatePath(file.path)
    const encoded = file.contentBase64
    if (
      typeof encoded !== 'string' ||
      encoded.length > Math.ceil(FILE_LIMITS.fileBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    )
      throw invalid('文件内容必须为有效 Base64，单文件不能超过 1 MiB')
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length > FILE_LIMITS.fileBytes || bytes.toString('base64') !== encoded)
      throw invalid('文件内容必须为有效 Base64，单文件不能超过 1 MiB')
    total += bytes.length
    if (total > FILE_LIMITS.totalBytes) throw invalid('工作区文件总量不能超过 8 MiB')
    if (paths.has(path)) throw invalid('工作区包含重复文件路径')
    paths.add(path)
  }
  for (const path of paths) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++)
      if (paths.has(parts.slice(0, i).join('/'))) throw invalid('文件路径与目录冲突')
  }
  return files
}
