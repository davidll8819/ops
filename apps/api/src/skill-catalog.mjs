import { readFile } from 'node:fs/promises'

const catalogFile = new URL('../../../skills/catalog/catalog.json', import.meta.url)

/** Read-only download directory. No installation or skill code execution. */
export async function readSkillCatalog() {
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8'))
  return {
    generatedAt: catalog.generatedAt,
    items: catalog.items.map(
      ({
        id,
        number,
        category,
        name,
        descriptionZh,
        descriptionEn,
        source,
        sameNameCount,
        detailUrl,
        descriptionBasis,
        download,
      }) => ({
        id,
        number,
        category,
        name,
        descriptionZh,
        descriptionEn,
        source,
        sameNameCount,
        detailUrl,
        descriptionBasis,
        download: {
          status: download.status,
          packagePath: download.packagePath,
          skillFile: download.skillFile,
          sha256: download.sha256,
          packageBytes: download.packageBytes,
          historical: download.historical || false,
          error: download.status === 'failed' ? '技能来源暂不可用或未能对应原文' : undefined,
        },
      }),
    ),
  }
}
