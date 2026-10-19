import { randomUUID } from 'node:crypto'
import { transaction, tenantAccess, fail } from '../db.mjs'
import { projectRow, ownedVersion, projectRoles } from './project-store.mjs'
import { snapshotSha256 } from './snapshot-hash.mjs'
import { discoverTestFiles, testCommand, classifyTestResult, validCounts,
  TEST_TIMEOUT_MS, TEST_ENVIRONMENT } from './test-evidence.mjs'

const identity = (ctx) => [ctx.projectId, ctx.tenantId, ctx.userId]
export function testRunView(row) {
  return { id: row.id, requestId: row.request_id, versionId: row.version_id,
    versionLabel: row.version_label, sourceRevision: row.source_revision,
    snapshotSha256: row.snapshot_sha256, testFiles: row.test_files, command: row.command,
    environment: row.environment, state: row.state, counts: row.counts, cases: row.cases,
    exitCode: row.exit_code, stdout: row.stdout, stderr: row.stderr, timedOut: row.timed_out,
    truncated: row.truncated, detail: row.detail, startedAt: row.started_at, finishedAt: row.finished_at }
}
export async function recoverVersionTests(db, ctx) {
  await db.query(`UPDATE employee_project_test_runs SET state='interrupted',finished_at=now(),lease_until=NULL,
    detail='上次自动测试已中断，未能确认结果；不会自动重跑。'
    WHERE workspace_id=$1 AND tenant_id=$2 AND user_id=$3 AND state='running' AND lease_until<=now()`, identity(ctx))
}
export async function versionTestHistory(db, ctx, versionId) {
  await projectRow(db, ctx, true)
  await ownedVersion(db, ctx, versionId)
  await recoverVersionTests(db, ctx)
  const rows = (await db.query(`SELECT * FROM employee_project_test_runs
    WHERE workspace_id=$1 AND tenant_id=$2 AND user_id=$3 AND version_id=$4
    ORDER BY started_at DESC,id DESC LIMIT 20`, [...identity(ctx), versionId])).rows
  const testRuns = rows.map(testRunView)
  return { testRuns, latestTest: testRuns[0] || null }
}
export async function deliveryTestEvidence(db, ctx, version, testRunId) {
  const { latestTest } = await versionTestHistory(db, ctx, version.id)
  if (!latestTest || latestTest.id !== testRunId || latestTest.state !== 'passed' ||
    latestTest.snapshotSha256 !== snapshotSha256(version) || latestTest.exitCode !== 0 ||
    latestTest.timedOut || latestTest.truncated || !validCounts(latestTest.counts) ||
    latestTest.counts.tests === 0 || latestTest.counts.passed !== latestTest.counts.tests)
    throw fail(409, '请运行此保存版本的自动测试，并确认最新一条全部通过的测试记录后再交付')
  return latestTest
}
function boundedEvidence(raw) {
  const result = raw && typeof raw === 'object' ? raw : { error: '执行服务未返回测试证据' }
  const clip = (text, limit) => {
    if (typeof text !== 'string') return ''
    const bytes = Buffer.from(text)
    if (bytes.length <= limit) return text
    result.truncated = true
    return new TextDecoder().decode(bytes.subarray(0, limit - 3))
  }
  const stdout = clip(result.stdout, 24000), stderr = clip(result.stderr, 24000)
  const cases = []
  let bytes = 0
  if (Array.isArray(result.cases)) for (const item of result.cases) {
    if (!item || typeof item.name !== 'string' || typeof item.detail !== 'string' ||
      !['passed','failed','skipped','todo'].includes(item.status)) { result.summaryComplete = false; continue }
    const value = { name: clip(item.name, 1000), status: item.status, detail: clip(item.detail, 4000) }
    bytes += Buffer.byteLength(JSON.stringify(value))
    if (bytes > 24000 || cases.length >= 100) { result.truncated = true; break }
    cases.push(value)
  }
  return { ...result, stdout, stderr, cases, counts: validCounts(result.counts) ? result.counts : null }
}
export function createVersionTestService({ pool, driver }) {
  const scoped = (ctx, fn, roles = projectRoles) => transaction(pool, async (db) => {
    await tenantAccess(db, ctx.userId, ctx.tenantId, roles)
    return fn(db)
  }, ctx)
  async function run(ctx, versionId, requestId) {
    const start = await scoped(ctx, async (db) => {
      await projectRow(db, ctx, true)
      const version = await ownedVersion(db, ctx, versionId)
      await recoverVersionTests(db, ctx)
      const previous = (await db.query(`SELECT * FROM employee_project_test_runs
        WHERE workspace_id=$1 AND tenant_id=$2 AND user_id=$3 AND request_id=$4`, [...identity(ctx), requestId])).rows[0]
      if (previous) {
        if (previous.version_id !== versionId) throw fail(409, '同一请求编号不能用于另一个保存版本')
        return { existing: testRunView(previous) }
      }
      if ((await db.query('SELECT id FROM employee_project_deliveries WHERE version_id=$1 AND workspace_id=$2 AND tenant_id=$3 AND user_id=$4',
        [versionId, ...identity(ctx)])).rows.length) throw fail(409, '此版本已正式交付，测试记录只读；请保存新版本继续修改')
      if ((await db.query(`SELECT id FROM employee_project_test_runs
        WHERE workspace_id=$1 AND tenant_id=$2 AND user_id=$3 AND state='running'`, identity(ctx))).rows.length)
        throw fail(409, '此项目已有自动测试正在运行，请等待结果')
      const count = (await db.query(`SELECT count(*) count FROM employee_project_test_runs
        WHERE workspace_id=$1 AND tenant_id=$2 AND user_id=$3 AND version_id=$4`, [...identity(ctx), versionId])).rows[0]
      if (Number(count.count) >= 100) throw fail(409, '此版本已达到100条测试记录上限，请保存新版本')
      const testFiles = discoverTestFiles(version.files), id = randomUUID()
      const row = (await db.query(`INSERT INTO employee_project_test_runs
        (id,request_id,version_id,workspace_id,tenant_id,user_id,version_label,source_revision,snapshot_sha256,test_files,
        command,environment,state,lease_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'running',now()+interval '120 seconds') RETURNING *`,
      [id, requestId, versionId, ...identity(ctx), version.label, version.source_revision, snapshotSha256(version),
        JSON.stringify(testFiles), testFiles.length ? testCommand(testFiles) : '', TEST_ENVIRONMENT])).rows[0]
      return { row, files: version.files }
    })
    if (start.existing) return start.existing
    let evidence
    if (!start.row.test_files.length) evidence = { state: 'no_tests', counts: null, cases: [], exitCode: null,
      stdout: '', stderr: '', timedOut: false, truncated: false, detail: '保存版本没有受支持的 Node.js 测试文件，不能判为通过。' }
    else {
      try {
        const result = boundedEvidence(await driver.test({ files: start.files, testFiles: start.row.test_files, timeoutMs: TEST_TIMEOUT_MS }))
        evidence = { ...result, ...classifyTestResult(result) }
      } catch (error) {
        evidence = { state: 'error', counts: null, cases: [], exitCode: null, stdout: '', stderr: '', timedOut: false,
          truncated: false, detail: error.expose ? error.message : '自动测试执行环境未能完成运行，请检查环境后重试。' }
      }
    }
    // Finalization always persists accepted work, but revoked access never records a pass.
    const final = await transaction(pool, async (db) => {
      await projectRow(db, ctx, true)
      await recoverVersionTests(db, ctx)
      let denied
      try { await tenantAccess(db, ctx.userId, ctx.tenantId, projectRoles) } catch (error) { denied = error }
      if (denied) evidence = { ...evidence, state: 'error', detail: '运行期间项目执行权限已撤销，不能记录为通过。' }
      const row = (await db.query(`UPDATE employee_project_test_runs SET
        state=$5,counts=$6,cases=$7,exit_code=$8,stdout=$9,stderr=$10,timed_out=$11,truncated=$12,detail=$13,
        finished_at=now(),lease_until=NULL
        WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3 AND user_id=$4 AND state='running' RETURNING *`,
      [start.row.id, ...identity(ctx), evidence.state, evidence.counts ? JSON.stringify(evidence.counts) : null,
        JSON.stringify(evidence.cases), Number.isInteger(evidence.exitCode) && evidence.exitCode >= 0 && evidence.exitCode <= 255 ? evidence.exitCode : null,
        evidence.stdout, evidence.stderr, !!evidence.timedOut, !!evidence.truncated, String(evidence.detail).slice(0,4000)])).rows[0] ||
        (await db.query('SELECT * FROM employee_project_test_runs WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3 AND user_id=$4',
          [start.row.id, ...identity(ctx)])).rows[0]
      return { run: testRunView(row), denied }
    }, ctx)
    if (final.denied) throw final.denied
    return final.run
  }
  return { run }
}
