import type { H3Event } from 'h3'
import { getRequestURL, setResponseHeader } from 'h3'

const NO_STORE_CACHE_CONTROL = 'no-store'
const USER_REWARD_PATH_RE = /^\/api\/proxy\/merkl\/users\/0x[a-fA-F0-9]{40}\/rewards\/?$/

const alwaysNoStorePrefixes = [
  '/api/proxy/subgraph/',
  '/api/proxy/turtle/',
  '/api/rpc/',
  '/api/tenderly/',
] as const

const alwaysNoStorePaths = new Set([
  '/api/pyth/updates',
  '/api/proxy/fuul/claimable-rewards',
  '/api/proxy/incentra/v1/getMerkleProofsBatch',
  '/api/screen-address',
])

export function forceNoStoreCacheHeaders(event: H3Event): void {
  setResponseHeader(event, 'Cache-Control', NO_STORE_CACHE_CONTROL)
  setResponseHeader(event, 'CDN-Cache-Control', NO_STORE_CACHE_CONTROL)
  setResponseHeader(event, 'Cloudflare-CDN-Cache-Control', NO_STORE_CACHE_CONTROL)
}

export function shouldForceNoStoreForPath(pathname: string): boolean {
  if (alwaysNoStorePaths.has(pathname)) return true
  if (USER_REWARD_PATH_RE.test(pathname)) return true
  return alwaysNoStorePrefixes.some(prefix => pathname.startsWith(prefix))
}

export function forceNoStoreForErrorResponse(event: H3Event): void {
  const statusCode = event.node.res.statusCode
  if (statusCode < 400) return

  forceNoStoreCacheHeaders(event)
}

export function forceNoStoreForSensitivePath(event: H3Event): void {
  const { pathname } = getRequestURL(event)
  if (!shouldForceNoStoreForPath(pathname)) return

  forceNoStoreCacheHeaders(event)
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('error', (_error, context) => {
    if (context.event) {
      forceNoStoreCacheHeaders(context.event)
    }
  })
  nitroApp.hooks.hook('beforeResponse', (event) => {
    forceNoStoreForSensitivePath(event)
    forceNoStoreForErrorResponse(event)
  })
})
