import { readFile } from 'node:fs/promises'
import { randomBytes, randomUUID, createHash, timingSafeEqual, scryptSync } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { fail } from './db.mjs'
export const hash = (value) => createHash('sha256').update(value).digest('hex')
const token = () => randomBytes(32).toString('base64url')
export function authService({ pool, cache, env }) {
  const secure = env.NODE_ENV === 'production'
  const cookieName = secure ? '__Host-office' : 'office_session'
  const opts = { httpOnly: true, secure, sameSite: 'lax', path: '/' }
  const origin = env.APP_ORIGIN
  const issuer = env.COGNITO_ISSUER
  const jwks = issuer ? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)) : null
  async function session(req) {
    const id = req.cookies[cookieName]
    if (!id) throw fail(401, '请先登录')
    const raw = await cache.get(`session:${hash(id)}`)
    if (!raw) throw fail(401, '登录已过期')
    return { ...JSON.parse(raw), sessionId: id }
  }
  async function issue(reply, user) {
    const id = token(),
      csrf = token()
    await cache.set(
      `session:${hash(id)}`,
      JSON.stringify({ userId: user.id, email: user.email, csrf }),
      { EX: 3600 },
    )
    reply.setCookie(cookieName, id, { ...opts, maxAge: 3600 })
    return { user: { id: user.id, email: user.email }, csrf }
  }
  async function userFromClaims({ sub, email, email_verified }) {
    if (!sub || !email || email_verified !== true) throw fail(403, '请先验证邮箱')
    const {
      rows: [existing],
    } = await pool.query('SELECT * FROM users WHERE subject=$1', [sub])
    // Identity is bound to the IdP subject; matching an email never silently merges identities.
    if (existing) return existing
    const {
      rows: [user],
    } = await pool.query(
      'INSERT INTO users(id,subject,email) VALUES($1,$2,$3) ON CONFLICT(subject) DO UPDATE SET subject=EXCLUDED.subject RETURNING *',
      [randomUUID(), sub, email.toLowerCase()],
    )
    return user
  }
  function register(app) {
    app.get('/auth/login', async (req, reply) => {
      if (!issuer) throw fail(503, '尚未配置 Cognito 登录服务')
      const state = token(),
        verifier = token(),
        nonce = token(),
        binding = token()
      await cache.set(
        `oauth:${hash(state)}`,
        JSON.stringify({ verifier, nonce, binding: hash(binding) }),
        { EX: 300 },
      )
      reply.setCookie('office_oauth', binding, { ...opts, maxAge: 300 })
      const url = new URL('/oauth2/authorize', env.COGNITO_DOMAIN)
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: env.COGNITO_CLIENT_ID,
        redirect_uri: `${origin}/auth/callback`,
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString()
      return reply.redirect(url.toString())
    })
    app.get('/auth/callback', async (req, reply) => {
      const { state, code } = req.query
      if (typeof state !== 'string' || typeof code !== 'string') throw fail(400, '登录回调参数无效')
      const raw = await cache.getDel(`oauth:${hash(state)}`)
      if (!raw) throw fail(400, '登录请求已失效，请重新登录')
      const saved = JSON.parse(raw)
      if (hash(req.cookies.office_oauth || '') !== saved.binding)
        throw fail(400, '登录请求与当前浏览器不匹配')
      const response = await fetch(`${env.COGNITO_DOMAIN}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: env.COGNITO_CLIENT_ID,
          code,
          redirect_uri: `${origin}/auth/callback`,
          code_verifier: saved.verifier,
        }),
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) throw fail(401, '登录验证失败')
      const data = await response.json()
      const { payload } = await jwtVerify(data.id_token, jwks, {
        issuer,
        audience: env.COGNITO_CLIENT_ID,
        algorithms: ['RS256'],
      })
      if (payload.nonce !== saved.nonce || payload.token_use !== 'id')
        throw fail(401, '登录凭证无效')
      await issue(reply, await userFromClaims(payload))
      reply.clearCookie('office_oauth', opts)
      return reply.redirect('/')
    })
    app.post('/auth/logout', async (req, reply) => {
      const s = await session(req)
      checkCsrf(req, s)
      await cache.del(`session:${hash(s.sessionId)}`)
      reply.clearCookie(cookieName, opts)
      const url = env.COGNITO_DOMAIN
        ? `${env.COGNITO_DOMAIN}/logout?${new URLSearchParams({ client_id: env.COGNITO_CLIENT_ID, logout_uri: origin })}`
        : origin
      return { redirect: url }
    })
    if (env.AUTH_MODE === 'local') {
      if (secure || !['http://localhost:3000', 'http://127.0.0.1:3000'].includes(origin))
        throw new Error('Local authentication is only allowed on loopback in development')
      app.post('/auth/local', async (req, reply) => {
        if (req.headers.origin !== origin) throw fail(403, '请求来源无效')
        const { email, password } = req.body || {}
        let accounts = [
          {
            email: env.LOCAL_EMAIL,
            salt: env.LOCAL_PASSWORD_SALT,
            passwordHash: env.LOCAL_PASSWORD_HASH,
          },
        ]
        if (env.LOCAL_ACCOUNTS_FILE)
          accounts.push(...JSON.parse(await readFile(env.LOCAL_ACCOUNTS_FILE, 'utf8')))
        const account = accounts.find((a) => a.email === String(email || '').toLowerCase())
        const expected = account?.passwordHash || ''
        const actual = scryptSync(
          String(password || ''),
          account?.salt || 'unmatched-local-user',
          32,
        ).toString('hex')
        if (
          !account ||
          expected.length !== actual.length ||
          !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
        )
          throw fail(401, '邮箱或密码不正确')
        return issue(
          reply,
          await userFromClaims({
            sub: `local:${email.toLowerCase()}`,
            email,
            email_verified: true,
          }),
        )
      })
    }
  }
  function checkCsrf(req, s) {
    if (req.headers.origin !== origin || req.headers['x-csrf-token'] !== s.csrf)
      throw fail(403, '请求验证失败，请刷新页面')
  }
  return { register, session, checkCsrf }
}
