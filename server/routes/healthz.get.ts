import { forceNoStoreCacheHeaders } from '~/server/utils/cache-headers'

/**
 * Container/platform liveness probe (Docker HEALTHCHECK, Railway).
 *
 * Deliberately lives OUTSIDE /api/ so it is exempt from the geo-gate, rate
 * limiting, and internal-request authentication: a liveness probe must not
 * depend on edge configuration (EDGE_PROVIDER / EDGE_ORIGIN_SECRET), and
 * giving it the origin secret would leak the secret into healthcheck
 * arguments and process listings. It reports process liveness only — no
 * upstream or config checks — so it cannot flap for reasons a container
 * restart wouldn't fix.
 */
export default defineEventHandler((event) => {
  forceNoStoreCacheHeaders(event)
  return { status: 'ok' }
})
