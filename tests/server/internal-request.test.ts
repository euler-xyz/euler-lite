/**
 * Regression tests for the internal-request sentinel.
 *
 * Server-internal $fetch calls (warm-cache, vaults-cache, etc.) do not
 * traverse Cloudflare, so they have no `cf-ipcountry` or real
 * `cf-connecting-ip`. Both the geo-gate and rate-limit middlewares
 * fail-closed when those headers are missing. INTERNAL_FETCH_HEADERS
 * stamps a loopback `cf-connecting-ip: 127.0.0.1` that downstream
 * middleware recognises via `isInternalRequest` to bypass those checks.
 *
 * If this contract breaks — the sentinel stops being set, the helper
 * stops recognising it, or a middleware forgets to consult the helper —
 * every internal API→API call 502s/451s in prod. One such regression
 * already shipped once (internal `/api/internal/vaults` → `/api/internal/euler-chains`
 * 451'd by geo-gate). Lock it down.
 */
import { describe, it, expect } from 'vitest'
import type { H3Event } from 'h3'
import { INTERNAL_FETCH_HEADERS, isInternalRequest } from '~/server/utils/internal-headers'

const eventWithHeaders = (headers: Record<string, string | undefined>): H3Event =>
  ({ node: { req: { headers } } }) as unknown as H3Event

describe('INTERNAL_FETCH_HEADERS', () => {
  it('sets cf-connecting-ip to the loopback sentinel', () => {
    expect(INTERNAL_FETCH_HEADERS['cf-connecting-ip']).toBe('127.0.0.1')
  })
})

describe('isInternalRequest', () => {
  it('returns true when cf-connecting-ip matches the sentinel', () => {
    const event = eventWithHeaders({ 'cf-connecting-ip': '127.0.0.1' })
    expect(isInternalRequest(event)).toBe(true)
  })

  it('returns true for requests decorated with INTERNAL_FETCH_HEADERS', () => {
    // End-to-end contract: whatever INTERNAL_FETCH_HEADERS sets must be
    // what isInternalRequest recognises.
    const event = eventWithHeaders({ ...INTERNAL_FETCH_HEADERS })
    expect(isInternalRequest(event)).toBe(true)
  })

  it('returns false when cf-connecting-ip is absent', () => {
    const event = eventWithHeaders({})
    expect(isInternalRequest(event)).toBe(false)
  })

  it('returns false for any other IP', () => {
    expect(isInternalRequest(eventWithHeaders({ 'cf-connecting-ip': '203.0.113.1' }))).toBe(false)
    expect(isInternalRequest(eventWithHeaders({ 'cf-connecting-ip': '::1' }))).toBe(false)
    expect(isInternalRequest(eventWithHeaders({ 'cf-connecting-ip': '127.0.0.2' }))).toBe(false)
  })
})
