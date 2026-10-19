import { buildDocumentContext } from './context.mjs'

export function buildComparisonContext(comparison) {
  const changed = comparison.hunks.filter((h) => h.type !== 'equal')
  const sources = []
  let characters = 0,
    included = 0
  for (const hunk of changed) {
    const pair = []
    for (const side of ['old', 'new']) {
      if (!hunk[side]) continue
      const version = comparison[`${side}Version`],
        block = hunk[side]
      pair.push({
        ...block,
        fileId: version.fileId,
        filename: version.name,
        extractionId: version.extractionId,
        sha256: version.sha256,
        sourceId: `${hunk.id}-${side}`,
        comparisonId: comparison.id,
        changeId: hunk.id,
        side,
        changeType: hunk.type,
      })
    }
    const size = pair.reduce((sum, s) => sum + s.text.length, 0)
    if (sources.length + pair.length > 32 || characters + size > 24000) continue
    sources.push(...pair)
    characters += size
    included++
  }
  const partial = included < changed.length
  const documentCoverage = `${partial ? '本轮仅包含部分改动' : '本轮包含全部已提取文字改动'}（${included}/${changed.length} 项）；这不是完整语义审查。`
  const base = buildDocumentContext([])
  return {
    sources,
    documentCoverage,
    comparisonValidation: true,
    instructions:
      base.instructions +
      '\n当前为旧版/新版已提取文字比对。仅依据实际改动回答，每项修改判断必须同时引用同一 changeId 的 old 和 new 来源；不得将不同改动、相同文字或旧回答当作修改证据。来源中的 changeId、side 是服务器指定，回复引用仅填写 sourceId 和 quote。' +
      comparison.warnings.join(' ') +
      (sources.some((s) => s.method === 'ocr') ? ' OCR 识别可能有误，请核对原件。' : ''),
    content: JSON.stringify({
      documentCoverage,
      sources: sources.map(
        ({ sourceId, filename, location, text, method, page, changeId, side }) => ({
          sourceId,
          filename,
          location,
          text,
          changeId,
          side,
          ...(method === 'ocr' ? { method, page } : {}),
        }),
      ),
    }),
  }
}
