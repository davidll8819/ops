import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { t } from '@/i18n'
import { api } from './api'
import { ArchiveDocuments } from './ArchiveDocuments'
import { ArchiveSources } from './ArchiveSources'
import type { ComparisonReference } from './archive-comparisons'
import type {
  ArchiveCitation,
  ArchiveFileReference,
  ArchiveSearchReference,
} from './archive-documents'
import './archive-search.css'
import type { OperationsBrief } from './operations/models'

export type Conversation = {
  revision: number
  messages: {
    id: string
    role: string
    text: string
    skillReads?: { name: string; path: string }[]
    runId?: string
    files?: ArchiveFileReference[]
    citations?: ArchiveCitation[]
    documentCoverage?: string
    comparison?: ComparisonReference
    archiveSearch?: ArchiveSearchReference
  }[]
}
export function DepartmentChat(props: ComponentProps<typeof DepartmentChatSession>) {
  return (
    <DepartmentChatSession
      key={`${props.base}/${props.department}/${props.project?.id || ''}`}
      {...props}
    />
  )
}

function DepartmentChatSession({
  base,
  department,
  openSettings,
  initial = '',
  image,
  employeeName,
  project,
  archiveDocuments = false,
  onOperations,
}: {
  base: string
  department: string
  openSettings: () => void
  initial?: string
  image?: string
  employeeName?: string
  archiveDocuments?: boolean
  onOperations?: (brief: OperationsBrief) => void
  project?: {
    id: string | null
    draft: string
    onDraftChange: (value: string, submitted?: string) => void
    requestPending: boolean
    error: string
    onErrorChange: (message: string) => void
    refreshVersion: number
    ready: boolean
    available: boolean
    activeRunId?: string | null
    canEdit: boolean
    onOpen: (runId?: string) => void
    onDeliverables?: () => void
    onRefresh: () => void
    onPendingChange: (pending: boolean) => void
  }
}) {
  const [conversation, setConversation] = useState<Conversation>({ revision: 0, messages: [] }),
    [input, setInput] = useState(initial),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('')
  const [execute, setExecute] = useState(true)
  const [handing, setHanding] = useState('')
  const [archiveSearch, setArchiveSearch] = useState(false)
  const [comparisonEpoch, setComparisonEpoch] = useState(0)
  const archiveAnswerPending = useRef(false)
  const [archiveSelection, setArchiveSelection] = useState<{ ids: string[]; ready: boolean }>({
    ids: [],
    ready: false,
  })
  const [activeComparison, setActiveComparison] = useState<ComparisonReference | null>(null)
  const [comparisonOpen, setComparisonOpen] = useState<{ id: string; sequence: number } | null>(
    null,
  )
  const activeComparisonRef = useRef<ComparisonReference | null>(null)
  const chatScope = useRef(0)
  const sending = useRef(false)
  const changeComparison = useCallback((value: ComparisonReference | null) => {
    if (archiveAnswerPending.current) return
    if (value) setArchiveSearch(false)
    if (activeComparisonRef.current?.id !== value?.id) chatScope.current++
    activeComparisonRef.current = value
    setActiveComparison(value)
  }, [])
  const [conversationRefresh, setConversationRefresh] = useState(0)
  const withDocuments = archiveDocuments && department === 'archive' && !image
  const conversationRequest = useRef(0)
  const mounted = useRef(false)
  const execution = department === 'dev' ? project : undefined
  const projectId = execution?.id
  const refreshVersion = execution?.refreshVersion
  const conversationEndpoint = `${base}/departments/${department}/conversation${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`
  const draft = execution ? execution.draft : input
  const pending = busy || execution?.requestPending
  const displayError = execution ? execution.error : error
  const activeRunId = execution?.activeRunId
  const projectReadOnly = Boolean(projectId && !execution?.canEdit)
  const canExecute = Boolean(execution?.canEdit && execution.ready && execution.available)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    let live = true
    const request = ++conversationRequest.current
    setLoading(true)
    api<Conversation>(conversationEndpoint)
      .then((r) => {
        if (live && request === conversationRequest.current) {
          setConversation(r)
          setError('')
        }
      })
      .catch((e) => {
        if (live) setError(e.message)
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [conversationEndpoint, activeRunId, refreshVersion, conversationRefresh])
  async function send(
    submittedText: string,
    selectedComparison = activeComparisonRef.current,
    preserveDraft = false,
  ) {
    if (
      !submittedText.trim() ||
      pending ||
      sending.current ||
      !!handing ||
      loading ||
      activeRunId ||
      projectReadOnly ||
      (withDocuments && !selectedComparison && !archiveSearch && !archiveSelection.ready)
    )
      return
    sending.current = true
    const scope = chatScope.current
    setBusy(true)
    setError('')
    execution?.onErrorChange('')
    const submittedSearch = withDocuments && archiveSearch && !selectedComparison
    archiveAnswerPending.current = Boolean(submittedSearch)
    const submittedFiles =
      withDocuments && !selectedComparison && !submittedSearch ? [...archiveSelection.ids] : []
    const executeRequest = execute && canExecute
    execution?.onPendingChange(true)
    try {
      const response = await api<Conversation>(`${base}/departments/${department}/chat`, {
        text: submittedText,
        revision: conversation.revision,
        ...(projectId ? { projectId } : {}),
        ...(image ? { image } : {}),
        ...(submittedFiles.length ? { fileIds: submittedFiles } : {}),
        ...(selectedComparison ? { comparisonId: selectedComparison.id } : {}),
        ...(submittedSearch ? { archiveSearch: true } : {}),
        ...(executeRequest ? { execute: true } : {}),
      })
      if (mounted.current) {
        conversationRequest.current += 1
        if (scope === chatScope.current) {
          setConversation(response)
          if (!preserveDraft) setInput((draft) => (draft === submittedText ? '' : draft))
        } else {
          // The server saved this reply even though its comparison is no longer
          // active. Keep the next send current without restoring obsolete UI.
          setConversation((current) =>
            response.revision > current.revision
              ? { ...current, revision: response.revision }
              : current,
          )
        }
      }
      execution?.onDraftChange('', submittedText)
    } catch (e) {
      if (mounted.current && scope === chatScope.current) setError((e as Error).message)
      execution?.onErrorChange((e as Error).message)
      if (execution && mounted.current) {
        const request = ++conversationRequest.current
        try {
          const saved = await api<Conversation>(conversationEndpoint)
          if (mounted.current && request === conversationRequest.current) setConversation(saved)
        } catch {
          // Keep the original failure visible; project refresh also retries status.
        }
      }
    } finally {
      execution?.onPendingChange(false)
      execution?.onRefresh()
      sending.current = false
      archiveAnswerPending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const chat = (
    <>
      <div className="heading-row">
        <h2>{t('与部门对话')}</h2>
        {withDocuments && (
          <label className="archive-chat-search">
            <input
              type="checkbox"
              checked={archiveSearch}
              disabled={!!pending || loading}
              onChange={(e) => {
                if (sending.current) return
                chatScope.current++
                setArchiveSearch(e.target.checked)
                if (e.target.checked) {
                  setComparisonEpoch((v) => v + 1)
                  changeComparison(null)
                }
              }}
            />
            {t('检索已归档资料')}
          </label>
        )}
        <button onClick={openSettings}>{t('模型设置')}</button>
      </div>
      {withDocuments && activeComparison && (
        <div className="archive-active-comparison" role="status">
          {t('比对问答')} · {activeComparison.oldVersion.name} → {activeComparison.newVersion.name}
          <button type="button" onClick={() => changeComparison(null)}>
            {t('退出比对问答')}
          </button>
        </div>
      )}
      <div role="log" className="department-messages">
        {loading && <p role="status">{t('正在读取对话…')}</p>}
        {!conversation.messages.length && (
          <p>
            {t(
              projectId
                ? '写下工作要求，回复、文件和成果会保存在当前项目中。'
                : '写下工作要求，回复与结果会保存到当前企业的个人对话中。',
            )}
          </p>
        )}
        {conversation.messages.map((m) => (
          <article key={m.id} className={m.role}>
            <strong>{m.role === 'user' ? t('我') : employeeName || t('部门回复')}</strong>
            <p>{m.text}</p>
            {department === 'content_ops' && onOperations && m.role === 'assistant' && (
              <button
                type="button"
                disabled={!!pending || loading || !!handing}
                onClick={async () => {
                  if (sending.current || handing) return
                  setHanding(m.id)
                  setError('')
                  try {
                    const data = await api<{ brief: OperationsBrief }>(
                      `${base}/operations/briefs`,
                      { messageId: m.id, revision: conversation.revision },
                    )
                    if (mounted.current) onOperations(data.brief)
                  } catch (e) {
                    if (mounted.current) setError((e as Error).message)
                  } finally {
                    if (mounted.current) setHanding('')
                  }
                }}
              >
                {t(handing === m.id ? '正在保存交接…' : '带入运营工作台')}
              </button>
            )}
            {!!m.files?.length && (
              <p className="archive-message-files">
                {t('本次使用的文档')}：{m.files.map((file) => file.name).join('、')}
              </p>
            )}
            {m.archiveSearch && (
              <p className="archive-message-files">
                {t('本次检索正式档案')} · {t('关键词匹配')} {m.archiveSearch.matchedCount} ·{' '}
                {t('本轮使用')} {m.archiveSearch.records.length}
                {!!m.archiveSearch.records.length &&
                  `：${m.archiveSearch.records.map((r) => `${r.archiveNumber} ${r.filename}`).join('、')}`}
              </p>
            )}
            {withDocuments && m.comparison && (
              <button
                type="button"
                className="department-run-link"
                disabled={!!pending && archiveSearch}
                onClick={() => {
                  if (archiveAnswerPending.current) return
                  chatScope.current++
                  changeComparison(null)
                  setArchiveSearch(false)
                  setComparisonOpen((request) => ({
                    id: m.comparison!.id,
                    sequence: (request?.sequence || 0) + 1,
                  }))
                }}
              >
                {t('查看本次比对')}
              </button>
            )}
            <ArchiveSources base={base} citations={m.citations} coverage={m.documentCoverage} />
            {m.runId && execution && (
              <div className="department-chat-actions">
                {execution.onDeliverables && (
                  <button className="department-run-link" onClick={execution.onDeliverables}>
                    {t('查看成果')}
                  </button>
                )}
                <button className="department-run-link" onClick={() => execution.onOpen(m.runId)}>
                  {t('查看项目与执行记录')} ↗
                </button>
              </div>
            )}
            {!!m.skillReads?.length && (
              <details className="department-skill-reads">
                <summary>
                  {t('本次读取的技能')} · {m.skillReads.length}
                </summary>
                <ul>
                  {m.skillReads.map((read) => (
                    <li key={read.path}>
                      {read.name} · {read.path.split('/').slice(1).join('/')}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </article>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void send(draft)
        }}
      >
        {department === 'content_ops' && (
          <div className="department-chat-actions ops-chat-templates" aria-label="运营工作模板">
            {[
              [
                '内容策划与文案',
                '请帮我做内容策划与可直接使用的文案。\n产品/主题：\n受众：\n发布平台：\n核心卖点：\n风格和限制：\n交付：选题、标题、正文、行动引导、素材清单与验收标准。先做方案，不发布。',
              ],
              [
                '视频脚本与分镜',
                '请编写视频脚本与逐镜分镜。\n产品/主题：\n受众与平台：\n总时长：\n风格：\n参考素材：\n交付：每镜时长、画面、口播/字幕、素材提示词和验收标准。先做方案，不生成、不发布。',
              ],
              [
                '图片与视频素材',
                '请制定图片与视频素材制作方案。\n主题/用途：\n画幅和分辨率：\n数量/视频时长：\n风格与必须保留的元素：\n参考素材链接：\n交付：素材清单、逐项提示词、制作顺序与验收标准。先核对方案，再到工作台制作，不发布。',
              ],
            ].map(([label, template]) => (
              <button
                type="button"
                key={label}
                disabled={!!pending || !!handing}
                onClick={() => setInput((value) => (value ? value + '\n\n' + template : template))}
              >
                {t(label)}
              </button>
            ))}
          </div>
        )}
        <label>
          {t('工作要求')}
          <textarea
            required
            value={draft}
            onChange={(e) =>
              execution ? execution.onDraftChange(e.target.value) : setInput(e.target.value)
            }
            rows={withDocuments || department === 'content_ops' ? 8 : 4}
            maxLength={20000}
          />
        </label>
        <div className="department-chat-actions">
          <button
            className="primary"
            disabled={
              pending ||
              !!handing ||
              loading ||
              !!activeRunId ||
              !draft.trim() ||
              projectReadOnly ||
              (withDocuments && !activeComparison && !archiveSearch && !archiveSelection.ready)
            }
          >
            {t(pending || activeRunId ? '正在处理…' : '发送')}
          </button>
          {execution && (
            <label className="department-execution-toggle">
              <input
                type="checkbox"
                checked={execute && canExecute}
                disabled={!canExecute || pending || !!activeRunId}
                onChange={(e) => setExecute(e.target.checked)}
              />
              {t('在项目工作区执行')}
            </label>
          )}
        </div>
        {execution && !canExecute && (
          <p className="muted small department-execution-note">
            {t(
              !execution.canEdit
                ? projectId
                  ? '仅企业所有者或管理员可以修改项目或发送项目对话。'
                  : '可以继续普通对话；仅企业所有者或管理员可以创建和执行项目。'
                : execution.ready
                  ? '执行环境暂不可用，可以继续普通对话。'
                  : '创建项目工作区后，可让龙傲天修改文件、运行代码和测试。',
            )}{' '}
            <button type="button" onClick={() => execution.onOpen()}>
              {t('查看项目工作区')}
            </button>
          </p>
        )}
        {activeRunId && (
          <p className="muted small department-execution-note" role="status">
            {t('项目正在执行，完成后可继续发送。')}{' '}
            <button type="button" onClick={() => execution?.onOpen(activeRunId)}>
              {t('查看执行进度')}
            </button>
          </p>
        )}
      </form>
      {(displayError || error) && (
        <p role="alert" className="error">
          {t(displayError || error)}{' '}
          {execution && <button onClick={() => execution.onOpen()}>{t('查看执行记录')}</button>}{' '}
          <button onClick={openSettings}>{t('检查设置')}</button>
          <button onClick={() => setConversationRefresh((value) => value + 1)}>
            {t('重新读取对话')}
          </button>
        </p>
      )}
    </>
  )
  return (
    <section className={`department-chat${withDocuments ? ' archive-document-chat' : ''}`}>
      {withDocuments ? (
        <>
          <div className="archive-workspace">
            <ArchiveDocuments
              key={base}
              base={base}
              disabled={!!pending}
              onSelectionChange={(ids, ready) => setArchiveSelection({ ids, ready })}
              onComparisonChange={changeComparison}
              onComparisonSummary={(value) => {
                if (archiveAnswerPending.current) return
                changeComparison(value)
                void send('总结改动', value, true)
              }}
              comparisonOpen={comparisonOpen}
              comparisonEpoch={comparisonEpoch}
              comparisonLocked={!!pending && archiveSearch}
            />
          </div>
          <div className="archive-chat-pane">{chat}</div>
        </>
      ) : (
        chat
      )}
    </section>
  )
}
