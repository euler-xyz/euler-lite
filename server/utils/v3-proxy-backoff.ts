export const V3_PROXY_FAILURE_BACKOFF_MS = 10_000

const RETRYABLE_V3_PROXY_STATUSES = new Set([429, 500, 502, 503, 504])

type V3ProxyBackoffEntry = {
  until: number
}

const backoffs = new Map<string, V3ProxyBackoffEntry>()

const normalizeV3ProxyBackoffPath = (pathname: string) => {
  if (/^\/v3\/accounts\/[^/]+\/positions$/.test(pathname)) {
    return '/v3/accounts/:address/positions'
  }
  if (/^\/v3\/earn\/vaults\/[^/]+\/[^/]+$/.test(pathname)) {
    return '/v3/earn/vaults/:chainId/:vault'
  }
  return pathname
}

export const buildV3ProxyBackoffKey = (method: string, pathname: string) =>
  `${method.toUpperCase()} ${normalizeV3ProxyBackoffPath(pathname)}`

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
