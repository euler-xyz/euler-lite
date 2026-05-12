import { afterEach, describe, expect, it } from 'vitest'
import type { H3Event } from 'h3'
import { INTERNAL_FETCH_HEADERS } from '~/server/utils/internal-headers'
import { createRateLimiter, getClientIp } from '~/server/utils/rate-limit'

const ORIGINAL_DOPPLER_ENVIRONMENT = process.env.DOPPLER_ENVIRONMENT
const ORIGINAL_EDGE_ORIGIN_SECRET = process.env.EDGE_ORIGIN_SECRET
const ORIGINAL_NODE_ENV = process.env.NODE_ENV

const eventWithHeaders = (headers: Record<string, string | undefined>): H3Event =>
  ({
    node: {
      req: {
        headers,
        socket: { remoteAddress: '198.51.100.9' },
      },
    },
  }) as unknown as H3Event

afterEach(() => {
  if (ORIGINAL_DOPPLER_ENVIRONMENT === undefined) delete process.env.DOPPLER_ENVIRONMENT
  else process.env.DOPPLER_ENVIRONMENT = ORIGINAL_DOPPLER_ENVIRONMENT

  if (ORIGINAL_EDGE_ORIGIN_SECRET === undefined) delete process.env.EDGE_ORIGIN_SECRET
  else process.env.EDGE_ORIGIN_SECRET = ORIGINAL_EDGE_ORIGIN_SECRET

  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV
})

describe('getClientIp', () => {
  it('prefers CF-Connecting-IP when present', () => {
    const event = eventWithHeaders({
      'cf-connecting-ip': '203.0.113.10',
      'x-forwarded-for': '203.0.113.20',
    })

    expect(getClientIp(event)).toBe('203.0.113.10')
  })

  it('falls back outside production when CF-Connecting-IP is absent', () => {
    process.env.DOPPLER_ENVIRONMENT = 'dev'
    const event = eventWithHeaders({ 'x-forwarded-for': '203.0.113.20, 203.0.113.21' })

    expect(getClientIp(event)).toBe('203.0.113.20')
  })
})

describe('createRateLimiter', () => {
  it('rejects production requests when CF-Connecting-IP is absent', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, label: 'test' })

    expect(() => limiter.consume(eventWithHeaders({
      'x-euler-edge-origin-secret': 'edge-secret',
    }))).toThrowError(expect.objectContaining({ statusCode: 403 }))
  })

  it('rejects production requests when the trusted ingress secret is absent', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, label: 'test' })

    expect(() => limiter.consume(eventWithHeaders({
      'cf-connecting-ip': '203.0.113.10',
    }))).toThrowError(expect.objectContaining({ statusCode: 403 }))
  })

  it('rejects production requests when EDGE_ORIGIN_SECRET is not configured', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    delete process.env.EDGE_ORIGIN_SECRET
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, label: 'test' })

    expect(() => limiter.consume(eventWithHeaders({
      'cf-connecting-ip': '203.0.113.10',
    }))).toThrowError(expect.objectContaining({ statusCode: 403 }))
  })

  it('requires trusted ingress when NODE_ENV is production and DOPPLER_ENVIRONMENT is absent', () => {
    delete process.env.DOPPLER_ENVIRONMENT
    process.env.NODE_ENV = 'production'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, label: 'test' })

    expect(() => limiter.consume(eventWithHeaders({
      'cf-connecting-ip': '203.0.113.10',
    }))).toThrowError(expect.objectContaining({ statusCode: 403 }))
  })

  it('accepts production requests after trusted ingress is verified', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, label: 'test' })

    expect(() => limiter.consume(eventWithHeaders({
      'cf-connecting-ip': '203.0.113.10',
      'x-euler-edge-origin-secret': 'edge-secret',
    }))).not.toThrow()
  })

  it('does not treat spoofed loopback CF-Connecting-IP as internal', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, label: 'test' })

    expect(() => limiter.consume(eventWithHeaders({
      'cf-connecting-ip': '127.0.0.1',
      'x-euler-edge-origin-secret': 'edge-secret',
    }))).not.toThrow()
    expect(() => limiter.consume(eventWithHeaders({
      'cf-connecting-ip': '127.0.0.1',
      'x-euler-edge-origin-secret': 'edge-secret',
    }))).toThrowError(expect.objectContaining({ statusCode: 429 }))
  })

  it('lets private internal requests bypass production edge checks and rate limits', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_ORIGIN_SECRET = 'edge-secret'
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000, label: 'test' })
    const event = eventWithHeaders({ ...INTERNAL_FETCH_HEADERS })

    expect(() => limiter.consume(event)).not.toThrow()
    expect(() => limiter.consume(event)).not.toThrow()
  })
})
