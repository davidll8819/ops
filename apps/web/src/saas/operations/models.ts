export type OperationsBrief = {
  id: string
  title: string
  text: string
  sourceMessageId: string
  sourceRevision: number
  createdAt: string
  messages: { id: string; role: string; text: string }[]
}
export type OperationsHandoff = {
  id: string
  text: string
  secretaryTaskId?: string
  runtimeTaskId?: string
  brief?: OperationsBrief
}
export type OpenOperations = (
  text?: string,
  task?: import('../../../../../packages/secretary/model.mjs').Task,
  brief?: OperationsBrief,
) => void
export function readable(value: unknown, depth = 0): string {
  if (depth > 15) return ''
  if (typeof value === 'string') return value.slice(-30000)
  if (Array.isArray(value))
    return value
      .slice(-200)
      .map((v) => readable(v, depth + 1))
      .filter(Boolean)
      .join('\n')
      .slice(-150000)
  if (value && typeof value === 'object') {
    const r = value as Record<string, unknown>
    for (const k of ['text', 'content', 'message', 'result', 'description', 'errors', 'tool_name'])
      if (r[k]) return readable(r[k], depth + 1)
  }
  return ''
}
export type VideoFormat = { ratio: '9:16' | '16:9' | '1:1'; resolution: '720p' | '1080p' }
export type ResultMedia = {
  type: string
  url: string
  specification?: {
    requested: VideoFormat
    actual: { width: number; height: number }
    matches: boolean
  }
}
export function mergeMedia(items: ResultMedia[]): ResultMedia[] {
  const merged = new Map<string, ResultMedia>()
  for (const item of items) {
    const previous = merged.get(item.url)
    merged.set(
      item.url,
      previous?.specification && !item.specification
        ? { ...item, specification: previous.specification }
        : item,
    )
  }
  return [...merged.values()].slice(0, 30)
}
export function resultMedia(value: unknown, depth = 0): ResultMedia[] {
  if (depth > 15) return []
  if (typeof value === 'string') {
    const links = [
      ...value.matchAll(
        /\[Resource link: (?:Generated image|Image \d+)\]\s+(https?:\/\/[^\s<>]+)/g,
      ),
    ]
      .slice(0, 30)
      .map((match) => ({ type: 'IMAGE', url: match[1] }))
    if (
      value.length < 1024 * 1024 &&
      (value.trim().startsWith('{') || value.trim().startsWith('['))
    ) {
      try {
        return [...links, ...resultMedia(JSON.parse(value), depth + 1)].slice(0, 30)
      } catch {
        return links
      }
    }
    return links
  }
  if (Array.isArray(value)) return value.flatMap((v) => resultMedia(v, depth + 1)).slice(0, 30)
  if (!value || typeof value !== 'object') return []
  const r = value as Record<string, unknown>
  if (
    typeof r.url === 'string' &&
    ['IMAGE', 'VIDEO'].includes(String(r.type)) &&
    /^https?:\/\//.test(r.url)
  )
    return [{ type: String(r.type), url: r.url }]
  if (
    ['SUCCESS', 'completed'].includes(String(r.status)) &&
    typeof r.videoUrl === 'string' &&
    /^https?:\/\//.test(r.videoUrl)
  ) {
    const s = r.specification as ResultMedia['specification']
    const valid =
      s &&
      typeof s.matches === 'boolean' &&
      ['9:16', '16:9', '1:1'].includes(s.requested?.ratio) &&
      ['720p', '1080p'].includes(s.requested?.resolution) &&
      Number.isSafeInteger(s.actual?.width) &&
      s.actual.width > 0 &&
      Number.isSafeInteger(s.actual?.height) &&
      s.actual.height > 0
    return [{ type: 'VIDEO', url: r.videoUrl, ...(valid ? { specification: s } : {}) }]
  }
  if (
    r.type === 'resource_link' &&
    /image/i.test(String(r.name)) &&
    typeof r.uri === 'string' &&
    /^https?:\/\//.test(r.uri)
  )
    return [{ type: 'IMAGE', url: r.uri }]
  return ['text', 'content', 'message', 'messages', 'result', 'medias', 'structured_output']
    .flatMap((k) => resultMedia(r[k], depth + 1))
    .slice(0, 30)
}
