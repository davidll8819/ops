import { useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'

type Project = { id: string; name: string; isDefault: boolean }

export function DragonProjects({
  base,
  selectedId,
  canEdit,
  onSelect,
}: {
  base: string
  selectedId: string | null
  canEdit: boolean
  onSelect: (id: string | null) => void
}) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'new' | 'rename' | null>(null)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [reload, setReload] = useState(0)
  const mounted = useRef(false)
  const endpoint = `${base}/employees/code-agent/projects`
  const storageKey = `dragon-project:${base}`
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    let live = true
    setLoading(true)
    api<{ projects: Project[]; defaultProjectId: string | null }>(endpoint)
      .then((data) => {
        if (!live) return
        setProjects(data.projects)
        let saved: string | null = null
        try {
          saved = localStorage.getItem(storageKey)
        } catch {
          /* Storage may be disabled. */
        }
        const choice =
          data.projects.find((item) => item.id === saved)?.id ||
          data.projects.find((item) => item.id === data.defaultProjectId)?.id ||
          data.projects[0]?.id ||
          null
        onSelect(choice)
        setError('')
      })
      .catch((failure: Error) => {
        if (live) setError(failure.message)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [endpoint, storageKey, reload, onSelect])
  const select = (id: string | null) => {
    try {
      if (id) localStorage.setItem(storageKey, id)
      else localStorage.removeItem(storageKey)
    } catch {
      /* Selection still works without persistence. */
    }
    onSelect(id)
  }
  const current = projects.find((item) => item.id === selectedId)
  return (
    <section className="dragon-projects" aria-label={t('切换项目')}>
      <div className="dragon-projects-row">
        <label>
          {t('当前项目')}
          <select
            value={selectedId || ''}
            disabled={loading || saving}
            onChange={(event) => {
              select(event.target.value || null)
              setMode(null)
            }}
          >
            {!projects.length && (
              <option value="">{t(loading ? '正在读取项目…' : '尚未创建项目')}</option>
            )}
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {canEdit && (
          <>
            <button
              disabled={loading || saving || projects.length >= 20}
              onClick={() => {
                setMode('new')
                setName('')
              }}
            >
              {t('新建项目')}
            </button>
            <button
              disabled={!current || saving}
              onClick={() => {
                setMode('rename')
                setName(current?.name || '')
              }}
            >
              {t('重命名')}
            </button>
          </>
        )}
      </div>
      {mode && (
        <form
          className="dragon-projects-form"
          onSubmit={async (event) => {
            event.preventDefault()
            if (!canEdit || saving || !name.trim() || (mode === 'rename' && !selectedId)) return
            setSaving(true)
            setError('')
            try {
              const result = await api<{ project: Project }>(
                mode === 'new' ? endpoint : `${endpoint}/${selectedId}/rename`,
                { name: name.trim() },
              )
              if (!mounted.current) return
              setProjects((items) =>
                mode === 'new'
                  ? [...items, result.project]
                  : items.map((item) => (item.id === result.project.id ? result.project : item)),
              )
              select(result.project.id)
              setMode(null)
            } catch (failure) {
              if (mounted.current) setError((failure as Error).message)
            } finally {
              if (mounted.current) setSaving(false)
            }
          }}
        >
          <label>
            {t(mode === 'new' ? '新项目名称' : '项目名称')}
            <input
              autoFocus
              required
              maxLength={80}
              value={name}
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button className="primary" disabled={saving || !name.trim()}>
            {t(saving ? '保存中…' : mode === 'new' ? '创建项目' : '保存名称')}
          </button>
          <button type="button" disabled={saving} onClick={() => setMode(null)}>
            {t('取消')}
          </button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {t(error)} <button onClick={() => setReload((value) => value + 1)}>{t('重试')}</button>
        </p>
      )}
    </section>
  )
}
