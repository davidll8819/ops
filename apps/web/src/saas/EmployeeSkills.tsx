import { useEffect, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'

type Skill = {
  id: string
  name: string
  description: string
  version: string
  catalog_id?: string
  provenance?: { sourceUrl?: string; commit?: string; modules?: string[] }
}
type Bindings = { items: Skill[]; skillIds: string[]; revision: string }
type Saved = Pick<Bindings, 'skillIds' | 'revision'>

export function EmployeeSkills({
  base,
  employeeId,
  canEdit,
  openLibrary,
  onSaved,
}: {
  base: string
  employeeId: string
  canEdit: boolean
  openLibrary: () => void
  onSaved: () => void
}) {
  const path = `${base}/employees/${employeeId}/skills`
  const [snapshot, setSnapshot] = useState<Bindings | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let live = true
    setBusy(true)
    api<Bindings>(path)
      .then((data) => {
        if (!live) return
        setSnapshot(data)
        setSelected(data.skillIds)
        setError('')
      })
      .catch((e) => {
        if (live) setError(e.message)
      })
      .finally(() => {
        if (live) setBusy(false)
      })
    return () => {
      live = false
    }
  }, [path, reload])
  const dirty =
    snapshot &&
    (selected.length !== snapshot.skillIds.length ||
      selected.some((id) => !snapshot.skillIds.includes(id)))
  const official = snapshot?.items.find((s) => s.catalog_id === 'official:obra/superpowers')
  const installed = official && snapshot?.skillIds.includes(official.id)
  async function save() {
    if (!snapshot) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const saved = await api<Saved>(
        path,
        { skillIds: selected, revision: snapshot.revision },
        'PUT',
      )
      setSnapshot({ ...snapshot, ...saved })
      setSelected(saved.skillIds)
      setNotice('技能绑定已保存，下一条消息或新开始的任务将使用这些技能。')
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function install() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api(`${path}/superpowers`, {})
      const data = await api<Bindings>(path)
      setSnapshot(data)
      setSelected(data.skillIds)
      setNotice('Superpowers 已安装并绑定，下一条消息即可使用。')
      onSaved()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="employee-skill-editor" aria-label={t('员工技能绑定')}>
      <div className="heading-row">
        <h2>
          {t('技能绑定')} {snapshot && <small>{selected.length} / 8</small>}
        </h2>
        <button onClick={openLibrary} disabled={busy}>
          {t('打开技能库')}
        </button>
      </div>
      <p className="muted small">
        {t('勾选该员工要使用的技能。取消勾选并保存即可停用，技能包仍保留在企业技能库中。')}
      </p>
      {employeeId === 'code-agent' && (
        <div className="employee-skill-featured">
          <strong>Superpowers {official?.version}</strong>
          <p>{t('把需求澄清、开发计划、测试、调试和评审的方法交给龙傲天。')}</p>
          {installed ? (
            <span className="employee-skill-active">{t('已安装并启用')}</span>
          ) : (
            canEdit && (
              <button className="primary" disabled={busy || !snapshot || !!dirty} onClick={install}>
                {t(official ? '绑定 Superpowers' : '安装并绑定 Superpowers')}
              </button>
            )
          )}
          {dirty && <p className="muted small">{t('请先保存或重新加载当前选择。')}</p>}
        </div>
      )}
      {!snapshot && !error && <p role="status">{t('正在读取技能…')}</p>}
      {snapshot && (
        <>
          {!snapshot.items.length ? (
            <p className="muted">{t('企业尚未安装技能，可从技能库中添加。')}</p>
          ) : (
            <ul className="employee-skill-options">
              {snapshot.items.map((skill) => (
                <li key={skill.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(skill.id)}
                      disabled={
                        !canEdit || busy || (!selected.includes(skill.id) && selected.length >= 8)
                      }
                      onChange={(e) => {
                        setNotice('')
                        setSelected(
                          e.target.checked
                            ? [...selected, skill.id]
                            : selected.filter((id) => id !== skill.id),
                        )
                      }}
                    />
                    <span>
                      <strong>{skill.name}</strong> <small>{skill.version}</small>
                      <span className="employee-skill-description">{skill.description}</span>
                    </span>
                  </label>
                  {skill.provenance?.modules && (
                    <details>
                      <summary>
                        {t('包含的技能')} · {skill.provenance.modules.length}
                      </summary>
                      <ul>
                        {skill.provenance.modules.map((name) => (
                          <li key={name}>{name}</li>
                        ))}
                      </ul>
                      {skill.provenance.sourceUrl?.startsWith('https://github.com/') && (
                        <a href={skill.provenance.sourceUrl} target="_blank" rel="noreferrer">
                          {t('查看官方来源')} · {skill.provenance.commit?.slice(0, 12)}
                        </a>
                      )}
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && (
            <div className="employee-actions">
              <button className="primary" disabled={busy || !dirty} onClick={save}>
                {t(busy ? '正在处理…' : '保存技能绑定')}
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  setNotice('')
                  setReload((n) => n + 1)
                }}
              >
                {t('重新加载')}
              </button>
              {dirty && <span className="muted small">{t('有未保存的选择')}</span>}
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {t(error)}{' '}
          <button disabled={busy} onClick={() => setReload((n) => n + 1)}>
            {t('重新加载')}
          </button>
        </p>
      )}
      {notice && <p role="status">{t(notice)}</p>}
      <p className="muted small">
        {t(
          employeeId === 'code-agent'
            ? '技能可按需读取开发方法。创建项目工作区后，可在对话中开启执行，修改文件并运行代码和测试。'
            : '技能指导对话和文字任务，可按需读取具体方法。',
        )}
      </p>
    </section>
  )
}
