import { useRef, useState } from 'react'
import { api } from '../api'
import { t } from '@/i18n'
export type Attachment = { id: string; name: string; mime: string }
export function Attachments({
  base,
  items,
  onChange,
  onBusy,
  disabled,
}: {
  base: string
  items: Attachment[]
  onBusy: (value: boolean) => void
  onChange: (items: Attachment[]) => void
  disabled: boolean
}) {
  const ref = useRef<HTMLInputElement>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  async function upload(files: FileList | null) {
    if (!files?.length) return
    setError('')
    if (items.length + files.length > 4) {
      setError('最多上传 4 个附件')
      return
    }
    setBusy(true)
    onBusy(true)
    const next = [...items]
    try {
      for (const file of Array.from(files)) {
        const ext = file.name.split('.').at(-1)?.toLowerCase() || ''
        const mime = (
          {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            webp: 'image/webp',
            txt: 'text/plain',
            md: 'text/markdown',
            csv: 'text/csv',
            json: 'application/json',
          } as Record<string, string>
        )[ext]
        if (!mime) throw Error('支持 PNG、JPG、WebP、TXT、MD、CSV、JSON')
        if (file.size > (mime.startsWith('image/') ? 2 * 1024 * 1024 : 256 * 1024))
          throw Error('图片每张最多 2 MB，文本每份最多 256 KB')
        const content = await new Promise<string>((resolve, reject) => {
          const r = new FileReader()
          r.onload = () => resolve(String(r.result).split(',')[1])
          r.onerror = () => reject(Error('文件读取失败'))
          r.readAsDataURL(file)
        })
        const result = await api<{ id: string }>(`${base}/files`, {
          name: file.name,
          mime,
          content,
        })
        next.push({ id: result.id, name: file.name, mime })
        onChange([...next])
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      onBusy(false)
      if (ref.current) ref.current.value = ''
    }
  }
  return (
    <div className="sec-attachments">
      <input
        ref={ref}
        type="file"
        hidden
        multiple
        accept=".png,.jpg,.jpeg,.webp,.txt,.md,.csv,.json"
        onChange={(e) => void upload(e.target.files)}
      />
      <button
        type="button"
        disabled={disabled || busy || items.length >= 4}
        onClick={() => ref.current?.click()}
      >
        {t(busy ? '正在上传…' : '上传附件')}
      </button>
      <small>{t('图片与文本，最多 4 个附件')}</small>
      <div>
        {items.map((item) => (
          <span className="attachment-chip" key={item.id}>
            {item.mime.startsWith('image/') && (
              <img src={`${base}/files/${item.id}/preview`} alt="" />
            )}
            {item.name}
            <button
              type="button"
              disabled={disabled || busy}
              aria-label={`${t('移除附件')} ${item.name}`}
              onClick={() => onChange(items.filter((i) => i.id !== item.id))}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {error && (
        <p role="alert" className="error">
          {t(error)}
        </p>
      )}
    </div>
  )
}
