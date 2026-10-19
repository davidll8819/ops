import { z } from 'zod'
import { filingCategories } from './filing.mjs'
import {
  recordMetadata,
  recordRevision,
  readRecordDraft,
  saveRecordDraft,
  confirmRecord,
  readArchivedRecord,
  listArchivedRecords,
} from './records.mjs'
export function registerArchiveRecordRoutes(app, { scoped }) {
  const root = '/api/tenants/:tenantId/archive',
    draft = root + '/filings/:suggestionId/record'
  app.get(draft, (req) =>
    scoped(req, async (db, _t, ctx) => ({
      record: await readRecordDraft(db, ctx, z.uuid().parse(req.params.suggestionId)),
    })),
  )
  app.post(draft, (req) =>
    scoped(req, async (db, _t, ctx) => ({
      record: await saveRecordDraft(
        db,
        ctx,
        z.uuid().parse(req.params.suggestionId),
        z
          .object({ revision: recordRevision.or(z.literal(0)), metadata: recordMetadata })
          .strict()
          .parse(req.body),
      ),
    })),
  )
  app.post(root + '/records/:id/confirm', (req) =>
    scoped(req, async (db, _t, ctx) => ({
      record: await confirmRecord(
        db,
        ctx,
        z.uuid().parse(req.params.id),
        z.object({ revision: recordRevision }).strict().parse(req.body).revision,
      ),
    })),
  )
  app.get(root + '/records/:id', (req) =>
    scoped(req, async (db, _t, ctx) => ({
      record: await readArchivedRecord(db, ctx, z.uuid().parse(req.params.id)),
    })),
  )
  app.get(root + '/records', (req) =>
    scoped(req, (db, _t, ctx) =>
      listArchivedRecords(
        db,
        ctx,
        z
          .object({
            category: z.enum(['', ...filingCategories]).default(''),
            tag: z.string().trim().max(20).default(''),
            q: z.string().trim().max(120).default(''),
            page: z.coerce.number().int().min(1).max(100000).default(1),
          })
          .strict()
          .parse(req.query),
      ),
    ),
  )
}
