import { useEffect, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'
const departments: Record<string, string> = {
  secretary: '秘书处',
  content_ops: '运营部',
  market_research: '市场调研',
  design: '设计部',
  dev: '程序部',
  archive: '资料室',
  compliance: '合规部',
  outreach: '拓客部',
  intern: '实习生',
}
export function SkillAssignment({
  base,
  id,
  canEdit,
  onClose,
}: {
  base: string
  id: string
  canEdit: boolean
  onClose: () => void
}) {
  const [data, setData] = useState<{ content: string; departments: string[]; name: string } | null>(
      null,
    ),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false)
  useEffect(() => {
    api<NonNullable<typeof data>>(`${base}/skills/${id}/detail`)
      .then(setData)
      .catch((e) => setError(e.message))
  }, [base, id])
  return (
    <section className="builder-card">
      <div className="heading-row">
        <h3>{data?.name || t('正在加载…')}</h3>
        <button onClick={onClose}>{t('收起')}</button>
      </div>
      {data && (
        <>
          <p>
            {t(
              '启用后，部门对话会读取技能说明。脚本与外部工具需要对应执行环境，不会在上传时自动运行。',
            )}
          </p>
          <pre className="skill-instructions">{data.content}</pre>
          <h3>{t('分配给部门')}</h3>
          <div className="skill-assignees">
            {Object.entries(departments).map(([key, name]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  disabled={!canEdit || busy}
                  checked={data.departments.includes(key)}
                  onChange={(e) => {
                    setData({
                      ...data,
                      departments: e.target.checked
                        ? [...data.departments, key]
                        : data.departments.filter((d) => d !== key),
                    })
                    setNotice('')
                  }}
                />
                {t(name)}
              </label>
            ))}
          </div>
          <button
            className="primary"
            disabled={!canEdit || busy}
            onClick={async () => {
              setBusy(true)
              setError('')
              try {
                await api(
                  `${base}/skills/${id}/assignments`,
                  { departments: data.departments },
                  'PUT',
                )
                setNotice('技能分配已保存')
              } catch (e) {
                setError((e as Error).message)
              } finally {
                setBusy(false)
              }
            }}
          >
            {t('保存分配')}
          </button>
        </>
      )}
      {notice && <p role="status">{t(notice)}</p>}
      {error && (
        <p role="alert" className="error">
          {t(error)}
        </p>
      )}
    </section>
  )
}
