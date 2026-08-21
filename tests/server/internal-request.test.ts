/**
 * Regression tests for internal-request detection.
 *
 * Server-internal $fetch calls (warm-cache, vaults-cache, etc.) do not
 * traverse the edge, so they carry no trusted country or client identity.
 * Both the geo-gate and rate-limit middlewares fail-closed when those
 * inputs are missing. `getInternalFetchHeaders()` stamps a marker header
 * that downstream middleware recognises via `isInternalRequest` to bypass
 * those checks — the value is EDGE_ORIGIN_SECRET when configured, or a
 * random per-process fallback otherwise, so internal status is not
 * forgeable under any preset. (An earlier loopback `cf-connecting-ip`
 * sentinel was forgeable wherever the edge did not overwrite it — notably
 * under the `none` preset — and must never be honoured again.)
 *
 * If this contract breaks — the headers stop being set, the helper stops
 * recognising them, or a middleware forgets to consult the helper — every
 * internal API→API call 502s/451s in prod. One such regression already
 * shipped once (internal `/api/internal/vaults` → `/api/internal/euler-chains`
 * 451'd by geo-gate). Lock it down.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { H3Event } from 'h3'
import { getInternalFetchHeaders, isInternalRequest } from '~/server/utils/internal-headers'

const eventWithHeaders = (headers: Record<string, string | string[] | undefined>): H3Event =>
  ({ node: { req: { headers } } }) as unknown as H3Event

const ENV_KNOBS = ['EDGE_ORIGIN_SECRET', 'EDGE_PROVIDER'] as const

const envSnapshot: Record<string, string | undefined> = {}

beforeEach(() => {
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

describe('without EDGE_ORIGIN_SECRET (per-process marker mode)', () => {
  it('stamps a random per-process marker and nothing else', () => {
    const headers = getInternalFetchHeaders()
    expect(Object.keys(headers)).toEqual(['x-edge-internal'])
    // 32 random bytes, base64url — long enough to be unguessable.
    expect(headers['x-edge-internal']).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('recognises requests decorated with getInternalFetchHeaders()', () => {
    // End-to-end contract: whatever getInternalFetchHeaders sets must be
    // what isInternalRequest recognises.
    expect(isInternalRequest(eventWithHeaders({ ...getInternalFetchHeaders() }))).toBe(true)
  })

  it('rejects guessed, empty, or same-length marker values', () => {
    expect(isInternalRequest(eventWithHeaders({}))).toBe(false)
    expect(isInternalRequest(eventWithHeaders({ 'x-edge-internal': 'anything' }))).toBe(false)
    const realLength = getInternalFetchHeaders()['x-edge-internal'].length
    // Same byte length as the real marker — exercises the timing-safe compare.
    expect(isInternalRequest(eventWithHeaders({ 'x-edge-internal': 'x'.repeat(realLength) }))).toBe(false)
  })

  it('never honours the legacy loopback sentinel, under any preset', () => {
    // Reproduces the review finding: under `none` (and any preset whose
    // edge forwards client headers untouched) a forged sentinel used to
    // grant internal status, bypassing rate limiting and the internal
    // exceptions in the CORS and geo middleware.
    const forged = eventWithHeaders({ 'cf-connecting-ip': '127.0.0.1' })
    for (const provider of ['none', 'cloudflare', 'google', 'cloudfront', undefined]) {
      if (provider === undefined) Reflect.deleteProperty(process.env, 'EDGE_PROVIDER')
      else process.env.EDGE_PROVIDER = provider
      expect(isInternalRequest(forged), `provider=${provider}`).toBe(false)
    }
  })
})

describe('with EDGE_ORIGIN_SECRET (shared-secret marker mode)', () => {
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

  it('never honours the legacy loopback sentinel', () => {
    expect(isInternalRequest(eventWithHeaders({ 'cf-connecting-ip': '127.0.0.1' }))).toBe(false)
  })

  it('rejects an origin-auth header without the marker (external edge traffic)', () => {
    // The edge stamps x-edge-origin-auth on ALL forwarded requests; that
    // alone must never grant internal status.
    expect(isInternalRequest(eventWithHeaders({ 'x-edge-origin-auth': 'shared-secret' }))).toBe(false)
  })
})

describe('retired loopback sentinel hygiene', () => {
  it('no repo script sends the retired sentinel or the internal marker', () => {
    // External processes (recorder, parity tooling, healthchecks) cannot be
    // internal by design — they must authenticate as normal first-party
    // callers (allowed Origin / first-party cookie). A script quietly
    // reintroducing these headers would 403 against any non-dev server.
    const scriptsDir = join(process.cwd(), 'scripts')
    const offenders = readdirSync(scriptsDir)
      .filter(file => /\.(mjs|js|ts)$/.test(file))
      .filter((file) => {
        const source = readFileSync(join(scriptsDir, file), 'utf8')
        return source.includes('cf-connecting-ip') || source.includes('x-edge-internal')
      })
    expect(offenders).toEqual([])
  })
})
