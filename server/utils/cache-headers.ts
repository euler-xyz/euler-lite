import type { H3Event } from 'h3'
import { setResponseHeader } from 'h3'

const NO_STORE_CACHE_CONTROL = 'no-store'

export function forceNoStoreCacheHeaders(event: H3Event): void {
  setResponseHeader(event, 'Cache-Control', NO_STORE_CACHE_CONTROL)
  setResponseHeader(event, 'CDN-Cache-Control', NO_STORE_CACHE_CONTROL)
  setResponseHeader(event, 'Cloudflare-CDN-Cache-Control', NO_STORE_CACHE_CONTROL)
}
