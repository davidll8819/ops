import { resolve } from 'node:path'

// Loaded from the image's read-only /opt/execution, never from the project.
// Console output arrives as test:stdout/stderr data, not reporter protocol.
export default async function* report(events) {
  const result = { protocol: 'dragon-node-tests-v1', counts: null, cases: [], success: false,
    summaryComplete: false, stdout: '', stderr: '', truncated: false }
  let summaries = 0, caseBytes = 0
  const wrappers = { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0 }
  const clip = (value, limit) => {
    const bytes = Buffer.from(String(value ?? ''))
    if (bytes.length <= limit) return bytes.toString()
    result.truncated = true
    return new TextDecoder().decode(bytes.subarray(0, Math.max(0, limit - 3)))
  }
  for await (const { type, data = {} } of events) {
    if (type === 'test:stdout' || type === 'test:stderr') {
      const channel = type === 'test:stdout' ? 'stdout' : 'stderr'
      result[channel] = clip(result[channel] + String(data.message ?? ''), 4000)
    }
    if ((type === 'test:pass' || type === 'test:fail') && data.details?.type !== 'suite') {
      const status = data.skip ? 'skipped' : data.todo ? 'todo' : type === 'test:pass' ? 'passed' : 'failed'
      // Node treats a file with no registered tests as a passing file-level test.
      // Exclude that wrapper so a blank test file cannot certify a delivery.
      const wrapper = data.file && resolve(data.name || '') === resolve(data.file)
      if (wrapper) { wrappers.tests++; wrappers[status]++; continue }
      const error = data.details?.error
      const item = { name: clip(data.name, 240), status,
        detail: clip(error ? `${error.message || error}\n${error.stack || ''}` : (data.skip || data.todo || ''), 700) }
      const bytes = Buffer.byteLength(JSON.stringify(item))
      if (caseBytes + bytes > 7000 || result.cases.length >= 100) result.truncated = true
      else { result.cases.push(item); caseBytes += bytes }
    }
    if (type === 'test:summary' && !data.file) {
      summaries++
      result.counts = Object.fromEntries(Object.keys(wrappers).map(key => [key, data.counts?.[key]]))
      result.success = data.success === true
      if (!result.success) process.exitCode = 1
    }
  }
  result.summaryComplete = summaries === 1
  if (result.counts)
    for (const key of Object.keys(wrappers)) result.counts[key] -= wrappers[key]
  let output = JSON.stringify(result)
  while (Buffer.byteLength(output) > 22000) {
    result.truncated = true
    result.stdout = result.stdout.slice(0, Math.floor(result.stdout.length / 2))
    result.stderr = result.stderr.slice(0, Math.floor(result.stderr.length / 2))
    if (!result.stdout && !result.stderr) result.cases.pop()
    output = JSON.stringify(result)
  }
  yield output
}
