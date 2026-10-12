import { SkillAssignment } from './SkillAssignment'
import { useEffect, useState } from 'react'
import { t, useLanguage } from '@/i18n'
import { api } from './api'

type Installed = {
  catalog_id?: string | null
  catalog_source?: string | null
  provenance?: { descriptionEn?: string; historical?: boolean }
  id: string
  name: string
  description: string
  version: string
  kind: string
  filename: string
  file_count: number
  created_at: string
}
export function InstalledSkills({
  base,
  revision,
  canEdit,
}: {
  base: string
  revision: number
  canEdit: boolean
}) {
  const language = useLanguage()
  const [selected, setSelected] = useState('')
  const [result, setResult] = useState<{ items: Installed[]; error?: string } | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    let live = true
    api<{ items: Installed[] }>(`${base}/skills/installed`)
      .then((data) => {
        if (live) setResult(data)
      })
      .catch((err) => {
        if (live) setResult({ items: [], error: err.message })
      })
    return () => {
      live = false
    }
  }, [base, revision])
  if (!result) return <p role="status">{t('正在加载技能…')}</p>
  if (result.error)
    return (
      <p role="alert" className="error">
        {t(result.error)}
      </p>
    )
  const items = result.items.filter((item) =>
    `${item.name} ${item.description} ${item.provenance?.descriptionEn || ''} ${item.catalog_source || ''}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  )
  return (
    <section className="installed-skills" aria-label={t('我的技能')}>
      <div className="heading-row">
        <h2>
          {t('已安装技能')} · {result.items.length}
        </h2>
        <span className="plan-tag">{t('当前企业')}</span>
      </div>
      <p className="muted small">
        {t('查看技能内容并分配给部门，后续对话会使用已启用的技能说明。')}
      </p>
      {!!result.items.length && (
        <label>
          {t('搜索我的技能')}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('搜索名称或说明')}
          />
        </label>
      )}
      {!items.length ? (
        <div className="installed-empty">
          <span aria-hidden="true">↑</span>
          <h3>{t(result.items.length ? '没有匹配的技能' : '还没有安装技能')}</h3>
          <p>{t('从「技能目录」安装，或使用「上传 Skill」添加文件，安装成功后会出现在这里。')}</p>
        </div>
      ) : (
        <div className="installed-skill-list">
          {items.map((item) => (
            <article key={item.id}>
              <div className="heading-row">
                <h3>{item.name}</h3>
                <span className="plan-tag">{t('已安装')}</span>
              </div>
              <p>
                {language === 'en' && item.provenance?.descriptionEn
                  ? item.provenance.descriptionEn
                  : item.description}
              </p>
              {item.catalog_source && (
                <p className="small muted">
                  {t('发布来源')} · {item.catalog_source}
                </p>
              )}
              <div className="installed-skill-meta">
                <span>{t(item.kind === 'workflow' ? '流程技能包' : '单体技能包')}</span>
                <span>
                  {t('版本')} {item.version}
                </span>
                <span>
                  {item.file_count} {t('个文件')}
                </span>
              </div>
              <p className="small muted">
                {item.filename} ·{' '}
                {new Date(item.created_at).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}
              </p>
              <button onClick={() => setSelected(selected === item.id ? '' : item.id)}>
                {t('查看内容与分配')}
              </button>
              {selected === item.id && (
                <SkillAssignment
                  base={base}
                  id={item.id}
                  canEdit={canEdit}
                  onClose={() => setSelected('')}
                />
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
