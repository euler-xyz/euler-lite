/**
 * Regression tests for internal-request detection.
 *
 * Server-internal $fetch calls (warm-cache, vaults-cache, etc.) do not
 * traverse the edge, so they carry no trusted country or client identity.
 * Both the geo-gate and rate-limit middlewares fail-closed when those
 * inputs are missing. `getInternalFetchHeaders()` stamps headers that
 * downstream middleware recognises via `isInternalRequest` to bypass those
 * checks — a secret-based marker when EDGE_ORIGIN_SECRET is configured, a
 * loopback sentinel otherwise.
 *
 * If this contract breaks — the headers stop being set, the helper stops
 * recognising them, or a middleware forgets to consult the helper — every
 * internal API→API call 502s/451s in prod. One such regression already
 * shipped once (internal `/api/internal/vaults` → `/api/internal/euler-chains`
 * 451'd by geo-gate). Lock it down.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { H3Event } from 'h3'
import { getInternalFetchHeaders, isInternalRequest } from '~/server/utils/internal-headers'

const eventWithHeaders = (headers: Record<string, string | string[] | undefined>): H3Event =>
  ({ node: { req: { headers } } }) as unknown as H3Event

let secretSnapshot: string | undefined

beforeEach(() => {
  secretSnapshot = process.env.EDGE_ORIGIN_SECRET
  Reflect.deleteProperty(process.env, 'EDGE_ORIGIN_SECRET')
})

afterEach(() => {
  if (secretSnapshot === undefined) Reflect.deleteProperty(process.env, 'EDGE_ORIGIN_SECRET')
  else process.env.EDGE_ORIGIN_SECRET = secretSnapshot
})

describe('without EDGE_ORIGIN_SECRET (sentinel mode)', () => {
  it('stamps the loopback sentinel', () => {
    expect(getInternalFetchHeaders()).toEqual({ 'cf-connecting-ip': '127.0.0.1' })
  })

  it('recognises requests decorated with getInternalFetchHeaders()', () => {
    // End-to-end contract: whatever getInternalFetchHeaders sets must be
    // what isInternalRequest recognises.
    expect(isInternalRequest(eventWithHeaders({ ...getInternalFetchHeaders() }))).toBe(true)
  })

  it('returns false when the sentinel is absent or different', () => {
    expect(isInternalRequest(eventWithHeaders({}))).toBe(false)
    expect(isInternalRequest(eventWithHeaders({ 'cf-connecting-ip': '203.0.113.1' }))).toBe(false)
    expect(isInternalRequest(eventWithHeaders({ 'cf-connecting-ip': '::1' }))).toBe(false)
    expect(isInternalRequest(eventWithHeaders({ 'cf-connecting-ip': '127.0.0.2' }))).toBe(false)
  })

  it('ignores the secret marker header entirely (nothing to verify it against)', () => {
    expect(isInternalRequest(eventWithHeaders({ 'x-edge-internal': 'anything' }))).toBe(false)
  })
})

describe('with EDGE_ORIGIN_SECRET (marker mode)', () => {
  beforeEach(() => {
    process.env.EDGE_ORIGIN_SECRET = 'shared-secret'
  })

  it('stamps the origin-auth header and the internal marker', () => {
    expect(getInternalFetchHeaders()).toEqual({
      'x-edge-origin-auth': 'shared-secret',
      'x-edge-internal': 'shared-secret',
    })
  })

  it('recognises requests decorated with getInternalFetchHeaders()', () => {
    expect(isInternalRequest(eventWithHeaders({ ...getInternalFetchHeaders() }))).toBe(true)
  })

  it('rejects a wrong or same-length marker', () => {
    expect(isInternalRequest(eventWithHeaders({ 'x-edge-internal': 'wrong' }))).toBe(false)
    // Same byte length as the secret — exercises the timing-safe compare.
    expect(isInternalRequest(eventWithHeaders({ 'x-edge-internal': 'shared-secreX' }))).toBe(false)
  })

  it('no longer honours the loopback sentinel — spoofing it must not bypass gates', () => {
    expect(isInternalRequest(eventWithHeaders({ 'cf-connecting-ip': '127.0.0.1' }))).toBe(false)
  })

  it('rejects an origin-auth header without the marker (external edge traffic)', () => {
    // The edge stamps x-edge-origin-auth on ALL forwarded requests; that
    // alone must never grant internal status.
    expect(isInternalRequest(eventWithHeaders({ 'x-edge-origin-auth': 'shared-secret' }))).toBe(false)
  })
})
