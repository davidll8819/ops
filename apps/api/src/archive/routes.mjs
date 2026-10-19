import { z } from 'zod'
import { createDocumentParser } from './worker.mjs'
import { claimParse, finishParse, getDocument, listDocuments, saveParseProgress } from './store.mjs'
import { validProgress } from './worker.mjs'
export function registerArchiveRoutes(app, { scoped, documentParser = createDocumentParser() }) {
  // Fastify waits for active sockets before onClose. Stop parser work first so
  // accepted parse handlers can persist their failure and release those sockets.
  app.addHook('preClose', async () => {
    await documentParser.close?.()
  })
  app.addHook('onClose', async () => {
    await documentParser.close?.()
  })
  const root = '/api/tenants/:tenantId/archive/documents'
  app.get(root, (req) =>
    scoped(req, async (db, _tenant, ctx) => ({ items: await listDocuments(db, ctx) })),
  )
  app.get(`${root}/:fileId`, (req) =>
    scoped(req, async (db, _tenant, ctx) => ({
      document: await getDocument(db, ctx, z.uuid().parse(req.params.fileId)),
    })),
  )
  app.post(`${root}/:fileId/parse`, async (req) => {
    z.object({}).strict().parse(req.body)
    const fileId = z.uuid().parse(req.params.fileId)
    const claim = await scoped(req, (db, _tenant, ctx) => claimParse(db, ctx, fileId))
    if (claim.document) return { document: claim.document }
    let result,
      error,
      accepting = true,
      cancelled = false,
      progressFailure
    let progress = Promise.resolve()
    const onProgress = (value) => {
      if (!accepting || !validProgress(value)) return Promise.resolve()
      const snapshot = { stage: value.stage, page: value.page, totalPages: value.totalPages }
      progress = progress.then(() => {
        if (cancelled) return
        return scoped(req, (db, _tenant, ctx) =>
          saveParseProgress(db, ctx, fileId, claim.attemptId, snapshot),
        )
      })
      progress.catch((caught) => {
        progressFailure = caught
      })
      return progress
    }
    try {
      result = await documentParser(claim.input, { onProgress })
      accepting = false
      await progress
      if (progressFailure) throw progressFailure
    } catch (caught) {
      cancelled = true
      error =
        caught.expose || caught.code
          ? String(caught.message).slice(0, 500)
          : '文档解析失败，请检查格式或重新导出文件后重试'
      result = undefined
    } finally {
      accepting = false
      // Success flushed above. On failure, a stalled progress write must not
      // disable the parser deadline; state/attempt predicates fence its late write.
    }
    return scoped(req, async (db, _tenant, ctx) => ({
      document: await finishParse(db, ctx, fileId, claim.attemptId, { result, error }),
    }))
  })
}
