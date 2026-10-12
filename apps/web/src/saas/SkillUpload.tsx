import { useRef, useState, type FormEvent } from 'react'
import { t } from '@/i18n'
import { api } from './api'

export function SkillUpload({
  base,
  canEdit,
  onInstalled,
}: {
  base: string
  canEdit: boolean
  onInstalled: () => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [kind, setKind] = useState('capability')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!file || busy) return
    setError('')
    setSuccess('')
    setBusy(true)
    const form = event.currentTarget
    try {
      if (file.size > 6 * 1024 * 1024) throw new Error('上传文件不能超过 6 MB')
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1])
        reader.onerror = () => reject(new Error('文件读取失败，请重新选择'))
        reader.readAsDataURL(file)
      })
      const result = await api<{ skill: { name: string } }>(`${base}/skills/uploads`, {
        filename: file.name,
        kind,
        contentBase64,
      })
      setSuccess(result.skill.name)
      setFile(null)
      form.reset()
      onInstalled()
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败，请重试')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="skill-upload-card" aria-label={t('上传 Skill')}>
      <div className="skill-upload-icon" aria-hidden="true">
        ↑
      </div>
      <h2>{t('上传 Skill')}</h2>
      <p className="muted small">{t('添加自己的单项技能或流程技能包。')}</p>
      {canEdit ? (
        <form onSubmit={upload}>
          <button
            type="button"
            className="skill-file-picker"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            {t(file ? '重新选择文件' : '选择技能文件')}
          </button>
          <input
            ref={fileInput}
            hidden
            aria-label={t('选择技能文件')}
            type="file"
            accept=".md,.zip"
            disabled={busy}
            onChange={(e) => {
              setFile(e.target.files?.[0] || null)
              setError('')
              setSuccess('')
            }}
          />
          {file && (
            <p className="skill-upload-filename">
              {file.name} · {Math.max(1, Math.ceil(file.size / 1024))} KB
            </p>
          )}
          <label>
            {t('技能类型')}
            <select value={kind} disabled={busy} onChange={(e) => setKind(e.target.value)}>
              <option value="capability">{t('单体技能包')}</option>
              <option value="workflow">{t('流程技能包')}</option>
            </select>
          </label>
          <p className="skill-upload-help">
            {t('支持 .md 或 .zip，最大 6 MB。ZIP 内需包含一份 SKILL.md。')}
          </p>
          <button className="primary" type="submit" disabled={!file || busy}>
            {t(busy ? '正在上传并安装…' : '上传并安装')}
          </button>
        </form>
      ) : (
        <p className="small muted">{t('仅企业所有者或管理员可以上传安装技能。')}</p>
      )}
      {error && (
        <p className="error small" role="alert">
          {t(error)}
        </p>
      )}
      {success && (
        <p className="skill-upload-success" role="status">
          {t('安装成功：')}
          {success}
          <br />
          {t('已加入当前企业的「我的技能」。')}
        </p>
      )}
      <div className="skill-upload-boundary">
        <strong>{t('安装到当前企业')}</strong>
        <p>{t('安装后可在我的技能中分配给部门，技能说明会用于对话和文字任务；上传不会执行脚本。')}</p>
      </div>
      <details className="skill-upload-example">
        <summary>{t('查看文件格式')}</summary>
        <p>{t('技能名称使用小写英文、数字和连字符。')}</p>
        <pre>
          {
            '---\nname: my-skill\ndescription: Describe this skill\nversion: "1.0.0"\n---\n\n# My skill\n\nDescribe the steps here.'
          }
        </pre>
        <p>{t('有脚本或参考资料时，请与 SKILL.md 一起打包为 ZIP。')}</p>
      </details>
    </section>
  )
}
