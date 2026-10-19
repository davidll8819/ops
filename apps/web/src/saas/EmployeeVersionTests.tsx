import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '@/i18n'
import { api } from './api'
import {
  testFeedback,
  testRequestRejected,
  testStateLabels,
  type TestHistory,
  type TestRun,
} from './version-tests'

export function TestEvidence({ run }: { run: TestRun | null }) {
  if (!run) return <p className="muted small">{t('没有自动测试记录。')}</p>
  const counts = run.counts
  const caseLabels = { passed: '通过', failed: '未通过', skipped: '跳过', todo: '待办' }
  return (
    <div className="employee-version-test-evidence">
      <p>
        <strong>{t(testStateLabels[run.state])}</strong> · {run.versionLabel} · {t('文件版本')}{' '}
        {run.sourceRevision}
      </p>
      <p className="muted small">
        {t('开始时间')} {new Date(run.startedAt).toLocaleString()}
        {run.finishedAt && ` · ${t('结束时间')} ${new Date(run.finishedAt).toLocaleString()}`}
      </p>
      <p>
        {t('退出码')}：{run.exitCode ?? t('尚无')} ·{' '}
        {counts
          ? `${t('总数')} ${counts.tests} · ${t('通过')} ${counts.passed} · ${t('未通过')} ${counts.failed} · ${t('取消')} ${counts.cancelled} · ${t('跳过')} ${counts.skipped} · ${t('待办')} ${counts.todo}`
          : t('尚无完整用例统计')}
      </p>
      {run.detail && <p className="employee-acceptance-text">{run.detail}</p>}
      {run.timedOut && <p role="status">{t('测试超时，不能作为全部通过的证据。')}</p>}
      {run.truncated && <p role="status">{t('测试输出或结果已截断，不能作为全部通过的证据。')}</p>}
      {!!run.cases.length && (
        <ul className="employee-version-test-cases">
          {run.cases.map((item, index) => (
            <li key={index}>
              <strong>
                {item.name} · {t(caseLabels[item.status])}
              </strong>
              {item.detail && <pre>{item.detail}</pre>}
            </li>
          ))}
        </ul>
      )}
      <details>
        <summary>{t('查看命令、文件摘要与实际日志')}</summary>
        <dl>
          <div>
            <dt>{t('测试记录')}</dt>
            <dd>{run.id}</dd>
          </div>
          <div>
            <dt>{t('保存版本 ID')}</dt>
            <dd>{run.versionId}</dd>
          </div>
          <div>
            <dt>SHA-256</dt>
            <dd>{run.snapshotSha256 || t('未取得摘要')}</dd>
          </div>
          <div>
            <dt>{t('运行环境')}</dt>
            <dd>{run.environment}</dd>
          </div>
          <div>
            <dt>{t('实际命令')}</dt>
            <dd>
              <code>{run.command}</code>
            </dd>
          </div>
          <div>
            <dt>{t('测试文件')}</dt>
            <dd>{run.testFiles.length ? run.testFiles.join('\n') : t('未发现测试文件')}</dd>
          </div>
        </dl>
        <h5>stdout</h5>
        <pre>{run.stdout || t('无输出')}</pre>
        <h5>stderr</h5>
        <pre>{run.stderr || t('无输出')}</pre>
      </details>
    </div>
  )
}

// Only the idempotency token is retained; evidence is always re-read from the server.
function pendingToken(key: string, value?: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key)
    else if (value !== undefined) sessionStorage.setItem(key, value)
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

export function EmployeeVersionTests({
  endpoint,
  versionId,
  versionLabel,
  canRun,
  feedbackPending,
  onFeedback,
  onStateChange,
}: {
  endpoint: string
  versionId: string
  versionLabel: string
  canRun: boolean
  feedbackPending: boolean
  onFeedback: (text: string) => void
  onStateChange: (history: TestHistory, ready: boolean, busy: boolean) => void
}) {
  const url = `${endpoint}/versions/${versionId}/acceptance/tests`
  const tokenKey = `office:version-test:${url}`
  const [pendingId] = useState(() => pendingToken(tokenKey))
  const token = useRef(pendingId)
  const [history, setHistory] = useState<TestHistory>({ latestTest: null, testRuns: [] })
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [uncertain, setUncertain] = useState(!!pendingId)
  const [error, setError] = useState('')
  const live = useRef(false)
  const generation = useRef(0)
  const running = history.latestTest?.state === 'running'
  const busy = submitting || running
  const refresh = useCallback(async () => {
    const current = ++generation.current
    setLoading(true)
    try {
      const result = await api<TestHistory>(url)
      if (!live.current || current !== generation.current) return
      setHistory(result)
      setError('')
      if (token.current && result.testRuns.some((run) => run.requestId === token.current)) {
        pendingToken(tokenKey, null)
        token.current = null
        setUncertain(false)
      }
    } catch (failure) {
      if (live.current && current === generation.current) setError((failure as Error).message)
    } finally {
      if (live.current && current === generation.current) setLoading(false)
    }
  }, [url, tokenKey])
  useEffect(() => {
    live.current = true
    void refresh()
    return () => {
      live.current = false
      generation.current += 1
    }
  }, [refresh])
  useEffect(() => {
    if (!running && !submitting) return
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [running, submitting, refresh])
  useEffect(() => {
    onStateChange(history, !loading && !error && !uncertain, busy || uncertain)
  }, [history, loading, error, uncertain, busy, onStateChange])

  async function runTests() {
    if (!canRun || busy || loading) return
    const requestId = token.current || crypto.randomUUID()
    token.current = requestId
    pendingToken(tokenKey, requestId)
    setSubmitting(true)
    setUncertain(true)
    setError('')
    generation.current += 1
    try {
      await api<{ testRun: TestRun }>(url, { requestId })
      if (!live.current) return
      // A separate read avoids an older response replacing newer history.
      await refresh()
    } catch (failure) {
      const rejected = testRequestRejected(failure)
      if (rejected) {
        // A definitive rejection created no run; it must not strand the version selector.
        if (pendingToken(tokenKey) === requestId) pendingToken(tokenKey, null)
        token.current = null
      }
      if (!live.current) return
      if (rejected) setUncertain(false)
      // Refresh is read-only; a connection loss never starts another test.
      await refresh()
      if (live.current && (rejected || token.current)) setError((failure as Error).message)
    } finally {
      if (live.current) setSubmitting(false)
    }
  }

  return (
    <section className="employee-version-tests" aria-label={t('保存版本自动测试')}>
      <h4>
        {t('自动测试')} · {versionLabel}
      </h4>
      <p className="muted small">
        {t(
          '只运行此保存版本已有的 Node.js 测试用例，不替代人工试玩或浏览器兼容性测试。测试不会修改人工验收。',
        )}
      </p>
      <div className="employee-deliverables-actions">
        {canRun && (
          <button disabled={busy || loading} onClick={() => void runTests()}>
            {t(submitting ? '正在运行测试…' : uncertain ? '恢复本次测试请求' : '运行此版本测试')}
          </button>
        )}
        <button disabled={loading || submitting} onClick={() => void refresh()}>
          {t(loading ? '正在读取测试…' : '刷新测试记录')}
        </button>
      </div>
      {running && <p role="status">{t('此保存版本正在测试，结果会自动刷新；请勿重复提交。')}</p>}
      {uncertain && !running && (
        <p role="status">
          {t('本次请求结果尚未确认。先刷新记录；恢复请求会使用同一请求编号，不会重复执行。')}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {t(error)}
        </p>
      )}
      <TestEvidence run={history.latestTest} />
      {!history.latestTest && !loading && !error && (
        <p className="muted small">
          {t(
            '在项目中添加 *.test.mjs、*.test.js、*.test.cjs 或对应 *.spec.* 测试，再保存新版本。没有测试文件或没有实际用例不能通过。',
          )}
        </p>
      )}
      {!loading &&
        !error &&
        !busy &&
        (!history.latestTest || history.latestTest.state !== 'passed') && (
          <button
            disabled={feedbackPending}
            onClick={() => onFeedback(testFeedback(history.latestTest, versionId, versionLabel))}
          >
            {t('将测试问题带入对话草稿')}
          </button>
        )}
      <p className="muted small">
        {t('测试反馈会追加到当前项目对话草稿，保留已有文字，由你检查后发送。')}
      </p>
      {history.testRuns.length > 1 && (
        <details>
          <summary>
            {t('查看本版本测试历史')} · {history.testRuns.length}
          </summary>
          {history.testRuns.slice(1).map((run) => (
            <details key={run.id}>
              <summary>
                {new Date(run.startedAt).toLocaleString()} · {t(testStateLabels[run.state])}
              </summary>
              <TestEvidence run={run} />
            </details>
          ))}
        </details>
      )}
    </section>
  )
}
