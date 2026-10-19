import { createHash } from 'node:crypto'
import { validateFiles } from '../../../execution/files.mjs'

export function snapshotSha256(version) {
  const hash = createHash('sha256')
  // Frame paths and bytes independently to avoid boundary ambiguity.
  for (const file of [...validateFiles(version.files)].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const path = Buffer.from(file.path), content = Buffer.from(file.contentBase64, 'base64')
    hash.update(`${path.length}:`).update(path).update(`${content.length}:`).update(content)
  }
  return hash.digest('hex')
}
