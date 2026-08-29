import type { H3Event } from 'h3'
import { createError } from 'h3'
import { getEdgeContext } from '~/server/utils/edge'
import { isInternalRequest } from '~/server/utils/internal-headers'
import { logger } from '~/server/utils/logger'

interface RateLimitEntry {
  consumed: number
  resetAt: number
}

interface RateLimiterConfig {
  /** Maximum allowed cost units within the window */
  max: number
  /** Window duration in milliseconds */
  windowMs: number
  /** Label used in warning logs when a client is rate-limited */
  label: string
}

// NOTE: This rate limiter keys budgets on the trusted client IP delivered by
// the configured edge provider (see server/utils/edge.ts). In production
// (DOPPLER_ENVIRONMENT=prd), requests without a trusted identity are rejected
// fail-closed, which closes the X-Forwarded-For rotation attack that was
// possible via the old fallback path.
//
// Residual limitation: an attacker who knows the origin IP and bypasses the
// edge can still forge the trusted headers with rotating values. Configure
// EDGE_ORIGIN_SECRET (origin auth) to close that, or enforce it at the
// network level (allowlisting the edge's IP ranges at the origin firewall).
//
// In dev and stg, the edge is not always in the request path, so the trusted
// identity is not required and X-Forwarded-For / socket is used instead.
//
// Remaining known limitation:
// - In-memory state is per-process. If Nitro runs multiple workers the
//   effective limit is multiplied by the worker count.

/**
 * Best-effort client IP for environments without a trusted edge identity
 * (dev, stg, previews). Leftmost X-Forwarded-For, then the socket address.
 */
function fallbackClientIp(event: H3Event): string {
  const forwarded = event.node.req.headers['x-forwarded-for']
  const forwardedStr = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return (
    forwardedStr?.split(',')[0]?.trim()
    || event.node.req.socket?.remoteAddress
    || 'unknown'
  )
}

/**
 * Create a cost-based rate limiter.
 *
 * Each call to `consume(event, cost)` deducts `cost` units from the
 * client's budget. When the budget is exhausted a 429 error is thrown.
 */
export function createRateLimiter(config: RateLimiterConfig) {
  const map = new Map<string, RateLimitEntry>()

  // Clean up stale entries every 2 minutes.
  // .unref() lets the process exit naturally without waiting for this timer.
  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of map) {
      if (now > entry.resetAt) map.delete(key)
    }
  }, 120_000)
  cleanup.unref()

  return {
    /**
     * Consume `cost` units from the client's rate-limit budget.
     * Throws a 429 error when the budget is exceeded.
     * In production, throws 403 when there is no trusted client identity.
     */
    consume(event: H3Event, cost = 1): void {
      // Escape hatch for local tooling (e.g. parity capture) that hammers the
      // app from a single IP. Never set in deployed environments.
      if (process.env.DISABLE_RATE_LIMIT === 'true') return
      // Server-internal $fetch calls (warm-cache, vaults-cache) are not
      // rate-limited — see server/utils/internal-headers.ts.
      if (isInternalRequest(event)) return

      const edge = getEdgeContext(event)
      // Fail-closed in production when the edge provided no trusted client
      // identity: the request bypassed the edge (or failed origin auth).
      // stg and dev are exempt: they don't always run behind the edge.
      if (edge.clientIp === null && process.env.DOPPLER_ENVIRONMENT === 'prd') {
        logger.warn({ ctx: 'rate-limit' }, 'blocked: no trusted client identity, request bypassed the edge')
        throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
      }

      const ip = edge.clientIp ?? fallbackClientIp(event)
      const now = Date.now()
      const entry = map.get(ip)

      if (entry && now < entry.resetAt) {
        if (entry.consumed + cost > config.max) {
          logger.warn({ ctx: config.label, ip }, 'rate limited')
          throw createError({ statusCode: 429, statusMessage: 'Too Many Requests' })
        }
        map.set(ip, { consumed: entry.consumed + cost, resetAt: entry.resetAt })
      }
      else {
        if (cost > config.max) {
          logger.warn({ ctx: config.label, ip }, 'rate limited')
          throw createError({ statusCode: 429, statusMessage: 'Too Many Requests' })
        }
        map.set(ip, { consumed: cost, resetAt: now + config.windowMs })
      }
    },
  }
}
