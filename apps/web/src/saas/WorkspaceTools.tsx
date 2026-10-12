import { useEffect, useRef, useState } from 'react'
import { t, useLanguage } from '@/i18n'
import { api } from './api'
import { DepartmentChat } from './DepartmentChat'
type FileItem = { id: string; name: string; size: number; created_at: string }
type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult:
    | ((e: {
        results: { isFinal: boolean; 0: { transcript: string } }[]
        resultIndex: number
      }) => void)
    | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
export function WorkspaceTools({
  base,
  tool,
  onClose,
  openSettings,
  onDictated,
}: {
  base: string
  tool: string
  onClose: () => void
  openSettings: () => void
  onDictated: (text: string) => void
}) {
  const ref = useRef<HTMLDialogElement>(null),
    rec = useRef<Recognition | null>(null),
    language = useLanguage()
  const [files, setFiles] = useState<FileItem[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [image, setImage] = useState(''),
    [text, setText] = useState(''),
    [listening, setListening] = useState(false)
  async function refresh() {
    try {
      setFiles((await api<{ items: FileItem[] }>(`${base}/files`)).items)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    ref.current?.showModal()
    return () => rec.current?.abort()
  }, [])
  useEffect(() => {
    if (tool === 'files') void refresh()
  }, [base, tool]) // eslint-disable-line react-hooks/exhaustive-deps
  async function read(file: File) {
    if (file.size > 6 * 1024 * 1024) throw new Error('文件不能超过 6 MB')
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(new Error('文件读取失败'))
      r.readAsDataURL(file)
    })
  }
  async function upload(file?: File) {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const data = await read(file)
      if (tool === 'ocr') {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
          throw new Error('请选择 PNG、JPEG 或 WebP 图片')
        setImage(data)
      } else {
        await api(`${base}/files`, {
          name: file.name,
          mime: file.type,
          content: data.split(',')[1],
        })
        await refresh()
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function capture() {
    setError('')
    setBusy(true)
    let stream: MediaStream | undefined
    try {
      if (!navigator.mediaDevices?.getDisplayMedia)
        throw new Error('此浏览器不支持屏幕截图，请上传系统截图')
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const video = document.createElement('video')
      video.muted = true
      video.srcObject = stream
      await video.play()
      await new Promise<void>((resolve) =>
        video.requestVideoFrameCallback
          ? video.requestVideoFrameCallback(() => resolve())
          : requestAnimationFrame(() => resolve()),
      )
      const scale = Math.min(1, 2048 / Math.max(video.videoWidth, video.videoHeight)),
        canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
      canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height)
      setImage(canvas.toDataURL('image/png'))
      video.srcObject = null
    } catch (e) {
      setError(
        (e as Error).name === 'NotAllowedError'
          ? '截图已取消，或未授予屏幕权限'
          : (e as Error).message,
      )
    } finally {
      stream?.getTracks().forEach((track) => track.stop())
      setBusy(false)
    }
  }
  function voice() {
    const w = window as unknown as {
      SpeechRecognition?: new () => Recognition
      webkitSpeechRecognition?: new () => Recognition
    }
    const C = w.SpeechRecognition || w.webkitSpeechRecognition
    if (!C) {
      setError('此浏览器不支持语音识别，请用 Safari 或 Chrome，或使用系统听写')
      return
    }
    const r = new C()
    rec.current = r
    r.lang = language === 'zh' ? 'zh-CN' : 'en-US'
    r.continuous = true
    r.interimResults = false
    r.onresult = (e) => {
      let next = ''
      for (let i = e.resultIndex; i < e.results.length; i++)
        if (e.results[i].isFinal) next += e.results[i][0].transcript
      setText((v) => v + next)
    }
    r.onerror = (e) => {
      setError(`${t('语音识别未完成')}：${e.error}`)
      setListening(false)
    }
    r.onend = () => setListening(false)
    try {
      r.start()
      setListening(true)
    } catch {
      setError('无法开启麦克风，请检查浏览器权限')
    }
  }
  return (
    <dialog ref={ref} className="workspace-tool-dialog" onClose={onClose} onCancel={onClose}>
      <header className="heading-row">
        <h2>{t(tool === 'files' ? '文件浏览' : tool === 'ocr' ? '图片文字识别' : '语音输入')}</h2>
        <button onClick={() => ref.current?.close()}>{t('关闭')}</button>
      </header>
      {tool === 'files' && (
        <>
          <p>{t('文件仅对当前企业中的你可见，单个文件最大 6 MB。')}</p>
          <label>
            {t('上传文件')}
            <input type="file" disabled={busy} onChange={(e) => void upload(e.target.files?.[0])} />
          </label>
          <button onClick={() => void refresh()}>{t('刷新')}</button>
          {files.length ? (
            files.map((f) => (
              <article className="member-row" key={f.id}>
                <span>
                  {f.name} · {(f.size / 1024).toFixed(1)} KB
                </span>
                <a href={`${base}/files/${f.id}/download`} download>
                  {t('下载')}
                </a>
              </article>
            ))
          ) : (
            <p>{t('暂无文件')}</p>
          )}
        </>
      )}
      {tool === 'ocr' && (
        <>
          <button disabled={busy} onClick={() => void capture()}>
            {t('截取屏幕')}
          </button>
          <p>{t('选择窗口或屏幕后生成预览；点击发送识别时才会把图片交给企业模型。')}</p>
          <p>{t('上传截图或图片，使用资料室的视觉文字模型提取文字；需要模型支持图片输入。')}</p>
          <label>
            {t('选择图片')}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
              onChange={(e) => void upload(e.target.files?.[0])}
            />
          </label>
          {image && (
            <>
              <img src={image} alt={t('待识别图片')} className="ocr-preview" />
              <DepartmentChat
                key={image.slice(-100)}
                base={base}
                department="archive"
                image={image}
                initial={t('请准确提取这张图片中的文字，保留段落与表格结构；看不清的部分注明。')}
                openSettings={openSettings}
              />
            </>
          )}
        </>
      )}
      {tool === 'voice' && (
        <>
          <p>
            {t(
              '点击开始后由浏览器请求麦克风权限；识别服务由浏览器提供。识别文本可修改后交给秘书。',
            )}
          </p>
          <button onClick={() => (listening ? rec.current?.stop() : voice())}>
            {t(listening ? '停止录音' : '开始录音')}
          </button>
          <label>
            {t('识别文本')}
            <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
          <button
            className="primary"
            disabled={!text.trim()}
            onClick={() => {
              rec.current?.stop()
              onDictated(text)
              ref.current?.close()
            }}
          >
            {t('交给私人秘书')}
          </button>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {t(error)}
        </p>
      )}
    </dialog>
  )
}
