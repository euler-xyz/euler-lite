import { readTurtleEarnApiKey } from '~/utils/api-url-env'

/**
 * Upstream + credential resolution for `/api/internal/proxy/turtle`.
 *
 * Turtle Earn requires an API key on every request (`X-API-Key`, per Turtle's
 * own 401 body and their Earn API docs). The key is read from the server-only
 * `TURTLE_EARN_API_KEY` variable — never from a `NUXT_PUBLIC_*` name — and is
 * only ever attached to requests whose destination passed
 * `resolveTurtleUpstreamBase`, so a misconfigured override cannot leak it to
 * an arbitrary host.
 */

export const DEFAULT_TURTLE_EARN_API_URL = 'https://earn.turtle.xyz/v1'

const TURTLE_EARN_API_URL_ENV_KEYS = ['TURTLE_EARN_API_URL', 'NUXT_PUBLIC_TURTLE_EARN_API_URL'] as const

const TRUSTED_TURTLE_APEX = 'turtle.xyz'
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

export type TurtleUpstreamRejection
  = | 'invalid-url'
    | 'credentials-in-url'
    | 'insecure-protocol'
    | 'untrusted-host'

export type TurtleUpstreamResolution
  = | { ok: true, base: string }
    | { ok: false, reason: TurtleUpstreamRejection }

const readConfiguredUpstream = (env: NodeJS.ProcessEnv): string => {
  for (const key of TURTLE_EARN_API_URL_ENV_KEYS) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return DEFAULT_TURTLE_EARN_API_URL
}

const isTrustedTurtleHost = (hostname: string): boolean =>
  hostname === TRUSTED_TURTLE_APEX || hostname.endsWith(`.${TRUSTED_TURTLE_APEX}`)

/**
 * Resolve the Turtle upstream base URL (no trailing slash) the proxy may send
 * the API key to. Only `https://` on `turtle.xyz` hosts is trusted; loopback
 * hosts are additionally allowed over plain http for local mocks.
 */
export function resolveTurtleUpstreamBase(env: NodeJS.ProcessEnv = process.env): TurtleUpstreamResolution {
  let url: URL
  try {
    url = new URL(readConfiguredUpstream(env))
  }
  catch {
    return { ok: false, reason: 'invalid-url' }
  }

  if (url.username || url.password) return { ok: false, reason: 'credentials-in-url' }

  const hostname = url.hostname.toLowerCase()
  const loopback = LOOPBACK_HOSTNAMES.has(hostname)
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    return { ok: false, reason: 'insecure-protocol' }
  }
  if (!loopback && !isTrustedTurtleHost(hostname)) return { ok: false, reason: 'untrusted-host' }

  return { ok: true, base: `${url.origin}${url.pathname}`.replace(/\/+$/, '') }
}

/**
 * Request headers for the Turtle upstream fetch. Returns `undefined` when no
 * key is configured so callers fail closed instead of sending an
 * unauthenticated request that Turtle would reject with 401 anyway.
 */
export function buildTurtleProxyRequestHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const apiKey = readTurtleEarnApiKey(env).trim()
  if (!apiKey) return undefined
  return { 'accept': 'application/json', 'X-API-Key': apiKey }
}
