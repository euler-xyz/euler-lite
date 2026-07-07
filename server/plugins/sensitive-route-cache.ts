import type { H3Event } from 'h3'
import { getRequestURL } from 'h3'
import { forceNoStoreCacheHeaders } from '~/server/utils/cache-headers'

const USER_REWARD_PATH_RE = /^\/api\/internal\/proxy\/merkl\/users\/0x[a-fA-F0-9]{40}\/rewards$/

const alwaysNoStorePrefixes = [
  '/api/internal/proxy/subgraph',
  '/api/internal/proxy/turtle',
  '/api/internal/rpc',
  '/api/internal/tenderly',
] as const

const alwaysNoStorePaths = new Set([
  '/api/internal/pyth/updates',
  '/api/internal/proxy/fuul/claimable-rewards',
  '/api/internal/proxy/incentra/v1/getMerkleProofsBatch',
  '/api/internal/screen-address',
])

const normalizePathname = (pathname: string): string =>
  pathname === '/' ? pathname : pathname.replace(/\/+$/, '')

const isPathInPrefix = (pathname: string, prefix: string): boolean =>
  pathname === prefix || pathname.startsWith(`${prefix}/`)

export function shouldForceNoStoreForPath(pathname: string): boolean {
  const normalizedPathname = normalizePathname(pathname)
  if (alwaysNoStorePaths.has(normalizedPathname)) return true
  if (USER_REWARD_PATH_RE.test(normalizedPathname)) return true
  return alwaysNoStorePrefixes.some(prefix => isPathInPrefix(normalizedPathname, prefix))
}

export function forceNoStoreForSensitivePath(event: H3Event): void {
  const { pathname } = getRequestURL(event)
  if (!shouldForceNoStoreForPath(pathname)) return

  forceNoStoreCacheHeaders(event)
}

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('beforeResponse', (event) => {
    forceNoStoreForSensitivePath(event)
  })
})
