export const V3_PROXY_FAILURE_BACKOFF_MS = 10_000
export const V3_PROXY_MAX_BACKOFF_ENTRIES = 256

const RETRYABLE_V3_PROXY_STATUSES = new Set([429, 500, 502, 503, 504])

type V3ProxyBackoffEntry = {
  until: number
}

const backoffs = new Map<string, V3ProxyBackoffEntry>()

const pruneV3ProxyBackoffs = (now: number) => {
  for (const [key, entry] of backoffs) {
    if (entry.until <= now) backoffs.delete(key)
  }
}

const normalizeV3ProxyBackoffPath = (pathname: string) => {
  if (/^\/v3\/accounts\/[^/]+\/positions$/.test(pathname)) {
    return '/v3/accounts/:address/positions'
  }
  if (/^\/v3\/earn\/vaults\/[^/]+\/[^/]+$/.test(pathname)) {
    return '/v3/earn/vaults/:chainId/:vault'
  }
  if (/^\/v3\/activity\/accounts\/[^/]+\/events$/.test(pathname)) {
    return '/v3/activity/accounts/:owner/events'
  }
  const vaultActivity = pathname.match(/^\/v3\/activity\/vaults\/([^/]+)\/[^/]+\/events$/)
  if (vaultActivity) {
    return `/v3/activity/vaults/${vaultActivity[1]}/:vault/events`
  }
  return pathname
}

const ACTIVITY_FILTER_RE = /^(?=.{1,256}$)[a-z][a-z0-9_]*(?:,[a-z][a-z0-9_]*)*$/
const ACTIVITY_RANGE_RE = /^[0-9]{1,16}$/
const ACTIVITY_CHAIN_IDS_RE = /^(?=.{1,256}$)[1-9][0-9]{0,15}(?:,[1-9][0-9]{0,15})*$/

const buildActivityContextKey = (
  pathname: string,
  searchParams?: URLSearchParams,
) => {
  if (!/^\/v3\/activity\/(?:accounts\/[^/]+|vaults\/[^/]+\/[^/]+)\/events$/.test(pathname) || !searchParams) {
    return pathname
  }

  const contextParams = new URLSearchParams()
  const safeParams: Array<[string, RegExp]> = [
    ['chainId', ACTIVITY_CHAIN_IDS_RE],
    ['vaultType', /^(?:evk|earn|securitize)$/],
    ['from', ACTIVITY_RANGE_RE],
    ['to', ACTIVITY_RANGE_RE],
    ['category', ACTIVITY_FILTER_RE],
    ['eventType', ACTIVITY_FILTER_RE],
  ]
  for (const [name, pattern] of safeParams) {
    const value = searchParams.get(name)
    if (value && pattern.test(value)) contextParams.set(name, value)
  }

  const context = contextParams.toString()
  return context ? `${pathname}?${context}` : pathname
}

const buildVaultTotalsRangeKey = (
  pathname: string,
  searchParams?: URLSearchParams,
) => {
  if (!/^\/v3\/(?:evk|earn)\/vaults\/[^/]+\/[^/]+\/totals$/.test(pathname) || !searchParams) {
    return pathname
  }

  const rangeParams = new URLSearchParams()
  for (const name of ['resolution', 'from', 'to']) {
    const value = searchParams.get(name)
    if (value) rangeParams.set(name, value)
  }

  const range = rangeParams.toString()
  return range ? `${pathname}?${range}` : pathname
}

export const buildV3ProxyBackoffKey = (
  method: string,
  pathname: string,
  searchParams?: URLSearchParams,
) =>
  `${method.toUpperCase()} ${buildActivityContextKey(
    buildVaultTotalsRangeKey(normalizeV3ProxyBackoffPath(pathname), searchParams),
    searchParams,
  )}`

export const readV3ProxyBackoffMs = (
  key: string,
  now = Date.now(),
): number => {
  const entry = backoffs.get(key)
  if (!entry) return 0
  const remainingMs = entry.until - now
  if (remainingMs <= 0) {
    backoffs.delete(key)
    return 0
  }
  return remainingMs
}

export const recordV3ProxyBackoff = (
  key: string,
  now = Date.now(),
) => {
  pruneV3ProxyBackoffs(now)
  backoffs.delete(key)
  while (backoffs.size >= V3_PROXY_MAX_BACKOFF_ENTRIES) {
    const oldestKey = backoffs.keys().next().value
    if (oldestKey === undefined) break
    backoffs.delete(oldestKey)
  }
  backoffs.set(key, { until: now + V3_PROXY_FAILURE_BACKOFF_MS })
}

export const clearV3ProxyBackoff = (key: string) => {
  backoffs.delete(key)
}

export const updateV3ProxyBackoffFromResponse = (
  key: string,
  status: number,
  now = Date.now(),
) => {
  if (RETRYABLE_V3_PROXY_STATUSES.has(status)) {
    recordV3ProxyBackoff(key, now)
  }
}

export const resetV3ProxyBackoffsForTest = () => {
  backoffs.clear()
}

export const getV3ProxyBackoffCountForTest = () => backoffs.size
