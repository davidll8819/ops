/** Nine office looks assembled from the original character skins and wardrobe. */
export const CHIBI_CHARACTER_SKINS = [
  'misaki', 'erikari', 'nate', 'harri', 'luke', 'soeren', 'mario', 'sinisa', 'spineboy',
] as const
export type ChibiSkinName = typeof CHIBI_CHARACTER_SKINS[number]
export type CharacterLook = {
  skin: ChibiSkinName
  outfit?: ChibiSkinName
  hide?: string[]
}

// Stable agent IDs keep appearance independent from names and desk order.
export const CHARACTER_LOOKS: Record<string, CharacterLook> = {
  marvis: { skin: 'misaki' },
  'code-agent': { skin: 'spineboy', outfit: 'soeren', hide: ['glasses', 'glasses-shadow'] },
  'file-agent': { skin: 'misaki', outfit: 'soeren' },
  'app-agent': { skin: 'harri' },
  'review-agent': { skin: 'sinisa' },
  'data-agent': { skin: 'soeren' },
  'new-agent-7': { skin: 'erikari' },
  'new-agent-8': { skin: 'mario', outfit: 'nate' },
  'new-agent-9': { skin: 'erikari', outfit: 'misaki' },
}

export function getChibiSkinName(agentId: string): ChibiSkinName {
  return CHARACTER_LOOKS[agentId]?.skin ?? 'spineboy'
}
