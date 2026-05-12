import type { H3Event } from 'h3'
import { randomUUID } from 'node:crypto'

export const INTERNAL_REQUEST_HEADER = 'x-euler-internal-request'

const INTERNAL_REQUEST_SECRET = process.env.INTERNAL_FETCH_SECRET?.trim() || randomUUID()

/**
 * Synthetic headers for server-internal $fetch calls.
 *
 * Internal fetches from warm-cache, vaults-cache, etc. don't go through
 * Cloudflare, so they have neither `cf-connecting-ip` nor `cf-ipcountry`.
 * This private header lets downstream middleware recognise those calls and
 * skip checks that only make sense for public edge traffic.
 *
 * The value is either `INTERNAL_FETCH_SECRET` (for deployments that need a
 * shared internal secret across workers) or a process-local random value.
 * The header name is not secret; the value is.
 */
export const INTERNAL_FETCH_HEADERS = {
  [INTERNAL_REQUEST_HEADER]: INTERNAL_REQUEST_SECRET,
} as const

/**
 * True when the incoming request bears the private internal header set by
 * `INTERNAL_FETCH_HEADERS`. Middleware uses this to bypass geo/rate checks
 * for warm-cache → `/api/*` traffic that never traversed Cloudflare.
 */
export const isInternalRequest = (event: H3Event): boolean =>
  event.node.req.headers[INTERNAL_REQUEST_HEADER] === INTERNAL_REQUEST_SECRET
