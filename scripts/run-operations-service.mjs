// Run an ALREADY BUILT original service with keys injected into its environment.
// Example: node --env-file=.env scripts/run-operations-service.mjs <tenant UUID> ai
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { gatewayToken } from '../apps/api/src/operations/policy.mjs'
const tenantId = z.uuid().parse(process.argv[2]), service = z.enum(['ai','server']).parse(process.argv[3])
const registry = JSON.parse(await readFile(process.env.OPERATIONS_RUNTIMES_FILE,'utf8')), entry = registry[tenantId]
if (!entry?.bridgeSecret || !entry?.jwtSecret || !entry?.internalToken) throw new Error('Missing operator runtime binding')
const cwd = resolve('integrations/aitoearn/source/project/aitoearn-backend')
const child = spawn(process.execPath,[`dist/apps/aitoearn-${service}/main.js`,'--config',resolve('.local/operations',tenantId,`${service}.yaml`)],{
  cwd,stdio:'inherit',env:{ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH','HOME','TMPDIR','LANG','TZ','NODE_ENV'].includes(key))),OFFICE_JWT_SECRET:entry.jwtSecret,OFFICE_INTERNAL_TOKEN:entry.internalToken,OFFICE_BRIDGE_SECRET:entry.bridgeSecret,OFFICE_MODEL_GATEWAY_TOKEN:gatewayToken(entry.bridgeSecret,tenantId),FOURYI_API_KEY_FILE:'',SERVER_RELAY_API_KEY_FILE:'' },
})
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,() => child.kill(signal))
child.on('exit',code => { process.exitCode = code ?? 1 })
