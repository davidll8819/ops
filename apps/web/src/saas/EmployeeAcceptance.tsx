import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'
import { EmployeeVersionTests, TestEvidence } from './EmployeeVersionTests'
import { canDeliverTest, type TestHistory, type TestRun } from './version-tests'

type Item = { id: string; title: string; status: 'unchecked' | 'passed' | 'failed'; note: string }
type SystemCheck = {
  status: 'passed' | 'failed'
  entry: string
  snapshotSha256: string
  fileCount: number
  packageBytes: number
  checkedAt: string
  detail: string
}
type Delivery = {
  id: string
  versionId: string
  versionLabel: string
  sourceRevision: number
  label: string
  entry: string
  items: Item[]
  systemCheck: SystemCheck
  automatedTest: TestRun | null
  instructions: string
  limitations: string
  createdAt: string
}
type Draft = {
  versionId: string
  revision: number
  entry: string
  items: Item[]
  instructions: string
  limitations: string
  systemCheck: SystemCheck | null
  delivery: Delivery | null
  latestTest: TestRun | null
  testRuns: TestRun[]
}
export type AcceptanceSession = { draft: Draft; savedContent: string; label: string }
type Preview = { url: string; expiresAt: string; entry: string; title: string; revision: number }
const statusLabels = { unchecked: '未确认', passed: '通过', failed: '未通过' }
const content = (draft: Draft) =>
  JSON.stringify([draft.entry, draft.items, draft.instructions, draft.limitations])

function Evidence({ check }: { check: SystemCheck | null }) {
  return (
    <div className="employee-acceptance-evidence">
      <strong>
        {t('系统文件检查')} · {t(check ? statusLabels[check.status] : '尚未检查')}
      </strong>
      <p className="muted small">
        {t(
          '仅验证保存版本中的 HTML 文件与静态 ZIP 可以组装，不代表功能、浏览器兼容性或游戏逻辑已通过测试。',
        )}
      </p>
      {check && (
        <details>
          <summary>{t('查看文件检查证据')}</summary>
          <dl>
            <div>
              <dt>{t('入口')}</dt>
              <dd>{check.entry}</dd>
            </div>
            <div>
              <dt>{t('实际检查')}</dt>
              <dd>
                {check.fileCount} {t('个文件')} · {check.packageBytes} bytes
              </dd>
            </div>
            <div>
              <dt>SHA-256</dt>
              <dd>{check.snapshotSha256 || '—'}</dd>
            </div>
            <div>
              <dt>{t('检查时间')}</dt>
              <dd>{new Date(check.checkedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t('检查结果')}</dt>
              <dd>{check.detail}</dd>
            </div>
          </dl>
        </details>
      )}
    </div>
  )
}

function AcceptanceEditor({
  endpoint,
  versionId,
  versionLabel,
  session,
  onSessionChange,
  canEdit,
  entries,
  onLockChange,
  onDelivered,
  feedbackPending,
  onFeedback,
}: {
  endpoint: string
  versionId: string
  versionLabel: string
  session?: AcceptanceSession
  onSessionChange: (versionId: string, session: AcceptanceSession | null) => void
  canEdit: boolean
  entries: { path: string; title: string }[]
  onLockChange: (locked: boolean) => void
  onDelivered: () => void
  feedbackPending: boolean
  onFeedback: (text: string) => void
}) {
  const initialSession = useRef(session)
  const [draft, setDraft] = useState<Draft | null>(() => session?.draft || null)
  const [savedContent, setSavedContent] = useState(() => session?.savedContent || '')
  const [label, setLabel] = useState(() => session?.label || '')
  const [loading, setLoading] = useState(
    !session || content(session.draft) === session.savedContent,
  )
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  const [testHistory, setTestHistory] = useState<TestHistory>({ latestTest: null, testRuns: [] })
  const [testsReady, setTestsReady] = useState(false)
  const [testsBusy, setTestsBusy] = useState(false)
  const changeTests = useCallback((history: TestHistory, ready: boolean, pending: boolean) => {
    setTestHistory(history)
    setTestsReady(ready)
    setTestsBusy(pending)
  }, [])
  const live = useRef(false)
  const operation = useRef(0)
  const acceptanceEndpoint = `${endpoint}/versions/${versionId}/acceptance`
  const dirty = !!draft && content(draft) !== savedContent
  const frozen = !!draft?.delivery
  const locked = loading || !!busy || !canEdit || frozen
  const validItems =
    !!draft?.items.length &&
    draft.items.every(
      (item) => item.title.trim() && (item.status === 'unchecked' || item.note.trim()),
    )
  const complete =
    !!draft &&
    validItems &&
    draft.items.every((item) => item.status === 'passed') &&
    !!draft.entry &&
    !!draft.instructions.trim() &&
    !!draft.limitations.trim() &&
    draft.systemCheck?.status === 'passed' &&
    draft.systemCheck.entry === draft.entry &&
    testsReady &&
    !testsBusy &&
    canDeliverTest(testHistory.latestTest, versionId, draft.systemCheck.snapshotSha256)

  useEffect(() => {
    onLockChange(dirty || !!busy || testsBusy)
    return () => onLockChange(false)
  }, [dirty, busy, testsBusy, onLockChange])
  useEffect(() => {
    if (draft) onSessionChange(versionId, { draft, savedContent, label })
  }, [draft, savedContent, label, versionId, onSessionChange])
  useEffect(() => {
    live.current = true
    const request = ++operation.current
    if (
      reload === 0 &&
      initialSession.current &&
      content(initialSession.current.draft) !== initialSession.current.savedContent
    ) {
      return () => {
        live.current = false
        operation.current += 1
      }
    }
    setLoading(true)
    setDraft(null)
    setError('')
    api<{ acceptance: Draft }>(acceptanceEndpoint)
      .then(({ acceptance }) => {
        if (!live.current || request !== operation.current) return
        setDraft(acceptance)
        setSavedContent(content(acceptance))
      })
      .catch((failure: Error) => {
        if (live.current && request === operation.current) setError(failure.message)
      })
      .finally(() => {
        if (live.current && request === operation.current) setLoading(false)
      })
    return () => {
      live.current = false
      operation.current += 1
    }
  }, [acceptanceEndpoint, reload])

  function edit(update: Partial<Draft>) {
    if (locked || !draft) return
    setDraft({ ...draft, ...update })
    setNotice('')
  }
  async function mutate(kind: 'save' | 'check' | 'confirm') {
    if (!draft || locked || (kind !== 'save' && dirty)) return
    if (kind === 'confirm' && (!complete || !testHistory.latestTest)) return
    const request = ++operation.current
    setBusy(kind)
    setError('')
    setNotice('')
    try {
      if (kind === 'confirm') {
        const { delivery } = await api<{ delivery: Delivery }>(`${endpoint}/deliveries`, {
          versionId,
          acceptanceRevision: draft.revision,
          label: label.trim(),
          testRunId: testHistory.latestTest!.id,
        })
        if (!live.current || request !== operation.current) return
        setDraft({ ...draft, delivery })
        setNotice('正式交付已保存，验收记录与说明已冻结。')
        onDelivered()
      } else {
        const body =
          kind === 'save'
            ? {
                revision: draft.revision,
                entry: draft.entry,
                items: draft.items,
                instructions: draft.instructions,
                limitations: draft.limitations,
              }
            : { revision: draft.revision }
        const { acceptance } = await api<{ acceptance: Draft }>(
          `${acceptanceEndpoint}${kind === 'check' ? '/check' : ''}`,
          body,
          kind === 'save' ? 'PUT' : 'POST',
        )
        if (!live.current || request !== operation.current) return
        setDraft(acceptance)
        setSavedContent(content(acceptance))
        setNotice(kind === 'save' ? '验收草稿已保存。' : '系统文件检查结果已记录。')
      }
    } catch (failure) {
      if (live.current && request === operation.current) setError((failure as Error).message)
    } finally {
      if (live.current && request === operation.current) setBusy('')
    }
  }

  return (
    <details className="employee-acceptance" open>
      <summary>
        {t('验收与正式交付')}
        {frozen ? ` · ${t('已交付，只读')}` : dirty ? ` · ${t('有未保存修改')}` : ''}
      </summary>
      <p className="muted small">
        {t('先试玩所选保存版本，再记录实际观察。模型总结和历史执行记录不会自动成为验收结论。')}
      </p>
      {loading && <p role="status">{t('正在读取版本验收…')}</p>}
      {error && (
        <p role="alert" className="error">
          {t(error)}
        </p>
      )}
      {!loading && !busy && (
        <button
          onClick={() => {
            setNotice('')
            onSessionChange(versionId, null)
            setReload((value) => value + 1)
          }}
        >
          {t(dirty ? '放弃本地修改并重新读取' : '重新读取验收')}
        </button>
      )}
      {draft && (
        <>
          <p className="muted small">
            {t('验收草稿修订')} {draft.revision} · {t('固定保存版本')}{' '}
            {versionLabel || t('保存版本')}
          </p>
          {frozen && (
            <p role="status">
              {t('此版本已经正式交付。需要修改时，请创建新的保存版本并重新验收。')}
            </p>
          )}
          {frozen ? (
            <section className="employee-version-tests">
              <h4>{t('冻结的自动测试证据')}</h4>
              <TestEvidence run={draft.delivery?.automatedTest || null} />
              {!draft.delivery?.automatedTest && (
                <p className="muted small">{t('此历史交付没有自动测试记录。')}</p>
              )}
            </section>
          ) : (
            <EmployeeVersionTests
              endpoint={endpoint}
              versionId={versionId}
              versionLabel={versionLabel}
              canRun={canEdit && !busy}
              feedbackPending={feedbackPending}
              onFeedback={onFeedback}
              onStateChange={changeTests}
            />
          )}
          <fieldset disabled={locked}>
            <legend>{t('用户试玩确认')}</legend>
            <label>
              {t('验收作品入口')}
              <select value={draft.entry} onChange={(event) => edit({ entry: event.target.value })}>
                <option value="">{t('选择保存版本中的 HTML')}</option>
                {entries.map((entry) => (
                  <option key={entry.path} value={entry.path}>
                    {entry.path}
                  </option>
                ))}
              </select>
            </label>
            {!entries.length && (
              <p className="muted small">
                {t('此版本没有可交付的 HTML 入口。请先生成网页并保存新版本。')}
              </p>
            )}
            {draft.items.map((item, index) => (
              <div key={item.id} className="employee-acceptance-item">
                <div className="employee-acceptance-item-row">
                  <label>
                    {t('验收项')} {index + 1}
                    <input
                      maxLength={160}
                      value={item.title}
                      onChange={(event) =>
                        edit({
                          items: draft.items.map((value) =>
                            value.id === item.id ? { ...value, title: event.target.value } : value,
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    {t('结论')}
                    <select
                      value={item.status}
                      onChange={(event) =>
                        edit({
                          items: draft.items.map((value) =>
                            value.id === item.id
                              ? { ...value, status: event.target.value as Item['status'] }
                              : value,
                          ),
                        })
                      }
                    >
                      {Object.entries(statusLabels).map(([status, title]) => (
                        <option key={status} value={status}>
                          {t(title)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    disabled={locked || draft.items.length <= 1}
                    onClick={() =>
                      edit({ items: draft.items.filter((value) => value.id !== item.id) })
                    }
                  >
                    {t('移除')}
                  </button>
                </div>
                <label>
                  {t(
                    item.status === 'unchecked'
                      ? '实际观察（通过或未通过时必填）'
                      : '实际观察（必填）',
                  )}
                  <textarea
                    maxLength={2000}
                    rows={2}
                    value={item.note}
                    onChange={(event) =>
                      edit({
                        items: draft.items.map((value) =>
                          value.id === item.id ? { ...value, note: event.target.value } : value,
                        ),
                      })
                    }
                  />
                </label>
              </div>
            ))}
            <button
              disabled={locked || draft.items.length >= 20}
              onClick={() =>
                edit({
                  items: [
                    ...draft.items,
                    { id: crypto.randomUUID(), title: '', status: 'unchecked', note: '' },
                  ],
                })
              }
            >
              {t('添加验收项')}
            </button>
            <label>
              {t('使用说明（必填）')}
              <textarea
                maxLength={8000}
                rows={3}
                value={draft.instructions}
                onChange={(event) => edit({ instructions: event.target.value })}
              />
            </label>
            <label>
              {t('已知限制（必填，可填写“暂无已知限制”）')}
              <textarea
                maxLength={8000}
                rows={2}
                value={draft.limitations}
                onChange={(event) => edit({ limitations: event.target.value })}
              />
            </label>
          </fieldset>
          <Evidence check={draft.systemCheck?.entry === draft.entry ? draft.systemCheck : null} />
          {draft.systemCheck && draft.systemCheck.entry !== draft.entry && (
            <p className="muted small">{t('入口已更改，保存后请重新执行文件检查。')}</p>
          )}
          {!frozen && (
            <>
              <div className="employee-deliverables-actions">
                <button
                  disabled={locked || !validItems || (!dirty && draft.revision > 0)}
                  onClick={() => void mutate('save')}
                >
                  {t(busy === 'save' ? '正在保存…' : '保存验收草稿')}
                </button>
                <button
                  disabled={locked || dirty || draft.revision === 0 || !draft.entry}
                  onClick={() => void mutate('check')}
                >
                  {t(busy === 'check' ? '正在检查…' : '检查保存版本文件与 ZIP')}
                </button>
              </div>
              <p className="muted small">
                {t(
                  dirty
                    ? '修改尚未保存；请先保存，再检查或正式交付。'
                    : '最新自动测试通过、全部人工验收通过、填写说明与限制，并完成系统文件检查后可正式交付。',
                )}
              </p>
              <label>
                {t('正式交付名称')}
                <input
                  maxLength={80}
                  value={label}
                  disabled={locked}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder={t('例如：第一版正式交付')}
                />
              </label>
              <button
                className="primary"
                disabled={locked || dirty || !complete || !label.trim() || draft.revision === 0}
                onClick={() => void mutate('confirm')}
              >
                {t(busy === 'confirm' ? '正在确认…' : '确认正式交付并冻结验收')}
              </button>
            </>
          )}
        </>
      )}
      {notice && <p role="status">{t(notice)}</p>}
    </details>
  )
}

function OfficialDelivery({
  endpoint,
  delivery,
  feedbackPending,
  onFeedback,
}: {
  endpoint: string
  delivery: Delivery
  feedbackPending: boolean
  onFeedback: (text: string) => void
}) {
  const [feedback, setFeedback] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expired, setExpired] = useState(false)
  const request = useRef(0)
  useEffect(
    () => () => {
      request.current += 1
    },
    [],
  )
  useEffect(() => {
    if (!preview) return
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(preview.expiresAt) - Date.now()),
    )
    return () => window.clearTimeout(timer)
  }, [preview])
  async function startPreview() {
    const current = ++request.current
    setBusy(true)
    setPreview(null)
    setError('')
    setExpired(false)
    try {
      const result = await api<Preview>(`${endpoint}/deliveries/${delivery.id}/preview`, {})
      if (request.current !== current) return
      const url = new URL(result.url, window.location.origin)
      if (
        !result.url.startsWith('/project-preview/') ||
        url.origin !== window.location.origin ||
        !url.pathname.startsWith('/project-preview/') ||
        result.entry !== delivery.entry ||
        result.revision !== delivery.sourceRevision ||
        !Number.isFinite(Date.parse(result.expiresAt)) ||
        Date.parse(result.expiresAt) <= Date.now()
      )
        throw new Error('交付预览暂时不可用，请重新打开。')
      setPreview(result)
    } catch (failure) {
      if (request.current === current) setError((failure as Error).message)
    } finally {
      if (request.current === current) setBusy(false)
    }
  }
  return (
    <article className="employee-official-delivery">
      <h4>{delivery.label}</h4>
      <p className="muted small">
        {delivery.versionLabel} · {t('文件版本')} {delivery.sourceRevision} ·{' '}
        {new Date(delivery.createdAt).toLocaleString()}
      </p>
      <div className="employee-deliverables-actions">
        <button disabled={busy} onClick={() => void startPreview()}>
          {t(busy ? '正在打开…' : '试玩此交付')}
        </button>
        <a
          className="employee-deliverables-download"
          href={`${endpoint}/deliveries/${delivery.id}/download`}
          download
        >
          {t('下载正式交付 ZIP')}
        </a>
        {(preview || busy) && (
          <button
            onClick={() => {
              request.current += 1
              setPreview(null)
              setBusy(false)
              setError('')
              setExpired(false)
            }}
          >
            {t('停止预览')}
          </button>
        )}
      </div>
      <p className="muted small">
        {t('ZIP 包含固定版本作品、打开作品.html、交付说明.txt 与验收记录.json。')}
      </p>
      {error && (
        <p className="error" role="alert">
          {t(error)}
        </p>
      )}
      {expired && <p role="status">{t('交付试玩已到期，请再次点击“试玩此交付”。')}</p>}
      {preview && !expired && (
        <div className="employee-deliverables-preview">
          <iframe
            src={preview.url}
            title={`${delivery.label} · ${t('正式交付试玩')}`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
          />
        </div>
      )}
      <details>
        <summary>{t('查看冻结的说明与验收证据')}</summary>
        <h5>{t('使用说明')}</h5>
        <p className="employee-acceptance-text">{delivery.instructions}</p>
        <h5>{t('已知限制')}</h5>
        <p className="employee-acceptance-text">{delivery.limitations}</p>
        <h5>{t('用户试玩确认')}</h5>
        <ul>
          {delivery.items.map((item) => (
            <li key={item.id}>
              <strong>
                {item.title} · {t(statusLabels[item.status])}
              </strong>
              <p className="employee-acceptance-text">{item.note}</p>
            </li>
          ))}
        </ul>
        <Evidence check={delivery.systemCheck} />
        <h5>{t('冻结的自动测试证据')}</h5>
        <TestEvidence run={delivery.automatedTest || null} />
        {!delivery.automatedTest && (
          <p className="muted small">{t('此历史交付没有自动测试记录。')}</p>
        )}
        <p className="muted small">
          {t('保存版本 ID')} {delivery.versionId}
        </p>
      </details>
      <label>
        {t('此交付的修改反馈')}
        <textarea
          rows={2}
          maxLength={8000}
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder={t('描述希望继续修改的内容')}
        />
      </label>
      <button
        disabled={feedbackPending || !feedback.trim()}
        onClick={() => {
          if (feedbackPending || !feedback.trim()) return
          onFeedback(
            `【正式交付修改反馈】\n交付：${delivery.label}（${delivery.id}）\n保存版本：${delivery.versionLabel}（${delivery.versionId}），文件版本 ${delivery.sourceRevision}，入口 ${delivery.entry}\n\n用户反馈：\n${feedback.trim()}\n\n请先读取当前项目文件，以此正式交付的保存版本为参考，按反馈继续修改。不要自动回滚文件。`,
          )
        }}
      >
        {t('带入对话继续修改')}
      </button>
      <p className="muted small">
        {t(
          feedbackPending
            ? '当前项目请求处理中，完成后可带入反馈。'
            : '反馈会追加到当前项目的对话草稿，保留已有文字；由你检查后发送。',
        )}
      </p>
    </article>
  )
}

export function EmployeeAcceptance({
  endpoint,
  versionId,
  versionLabel,
  sessions,
  onSessionChange,
  entries,
  canEdit,
  onLockChange,
  feedbackPending,
  onFeedback,
}: {
  endpoint: string
  versionId: string
  versionLabel: string
  sessions: Record<string, AcceptanceSession | undefined>
  onSessionChange: (versionId: string, session: AcceptanceSession | null) => void
  entries: { path: string; title: string }[]
  canEdit: boolean
  onLockChange: (locked: boolean) => void
  feedbackPending: boolean
  onFeedback: (text: string) => void
}) {
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let live = true
    setLoading(true)
    setError('')
    setDeliveries([])
    api<{ deliveries: Delivery[] }>(`${endpoint}/deliveries`)
      .then((result) => {
        if (live) setDeliveries(result.deliveries)
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
  }, [endpoint, reload])
  return (
    <>
      {versionId ? (
        <AcceptanceEditor
          key={`${endpoint}/${versionId}`}
          endpoint={endpoint}
          versionId={versionId}
          versionLabel={versionLabel}
          session={sessions[versionId]}
          onSessionChange={onSessionChange}
          entries={entries}
          canEdit={canEdit}
          onLockChange={onLockChange}
          onDelivered={() => setReload((value) => value + 1)}
          feedbackPending={feedbackPending}
          onFeedback={onFeedback}
        />
      ) : (
        <p className="employee-deliverables-notice">
          {t('正式验收以保存版本为准。先在上方保存或选择版本，再试玩并记录验收。')}
        </p>
      )}
      <section className="employee-official-deliveries" aria-label={t('本项目正式交付')}>
        <div className="heading-row">
          <h3>{t('本项目正式交付')}</h3>
          <button disabled={loading} onClick={() => setReload((value) => value + 1)}>
            {t('刷新交付列表')}
          </button>
        </div>
        {loading && <p role="status">{t('正在读取正式交付…')}</p>}
        {error && (
          <p role="alert" className="error">
            {t(error)}
          </p>
        )}
        {!loading && !error && !deliveries.length && (
          <p className="muted small">{t('此项目暂无正式交付。')}</p>
        )}
        {deliveries.map((delivery) => (
          <OfficialDelivery
            key={delivery.id}
            endpoint={endpoint}
            delivery={delivery}
            feedbackPending={feedbackPending}
            onFeedback={onFeedback}
          />
        ))}
      </section>
    </>
  )
}
