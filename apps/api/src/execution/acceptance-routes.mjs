import { z } from 'zod'
import { projectRoles } from './project-store.mjs'
import {
  readAcceptance,
  saveAcceptance,
  checkAcceptance,
  confirmDelivery,
  listDeliveries,
  ownedDelivery,
} from './acceptance-service.mjs'
import { productZip } from './deliverables.mjs'

const uuid = z.string().uuid()
const revision = z.number().int().nonnegative()
export function registerAcceptanceRoutes(app, { scoped, previews }) {
  const root = '/api/tenants/:tenantId/employees/code-agent/projects/:projectId'
  const inProject = (req, callback, roles) =>
    scoped(
      req,
      (db, _tenant, ctx) => callback(db, { ...ctx, projectId: uuid.parse(req.params.projectId) }),
      roles,
    )
  const draftRoot = `${root}/versions/:versionId/acceptance`
  app.get(draftRoot, (req) =>
    inProject(req, async (db, ctx) => ({
      acceptance: await readAcceptance(db, ctx, uuid.parse(req.params.versionId)),
    })),
  )
  app.put(draftRoot, { bodyLimit: 256 * 1024 }, (req) =>
    inProject(
      req,
      async (db, ctx) => ({
        acceptance: await saveAcceptance(db, ctx, uuid.parse(req.params.versionId), req.body),
      }),
      projectRoles,
    ),
  )
  app.post(`${draftRoot}/check`, (req) =>
    inProject(
      req,
      async (db, ctx) => {
        const data = z.object({ revision }).strict().parse(req.body)
        return {
          acceptance: await checkAcceptance(
            db,
            ctx,
            uuid.parse(req.params.versionId),
            data.revision,
          ),
        }
      },
      projectRoles,
    ),
  )
  app.post(`${root}/deliveries`, (req) =>
    inProject(
      req,
      async (db, ctx) => {
        const data = z
          .object({
            versionId: uuid,
            acceptanceRevision: revision,
            testRunId: uuid,
            label: z.string().trim().min(1).max(80),
          })
          .strict()
          .parse(req.body)
        return {
          delivery: await confirmDelivery(
            db,
            ctx,
            data.versionId,
            data.acceptanceRevision,
            data.label,
            data.testRunId,
          ),
        }
      },
      projectRoles,
    ),
  )
  app.get(`${root}/deliveries`, (req) =>
    inProject(req, async (db, ctx) => ({ deliveries: await listDeliveries(db, ctx) })),
  )
  app.get(`${root}/deliveries/:deliveryId`, (req) =>
    inProject(req, async (db, ctx) => ({
      delivery: (await ownedDelivery(db, ctx, uuid.parse(req.params.deliveryId))).delivery,
    })),
  )
  app.post(`${root}/deliveries/:deliveryId/preview`, (req) =>
    inProject(req, async (db, ctx) => {
      z.object({}).strict().parse(req.body)
      const { delivery, snapshot } = await ownedDelivery(db, ctx, uuid.parse(req.params.deliveryId))
      return {
        ...previews.issue(ctx, snapshot, delivery.entry),
        projectId: ctx.projectId,
        versionId: delivery.versionId,
      }
    }),
  )
  app.get(`${root}/deliveries/:deliveryId/download`, async (req, reply) => {
    const bytes = await inProject(req, async (db, ctx) => {
      const { delivery, snapshot } = await ownedDelivery(db, ctx, uuid.parse(req.params.deliveryId))
      return productZip(snapshot, delivery.entry, delivery)
    })
    return reply
      .type('application/zip')
      .header('content-disposition', 'attachment; filename="dragon-delivery.zip"')
      .send(bytes)
  })
}
