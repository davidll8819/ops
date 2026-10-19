import { z } from 'zod'
import { createModelGateway, loadPolicy } from '../operations/gateway.mjs'
import { loadAssignedSkills, runWithSkills } from '../skill-runtime.mjs'
import { buildFilingContext, validateFilingResponse } from './filing.mjs'
import { readFiling, reserveFiling, completeFiling, failFiling } from './filing-store.mjs'

export function registerFilingRoutes(app, { scoped, pool, env, fetcher }) {
  const route = '/api/tenants/:tenantId/archive/documents/:fileId/filing',
    call = createModelGateway({ pool, env, fetcher })
  app.get(route, (req) =>
    scoped(req, async (db, _tenant, ctx) => ({
      suggestion: await readFiling(db, ctx, z.uuid().parse(req.params.fileId)),
    })),
  )
  app.post(route, async (req) => {
    const fileId = z.uuid().parse(req.params.fileId)
    z.object({}).strict().parse(req.body)
    const { ctx, reservation, policy, skills } = await scoped(req, async (db, _tenant, ctx) => {
      const reservation = await reserveFiling(db, ctx, fileId)
      return {
        ctx,
        reservation,
        ...(reservation.claimed
          ? {
              ...(await loadPolicy(db, ctx.tenantId, env)),
              skills: await loadAssignedSkills(db, ctx.tenantId, 'archive'),
            }
          : {}),
      }
    })
    if (!reservation.claimed) return { suggestion: reservation.suggestion }
    try {
      const context = buildFilingContext(reservation.document)
      const response = await runWithSkills({
        call,
        skills,
        ctx,
        policy,
        department: 'archive',
        allowFallback: false,
        path: '/api/v1/chat/completions',
        body: {
          messages: [
            { role: 'system', content: '你是资料室赵雅梦。' + skills.instructions },
            { role: 'system', content: context.instructions },
            { role: 'user', content: context.content },
          ],
          max_tokens: 3072,
        },
      })
      const value = validateFilingResponse(response.choices?.[0]?.message?.content, context)
      return await scoped(req, async (db, _tenant, current) => ({
        suggestion: await completeFiling(db, current, reservation, value),
      }))
    } catch (error) {
      // Preserve the original error. A revoked membership cannot authorize a cleanup write.
      await scoped(req, (db, _tenant, current) => failFiling(db, current, reservation)).catch(
        () => {},
      )
      throw error
    }
  })
}
