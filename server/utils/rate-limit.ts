import type { H3Event } from 'h3'
import { createError } from 'h3'

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

// NOTE: In-memory rate limiting is per-process. If Nitro runs multiple
// workers the effective limit is multiplied by the worker count.

/**
 * Extract the client IP from an H3 event.
 *
 * Prefers CF-Connecting-IP (set by Cloudflare, cannot be spoofed by the
 * client), falls back to X-Forwarded-For, then the raw socket address.
 */
export function getClientIp(event: H3Event): string {
  const cfIp = event.node.req.headers['cf-connecting-ip']
  if (typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim()

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
     */
    consume(event: H3Event, cost = 1): void {
      const ip = getClientIp(event)
      const now = Date.now()
      const entry = map.get(ip)

      if (entry && now < entry.resetAt) {
        if (entry.consumed + cost > config.max) {
          console.warn(`[${config.label}] Rate limited:`, ip)
          throw createError({ statusCode: 429, statusMessage: 'Too Many Requests' })
        }
        map.set(ip, { consumed: entry.consumed + cost, resetAt: entry.resetAt })
      }
      else {
        if (cost > config.max) {
          console.warn(`[${config.label}] Rate limited:`, ip)
          throw createError({ statusCode: 429, statusMessage: 'Too Many Requests' })
        }
        map.set(ip, { consumed: cost, resetAt: now + config.windowMs })
      }
    },
  }
}
