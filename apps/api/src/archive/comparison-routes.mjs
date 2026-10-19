import { z } from 'zod'
import { fail } from '../db.mjs'
import { compareDocumentText } from './compare.mjs'
import {
  loadComparisonInputs,
  persistComparison,
  getComparison,
  listComparisons,
} from './comparison-store.mjs'

export function registerComparisonRoutes(app, { scoped, compare = compareDocumentText }) {
  const root = '/api/tenants/:tenantId/archive/comparisons'
  app.get(root, (req) =>
    scoped(req, async (db, _tenant, ctx) => ({ items: await listComparisons(db, ctx) })),
  )
  app.get(`${root}/:id`, (req) =>
    scoped(req, async (db, _tenant, ctx) => ({
      comparison: await getComparison(db, ctx, z.uuid().parse(req.params.id)),
    })),
  )
  app.post(root, async (req) => {
    const { oldFileId, newFileId } = z
      .object({ oldFileId: z.uuid(), newFileId: z.uuid() })
      .strict()
      .parse(req.body)
    const documents = await scoped(req, (db, _tenant, ctx) =>
      loadComparisonInputs(db, ctx, oldFileId, newFileId),
    )
    let result
    try {
      result = compare(...documents)
    } catch (error) {
      if (error.code === 'COMPARISON_LIMIT') throw fail(413, error.message)
      if (error.code === 'INVALID_COMPARISON_SOURCE') throw fail(400, error.message)
      throw error
    }
    result.warnings = [
      ...result.warnings,
      ...documents.flatMap((document, i) =>
        document.warnings.map(
          (warning) => `${i === 0 ? '旧版' : '新版'} ${document.name}：${warning}`,
        ),
      ),
      ...(documents[0].parserVersion !== documents[1].parserVersion
        ? ['旧版与新版使用不同解析器版本，文字差异可能包含提取方式造成的变化，请核对原件。']
        : []),
    ]
    return scoped(req, async (db, _tenant, ctx) => ({
      comparison: await persistComparison(db, ctx, documents, result),
    }))
  })
}
