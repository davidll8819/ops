import { useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'
import { EmployeeAcceptance, type AcceptanceSession } from './EmployeeAcceptance'

type Deliverables = {
  workspace: null | {
    name: string
    revision: number
    updatedAt: string
    activeRunId: string | null
  }
  entries: { path: string; title: string; size: number }[]
}

type Preview = {
  url: string
  expiresAt: string
  revision: number
  title: string
  entry: string
}
type SavedVersion = {
  id: string
  label: string
  kind: 'manual' | 'before_restore'
  sourceRevision: number
  createdAt: string
  fileCount: number
  bytes: number
}

export function EmployeeDeliverables({
  base,
  projectId,
  canEdit,
  onRestored,
  onPendingChange,
  projectRevision,
  activeRunId,
  requestPending,
  onChat,
  onProject,
  onFeedback,
  selectedVersionId,
  onVersionChange: setSelectedVersionId,
  acceptanceSessions,
  onAcceptanceSessionChange,
}: {
  base: string
  projectId: string
  canEdit: boolean
  onRestored: () => void
  onPendingChange: (pending: boolean) => void
  projectRevision?: number
  activeRunId?: string | null
  requestPending: boolean
  onChat: () => void
  onProject: () => void
  onFeedback: (text: string) => void
  selectedVersionId: string
  onVersionChange: (versionId: string) => void
  acceptanceSessions: Record<string, AcceptanceSession | undefined>
  onAcceptanceSessionChange: (versionId: string, session: AcceptanceSession | null) => void
}) {
  const projectEndpoint = `${base}/employees/code-agent/projects/${projectId}`
  const endpoint = selectedVersionId
    ? `${projectEndpoint}/versions/${selectedVersionId}/deliverables`
    : `${projectEndpoint}/workspace/deliverables`
  const [versions, setVersions] = useState<SavedVersion[]>([])
  const [versionsError, setVersionsError] = useState('')
  const [versionsLoading, setVersionsLoading] = useState(true)
  const [versionLabel, setVersionLabel] = useState('')
  const [versionBusy, setVersionBusy] = useState(false)
  const [restoreReady, setRestoreReady] = useState(false)
  const [versionNotice, setVersionNotice] = useState('')
  const [acceptanceLocked, setAcceptanceLocked] = useState(false)
  const mounted = useRef(false)
  const [snapshot, setSnapshot] = useState<Deliverables | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [selectedPath, setSelectedPath] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [expired, setExpired] = useState(false)
  const listRequest = useRef(0)
  const previewRequest = useRef(0)
  const selectedVersion = versions.find((version) => version.id === selectedVersionId)
  const mutationBlocked =
    !canEdit ||
    versionBusy ||
    acceptanceLocked ||
    requestPending ||
    !!activeRunId ||
    projectRevision == null
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    let live = true
    setVersionsLoading(true)
    api<{ versions: SavedVersion[] }>(`${projectEndpoint}/versions`)
      .then((data) => {
        if (!live) return
        setVersions(data.versions)
        setVersionsError('')
      })
      .catch((failure: Error) => {
        if (live) setVersionsError(failure.message)
      })
      .finally(() => {
        if (live) setVersionsLoading(false)
      })
    return () => {
      live = false
    }
  }, [projectEndpoint, refreshVersion])

  useEffect(() => {
    const request = ++listRequest.current
    previewRequest.current += 1
    setPreviewLoading(false)
    setLoading(true)
    setError('')
    api<Deliverables>(endpoint)
      .then((data) => {
        if (request !== listRequest.current) return
        setSnapshot(data)
        setSelectedPath((path) =>
          data.entries.some((entry) => entry.path === path) ? path : data.entries[0]?.path || '',
        )
      })
      .catch((failure) => {
        if (request === listRequest.current) {
          setSnapshot(null)
          setError((failure as Error).message)
        }
      })
      .finally(() => {
        if (request === listRequest.current) setLoading(false)
      })
    return () => {
      listRequest.current += 1
      previewRequest.current += 1
    }
  }, [endpoint, projectRevision, activeRunId, requestPending, refreshVersion])

  const workspace = snapshot?.workspace
  const entry = snapshot?.entries.find((item) => item.path === selectedPath)
  const updating =
    !selectedVersionId && Boolean(requestPending || activeRunId || workspace?.activeRunId)
  const versionPending =
    !selectedVersionId &&
    workspace != null &&
    projectRevision != null &&
    workspace.revision < projectRevision
  const unavailable = loading || Boolean(error) || updating || versionPending
  const changed = Boolean(
    preview &&
    (preview.revision !== workspace?.revision ||
      (!selectedVersionId && projectRevision != null && preview.revision < projectRevision)),
  )
  const visiblePreview =
    preview && entry?.path === preview.entry && !changed && !expired ? preview : null

  useEffect(() => {
    if (!preview) return
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    )
    return () => window.clearTimeout(timer)
  }, [preview])

  function stopPreview() {
    previewRequest.current += 1
    setPreview(null)
    setPreviewLoading(false)
    setPreviewError('')
    setExpired(false)
  }

  async function startPreview() {
    if (!workspace || !entry || unavailable || previewLoading) return
    const request = ++previewRequest.current
    const revision = workspace.revision
    const path = entry.path
    setPreviewLoading(true)
    setPreviewError('')
    setPreview(null)
    setExpired(false)
    try {
      const data = await api<Preview>(`${endpoint}/preview`, { entry: path, revision })
      if (request !== previewRequest.current) return
      const url = new URL(data.url, window.location.origin)
      if (
        !data.url.startsWith('/project-preview/') ||
        url.origin !== window.location.origin ||
        !url.pathname.startsWith('/project-preview/') ||
        data.entry !== path ||
        data.revision !== revision ||
        !Number.isFinite(Date.parse(data.expiresAt)) ||
        Date.parse(data.expiresAt) <= Date.now()
      )
        throw new Error('试玩暂时无法打开，请重新加载成果。')
      setPreview(data)
    } catch (failure) {
      if (request === previewRequest.current) setPreviewError((failure as Error).message)
    } finally {
      if (request === previewRequest.current) setPreviewLoading(false)
    }
  }

  return (
    <section className="employee-deliverables" aria-label={t('成果')}>
      <div className="heading-row employee-deliverables-heading">
        <div>
          <h2>{t('成果')}</h2>
          <p className="muted small">{t('在这里试玩网页成品，也可以下载 ZIP 交给使用者。')}</p>
        </div>
        <button disabled={loading} onClick={() => setRefreshVersion((value) => value + 1)}>
          {t(loading ? '刷新中…' : '刷新成果')}
        </button>
      </div>
      <section className="employee-versions" aria-label={t('项目版本')}>
        <label>
          {t('查看版本')}
          <select
            value={selectedVersionId}
            disabled={versionsLoading || versionBusy || acceptanceLocked}
            onChange={(event) => {
              stopPreview()
              setSnapshot(null)
              setSelectedPath('')
              setSelectedVersionId(event.target.value)
              setRestoreReady(false)
              setVersionNotice('')
            }}
          >
            <option value="">{t('当前文件')}</option>
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.label} · {t(version.kind === 'before_restore' ? '恢复前备份' : '保存版本')}{' '}
                · {new Date(version.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        {selectedVersion && (
          <p className="muted small">
            {t('文件版本')} {selectedVersion.sourceRevision} · {selectedVersion.fileCount}{' '}
            {t('个文件')} · {new Date(selectedVersion.createdAt).toLocaleString()}
          </p>
        )}
        {canEdit && (
          <form
            className="employee-version-save"
            onSubmit={async (event) => {
              event.preventDefault()
              if (mutationBlocked || !versionLabel.trim()) return
              setVersionBusy(true)
              onPendingChange(true)
              setVersionsError('')
              setVersionNotice('')
              try {
                const result = await api<{ version: SavedVersion }>(`${projectEndpoint}/versions`, {
                  label: versionLabel.trim(),
                  revision: projectRevision,
                })
                if (!mounted.current) return
                setVersions((items) => [result.version, ...items])
                setVersionLabel('')
                setVersionNotice('当前全部项目文件已保存，可随时恢复。')
              } catch (failure) {
                if (mounted.current) setVersionsError((failure as Error).message)
              } finally {
                onPendingChange(false)
                if (mounted.current) setVersionBusy(false)
              }
            }}
          >
            <label>
              {t('保存当前文件为版本')}
              <input
                required
                maxLength={80}
                placeholder={t('例如：第一版完成')}
                value={versionLabel}
                disabled={versionBusy}
                onChange={(event) => setVersionLabel(event.target.value)}
              />
            </label>
            <button disabled={mutationBlocked || !versionLabel.trim()}>
              {t(versionBusy ? '处理中…' : '保存版本')}
            </button>
          </form>
        )}
        {selectedVersion && canEdit && (
          <div className="employee-version-restore">
            {restoreReady ? (
              <>
                <p>
                  {t(
                    '恢复会替换当前项目的全部文件，并先自动保存一份“恢复前备份”。对话和执行记录会保留，之后也可恢复该备份。',
                  )}
                </p>
                <button
                  disabled={mutationBlocked}
                  onClick={async () => {
                    if (mutationBlocked) return
                    setVersionBusy(true)
                    onPendingChange(true)
                    setVersionsError('')
                    try {
                      await api(`${projectEndpoint}/versions/${selectedVersion.id}/restore`, {
                        revision: projectRevision,
                      })
                      onRestored()
                      if (!mounted.current) return
                      stopPreview()
                      setSnapshot(null)
                      setSelectedVersionId('')
                      setRestoreReady(false)
                      setRefreshVersion((value) => value + 1)
                      setVersionNotice('已恢复所选版本，恢复前的全部文件已保存为备份。')
                    } catch (failure) {
                      if (mounted.current) setVersionsError((failure as Error).message)
                    } finally {
                      onPendingChange(false)
                      if (mounted.current) setVersionBusy(false)
                    }
                  }}
                >
                  {t(versionBusy ? '正在恢复…' : '备份当前文件并恢复此版本')}
                </button>
                <button disabled={versionBusy} onClick={() => setRestoreReady(false)}>
                  {t('取消')}
                </button>
              </>
            ) : (
              <button disabled={mutationBlocked} onClick={() => setRestoreReady(true)}>
                {t('恢复此版本…')}
              </button>
            )}
          </div>
        )}
        {versionsLoading && (
          <p role="status" className="muted small">
            {t('正在读取保存版本…')}
          </p>
        )}
        {versionsError && (
          <p className="error" role="alert">
            {t(versionsError)}
          </p>
        )}
        {versionNotice && (
          <p role="status" className="muted small">
            {t(versionNotice)}
          </p>
        )}
      </section>
      {error && (
        <p className="error" role="alert">
          {t(error)}
        </p>
      )}
      {!snapshot && loading && <p role="status">{t('正在读取成果…')}</p>}
      {updating && (
        <p className="employee-project-running" role="status">
          {t('正在更新成果，完成后可打开试玩或下载成品。')}
          {visiblePreview && ` ${t('下方保留的是更新前的试玩。')}`}
        </p>
      )}
      {snapshot && (!workspace || !snapshot.entries.length) && (
        <div className="employee-deliverables-empty">
          <p>{t('还没有可试玩的网页成品，让龙傲天生成 index.html 后会出现在这里。')}</p>
          <div className="employee-deliverables-actions">
            <button className="primary" onClick={onChat}>
              {t('返回对话')}
            </button>
            <button onClick={onProject}>{t('查看项目工作区')}</button>
          </div>
        </div>
      )}
      {workspace && entry && (
        <div className="employee-deliverables-card">
          <div className="employee-deliverables-title">
            <h3>{entry.title || workspace.name || t('网页作品')}</h3>
            <p className="muted small">
              {t('版本')} {workspace.revision} · {t('更新于')}{' '}
              <time dateTime={workspace.updatedAt}>
                {new Date(workspace.updatedAt).toLocaleString()}
              </time>
            </p>
          </div>
          {snapshot.entries.length > 1 && (
            <label className="employee-deliverables-entry">
              {t('选择作品')}
              <select
                value={selectedPath}
                onChange={(event) => {
                  stopPreview()
                  setSelectedPath(event.target.value)
                }}
              >
                {snapshot.entries.map((item) => (
                  <option key={item.path} value={item.path}>
                    {item.title || t('网页作品')} · {item.path}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="employee-deliverables-actions">
            <button
              className="primary"
              disabled={unavailable || previewLoading}
              onClick={() => void startPreview()}
            >
              {t(previewLoading ? '正在打开…' : preview ? '重新加载' : '打开试玩')}
            </button>
            {unavailable ? (
              <button disabled>{t('下载成品')}</button>
            ) : (
              <a
                className="employee-deliverables-download"
                href={`${endpoint}/download?entry=${encodeURIComponent(entry.path)}&revision=${workspace.revision}`}
                download
              >
                {t('下载成品')}
              </a>
            )}
            {(preview || previewLoading) && <button onClick={stopPreview}>{t('停止预览')}</button>}
          </div>
          <p className="muted small employee-deliverables-download-note">
            {t('下载后解压，双击“打开作品.html”即可使用。')}
          </p>
          {previewError && (
            <p className="error" role="alert">
              {t(previewError)}
            </p>
          )}
          {changed ? (
            <p className="employee-deliverables-notice" role="status">
              {t('有新版本，重新加载后可继续试玩。')}
            </p>
          ) : expired ? (
            <p className="employee-deliverables-notice" role="status">
              {t('本次试玩已到期，点击“重新加载”可再次打开。')}
            </p>
          ) : null}
          {visiblePreview ? (
            <div className="employee-deliverables-preview">
              <iframe
                key={visiblePreview.url}
                src={visiblePreview.url}
                title={`${visiblePreview.title || entry.title || t('网页作品')} · ${t('试玩')}`}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
              />
              <p className="muted small">
                {t('本次试玩有效期为 15 分钟。重新加载会重新开始，离开成果页会停止预览。')}
              </p>
            </div>
          ) : (
            <div className="employee-deliverables-placeholder">
              <p>
                {t(
                  previewLoading
                    ? '正在准备试玩…'
                    : preview
                      ? '点击“重新加载”，即可继续体验作品。'
                      : '点击“打开试玩”，即可在这里体验作品。',
                )}
              </p>
            </div>
          )}
        </div>
      )}
      <EmployeeAcceptance
        endpoint={projectEndpoint}
        versionId={selectedVersionId}
        versionLabel={selectedVersion?.label || ''}
        sessions={acceptanceSessions}
        onSessionChange={onAcceptanceSessionChange}
        entries={snapshot?.entries || []}
        canEdit={canEdit}
        onLockChange={setAcceptanceLocked}
        feedbackPending={requestPending}
        onFeedback={onFeedback}
      />
    </section>
  )
}
