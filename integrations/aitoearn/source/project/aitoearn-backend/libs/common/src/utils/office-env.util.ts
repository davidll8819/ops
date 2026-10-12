/** Resolve whole-value environment references before schema validation. Never include values in errors. */
export function resolveOfficeEnv(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === 'string') {
    const ref = /^\$\{([A-Z][A-Z0-9_]+)\}$/.exec(value)
    if (!ref) return value
    const secret = env[ref[1]]
    if (!secret) throw new Error(`Missing required environment variable: ${ref[1]}`)
    return secret
  }
  if (Array.isArray(value)) return value.map(item => resolveOfficeEnv(item, env))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveOfficeEnv(item, env)]))
  return value
}
