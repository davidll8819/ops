export type TestRun = {
  id: string
  requestId: string
  versionId: string
  versionLabel: string
  sourceRevision: number
  snapshotSha256: string
  testFiles: string[]
  command: string
  environment: string
  state:
    | 'running'
    | 'passed'
    | 'failed'
    | 'no_tests'
    | 'timed_out'
    | 'interrupted'
    | 'error'
    | 'incomplete'
  counts: null | {
    tests: number
    passed: number
    failed: number
    cancelled: number
    skipped: number
    todo: number
  }
  cases: { name: string; status: 'passed' | 'failed' | 'skipped' | 'todo'; detail: string }[]
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  detail: string
  startedAt: string
  finishedAt: string | null
}
export type TestHistory = { latestTest: TestRun | null; testRuns: TestRun[] }

export function testRequestRejected(failure: unknown) {
  return (
    failure instanceof Error &&
    'status' in failure &&
    typeof failure.status === 'number' &&
    failure.status >= 400 &&
    failure.status < 500 &&
    failure.status !== 408
  )
}

export const testStateLabels: Record<TestRun['state'], string> = {
  running: '运行中',
  passed: '通过',
  failed: '未通过',
  no_tests: '没有测试用例',
  timed_out: '已超时',
  interrupted: '执行中断',
  error: '执行错误',
  incomplete: '证据不完整',
}

export function canDeliverTest(
  run: TestRun | null | undefined,
  versionId: string,
  snapshotSha256: string | undefined,
) {
  const counts = run?.counts
  return (
    !!run &&
    run.state === 'passed' &&
    run.versionId === versionId &&
    /^[a-f0-9]{64}$/i.test(run.snapshotSha256) &&
    run.snapshotSha256 === snapshotSha256 &&
    run.exitCode === 0 &&
    !run.timedOut &&
    !run.truncated &&
    !!run.finishedAt &&
    !!counts &&
    Number.isInteger(counts.tests) &&
    counts.tests > 0 &&
    counts.passed === counts.tests &&
    counts.failed === 0 &&
    counts.cancelled === 0 &&
    counts.skipped === 0 &&
    counts.todo === 0
  )
}

export function testFeedback(run: TestRun | null, versionId: string, versionLabel: string) {
  const bounded = (value: string, limit: number) =>
    value.length > limit ? `${value.slice(0, limit)}\n[内容已截取，完整记录请查看测试详情]` : value
  const evidence = run
    ? `测试记录：${run.id}\n文件版本：${run.sourceRevision}\nSHA-256：${run.snapshotSha256}\n结论：${testStateLabels[run.state]}；退出码：${run.exitCode ?? '无'}\n结果：${bounded(run.detail || '', 800)}\n失败用例：\n${bounded(
        run.cases
          .filter((item) => item.status !== 'passed')
          .map((item) => `${item.name}: ${item.detail}`)
          .join('\n'),
        1200,
      )}\nstdout：\n${bounded(run.stdout || '', 1500)}\nstderr：\n${bounded(run.stderr || '', 1500)}`
    : '此保存版本尚无自动测试记录，请为真实功能补充可执行的 Node.js 测试。'
  return `【保存版本自动测试反馈】\n保存版本：${versionLabel}（${versionId}）\n${evidence}\n\n请先读取当前项目文件，以此保存版本和测试证据为参考，补充测试或修复问题，再保存新版本并重新测试。不要自动回滚文件，不要代替用户填写人工验收结论。`
}
