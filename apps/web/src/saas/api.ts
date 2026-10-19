export let csrf = ''
export function setCsrf(value: string) {
  csrf = value
}
const slowResponseType = 'application/x-office-response+ndjson'
const interrupted = () =>
  new Error('连接中断，任务可能仍在处理。请先查看任务进度或对话记录，勿重复提交。')
function checked<T>(status: number, data: T & { error?: string }): T {
  if (status < 200 || status >= 300) {
    if (status === 401) window.dispatchEvent(new Event('office:unauthorized'))
    throw Object.assign(new Error(data?.error || '请求失败'), { status })
  }
  return data
}
export async function readApiResponse<T>(response: Response): Promise<T> {
  if (!response.headers.get('content-type')?.startsWith(slowResponseType))
    return checked(response.status, await response.json())
  if (!response.ok || !response.body) throw interrupted()
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch {
        throw interrupted()
      }
      if (chunk.done) throw interrupted()
      pending += decoder.decode(chunk.value, { stream: true })
      if (pending.length > 16 * 1024 * 1024) throw interrupted()
      let newline
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          throw interrupted()
        }
        if (frame?.type === 'heartbeat') continue
        if (
          frame?.type !== 'result' ||
          !Number.isInteger(frame.status) ||
          frame.status < 100 ||
          frame.status > 599 ||
          !Object.hasOwn(frame, 'data')
        )
          throw interrupted()
        return checked<T>(frame.status, frame.data)
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf,
        Accept: `${slowResponseType}, application/json`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    throw interrupted()
  }
  return readApiResponse<T>(response)
}
export type Tenant = { id: string; name: string; plan: string; role: string }
export type Me = { user: { id: string; email: string }; csrf: string; tenants: Tenant[] }
export type Profile = {
  name: string
  systemPrompt: string
  modelId: string
  maxTokens: number
  temperature: number
  memory: boolean
}
export type Agent = { id: string; profile: Profile }
