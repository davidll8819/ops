import { useCallback, useEffect, useRef, useState } from 'react'
import { api, csrf } from '../api'
import {
  readable,
  resultMedia,
  mergeMedia,
  type OperationsHandoff,
  type OperationsBrief,
  type VideoFormat,
  type ResultMedia,
} from './models'
type Submission = { state: string; runtimeTaskId?: string | null; briefId?: string | null }
const labels: Record<string, string> = {
  running: '正在制作，可查看实时记录',
  completed: '制作已完成，请验收成果',
  requires_action: '需要补充信息或账号授权',
  error: '制作失败，请查看记录后调整要求',
  aborted: '制作已停止',
}
export function useOperationsTask(
  root: string,
  handoff: OperationsHandoff | undefined,
  canEdit: boolean,
  ready: boolean,
) {
  const [prompt, setPrompt] = useState(''),
    [busy, setBusy] = useState(false),
    [output, setOutput] = useState<string[]>([]),
    [media, setMedia] = useState<ResultMedia[]>([]),
    [videoFormat, setVideoFormat] = useState<VideoFormat>(),
    [videoPending, setVideoPending] = useState(false),
    [taskId, setTaskId] = useState<string>(),
    [secretaryTaskId, setSecretaryTaskId] = useState<string>(),
    [brief, setBrief] = useState(handoff?.brief),
    [phase, setPhase] = useState(''),
    [error, setError] = useState(''),
    [unresolved, setUnresolved] = useState(false)
  const mounted = useRef(false),
    epoch = useRef(0),
    lookup = useRef(0),
    sending = useRef(false),
    requestId = useRef<string | undefined>(undefined),
    handled = useRef<string | undefined>(undefined),
    source = useRef(handoff),
    controller = useRef<AbortController | undefined>(undefined)
  const current = useCallback((id: number) => mounted.current && epoch.current === id, [])
  useEffect(() => {
    const generation = epoch
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current++
      controller.current?.abort()
    }
  }, [])
  const loadTask = useCallback(
    async (id: string, expectedScope = epoch.current) => {
      if (!current(expectedScope)) return
      const scope = expectedScope,
        seq = ++lookup.current
      try {
        const data = await api<{
          status?: string
          messages?: unknown[]
          result?: unknown
          videoFormat?: VideoFormat
          savedVideos?: { status?: string }[]
          videoStatusUnavailable?: boolean
        }>(`${root}/tasks/${id}`)
        if (!current(scope) || seq !== lookup.current) return
        setTaskId(id)
        setVideoFormat(data.videoFormat)
        setVideoPending(
          !!data.videoStatusUnavailable ||
            !!data.savedVideos?.some((video) =>
              ['Submitted', 'InProgress'].includes(video.status || ''),
            ),
        )
        setPhase(
          data.status === 'error' && data.savedVideos?.some((video) => video.status === 'SUCCESS')
            ? '对话执行中断，已保存的素材仍可查看'
            : labels[data.status || ''] || '任务状态待核对',
        )
        setOutput([readable(data.messages || data.result) || '任务记录暂无文本'])
        setMedia(mergeMedia(resultMedia([data.messages || data.result, data.savedVideos])))
        setUnresolved(!labels[data.status || ''])
      } catch (e) {
        if (current(scope) && seq === lookup.current) {
          setError((e as Error).message)
          setPhase('状态查询失败，已保留任务编号')
          setUnresolved(true)
        }
      }
    },
    [root, current],
  )
  useEffect(() => {
    if (!handoff || handoff.id === handled.current || busy || unresolved) return
    handled.current = handoff.id
    source.current = handoff
    epoch.current++
    lookup.current++
    requestId.current = undefined
    setPrompt(handoff.text)
    setVideoFormat(undefined)
    setVideoPending(false)
    setBrief(handoff.brief)
    setSecretaryTaskId(handoff.secretaryTaskId)
    setTaskId(handoff.runtimeTaskId)
    setOutput([])
    setMedia([])
    setPhase('')
    setError('')
    if (handoff.runtimeTaskId) void loadTask(handoff.runtimeTaskId)
  }, [handoff, busy, unresolved, loadTask])
  const recover = useCallback(async () => {
    const scope = epoch.current
    if (!requestId.current) {
      if (taskId) await loadTask(taskId)
      return
    }
    try {
      const data = await api<{ submission: Submission }>(`${root}/submissions/${requestId.current}`)
      if (!current(scope)) return
      if (data.submission.briefId) {
        const source = await api<{ brief: OperationsBrief }>(
          `${root}/briefs/${data.submission.briefId}`,
        )
        if (!current(scope)) return
        setBrief(source.brief)
      }
      if (data.submission.state === 'failed') {
        setUnresolved(false)
        setPhase('请求未进入制作服务，可修改后重试')
        return
      }
      if (data.submission.runtimeTaskId) {
        setTaskId(data.submission.runtimeTaskId)
        await loadTask(data.submission.runtimeTaskId)
      } else {
        setUnresolved(true)
        setPhase('提交结果待核对，请勿重复生成')
      }
    } catch (e) {
      if (current(scope)) {
        setUnresolved(true)
        setPhase('提交结果待核对，请勿重复生成')
        setError((e as Error).message)
      }
    }
  }, [root, taskId, loadTask, current])
  useEffect(() => {
    if (!taskId || busy || (phase !== labels.running && !videoPending)) return
    const scope = epoch.current
    const timer = setTimeout(() => {
      if (current(scope)) void loadTask(taskId, scope)
    }, 5000)
    return () => clearTimeout(timer)
  }, [taskId, busy, phase, videoPending, output, loadTask, current])
  async function send() {
    if (
      !canEdit ||
      !ready ||
      !prompt.trim() ||
      sending.current ||
      unresolved ||
      phase === labels.running
    )
      return
    sending.current = true
    const scope = epoch.current,
      submitted = prompt
    requestId.current = crypto.randomUUID()
    const id = requestId.current
    setBusy(true)
    setError('')
    setUnresolved(true)
    setPhase('正在提交制作要求')
    setOutput([submitted])
    setMedia([])
    controller.current = new AbortController()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let pending: string[] = [],
      pendingMedia: ResultMedia[] = [],
      last = 0
    const flush = () => {
      if (!current(scope)) return
      if (pending.length) {
        const batch = pending
        pending = []
        setOutput((items) => [...items, ...batch].slice(-200))
      }
      if (pendingMedia.length) {
        const batch = pendingMedia
        pendingMedia = []
        setMedia((items) => mergeMedia([...items, ...batch]))
      }
      last = Date.now()
    }
    try {
      const response = await fetch(`${root}/tasks`, {
        method: 'POST',
        signal: controller.current.signal,
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({
          prompt: submitted,
          videoFormat: videoFormat || null,
          requestId: id,
          ...(taskId ? { taskId } : {}),
          ...(secretaryTaskId ? { secretaryTaskId } : {}),
          ...(brief ? { briefId: brief.id } : {}),
        }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.message || '制作请求未完成')
      }
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
        throw new Error('未收到制作事件流，请核对提交记录')
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (!current(scope)) break
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n')
          try {
            const event = JSON.parse(data)
            if (/^[a-f0-9]{24}$/.test(event.taskId || '')) setTaskId(event.taskId)
            const text = readable(event)
            if (text) pending.push(text.slice(0, 30000))
            pendingMedia.push(...resultMedia(event))
          } catch {
            /* keepalive */
          }
        }
        if (buffer.length > 1024 * 1024) throw new Error('事件流超过容量，请核对任务记录')
        if (Date.now() - last >= 80) flush()
      }
      flush()
      if (current(scope)) await recover()
    } catch (e) {
      flush()
      if (current(scope)) {
        setError((e as Error).message)
        // A missing record may be a request still in flight. Only a persisted failed preflight is safe.
        await recover()
      }
    } finally {
      reader?.releaseLock()
      sending.current = false
      if (current(scope)) setBusy(false)
    }
  }
  function reset() {
    if (sending.current || unresolved || phase === labels.running) return
    epoch.current++
    lookup.current++
    requestId.current = undefined
    source.current = undefined
    setBrief(undefined)
    setSecretaryTaskId(undefined)
    setTaskId(undefined)
    setPrompt('')
    setVideoFormat(undefined)
    setVideoPending(false)
    setOutput([])
    setMedia([])
    setPhase('')
    setError('')
  }
  async function selectTask(id: string) {
    if (sending.current) return
    epoch.current++
    lookup.current++
    requestId.current = undefined
    setTaskId(undefined)
    setPhase('正在读取任务')
    setVideoPending(false)
    setVideoFormat(undefined)
    setSecretaryTaskId(
      source.current?.runtimeTaskId === id ? source.current.secretaryTaskId : undefined,
    )
    setBrief(undefined)
    setPrompt('')
    setUnresolved(true)
    await loadTask(id)
  }
  async function recoverSubmission(id: string) {
    if (sending.current) return
    epoch.current++
    lookup.current++
    requestId.current = id
    setBrief(undefined)
    setSecretaryTaskId(undefined)
    setTaskId(undefined)
    setVideoPending(false)
    setPrompt('')
    setVideoFormat(undefined)
    setOutput([])
    setMedia([])
    setUnresolved(true)
    setError('')
    await recover()
  }
  async function stop() {
    if (!taskId || !canEdit) return
    const scope = epoch.current
    try {
      await api(`${root}/tasks/${taskId}/abort`, {})
      if (!current(scope)) return
      if (current(scope)) setOutput((v) => [...v, '已请求停止，等待运行服务确认。'].slice(-200))
      await loadTask(taskId, scope)
    } catch (e) {
      if (current(scope)) setError((e as Error).message)
    }
  }
  return {
    prompt,
    setPrompt,
    videoFormat,
    videoPending,
    setVideoFormat,
    busy,
    output,
    media,
    taskId,
    brief,
    phase,
    error,
    unresolved,
    send,
    reset,
    selectTask,
    recoverSubmission,
    recover,
    stop,
    running: phase === labels.running || videoPending,
  }
}
