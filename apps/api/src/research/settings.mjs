import { z } from 'zod'
import { fail } from '../db.mjs'
import { configKey, encryptConfig, decryptConfig } from '../operations/security.mjs'
export async function loadSearchSettings(db, tenantId, env) {
  const row = (
    await db.query('SELECT encrypted_config FROM research_settings WHERE tenant_id=$1', [tenantId])
  ).rows[0]
  return row
    ? decryptConfig(row.encrypted_config, await configKey(env), tenantId)
    : { provider: 'tavily', apiKey: '' }
}
export function registerSearchSettings(app, { scoped, env }) {
  const root = '/api/tenants/:tenantId/research/settings'
  app.get(root, (req) =>
    scoped(
      req,
      async (db, t, c) => {
        const value = await loadSearchSettings(db, c.tenantId, env)
        return { provider: value.provider, keySet: !!value.apiKey }
      },
      ['owner', 'admin'],
    ),
  )
  app.put(root, (req) =>
    scoped(
      req,
      async (db, t, c) => {
        const input = z
          .object({
            provider: z.enum(['tavily', 'brave']),
            apiKey: z.string().trim().max(4096).optional(),
            clear: z.boolean().default(false),
          })
          .strict()
          .parse(req.body)
        await db.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [c.tenantId])
        const old = await loadSearchSettings(db, c.tenantId, env)
        const apiKey = input.clear
          ? ''
          : input.apiKey || (old.provider === input.provider ? old.apiKey : '')
        if (!apiKey && !input.clear) throw fail(400, '请填写搜索服务 API Key')
        await db.query(
          'INSERT INTO research_settings(tenant_id,encrypted_config) VALUES($1,$2) ON CONFLICT(tenant_id) DO UPDATE SET encrypted_config=$2,updated_at=now()',
          [
            c.tenantId,
            encryptConfig({ provider: input.provider, apiKey }, await configKey(env), c.tenantId),
          ],
        )
        return { provider: input.provider, keySet: !!apiKey }
      },
      ['owner', 'admin'],
    ),
  )
}
