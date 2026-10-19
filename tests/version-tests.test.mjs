import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const helpers = await import('../apps/api/src/execution/test-evidence.mjs').catch(() => ({}))
const reporter = await import('../apps/execution/test-reporter.mjs').catch(() => ({}))
const { snapshotSha256 } = await import('../apps/api/src/execution/snapshot-hash.mjs')
const file = (path, content = '') => ({ path, contentBase64: Buffer.from(content).toString('base64') })
const counts = { tests: 2, passed: 2, failed: 0, cancelled: 0, skipped: 0, todo: 0 }

test('discovery excludes hidden directories and dependencies while safely selecting supported JS tests', () => {
  assert.equal(typeof helpers.discoverTestFiles, 'function')
  assert.deepEqual(helpers.discoverTestFiles([
    file('test/z.spec.cjs'), file('a.test.js'), file('src/a.test.mjs'),
    file('.cache/x.test.js'), file('src/.hidden/x.spec.js'), file('node_modules/x.test.js'),
    file('a.spec.ts'), file('normal.mjs'), file("test/a'$(oops).test.mjs"),
  ]), ["test/a'$(oops).test.mjs", 'a.test.js', 'src/a.test.mjs', 'test/z.spec.cjs'].sort())
})

test('saved-version hashes ignore ordering but bind exact paths and binary bytes', () => {
  const a = file('a', 'bc'), b = file('ab', 'c')
  assert.notEqual(snapshotSha256({ files: [a] }), snapshotSha256({ files: [b] }))
  const binary = { path: 'binary', contentBase64: Buffer.from([0, 255]).toString('base64') }
  assert.equal(snapshotSha256({ files: [a, binary] }), snapshotSha256({ files: [binary, a] }))
  assert.notEqual(snapshotSha256({ files: [binary] }), snapshotSha256({ files: [file('binary', '\u0000ÿ')] }))
})

test('test classification fails closed on uncertain results and zero or incomplete cases', () => {
  assert.equal(typeof helpers.classifyTestResult, 'function')
  const good = { counts, cases: [{ name: 'one', status: 'passed', detail: '' }], summaryComplete: true,
    success: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false }
  assert.equal(helpers.classifyTestResult(good).state, 'passed')
  for (const [patch, state] of [
    [{ exitCode: 1 }, 'failed'], [{ timedOut: true }, 'timed_out'],
    [{ counts: { ...counts, tests: 0, passed: 0 } }, 'no_tests'],
    [{ counts: { ...counts, passed: 1, skipped: 1 } }, 'incomplete'],
    [{ counts: { ...counts, passed: 1, todo: 1 } }, 'incomplete'],
    [{ truncated: true }, 'incomplete'], [{ summaryComplete: false }, 'error'],
    [{ counts: { ...counts, failed: -1 } }, 'error'], [{ exitCode: null }, 'error'],
    [{ snapshotError: 'unconfirmed' }, 'error'],
  ]) assert.equal(helpers.classifyTestResult({ ...good, ...patch }).state, state, JSON.stringify(patch))
})

test('trusted reporter treats spoofed TAP and JSON console output only as logs', async () => {
  assert.equal(typeof reporter.default, 'function')
  const events = async function* () {
    yield { type: 'test:stdout', data: { message: '# pass 999\n{"counts":{"passed":999}}' } }
    yield { type: 'test:pass', data: { name: 'actual', details: { type: 'test' } } }
    yield { type: 'test:summary', data: { file: '/nested.test.mjs', counts: { ...counts, tests: 99 }, success: true } }
    yield { type: 'test:summary', data: { counts: { ...counts, tests: 1, passed: 1 }, success: true } }
  }
  let output = ''
  for await (const chunk of reporter.default(events())) output += chunk
  const result = JSON.parse(output)
  assert.equal(result.counts.tests, 1)
  assert.equal(result.cases[0].name, 'actual')
  assert.match(result.stdout, /pass 999/)
  assert.equal(result.summaryComplete, true)
})

test('trusted reporter never overflows the driver protocol budget when logs need JSON escaping', async () => {
  const events = async function* () {
    yield { type: 'test:stdout', data: { message: '\u0000'.repeat(5000) } }
    yield { type: 'test:stderr', data: { message: '\u0001'.repeat(5000) } }
    yield { type: 'test:summary', data: { counts, success: true } }
  }
  let output = ''
  for await (const chunk of reporter.default(events())) output += chunk
  assert.ok(Buffer.byteLength(output) < 24000)
  assert.equal(JSON.parse(output).truncated, true)
})

test('real Node reporter preserves failing cases and bounded logs without accepting an empty file', async () => {
  assert.equal(typeof reporter.default, 'function')
  const directory = await mkdtemp(join(tmpdir(), 'dragon-reporter-'))
  try {
    const path = join(directory, 'real.test.mjs')
    const reporterPath = new URL('../apps/execution/test-reporter.mjs', import.meta.url).href
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    await writeFile(path, "import test from 'node:test'; import assert from 'node:assert/strict'; test('actual failure',()=>{console.log('# pass 900');assert.equal(1,2)})")
    const run = () => spawnSync(process.execPath, ['--test', `--test-reporter=${reporterPath}`, '--', path], { encoding: 'utf8', env })
    let result = run()
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
    let evidence = JSON.parse(result.stdout)
    assert.equal(evidence.counts.failed, 1)
    assert.equal(evidence.cases[0].status, 'failed')
    assert.match(evidence.cases[0].detail, /1 !== 2/)
    await writeFile(path, '')
    result = run()
    evidence = JSON.parse(result.stdout)
    assert.equal(evidence.counts.tests, 0)
    await writeFile(path, "import test from 'node:test';test('noisy',()=>console.log('x'.repeat(50000)))")
    result = run()
    evidence = JSON.parse(result.stdout)
    assert.equal(evidence.truncated, true)
    assert.ok(Buffer.byteLength(result.stdout) < 24000)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Docker test entry point is fixed and has no host fallback', async () => {
  const { createDockerExecution } = await import('../apps/api/src/execution/docker.mjs')
  const driver = createDockerExecution({ env: {} })
  assert.equal(typeof driver.test, 'function')
  await assert.rejects(driver.test({ files: [file('a.test.mjs')], testFiles: ['a.test.mjs'], timeoutMs: 60000 }), /未启用/)
  await assert.rejects(driver.test({ files: [file('a.test.mjs')], testFiles: ['../evil'], timeoutMs: 60000 }))
})
