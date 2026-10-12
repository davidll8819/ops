// Materialize a tenant's encrypted settings into a PRIVATE, operator-prepared runtime directory.
// Does not start containers, contact model providers, or publish anything.
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import { makePool, transaction } from '../apps/api/src/db.mjs'
import { configKey, decryptConfig } from '../apps/api/src/operations/security.mjs'
import { toPolicy, resolveDepartment } from '../apps/api/src/operations/policy.mjs'
import { resolveSecrets } from '../apps/api/src/operations/credentials.mjs'
import { z } from 'zod'
const tenantId = z.uuid().parse(process.argv[2])
const output = resolve('.local/operations', tenantId)
if (!process.env.OPERATIONS_RUNTIMES_FILE) throw new Error('Set OPERATIONS_RUNTIMES_FILE to the private runtime registry')
const registry = JSON.parse(await readFile(process.env.OPERATIONS_RUNTIMES_FILE, 'utf8'))
const entry = registry[tenantId]
if (!entry?.bridgeSecret || !entry?.jwtSecret || !entry?.internalToken || !entry?.infrastructure) throw new Error('Prepare a dedicated runtime registry entry first')
for (const [id, other] of Object.entries(registry)) {
  if (id !== tenantId && (other.serverUrl === entry.serverUrl || other.aiUrl === entry.aiUrl || other.infrastructure?.mongodb?.dbName === entry.infrastructure.mongodb?.dbName)) throw new Error('Shared tenant runtime/database rejected')
}
const pool = await makePool()
try {
  const row = await transaction(pool, async db => (await db.query('SELECT * FROM operations_settings WHERE tenant_id=$1', [tenantId])).rows[0], { tenantId, userId: '' })
  if (!row) throw new Error('Save this tenant configuration in Office Settings first')
  const stored = decryptConfig(row.encrypted_config, await configKey(process.env), tenantId)
  const value = toPolicy(stored)
  resolveDepartment(value, 'content_ops')
  const secrets = resolveSecrets(stored,process.env,tenantId)
  await mkdir(output, { recursive: true, mode: 0o700 }); await chmod(output, 0o700)
  for (const service of ['server', 'ai']) {
    const template = `integrations/aitoearn/source/project/aitoearn-backend/apps/aitoearn-${service}/config/config.yaml.example`
    const config = parse(await readFile(template, 'utf8'))
    const infra = entry.infrastructure
    for (const field of ['mongodb', 'redis', 'redlock', 'assets']) {
      if (!infra[field]) throw new Error(`Missing infrastructure ${field}`)
      config[field] = infra[field]
    }
    config.auth = { secret: '${OFFICE_JWT_SECRET}', internalToken: '${OFFICE_INTERNAL_TOKEN}' }
    config.officeBridge = { tenantId, revision: row.revision, secret: '${OFFICE_BRIDGE_SECRET}', officeOrigin: entry.officeOrigin || process.env.APP_ORIGIN }
    config.enableConfigLogging = false; config.enableBadRequestDetails = false
    config.logger = { console: { enable: true, level: 'warn' } }
    if (service === 'server') {
      config.aiClient = { baseUrl: entry.privateAiUrl || entry.aiUrl, token: '${OFFICE_INTERNAL_TOKEN}' }
      if (!infra.channelDb) throw new Error('Missing dedicated channelDb')
      config.channel.channelDb = infra.channelDb
      if (secrets.relay && !entry.relayCallbackUrl) throw new Error('Prepare a verified Relay callback before enabling account binding')
      if (entry.relayCallbackUrl) {
        config.relay = { serverUrl: value.aitoearn.region === 'china' ? 'https://aitoearn.cn/api' : 'https://aitoearn.ai/api', apiKey: '', callbackUrl: entry.relayCallbackUrl }
      } else delete config.relay
    } else {
      config.serverClient.baseUrl = entry.privateServerUrl || entry.serverUrl
      config.ai.fouryi = { baseUrl: `${(entry.officeOrigin || process.env.APP_ORIGIN).replace(/\/$/,'')}/integrations/model-gateway/${tenantId}`, apiKey: '${OFFICE_MODEL_GATEWAY_TOKEN}', timeout: 300000 }
      config.agent.defaultModel = 'office-content-ops'
      config.agent.backgroundModel = 'office-content-ops'
      config.agent.thinkModel = 'office-content-ops'
      config.agent.models = ['office-content-ops']
    }
    const path = `${output}/${service}.yaml`
    await writeFile(path, stringify(config), { mode: 0o600 }); await chmod(path, 0o600)
  }
  console.log(JSON.stringify({ tenantId, revision: row.revision, directory: output, started: false }))
} finally { await pool.end() }
