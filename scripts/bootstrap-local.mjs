import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { makePool, transaction } from '../apps/api/src/db.mjs'
if (
  process.env.AUTH_MODE !== 'local' ||
  process.env.NODE_ENV === 'production' ||
  process.env.PGHOST !== '127.0.0.1' ||
  process.env.DATABASE_URL
)
  throw new Error('Local bootstrap may only target the local database')
const result = spawnSync(process.execPath, ['database/bootstrap.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, PGUSER: 'office_admin', PGPASSWORD: process.env.LOCAL_DB_PASSWORD },
})
if (result.status !== 0) process.exit(result.status || 1)
const pool = await makePool()
try {
  const owner = randomUUID(),
    member = randomUUID(),
    tenant = randomUUID(),
    personal = randomUUID()
  if (
    (
      await pool.query('SELECT id FROM users WHERE subject=$1', [
        `local:${process.env.LOCAL_EMAIL}`,
      ])
    ).rows.length
  ) {
    console.log('Existing local workspaces preserved')
    process.exitCode = 0
  } else {
    if (Number((await pool.query('SELECT count(*) FROM users')).rows[0].count) !== 0)
      throw new Error(
        'Existing users do not match LOCAL_EMAIL. Restore the original .env and account files; refusing to create replacement identities.',
      )
    const password = randomBytes(18).toString('base64url'),
      salt = randomBytes(16).toString('hex'),
      email = 'member@local.test'
    await mkdir('.local', { recursive: true })
    await writeFile(
      '.local/accounts.json',
      JSON.stringify([
        { email, salt, passwordHash: scryptSync(password, salt, 32).toString('hex') },
      ]),
      { mode: 0o600 },
    )
    const login = await readFile('.local/login.txt', 'utf8')
    await writeFile(
      '.local/login.txt',
      login + `\nSecond local account\nEmail: ${email}\nPassword: ${password}\n`,
      { mode: 0o600 },
    )
    await transaction(pool, async (db) => {
      for (const [id, address] of [
        [owner, process.env.LOCAL_EMAIL],
        [member, email],
      ])
        await db.query('INSERT INTO users(id,subject,email) VALUES($1,$2,$3)', [
          id,
          `local:${address}`,
          address,
        ])
      await db.query(
        "INSERT INTO tenants(id,name,plan,subscription_status) VALUES($1,'本地企业联调','enterprise','manual'),($2,'个人工作空间','personal','none')",
        [tenant, personal],
      )
      await db.query(
        "INSERT INTO memberships VALUES($1,$2,'owner'),($1,$3,'member'),($4,$2,'owner')",
        [tenant, owner, member, personal],
      )
    })
    console.log(
      'Local enterprise and personal workspaces initialized; credentials are in .local/login.txt',
    )
  }
} finally {
  await pool.end()
}
