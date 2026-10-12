import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const root = new URL('../integrations/aitoearn/', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('source-manifest.json', root), 'utf8'))
const patched = new Set([
  'scripts/init.mjs',
  ...['relay-client.service.ts','relay-exception.filter.ts'].map(file => `project/aitoearn-backend/apps/aitoearn-server/src/core/channels/relay/${file}`),
  'project/aitoearn-backend/libs/common/src/utils/select-config.util.ts',
  'project/aitoearn-backend/libs/common/src/index.ts',
  ...['server','ai'].flatMap(service => ['main.ts','config.ts'].map(file => `project/aitoearn-backend/apps/aitoearn-${service}/src/${file}`)),
])
let unchanged = 0, modified = 0
for (const file of manifest.files) {
  const data = await readFile(new URL(`source/${file.path}`, root))
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual === file.sha256) unchanged++
  else if (patched.has(file.path)) modified++
  else throw new Error(`Unexpected upstream modification: ${file.path}`)
}
console.log(JSON.stringify({ sourceCommit: manifest.sourceCommit, sourceFiles: manifest.files.length, unchanged, bridgePatched: modified }))
