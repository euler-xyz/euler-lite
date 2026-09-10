/**
 * Tests for the per-IP rate limiter's identity handling: trusted identity
 * from the edge context, fail-closed in production without one, internal
 * bypass, and the dev/stg best-effort fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
}))

const warn = vi.fn()
vi.mock('~/server/utils/logger', () => ({
  logger: { warn: (...args: unknown[]) => warn(...args) },
}))

const { createRateLimiter } = await import('~/server/utils/rate-limit')
const { getInternalFetchHeaders } = await import('~/server/utils/internal-headers')

const eventWith = (
  headers: Record<string, string | string[] | undefined>,
  remoteAddress?: string,
): H3Event =>
  ({ node: { req: { headers, socket: { remoteAddress } } } }) as unknown as H3Event

const ENV_KNOBS = ['DOPPLER_ENVIRONMENT', 'EDGE_PROVIDER', 'EDGE_ORIGIN_SECRET', 'DISABLE_RATE_LIMIT', 'DEV_GEO_COUNTRY'] as const

const envSnapshot: Record<string, string | undefined> = {}

beforeEach(() => {
  warn.mockClear()
  for (const key of ENV_KNOBS) {
    envSnapshot[key] = process.env[key]
    Reflect.deleteProperty(process.env, key)
  }
})

afterEach(() => {
  for (const key of ENV_KNOBS) {
    if (envSnapshot[key] === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = envSnapshot[key]
  }
})

const makeLimiter = (max = 2) => createRateLimiter({ max, windowMs: 60_000, label: 'test' })

describe('trusted identity (cloudflare preset)', () => {
  beforeEach(() => {
    process.env.EDGE_PROVIDER = 'cloudflare'
  })

  it('budgets per trusted client IP and throws 429 past the budget', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    const limiter = makeLimiter(2)
    const clientA = () => eventWith({ 'cf-connecting-ip': '203.0.113.1' })
    const clientB = () => eventWith({ 'cf-connecting-ip': '203.0.113.2' })

    limiter.consume(clientA())
    limiter.consume(clientA())
    expect(() => limiter.consume(clientA())).toThrow()

    // A different client keeps its own budget.
    expect(() => limiter.consume(clientB())).not.toThrow()
  })

  it('fails closed (403) in production without a trusted identity', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    const limiter = makeLimiter()
    try {
      limiter.consume(eventWith({ 'x-forwarded-for': '203.0.113.1' }, '10.0.0.1'))
      throw new Error('Expected the request to be rejected')
    }
    catch (err) {
      expect(err).toMatchObject({ statusCode: 403 })
    }
  })

  it('fails closed (403) in production when origin auth fails', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_ORIGIN_SECRET = 'shared-secret'
    const limiter = makeLimiter()
    try {
      limiter.consume(eventWith({ 'cf-connecting-ip': '203.0.113.1' }))
      throw new Error('Expected the request to be rejected')
    }
    catch (err) {
      expect(err).toMatchObject({ statusCode: 403 })
    }

    // With the stamped secret the same request passes.
    expect(() => limiter.consume(eventWith({
      'cf-connecting-ip': '203.0.113.1',
      'x-edge-origin-auth': 'shared-secret',
    }))).not.toThrow()
  })

  it('never rate-limits internal server-to-server requests', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    const limiter = makeLimiter(1)
    const internal = () => eventWith({ ...getInternalFetchHeaders() })
    expect(() => {
      for (let i = 0; i < 10; i++) limiter.consume(internal())
    }).not.toThrow()
  })

  it('falls back to X-Forwarded-For / socket outside production', () => {
    process.env.DOPPLER_ENVIRONMENT = 'dev'
    const limiter = makeLimiter(1)
    limiter.consume(eventWith({ 'x-forwarded-for': '203.0.113.1, 10.0.0.1' }))
    expect(() => limiter.consume(eventWith({ 'x-forwarded-for': '203.0.113.1, 10.0.0.1' }))).toThrow()
    // A different leftmost entry is a different bucket.
    expect(() => limiter.consume(eventWith({ 'x-forwarded-for': '203.0.113.9' }))).not.toThrow()
  })
})

describe('none preset', () => {
  it('keys budgets on the rightmost x-forwarded-for entry', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_PROVIDER = 'none'
    const limiter = makeLimiter(1)

    // Rotating the client-controlled leftmost entry must not reset the budget.
    limiter.consume(eventWith({ 'x-forwarded-for': 'spoof-1, 203.0.113.1' }))
    expect(() => limiter.consume(eventWith({ 'x-forwarded-for': 'spoof-2, 203.0.113.1' }))).toThrow()
  })

  it('a forged legacy loopback sentinel does not bypass rate limiting', () => {
    // Reproduces the review finding: under `none` there is no edge to
    // overwrite cf-connecting-ip, so trusting it as an internal marker let
    // forged requests skip rate-limit accounting entirely.
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_PROVIDER = 'none'
    const limiter = makeLimiter(2)
    const forged = () => eventWith({
      'cf-connecting-ip': '127.0.0.1',
      'x-forwarded-for': '203.0.113.1',
    })

    limiter.consume(forged())
    limiter.consume(forged())
    try {
      limiter.consume(forged())
      throw new Error('Expected the third forged request to be rate limited')
    }
    catch (err) {
      expect(err).toMatchObject({ statusCode: 429 })
    }
  })
})

describe('escape hatches', () => {
  it('DISABLE_RATE_LIMIT=true bypasses everything', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_PROVIDER = 'cloudflare'
    process.env.DISABLE_RATE_LIMIT = 'true'
    const limiter = makeLimiter(1)
    expect(() => {
      for (let i = 0; i < 5; i++) limiter.consume(eventWith({}))
    }).not.toThrow()
  })

  it('throws 429 when a single cost exceeds the whole budget', () => {
    process.env.DOPPLER_ENVIRONMENT = 'dev'
    const limiter = makeLimiter(2)
    try {
      limiter.consume(eventWith({}, '10.0.0.1'), 3)
      throw new Error('Expected the request to be rejected')
    }
    catch (err) {
      expect(err).toMatchObject({ statusCode: 429 })
    }
  })
})
