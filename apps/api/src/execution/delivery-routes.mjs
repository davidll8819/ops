import { z } from 'zod'
import { transaction, tenantAccess, fail } from '../db.mjs'
import {
  createPreviewStore,
  listDeliverables,
  previewHeaders,
  productZip,
} from './deliverables.mjs'
import { projectRow, ownedVersion } from './project-store.mjs'

export function registerDeliveryRoutes(app, { scoped, service, pool, env }) {
  const root = '/api/tenants/:tenantId/employees/code-agent/workspace/deliverables'
  const previews = createPreviewStore()
  const origin = new URL(env.APP_ORIGIN).origin
  const context = (req) =>
    scoped(req, async (_db, _tenant, ctx) => ({
      ...ctx,
      ...(req.params.projectId ? { projectId: z.string().uuid().parse(req.params.projectId) } : {}),
    }))
  const entrySchema = z.string().min(1).max(512)
  const revisionSchema = z.number().int().nonnegative()
  const inputSchema = z.object({ entry: entrySchema, revision: revisionSchema }).strict()
  function current(snapshot, revision) {
    if (!snapshot) throw fail(404, '请先创建龙傲天项目工作区')
    if (snapshot.activeRunId) throw fail(409, '龙傲天正在更新项目，请完成后再打开或下载成果')
    if (snapshot.revision !== revision) throw fail(409, '项目已有新版本，请刷新成果后重试')
    return snapshot
  }
  const projectRoot = '/api/tenants/:tenantId/employees/code-agent/projects/:projectId'
  for (const deliveryRoot of [
    root,
    `${projectRoot}/workspace/deliverables`,
    `${projectRoot}/versions/:versionId/deliverables`,
  ]) {
    const snapshotFor = (ctx, req) =>
      req.params.versionId
        ? service.versionSnapshot(ctx, z.string().uuid().parse(req.params.versionId))
        : service.deliverySnapshot(ctx)
    const identity = (snapshot) =>
      snapshot
        ? {
            projectId: snapshot.projectId,
            ...(snapshot.versionId ? { versionId: snapshot.versionId } : {}),
          }
        : {}
    app.get(deliveryRoot, async (req) => {
      const snapshot = await snapshotFor(await context(req), req)
      return { ...listDeliverables(snapshot), ...identity(snapshot) }
    })
    app.post(`${deliveryRoot}/preview`, async (req) => {
      const ctx = await context(req)
      const { entry, revision } = inputSchema.parse(req.body)
      const snapshot = current(await snapshotFor(ctx, req), revision)
      return { ...previews.issue(ctx, snapshot, entry), ...identity(snapshot) }
    })
    app.get(`${deliveryRoot}/download`, async (req, reply) => {
      const ctx = await context(req)
      const { entry, revision } = z
        .object({ entry: entrySchema, revision: z.coerce.number().int().nonnegative() })
        .strict()
        .parse(req.query)
      const snapshot = current(await snapshotFor(ctx, req), revision)
      const bytes = await productZip(snapshot, entry)
      return reply
        .type('application/zip')
        .header('content-disposition', 'attachment; filename="dragon-product.zip"')
        .send(bytes)
    })
  }
  // This endpoint uses a short-lived, read-only snapshot capability because sandboxed
  // resource requests cannot use the office's SameSite session cookie. Never serve
  // application files or proxy arbitrary URLs from here.
  app.get('/project-preview/:token/*', { helmet: false }, async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'; sandbox")
    const asset = previews.lookup(req.params.token, req.params['*'])
    await transaction(
      pool,
      async (db) => {
        await tenantAccess(db, asset.ctx.userId, asset.ctx.tenantId)
        if (asset.ctx.projectId) await projectRow(db, asset.ctx)
        if (asset.ctx.versionId) await ownedVersion(db, asset.ctx, asset.ctx.versionId)
      },
      asset.ctx,
    )
    return reply
      .headers(previewHeaders({ origin, token: req.params.token }))
      .type(asset.mime)
      .send(asset.buffer)
  })
  return previews
}
