import yauzl from 'yauzl'
import { parseDocument } from 'yaml'
import { crc32 } from 'node:zlib'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { fail } from './db.mjs'

export const MAX_PACKAGE = 6 * 1024 * 1024
const MAX_EXPANDED = 30 * 1024 * 1024
const MAX_FILES = 200
const input = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^/\\\x00-\x1f]+\.(md|zip)$/i),
    kind: z.enum(['capability', 'workflow']),
    contentBase64: z
      .string()
      .min(4)
      .max(Math.ceil(MAX_PACKAGE / 3) * 4),
  })
  .strict()
const invalid = () => fail(400, '技能包格式无效，请检查文件后重试')

/** Inspect bytes in memory. No extraction, shell, imports or script execution. */
export async function zipFiles(buffer, { select = (path) => path, maxFiles = MAX_FILES } = {}) {
  const zip = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (e, z) => (e ? reject(e) : resolve(z)),
    )
  })
  const files = new Map(),
    seen = new Set()
  let total = 0,
    count = 0,
    scanned = 0
  try {
    for await (const entry of zip.eachEntry()) {
      if (++scanned > 100000) throw invalid()
      const selectedPath = select(entry.fileName)
      if (selectedPath === null) continue
      const path = selectedPath.normalize('NFC')
      const parts = path.replace(/\/$/, '').split('/')
      const type = (entry.externalFileAttributes >>> 16) & 0xf000
      if (
        ++count > maxFiles ||
        !path ||
        path.length > 240 ||
        /[\\:\x00-\x1f]/.test(path) ||
        path.startsWith('/') ||
        parts.some((p) => !p || p === '.' || p === '..') ||
        seen.has(path.toLowerCase()) ||
        entry.isEncrypted() ||
        (type && type !== 0x8000 && type !== 0x4000)
      )
        throw invalid()
      seen.add(path.toLowerCase())
      if (path.endsWith('/')) continue
      // macOS packaging metadata is ignored, after checking paths and entry types.
      if (parts[0] === '__MACOSX' || parts.at(-1) === '.DS_Store') continue
      if (
        entry.uncompressedSize > 10 * 1024 * 1024 ||
        total + entry.uncompressedSize > MAX_EXPANDED
      )
        throw fail(413, '技能包解压后过大或文件过多')
      const stream = await zip.openReadStreamPromise(entry)
      const chunks = []
      let bytes = 0,
        checksum = 0
      for await (const chunk of stream) {
        bytes += chunk.length
        total += chunk.length
        if (bytes > 10 * 1024 * 1024 || total > MAX_EXPANDED) {
          stream.destroy()
          throw fail(413, '技能包解压后过大或文件过多')
        }
        checksum = crc32(chunk, checksum)
        chunks.push(chunk)
      }
      if (checksum !== entry.crc32 || bytes !== entry.uncompressedSize) throw invalid()
      files.set(path, Buffer.concat(chunks))
    }
    if (!files.size) throw invalid()
    // No file may also be the parent directory of another file.
    const paths = new Set([...files.keys()].map((p) => p.toLowerCase()))
    for (const path of paths) {
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++)
        if (paths.has(parts.slice(0, i).join('/'))) throw invalid()
    }
    return { files, expandedBytes: total }
  } catch (e) {
    if (e.statusCode) throw e
    throw invalid()
  } finally {
    zip.close()
  }
}

export async function inspectSkillUpload(body) {
  const data = input.parse(body)
  if (data.contentBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.contentBase64))
    throw invalid()
  const buffer = Buffer.from(data.contentBase64, 'base64')
  if (buffer.toString('base64') !== data.contentBase64) throw invalid()
  if (!buffer.length || buffer.length > MAX_PACKAGE) throw fail(413, '上传文件不能超过 6 MB')
  const format = data.filename.toLowerCase().endsWith('.zip') ? 'zip' : 'md'
  let result
  try {
    result =
      format === 'zip'
        ? await zipFiles(buffer)
        : { files: new Map([['SKILL.md', buffer]]), expandedBytes: buffer.length }
  } catch (e) {
    if (e.statusCode) throw e
    throw invalid()
  }
  const entries = [...result.files.keys()].filter((p) => p.split('/').at(-1) === 'SKILL.md')
  if (entries.length !== 1) throw fail(400, '每次请上传一个技能，ZIP 内必须只有一份 SKILL.md')
  const skillFile = entries[0],
    bytes = result.files.get(skillFile)
  if (bytes.length > 512 * 1024) throw fail(413, 'SKILL.md 不能超过 512 KB')
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw invalid()
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text)
  if (!match || match[1].length > 16384 || !match[2].trim())
    throw fail(400, 'SKILL.md 需要名称、说明和正文，请参考示例格式')
  let metadata
  try {
    const doc = parseDocument(match[1], { schema: 'core', uniqueKeys: true })
    if (doc.errors.length) throw invalid()
    metadata = doc.toJS({ maxAliasCount: 0 })
  } catch {
    throw invalid()
  }
  const parsed = z
    .object({
      name: z
        .string()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .max(64),
      description: z.string().trim().min(1).max(2000),
      version: z.union([z.string(), z.number()]).optional(),
    })
    .safeParse(metadata)
  if (!parsed.success)
    throw fail(400, '技能名称需使用小写英文、数字和连字符，并填写 description 说明')
  const version = String(parsed.data.version ?? '1.0.0')
  if (!version || version.length > 64) throw invalid()
  return {
    ...parsed.data,
    version,
    kind: data.kind,
    filename: data.filename,
    format,
    buffer,
    skillFile,
    fileCount: result.files.size,
    expandedBytes: result.expandedBytes,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

const columns =
  'id,name,description,version,kind,filename,format,sha256,skill_file,file_count,expanded_bytes,octet_length(package_data) AS package_bytes,created_at,catalog_id,catalog_source,provenance'
const present = (row) => ({ ...row, status: 'installed', runtimeReady: false })
export async function listInstalledSkills(db, tenantId) {
  return {
    items: (
      await db.query(
        `SELECT ${columns} FROM installed_skills WHERE tenant_id=$1 ORDER BY created_at DESC,id`,
        [tenantId],
      )
    ).rows.map(present),
  }
}
export async function installUploadedSkill(db, ctx, upload) {
  // Tenant lock makes name and storage quota checks atomic across simultaneous uploads.
  await db.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [ctx.tenantId])
  if (upload.catalogId) {
    const existing = await db.query(
      `SELECT ${columns} FROM installed_skills WHERE tenant_id=$1 AND catalog_id=$2`,
      [ctx.tenantId, upload.catalogId],
    )
    if (existing.rows.length) return { skill: present(existing.rows[0]), alreadyInstalled: true }
  }
  const {
    rows: [stats],
  } = await db.query(
    'SELECT count(*)::int AS count,coalesce(sum(octet_length(package_data)),0)::bigint AS bytes FROM installed_skills WHERE tenant_id=$1',
    [ctx.tenantId],
  )
  if (stats.count >= 100 || Number(stats.bytes) + upload.buffer.length > 100 * 1024 * 1024)
    throw fail(409, '当前企业的技能存储空间已满')
  const { rows } = await db.query(
    `INSERT INTO installed_skills(id,tenant_id,name,description,version,kind,filename,format,sha256,skill_file,file_count,expanded_bytes,package_data,created_by,catalog_id,catalog_source,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT DO NOTHING RETURNING ${columns}`,
    [
      randomUUID(),
      ctx.tenantId,
      upload.name,
      upload.description,
      upload.version,
      upload.kind,
      upload.filename,
      upload.format,
      upload.sha256,
      upload.skillFile,
      upload.fileCount,
      upload.expandedBytes,
      upload.buffer,
      ctx.userId,
      upload.catalogId || null,
      upload.catalogSource || null,
      JSON.stringify(upload.provenance || {}),
    ],
  )
  if (!rows.length) throw fail(409, '同名技能已安装，请修改技能名称；原技能不会被覆盖')
  await db.query(
    'INSERT INTO audit_events(id,tenant_id,user_id,action,target_id) VALUES($1,$2,$3,$4,$5)',
    [
      randomUUID(),
      ctx.tenantId,
      ctx.userId,
      upload.catalogId ? 'skill.catalog-installed' : 'skill.upload-installed',
      rows[0].id,
    ],
  )
  return { skill: present(rows[0]) }
}
