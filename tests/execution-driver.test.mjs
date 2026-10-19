import test from 'node:test'
import assert from 'node:assert/strict'

const loadFiles = () => import('../apps/execution/files.mjs').catch(() => ({}))
const loadDriver = () => import('../apps/api/src/execution/docker.mjs').catch(() => ({}))
const file = (path, content) => ({ path, contentBase64: Buffer.from(content).toString('base64') })

test('snapshot validators preserve binary files and safe relative paths', async () => {
  const { validateFiles, validatePath } = await loadFiles()
  assert.equal(typeof validateFiles, 'function', 'snapshot validator must exist')
  assert.equal(validatePath('src/你好.test.mjs'), 'src/你好.test.mjs')
  const input = [
    file('src/main.mjs', 'console.log(42)'),
    file('empty.txt', ''),
    file('data.bin', [0, 255, 4]),
  ]
  assert.deepEqual(validateFiles(input), input)
})

test('snapshot validation rejects traversal, Windows aliases, ambiguous paths, and conflicting files', async () => {
  const { validateFiles, validatePath } = await loadFiles()
  assert.equal(typeof validatePath, 'function', 'path validator must exist')
  for (const path of [
    '',
    '/',
    '/etc/file',
    '../x',
    'a/../../x',
    'a//b',
    'a/./b',
    'a\\b',
    'C:/x',
    'a:b',
    'a\0b',
    'a\nb',
    'a/',
    'a/..',
    'CON',
    'dir/Lpt1.txt',
    'x. ',
    'a./b',
    'a /b',
  ])
    assert.throws(() => validatePath(path), undefined, path)
  assert.throws(() => validateFiles([file('a', 'one'), file('a', 'two')]))
  assert.throws(() => validateFiles([file('a', 'one'), file('a/b', 'two')]))
  assert.throws(() => validateFiles([file('a/b', 'two'), file('a', 'one')]))
  assert.throws(() => validateFiles([{ path: 'a', contentBase64: '%%%=' }]))
  assert.throws(() => validateFiles([{ path: 'a', contentBase64: 'YQ' }]))
  assert.throws(() => validateFiles([{ ...file('a', ''), hostPath: 'ignored' }]))
})

test('snapshot limits are enforced before execution', async () => {
  const { validateFiles } = await loadFiles()
  assert.equal(typeof validateFiles, 'function', 'snapshot validator must exist')
  assert.throws(() => validateFiles(Array.from({ length: 201 }, (_, i) => file(`${i}`, ''))))
  assert.throws(() => validateFiles([file('large', Buffer.alloc(1024 * 1024 + 1))]))
  assert.throws(() =>
    validateFiles(Array.from({ length: 9 }, (_, i) => file(`${i}`, Buffer.alloc(1024 * 1024)))),
  )
})

test('valid snapshots at the byte and file-count boundaries remain usable', async () => {
  const { validateFiles } = await loadFiles()
  const full = Array.from({ length: 8 }, (_, i) => file(`${i}.bin`, Buffer.alloc(1024 * 1024, i)))
  assert.deepEqual(validateFiles(full), full)
  const many = Array.from({ length: 200 }, (_, i) => file(`${i}`, ''))
  assert.deepEqual(validateFiles(many), many)
})

test('execution is disabled by default and never falls back to host shell', async () => {
  const { createDockerExecution } = await loadDriver()
  assert.equal(typeof createDockerExecution, 'function', 'execution driver must exist')
  const driver = createDockerExecution({ env: {} })
  assert.equal((await driver.status()).available, false)
  await assert.rejects(
    driver.execute({ files: [], command: 'echo must-not-run' }),
    /未启用|disabled/i,
  )
})

const dockerTest = process.env.EXECUTION_DOCKER_TESTS === 'true' ? test : test.skip
dockerTest(
  'Docker runtime captures changed binary/text files, exit codes, and bounded output',
  async () => {
    const { createDockerExecution } = await loadDriver()
    assert.equal(typeof createDockerExecution, 'function', 'execution driver must exist')
    const driver = createDockerExecution({ env: { ...process.env, EXECUTION_ENABLED: 'true' } })
    assert.equal((await driver.status()).available, true)
    const result = await driver.execute({
      files: [file('input.txt', 'before')],
      command: `node -e "require('fs').writeFileSync('output.bin',Buffer.from([0,255,4])); console.log('node='+process.versions.node); console.error('failure evidence')"; python3 -c "open('input.txt','w').write('after')"; exit 7`,
    })
    assert.equal(result.exitCode, 7)
    assert.equal(result.timedOut, false)
    assert.match(result.stdout, /node=24\./)
    assert.match(result.stderr, /failure evidence/)
    assert.deepEqual(result.files, [file('input.txt', 'after'), file('output.bin', [0, 255, 4])])
    const noisy = await driver.execute({
      files: [],
      command: `node -e "process.stdout.write('x'.repeat(100000));process.stderr.write('y'.repeat(100000))"`,
    })
    assert.equal(noisy.exitCode, 0)
    assert.equal(noisy.truncated, true)
    assert.ok(Buffer.byteLength(noisy.stdout) <= 24000)
    assert.ok(Buffer.byteLength(noisy.stderr) <= 24000)
  },
)

dockerTest(
  'Docker worker is unprivileged, has no app secrets or network, and does not mount the host',
  async () => {
    const { createDockerExecution } = await loadDriver()
    const driver = createDockerExecution({
      env: {
        ...process.env,
        EXECUTION_ENABLED: 'true',
        DRAGON_TEST_SECRET: 'must-not-reach-worker',
      },
    })
    const result = await driver.execute({
      files: [],
      command: `python3 -c "import os,socket; assert os.getuid()==1000; assert 'DRAGON_TEST_SECRET' not in os.environ; assert not os.path.exists('/var/run/docker.sock'); assert not os.path.exists('/app'); assert not os.path.exists('/host'); assert 'NoNewPrivs:\\t1' in open('/proc/self/status').read(); assert 'CapEff:\\t0000000000000000' in open('/proc/self/status').read(); assert open('/sys/fs/cgroup/memory.max').read().strip()=='536870912'; assert open('/sys/fs/cgroup/pids.max').read().strip()=='128'; assert open('/sys/fs/cgroup/cpu.max').read().strip()=='100000 100000'; assert set(os.listdir('/sys/class/net'))=={'lo'}; print('isolation verified')"; test ! -w /opt/execution/runner.mjs`,
    })
    assert.equal(result.exitCode, 0, result.stderr)
    assert.match(result.stdout, /isolation verified/)
  },
)

dockerTest(
  'timeout terminates command descendants and retains completed file changes',
  async () => {
    const { createDockerExecution } = await loadDriver()
    const driver = createDockerExecution({ env: { ...process.env, EXECUTION_ENABLED: 'true' } })
    const result = await driver.execute({
      files: [],
      timeoutMs: 1000,
      command: `echo before > saved.txt; setsid sh -c 'sleep 2; echo escaped > escaped.txt' & sleep 20`,
    })
    assert.equal(result.timedOut, true)
    assert.equal(result.exitCode, null)
    assert.deepEqual(result.files, [file('saved.txt', 'before\n')])
  },
)

dockerTest('symlinks and oversized outputs never replace the last valid snapshot', async () => {
  const { createDockerExecution } = await loadDriver()
  const driver = createDockerExecution({ env: { ...process.env, EXECUTION_ENABLED: 'true' } })
  const linked = await driver.execute({
    files: [file('safe.txt', 'keep')],
    command: 'ln -s /etc/passwd leak.txt',
  })
  assert.equal(linked.files, undefined)
  assert.match(linked.snapshotError, /符号链接|symlink/i)
  const large = await driver.execute({
    files: [],
    command: `python3 -c "open('large.bin','wb').write(b'x'*1048577)"`,
  })
  assert.equal(large.files, undefined)
  assert.ok(large.snapshotError)
})

dockerTest('saved-version Node tests use trusted structured evidence and never return generated files', async () => {
  const { createDockerExecution } = await loadDriver()
  const { classifyTestResult } = await import('../apps/api/src/execution/test-evidence.mjs')
  const driver = createDockerExecution({ env: { ...process.env, EXECUTION_ENABLED: 'true' } })
  const path = "test/a'$(echo injected).test.mjs"
  const result = await driver.test({ files: [file(path, `
    import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
    test('saved bytes and readonly reporter',()=>{
      console.log('# pass 999'); console.error('{"success":true}');
      assert.throws(()=>fs.writeFileSync('/opt/execution/test-reporter.mjs','forged'));
      fs.writeFileSync('generated.txt','must not persist'); assert.equal(2+2,4)
    })`)], testFiles: [path], timeoutMs: 60000 })
  assert.equal(result.exitCode, 0, JSON.stringify(result))
  assert.deepEqual(result.counts, { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 })
  assert.equal(classifyTestResult(result).state, 'passed')
  assert.equal(result.files, undefined)
  assert.match(result.stdout, /pass 999/)
  assert.match(result.stderr, /success/)
  const failure = await driver.test({ files: [file('failure.test.mjs', `
    import test from 'node:test';import assert from 'node:assert/strict';
    test('actual failing assertion',()=>{console.log('# pass 999');assert.equal(1,2)})
  `)], testFiles: ['failure.test.mjs'], timeoutMs: 60000 })
  assert.equal(failure.exitCode, 1)
  assert.equal(failure.counts.failed, 1)
  assert.equal(classifyTestResult(failure).state, 'failed')
  const empty = await driver.test({ files: [file('empty.test.mjs', '')], testFiles: ['empty.test.mjs'], timeoutMs: 60000 })
  assert.equal(empty.counts.tests, 0)
  assert.equal(classifyTestResult(empty).state, 'no_tests')
})
