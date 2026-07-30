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
  '/v3/evk/vaults/open-interest',
  '/v3/evk/vaults/open-interest/by-collateral',
  '/v3/liquidations',
  '/v3/prices',
  '/v3/rewards/breakdown',
  '/v3/tokens',
])

const GET_ONLY_PATH_PATTERNS = [
  /^\/v3\/accounts\/[^/]+\/positions$/,
  /^\/v3\/activity\/accounts\/0x[a-fA-F0-9]{40}\/events$/,
  /^\/v3\/activity\/vaults\/[1-9][0-9]{0,15}\/0x[a-fA-F0-9]{40}\/events$/,
  /^\/v3\/earn\/vaults\/[^/]+\/[^/]+$/,
  /^\/v3\/earn\/vaults\/[^/]+\/[^/]+\/totals$/,
  /^\/v3\/evk\/vaults\/[^/]+\/[^/]+\/totals$/,
]

const POST_ONLY_PATHS = new Set([
  '/v3/evk/vaults/batch',
  '/v3/resolve/vaults',
])

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const INTEGER_RE = /^[0-9]{1,16}$/
const CHAIN_ID_LIST_RE = /^(?=.{1,256}$)[1-9][0-9]{0,15}(?:,[1-9][0-9]{0,15})*$/
const DECIMAL_RE = /^[0-9]+(?:\.[0-9]+)?$/
const ACTIVITY_FILTER_RE = /^(?=.{1,256}$)[a-z][a-z0-9_]*(?:,[a-z][a-z0-9_]*)*$/
const SAFE_QUERY_FIELDS = {
  from: INTEGER_RE,
  limit: INTEGER_RE,
  minBadDebtUsd: DECIMAL_RE,
  offset: INTEGER_RE,
  resolution: /^[A-Za-z0-9_-]{1,16}$/,
  to: INTEGER_RE,
} as const

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

const cleanParam = (value: string | null, pattern: RegExp): string | undefined =>
  value != null && pattern.test(value) ? value : undefined

const readSafeQueryFields = (params: URLSearchParams): Record<string, string> => {
  const fields: Record<string, string> = {}
  for (const [name, pattern] of Object.entries(SAFE_QUERY_FIELDS)) {
    const value = cleanParam(params.get(name), pattern)
    if (value != null) fields[`v3${name[0].toUpperCase()}${name.slice(1)}`] = value
  }
  return fields
}

export function buildV3ProxyLogFields(requestUrl: URL): Record<string, string> {
  const pathname = getV3ProxyPath(requestUrl)
  const parts = pathname.split('/').filter(Boolean)
  const fields: Record<string, string> = {}
  const chainId = cleanParam(requestUrl.searchParams.get('chainId'), INTEGER_RE)
  if (chainId != null) fields.v3ChainId = chainId

  if (
    parts.length === 5
    && parts[0] === 'v3'
    && (parts[1] === 'evk' || parts[1] === 'earn')
    && parts[2] === 'vaults'
    && INTEGER_RE.test(parts[3])
    && ADDRESS_RE.test(parts[4])
  ) {
    fields.v3VaultKind = parts[1]
    fields.v3ChainId = parts[3]
    fields.v3VaultAddress = parts[4]
  }

  if (
    parts.length === 6
    && parts[0] === 'v3'
    && (parts[1] === 'evk' || parts[1] === 'earn')
    && parts[2] === 'vaults'
    && INTEGER_RE.test(parts[3])
    && ADDRESS_RE.test(parts[4])
    && parts[5] === 'totals'
  ) {
    fields.v3VaultKind = parts[1]
    fields.v3ChainId = parts[3]
    fields.v3VaultAddress = parts[4]
  }

  if (
    parts.length === 4
    && parts[0] === 'v3'
    && parts[1] === 'evk'
    && parts[2] === 'vaults'
    && parts[3] === 'open-interest'
  ) {
    const vaultAddress = cleanParam(requestUrl.searchParams.get('vault'), ADDRESS_RE)
    if (vaultAddress != null) fields.v3VaultAddress = vaultAddress
  }

  if (parts.length === 2 && parts[0] === 'v3' && parts[1] === 'liquidations') {
    fields.v3ActivityScope = 'liquidations'
    // Violator and liquidator filters identify wallets and are intentionally
    // omitted; the vault filter is enough to diagnose upstream failures.
    const vaultAddress = cleanParam(requestUrl.searchParams.get('vault'), ADDRESS_RE)
    if (vaultAddress != null) fields.v3VaultAddress = vaultAddress
  }

  if (
    parts.length === 5
    && parts[0] === 'v3'
    && parts[1] === 'activity'
    && parts[2] === 'accounts'
    && ADDRESS_RE.test(parts[3])
    && parts[4] === 'events'
  ) {
    fields.v3ActivityScope = 'account'
    delete fields.v3ChainId
    // Account addresses are intentionally omitted. They identify the wallet
    // being viewed and are not needed to diagnose upstream activity failures.
    const activityChainIds = cleanParam(requestUrl.searchParams.get('chainId'), CHAIN_ID_LIST_RE)
    if (activityChainIds != null) fields.v3ChainIds = activityChainIds
  }

  if (
    parts.length === 6
    && parts[0] === 'v3'
    && parts[1] === 'activity'
    && parts[2] === 'vaults'
    && INTEGER_RE.test(parts[3])
    && ADDRESS_RE.test(parts[4])
    && parts[5] === 'events'
  ) {
    fields.v3ActivityScope = 'vault'
    fields.v3ChainId = parts[3]
    fields.v3VaultAddress = parts[4]
    const vaultType = cleanParam(requestUrl.searchParams.get('vaultType'), /^(?:evk|earn|securitize)$/)
    if (vaultType != null) fields.v3VaultKind = vaultType
  }

  const activityCategories = cleanParam(requestUrl.searchParams.get('category'), ACTIVITY_FILTER_RE)
  if (activityCategories != null && fields.v3ActivityScope) fields.v3ActivityCategories = activityCategories
  const activityEventTypes = cleanParam(requestUrl.searchParams.get('eventType'), ACTIVITY_FILTER_RE)
  if (activityEventTypes != null && fields.v3ActivityScope) fields.v3ActivityEventTypes = activityEventTypes

  return {
    ...fields,
    ...readSafeQueryFields(requestUrl.searchParams),
  }
}

export function readForwardedV3ResponseHeaders(headers: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = headers.get(name)
    if (value) forwarded[name] = value
  }
  return forwarded
}
