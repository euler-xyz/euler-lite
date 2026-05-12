/**
 * Regression tests for the internal-request sentinel.
 *
 * Server-internal $fetch calls (warm-cache, vaults-cache, etc.) do not
 * traverse Cloudflare, so they have no `cf-ipcountry` or real
 * `cf-connecting-ip`. INTERNAL_FETCH_HEADERS stamps a private header that
 * downstream middleware recognises via `isInternalRequest` to bypass checks
 * that only apply to public edge traffic.
 *
 * If this contract breaks — the sentinel stops being set, the helper
 * stops recognising it, or a middleware forgets to consult the helper —
 * every internal API→API call 502s/451s in prod. One such regression
 * already shipped once (internal `/api/vaults` → `/api/euler-chains`
 * 451'd by geo-gate). Lock it down.
 */
import { describe, it, expect } from 'vitest'
import type { H3Event } from 'h3'
import { INTERNAL_FETCH_HEADERS, INTERNAL_REQUEST_HEADER, isInternalRequest } from '~/server/utils/internal-headers'

const eventWithHeaders = (headers: Record<string, string | undefined>): H3Event =>
  ({ node: { req: { headers } } }) as unknown as H3Event

describe('INTERNAL_FETCH_HEADERS', () => {
  it('sets a private internal request header', () => {
    expect(INTERNAL_FETCH_HEADERS[INTERNAL_REQUEST_HEADER]).toEqual(expect.any(String))
    expect(INTERNAL_FETCH_HEADERS[INTERNAL_REQUEST_HEADER]).not.toBe('')
    expect(INTERNAL_FETCH_HEADERS).not.toHaveProperty('cf-connecting-ip')
  })
})

describe('isInternalRequest', () => {
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

  it('returns false for spoofed CF-Connecting-IP values', () => {
    expect(isInternalRequest(eventWithHeaders({ 'cf-connecting-ip': '127.0.0.1' }))).toBe(false)
    expect(isInternalRequest(eventWithHeaders({ 'cf-connecting-ip': '203.0.113.1' }))).toBe(false)
    expect(isInternalRequest(eventWithHeaders({ 'cf-connecting-ip': '::1' }))).toBe(false)
    expect(isInternalRequest(eventWithHeaders({ 'cf-connecting-ip': '127.0.0.2' }))).toBe(false)
  })

  it('returns false when the private header has the wrong value', () => {
    expect(isInternalRequest(eventWithHeaders({ [INTERNAL_REQUEST_HEADER]: 'wrong-secret' }))).toBe(false)
  })
})
