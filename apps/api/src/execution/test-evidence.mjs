import { validateFiles } from '../../../execution/files.mjs'

export const TEST_TIMEOUT_MS = 60000
export const TEST_ENVIRONMENT = 'Node.js 24 / npm / Python 3；网络关闭；60 秒 / 512 MiB'
export const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`
export function discoverTestFiles(files) {
  return validateFiles(files).map(file => file.path).filter(path => {
    const parts = path.split('/')
    return !parts.some(part => part.startsWith('.') || part === 'node_modules') &&
      /\.(test|spec)\.(mjs|js|cjs)$/.test(path)
  }).sort()
}
export function testCommand(testFiles) {
  return `node --test --test-reporter=/opt/execution/test-reporter.mjs -- ${testFiles.map(shellQuote).join(' ')}`
}
export function classifyTestResult(result) {
  const state = (state, detail) => ({ state, detail })
  if (result.timedOut) return state('timed_out', '自动测试超过60秒，未能确认全部结果。')
  if (result.snapshotError || result.error || result.exitCode == null)
    return state('error', result.error || result.snapshotError || '执行结果未完整收集，不能判为通过。')
  if (!result.summaryComplete || !validCounts(result.counts))
    return state('error', '缺少有效的全局测试摘要，不能判为通过。')
  const c = result.counts
  if (result.exitCode !== 0 || c.failed || c.cancelled || !result.success)
    return state('failed', '自动测试未通过，请查看真实退出码、失败用例与日志。')
  if (c.tests === 0) return state('no_tests', '测试文件没有注册任何测试用例，不能判为通过。')
  if (result.truncated || c.skipped || c.todo || c.passed !== c.tests)
    return state('incomplete', '存在跳过、待办或截断结果，不能确认全部测试通过。')
  return state('passed', '此保存版本已有的自动测试全部通过；不替代人工试玩或浏览器兼容性测试。')
}
export function validCounts(counts) {
  if (!counts || typeof counts !== 'object') return false
  const keys = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo']
  if (!keys.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)) return false
  return counts.tests === counts.passed + counts.failed + counts.cancelled + counts.skipped + counts.todo
}
