import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fail } from '../db.mjs'
export async function configKey(env) {
  const encoded = env.OPERATIONS_CONFIG_KEY || (env.OPERATIONS_CONFIG_KEY_FILE ? (await readFile(env.OPERATIONS_CONFIG_KEY_FILE, 'utf8')).trim() : '')
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32) throw fail(503, '企业密钥存储尚未初始化')
  return key
}
export function encryptConfig(value, key, tenantId) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(tenantId))
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map(v => v.toString('base64')).join('.')
}
export function decryptConfig(value, key, tenantId) {
  const [iv, tag, data] = value.split('.').map(v => Buffer.from(v, 'base64'))
  const cipher = createDecipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(tenantId)); cipher.setAuthTag(tag)
  return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString())
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  return JSON.stringify(value)
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
export function signBridge(secret, method, path, body, timestamp = String(Date.now())) {
  const signature = createHmac('sha256', secret).update(`${timestamp}\n${method}\n${path}\n${canonical(body)}`).digest('hex')
  return { 'x-office-time': timestamp, 'x-office-signature': signature }
}
export function verifyBridge(secret, method, path, body, headers) {
  const time = String(headers['x-office-time'] || '')
  const got = String(headers['x-office-signature'] || '')
  if (!/^\d+$/.test(time) || Math.abs(Date.now() - Number(time)) > 60000 || !/^[a-f0-9]{64}$/.test(got)) return false
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(signBridge(secret, method, path, body, time)['x-office-signature'], 'hex'))
}
