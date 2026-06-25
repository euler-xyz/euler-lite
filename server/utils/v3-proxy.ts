import { V3_API_PROXY_URL, readResolvedV3ApiUrl, readV3ApiKey } from '~/utils/api-url-env'

const FORWARDED_RESPONSE_HEADERS = [
  'cache-control',
  'cf-ray',
  'content-type',
  'etag',
  'last-modified',
] as const

const GET_ONLY_PATHS = new Set([
  '/v3/apys/intrinsic',
  '/v3/apys/rewards',
  '/v3/earn/vaults',
  '/v3/evk/vaults',
  '/v3/evk/vaults/bad-debt',
  '/v3/prices',
  '/v3/rewards/breakdown',
  '/v3/tokens',
])

const GET_ONLY_PATH_PATTERNS = [
  /^\/v3\/accounts\/[^/]+\/positions$/,
  /^\/v3\/earn\/vaults\/[^/]+\/[^/]+$/,
]

const POST_ONLY_PATHS = new Set([
  '/v3/evk/vaults/batch',
  '/v3/resolve/vaults',
])

type V3ProxyValidationResult
  = | { ok: true }
    | { ok: false, statusCode: number, statusMessage: string }

const cleanBasePath = (pathname: string) => pathname.replace(/\/+$/, '')
const normalizeV3ProxyPath = (pathname: string) => pathname.startsWith('/v3/')
  ? pathname
  : `/v3${pathname.startsWith('/') ? pathname : `/${pathname}`}`

export function getV3ProxyPath(requestUrl: URL): string {
  const path = requestUrl.pathname.startsWith(V3_API_PROXY_URL)
    ? requestUrl.pathname.slice(V3_API_PROXY_URL.length) || '/'
    : requestUrl.pathname

  return normalizeV3ProxyPath(path)
}

export function isV3ProxyPathAllowed(pathname: string): boolean {
  return (
    GET_ONLY_PATHS.has(pathname)
    || POST_ONLY_PATHS.has(pathname)
    || GET_ONLY_PATH_PATTERNS.some(pattern => pattern.test(pathname))
  )
}

const invalid = (statusCode: number, statusMessage: string): V3ProxyValidationResult => ({
  ok: false,
  statusCode,
  statusMessage,
})

export function validateV3ProxyUrl(method: string, requestUrl: URL): V3ProxyValidationResult {
  const normalizedMethod = method.toUpperCase()
  const pathname = getV3ProxyPath(requestUrl)

  if (!isV3ProxyPathAllowed(pathname)) {
    return invalid(404, 'V3 path not allowed')
  }

  if (normalizedMethod === 'POST') {
    if (!POST_ONLY_PATHS.has(pathname)) return invalid(405, 'Method not allowed')
    return { ok: true }
  }

  if (normalizedMethod !== 'GET') {
    return invalid(405, 'Method not allowed')
  }

  if (POST_ONLY_PATHS.has(pathname)) return invalid(405, 'Method not allowed')

  return { ok: true }
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
  method: string,
  env: NodeJS.ProcessEnv = process.env,
): Headers {
  const headers = new Headers({ accept: 'application/json' })
  if (method.toUpperCase() === 'POST') headers.set('content-type', 'application/json')

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
