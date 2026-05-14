import { V3_API_PROXY_URL, readResolvedV3ApiUrl, readV3ApiKey } from '~/utils/api-url-env'

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-api-key',
])

const FORWARDED_RESPONSE_HEADERS = [
  'cache-control',
  'content-type',
  'etag',
  'last-modified',
] as const

export const ALLOWED_V3_PROXY_PATH_PREFIXES = [
  '/v3/accounts',
  '/v3/apys',
  '/v3/earn/vaults',
  '/v3/evk/vaults',
  '/v3/prices',
  '/v3/resolve/vaults',
  '/v3/rewards',
  '/v3/tokens',
] as const

const cleanBasePath = (pathname: string) => pathname.replace(/\/+$/, '')

export function getV3ProxyPath(requestUrl: URL): string {
  return requestUrl.pathname.startsWith(V3_API_PROXY_URL)
    ? requestUrl.pathname.slice(V3_API_PROXY_URL.length) || '/'
    : requestUrl.pathname
}

export function isV3ProxyPathAllowed(pathname: string): boolean {
  return ALLOWED_V3_PROXY_PATH_PREFIXES.some(prefix =>
    pathname === prefix || pathname.startsWith(`${prefix}/`))
}

export function buildV3ProxyTarget(requestUrl: URL, env: NodeJS.ProcessEnv = process.env): string {
  const upstream = new URL(readResolvedV3ApiUrl(env))
  const suffix = getV3ProxyPath(requestUrl)

  upstream.pathname = `${cleanBasePath(upstream.pathname)}${suffix.startsWith('/') ? suffix : `/${suffix}`}`
  upstream.search = requestUrl.search
  upstream.hash = ''
  return upstream.toString()
}

export function buildV3ProxyRequestHeaders(
  incomingHeaders: Record<string, string | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): Headers {
  const headers = new Headers()

  for (const [key, value] of Object.entries(incomingHeaders)) {
    if (!value) continue
    const lower = key.toLowerCase()
    if (HOP_BY_HOP_REQUEST_HEADERS.has(lower)) continue
    if (lower.startsWith('cf-')) continue
    if (lower.startsWith('x-forwarded-')) continue
    headers.set(key, value)
  }

  const apiKey = readV3ApiKey(env).trim()
  if (apiKey) headers.set('X-API-Key', apiKey)

  return headers
}

export function readForwardedV3ResponseHeaders(headers: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = headers.get(name)
    if (value) forwarded[name] = value
  }
  return forwarded
}
