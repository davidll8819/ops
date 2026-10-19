import { z } from 'zod'
import { projectRoles } from './project-store.mjs'
import { createVersionTestService, versionTestHistory } from './version-tests.mjs'

export function registerVersionTestRoutes(app, { scoped, pool, driver }) {
  const service = createVersionTestService({ pool, driver })
  const root = '/api/tenants/:tenantId/employees/code-agent/projects/:projectId/versions/:versionId/acceptance/tests'
  const identifiers = (req, ctx) => ({ ...ctx, projectId: z.string().uuid().parse(req.params.projectId) })
  app.get(root, req => scoped(req, (db, _tenant, ctx) =>
    versionTestHistory(db, identifiers(req, ctx), z.string().uuid().parse(req.params.versionId))))
  app.post(root, async req => {
    const { requestId } = z.object({ requestId: z.string().uuid() }).strict().parse(req.body)
    const ctx = await scoped(req, (_db, _tenant, ctx) => identifiers(req, ctx), projectRoles)
    const versionId = z.string().uuid().parse(req.params.versionId)
    return { testRun: await service.run(ctx, versionId, requestId) }
  })
}
