import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'

type ProjectStep = {
  id: string
  tool: string
  summary: string
  status: string
  result?: Record<string, unknown> | null
}
export type EmployeeProjectSnapshot = {
  workspace: null | {
    id: string
    name: string
    revision: number
    files: { path: string; size: number }[]
    activeRunId: string | null
    updatedAt: string
  }
  runtime: { available: boolean; reason?: string; environment?: unknown }
  runs: {
    id: string
    state: string
    summary: string
    createdAt: string
    finishedAt?: string | null
    steps: ProjectStep[]
  }[]
}
type ProjectFile = { path: string; content: string; size: number }

const states: Record<string, string> = {
  running: '执行中',
  pending: '等待执行',
  completed: '已完成',
  succeeded: '成功',
  success: '成功',
  failed: '失败',
  interrupted: '已中断',
}
const toolNames: Record<string, string> = {
  workspace_list_files: '列出文件',
  workspace_read_file: '读取文件',
  workspace_write_file: '写入文件',
  workspace_run_command: '运行命令',
  read_skill: '读取技能',
}
function sizeLabel(size: number) {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KiB`
}
function readable(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '')
}
function StepResult({ result }: { result: ProjectStep['result'] }) {
  if (!result) return null
  const {
    exitCode,
    stdout,
    stderr,
    timedOut,
    truncated,
    path,
    bytes,
    error,
    snapshotError,
    ...extra
  } = result
  return (
    <div className="employee-project-result">
      {Object.hasOwn(result, 'exitCode') && (
        <p>
          {t('退出码')}：<strong>{exitCode == null ? t('未取得') : readable(exitCode)}</strong>
          {timedOut === true && <span className="error"> · {t('执行超时')}</span>}
          {truncated === true && <span> · {t('输出已截断')}</span>}
        </p>
      )}
      {path != null && (
        <p>
          <code>{readable(path)}</code>
          {typeof bytes === 'number' && ` · ${sizeLabel(bytes)}`}
        </p>
      )}
      {error != null && <pre className="error">{readable(error)}</pre>}
      {snapshotError != null && (
        <div className="error">
          <strong>{t('文件快照保存失败')}</strong>
          <pre>{readable(snapshotError)}</pre>
        </div>
      )}
      {stdout != null && (
        <div>
          <span className="muted small">{t('标准输出')}</span>
          <pre>{readable(stdout) || t('无输出')}</pre>
        </div>
      )}
      {stderr != null && (
        <div>
          <span className="muted small">{t('标准错误')}</span>
          <pre>{readable(stderr) || t('无输出')}</pre>
        </div>
      )}
      {Object.keys(extra).length > 0 && <pre>{readable(extra)}</pre>}
    </div>
  )
}

export function EmployeeProject({
  workspaceEndpoint,
  refreshVersion,
  requestPending,
  selectedRunId,
  visible,
  onChange,
}: {
  workspaceEndpoint: string
  refreshVersion: number
  requestPending: boolean
  selectedRunId: string | null
  visible: boolean
  onChange: (snapshot: EmployeeProjectSnapshot | null) => void
}) {
  const endpoint = workspaceEndpoint
  const [snapshot, setSnapshot] = useState<EmployeeProjectSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [file, setFile] = useState<ProjectFile | null>(null)
  const [fileError, setFileError] = useState('')
  const [fileLoading, setFileLoading] = useState(false)
  const [fileReload, setFileReload] = useState(0)
  const requestId = useRef(0)
  const runsPanel = useRef<HTMLElement>(null)
  const refresh = useCallback(async () => {
    const current = ++requestId.current
    setLoading(true)
    try {
      const data = await api<EmployeeProjectSnapshot>(endpoint)
      if (current !== requestId.current) return
      setSnapshot(data)
      onChange(data)
      setError('')
    } catch (e) {
      if (current !== requestId.current) return
      setError((e as Error).message)
      onChange(null)
    } finally {
      if (current === requestId.current) setLoading(false)
    }
  }, [endpoint, onChange])
  useEffect(() => {
    void refresh()
    return () => {
      requestId.current += 1
    }
  }, [refresh, refreshVersion])
  const activeRunId = snapshot?.workspace?.activeRunId
  useEffect(() => {
    if (!activeRunId && !requestPending) return
    let live = true
    let timer: number
    const poll = async () => {
      await refresh()
      if (live) timer = window.setTimeout(poll, 3000)
    }
    timer = window.setTimeout(poll, 3000)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [activeRunId, requestPending, refresh])
  const workspace = snapshot?.workspace
  const filePath = workspace?.files.some((item) => item.path === selectedPath)
    ? selectedPath
    : workspace?.files[0]?.path || ''
  useEffect(() => {
    let live = true
    setFile(null)
    setFileError('')
    setFileLoading(Boolean(filePath))
    if (filePath) {
      api<ProjectFile>(`${endpoint}/file?path=${encodeURIComponent(filePath)}`)
        .then((data) => {
          if (live) setFile(data)
        })
        .catch((e) => {
          if (live) setFileError(e.message)
        })
        .finally(() => {
          if (live) setFileLoading(false)
        })
    }
    return () => {
      live = false
    }
  }, [endpoint, filePath, workspace?.revision, fileReload])
  useEffect(() => {
    if (visible && selectedRunId) {
      const selected = runsPanel.current?.querySelector(
        `[data-run-id="${CSS.escape(selectedRunId)}"]`,
      )
      const target = selected || runsPanel.current
      target?.scrollIntoView({ block: 'start' })
    }
  }, [visible, selectedRunId])

  return (
    <div className="employee-project-view" hidden={!visible}>
      <div className="heading-row employee-project-heading">
        <h2>{workspace?.name || t('项目工作区')}</h2>
        <div className="employee-project-actions">
          {workspace && (
            <a className="employee-project-download" href={`${endpoint}/download`} download>
              {t('下载 ZIP')}
            </a>
          )}
          <button
            disabled={loading}
            onClick={() => {
              setFileReload((n) => n + 1)
              void refresh()
            }}
          >
            {t(loading ? '刷新中…' : '刷新')}
          </button>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {t(error)}
        </p>
      )}
      {!snapshot && !error && <p role="status">{t('正在读取项目工作区…')}</p>}
      {snapshot && (
        <>
          <div className="employee-project-environment">
            <span
              className={`employee-project-status ${snapshot.runtime.available ? 'ready' : ''}`}
            >
              {t(snapshot.runtime.available ? '执行环境可用' : '执行环境不可用')}
            </span>
          </div>
          {!snapshot.runtime.available && snapshot.runtime.reason && (
            <p className="muted small">{t(snapshot.runtime.reason)}</p>
          )}
          <details className="employee-project-limits">
            <summary>{t('环境与使用范围')}</summary>
            <p>
              {t(
                '可创建和修改项目文件，运行 Node.js、npm、Python 3 与标准库测试。当前不联网，不支持安装外部依赖或网页服务预览。',
              )}
            </p>
            <p>
              {t(
                '每条命令最多 60 秒、512 MiB 内存；项目最多 200 个文件，单文件 1 MiB、合计 8 MiB。二进制文件可随项目下载，文本预览仅支持 UTF-8。',
              )}
            </p>
            <p>{t('项目按当前企业和用户独立保存，仅企业所有者和管理员可以创建或执行。')}</p>
          </details>
          {!workspace ? (
            <section className="employee-project-empty">
              <h3>{t('开始一个独立项目')}</h3>
              <p>{t('创建后，在对话中告诉龙傲天要开发或修改什么。文件和执行记录会保存在这里。')}</p>
              <p className="muted small">{t('使用上方“新建项目”创建项目。')}</p>
            </section>
          ) : (
            <>
              {activeRunId && (
                <p className="employee-project-running" role="status">
                  {t('龙傲天正在执行，文件与记录将自动刷新。')}
                </p>
              )}
              <section className="employee-project-files" aria-label={t('项目文件')}>
                <div className="heading-row">
                  <h3>
                    {t('项目文件')} <small>· {workspace.files.length}</small>
                  </h3>
                  <span className="muted small">
                    {t('版本')} {workspace.revision}
                  </span>
                </div>
                {!workspace.files.length ? (
                  <p className="muted small">
                    {t('还没有文件。回到对话，开启“在项目工作区执行”并描述你的需求。')}
                  </p>
                ) : (
                  <div className="employee-project-browser">
                    <ul className="employee-project-file-list" aria-label={t('选择文件')}>
                      {workspace.files.map((item) => (
                        <li key={item.path}>
                          <button
                            aria-pressed={filePath === item.path}
                            onClick={() => setSelectedPath(item.path)}
                          >
                            <span>{item.path}</span>
                            <small>{sizeLabel(item.size)}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                    <div className="employee-project-file-content">
                      <div className="employee-project-file-title">
                        <code>{filePath}</code>
                        <span>{t('只读预览')}</span>
                      </div>
                      {fileLoading && <p role="status">{t('正在读取文件…')}</p>}
                      {fileError && (
                        <p className="error" role="alert">
                          {t(fileError)}
                        </p>
                      )}
                      {file && (
                        <pre aria-label={`${t('文件内容')} ${file.path}`}>
                          {file.content || t('空文件')}
                        </pre>
                      )}
                    </div>
                  </div>
                )}
              </section>
            </>
          )}
          <section className="employee-project-runs" ref={runsPanel} aria-label={t('执行记录')}>
            <h3>{t('执行记录')}</h3>
            {!snapshot.runs.length && (
              <p className="muted small">
                {t('执行后将在这里保留每一步的工具结果、命令输出和退出码。')}
              </p>
            )}
            {selectedRunId && !snapshot.runs.some((run) => run.id === selectedRunId) && (
              <p className="muted small">{t('这条对话关联的运行未出现在最近记录中。')}</p>
            )}
            {snapshot.runs.map((run, index) => (
              <details
                key={`${run.id}/${selectedRunId === run.id}`}
                data-run-id={run.id}
                className={`employee-project-run ${selectedRunId === run.id ? 'selected' : ''}`}
                open={selectedRunId ? selectedRunId === run.id : index === 0}
              >
                <summary>
                  <span className={`employee-project-run-state ${run.state}`}>
                    {t(states[run.state] || run.state)}
                  </span>
                  <span>
                    {run.summary
                      ? `${run.summary.slice(0, 120)}${run.summary.length > 120 ? '…' : ''}`
                      : t('项目执行')}
                  </span>
                  <time dateTime={run.createdAt}>{new Date(run.createdAt).toLocaleString()}</time>
                </summary>
                {run.summary.length > 120 && (
                  <p className="employee-project-run-summary">{run.summary}</p>
                )}
                {run.finishedAt && (
                  <p className="muted small">
                    {t('结束时间')} · {new Date(run.finishedAt).toLocaleString()}
                  </p>
                )}
                {!run.steps.length && (
                  <p className="muted small">
                    {t(run.state === 'running' ? '正在准备执行步骤…' : '此运行没有工具执行记录。')}
                  </p>
                )}
                <ol className="employee-project-steps">
                  {run.steps.map((step) => (
                    <li key={step.id}>
                      <details open={step.status === 'failed'}>
                        <summary>
                          <strong>{t(toolNames[step.tool] || step.tool)}</strong>
                          <span>{step.summary}</span>
                          <small>{t(states[step.status] || step.status)}</small>
                        </summary>
                        <StepResult result={step.result} />
                      </details>
                    </li>
                  ))}
                </ol>
              </details>
            ))}
          </section>
        </>
      )}
    </div>
  )
}
