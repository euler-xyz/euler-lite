import type { H3Event } from 'h3'
import { createError } from 'h3'
import { isProductionRuntime } from '~/server/utils/deploy-env'
import { isInternalRequest } from '~/server/utils/internal-headers'
import { logger } from '~/server/utils/logger'
import { isTrustedIngressRequest } from '~/server/utils/trusted-ingress'

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

// NOTE: This rate limiter relies on Cloudflare being in the request path for
// production (DOPPLER_ENVIRONMENT=prd). CF-Connecting-IP is set by Cloudflare's
// edge and cannot be spoofed by clients going through Cloudflare. The trusted
// ingress also adds x-euler-edge-origin-secret and strips/overwrites incoming
// CF-* forwarding headers before the request reaches the origin.
//
// In production, requests missing either CF-Connecting-IP or the trusted ingress
// secret are rejected fail-closed. This keeps CF-Connecting-IP usable as the
// per-client identity only after the immediate edge/origin path is verified.
//
// In dev and stg, Cloudflare is not always in the request path, so the CF
// requirement is not enforced and X-Forwarded-For / socket is used instead.
//
// Remaining known limitation:
// - In-memory state is per-process. If Nitro runs multiple workers the
//   effective limit is multiplied by the worker count.

function assertProductionIngressTrusted(event: H3Event): void {
  const cfIp = event.node.req.headers['cf-connecting-ip']
  const hasCfIp = typeof cfIp === 'string' && !!cfIp.trim()
  if (!hasCfIp) {
    logger.warn({ ctx: 'rate-limit' }, 'blocked: CF-Connecting-IP absent, request bypassed Cloudflare')
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  if (!isTrustedIngressRequest(event)) {
    logger.warn({ ctx: 'rate-limit' }, 'blocked: trusted ingress secret absent or invalid')
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
}

/**
 * Extract the client IP from an H3 event.
 *
 * Prefers CF-Connecting-IP (set by Cloudflare, cannot be spoofed by clients
 * going through Cloudflare), falls back to X-Forwarded-For, then the raw
 * socket address.
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
     * In production, throws 403 if the request did not arrive via trusted ingress.
     */
    consume(event: H3Event, cost = 1): void {
      if (isInternalRequest(event)) {
        return
      }

      if (isProductionRuntime()) {
        assertProductionIngressTrusted(event)
      }

      const ip = getClientIp(event)
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
