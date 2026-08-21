/**
 * Regression tests for the geo-gate middleware: log hygiene plus the
 * preset-dependent gating semantics.
 *
 * Log hygiene: some `/api/*` routes embed a wallet address in the path
 * (e.g. /api/internal/proxy/merkl/users/0x.../rewards). When geo-gate blocks a
 * request or flags VPN/proxy usage it logs the request path. The path
 * MUST be run through safePathTemplate so a raw wallet address (PII)
 * never reaches the log sink. These tests lock that in.
 *
 * Gating semantics: geo-capable presets fail closed on an undetermined
 * country outside dev; the `none` preset runs with geo-blocking off; failed
 * origin auth voids the trusted country.
 */
import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getInternalFetchHeaders } from '~/server/utils/internal-headers'

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getRequestURL: (event: TestEvent) => new URL(event.url),
}))

const warn = vi.fn()
vi.mock('~/server/utils/logger', () => ({
  logger: { warn: (...args: unknown[]) => warn(...args) },
}))

type TestEvent = H3Event & {
  url: string
  node: { req: { headers: Record<string, string | undefined> } }
}

const ADDRESS = '0x0000000000000000000000000000000000000001'

const handler = (await import('~/server/middleware/geo-gate')).default

const makeEvent = (url: string, headers: Record<string, string | undefined> = {}): TestEvent => ({
  url,
  node: { req: { headers } },
} as unknown as TestEvent)

const runHandler = (event: TestEvent) => (handler as (e: TestEvent) => unknown)(event)

// The only environment knobs the middleware consults. Snapshot and clear
// every one of them per test so the suite is deterministic regardless of the
// caller's shell — a stray DEV_GEO_COUNTRY, for example, would otherwise take
// the dev-country fallback and defeat the fail-closed (undetermined-country)
// path under test.
const ENV_KNOBS = ['DOPPLER_ENVIRONMENT', 'DEV_GEO_COUNTRY', 'EDGE_PROVIDER', 'EDGE_ORIGIN_SECRET'] as const

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

describe('geo-gate log hygiene', () => {
  it('templates the wallet address when blocking undetermined country', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_PROVIDER = 'cloudflare'

    expect(() =>
      runHandler(makeEvent(`https://app.example/api/internal/proxy/merkl/users/${ADDRESS}/rewards`)),
    ).toThrow()

    expect(warn).toHaveBeenCalledTimes(1)
    const [payload] = warn.mock.calls[0]
    expect(payload.pathTemplate).toBe('/api/internal/proxy/merkl/users/:address/rewards')
    expect(JSON.stringify(payload)).not.toContain(ADDRESS)
    expect(payload).not.toHaveProperty('path')
  })

  it('templates the wallet address when flagging VPN/proxy usage', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_PROVIDER = 'cloudflare'

    runHandler(makeEvent(`https://app.example/api/internal/proxy/merkl/users/${ADDRESS}/rewards`, {
      'cf-ipcountry': 'US',
      'x-is-vpn': 'true',
    }))

    expect(warn).toHaveBeenCalledTimes(1)
    const [payload] = warn.mock.calls[0]
    expect(payload.pathTemplate).toBe('/api/internal/proxy/merkl/users/:address/rewards')
    expect(JSON.stringify(payload)).not.toContain(ADDRESS)
  })

  it('templates the wallet address when blocking a sanctioned country', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_PROVIDER = 'cloudflare'

    expect(() =>
      runHandler(makeEvent(`https://app.example/api/internal/proxy/merkl/users/${ADDRESS}/rewards`, {
        'cf-ipcountry': 'KP',
      })),
    ).toThrow()

    expect(warn).toHaveBeenCalledTimes(1)
    const [payload] = warn.mock.calls[0]
    expect(payload.pathTemplate).toBe('/api/internal/proxy/merkl/users/:address/rewards')
    expect(JSON.stringify(payload)).not.toContain(ADDRESS)
  })

  it('does not gate or log internal server-to-server requests', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_PROVIDER = 'cloudflare'

    expect(() =>
      runHandler(makeEvent(
        `https://app.example/api/internal/proxy/merkl/users/${ADDRESS}/rewards`,
        { ...getInternalFetchHeaders() },
      )),
    ).not.toThrow()

    expect(warn).not.toHaveBeenCalled()
  })

  it('gates requests bearing a forged legacy loopback sentinel like any external request', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_PROVIDER = 'cloudflare'

    // The sentinel used to grant the internal bypass; it must not anymore.
    expect(() =>
      runHandler(makeEvent('https://app.example/api/internal/vaults', {
        'cf-connecting-ip': '127.0.0.1',
      })),
    ).toThrow()
  })
})

describe('geo-gate preset semantics', () => {
  it('passes a determined, non-sanctioned country through', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_PROVIDER = 'cloudflare'

    expect(() =>
      runHandler(makeEvent('https://app.example/api/internal/vaults', { 'cf-ipcountry': 'DE' })),
    ).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
  })

  it('runs with geo-blocking off under the none preset (forks, previews)', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_PROVIDER = 'none'

    expect(() => runHandler(makeEvent('https://app.example/api/internal/vaults'))).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
  })

  it('still blocks sanctioned countries under the none preset when DEV_GEO_COUNTRY simulates one', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_PROVIDER = 'none'
    process.env.DEV_GEO_COUNTRY = 'KP'

    expect(() => runHandler(makeEvent('https://app.example/api/internal/vaults'))).toThrow()
  })

  it('fails closed when origin auth is configured and the request lacks the secret', () => {
    process.env.DOPPLER_ENVIRONMENT = 'prd'
    process.env.EDGE_PROVIDER = 'cloudflare'
    process.env.EDGE_ORIGIN_SECRET = 'shared-secret'

    // Country header present but the request bypassed the edge — the
    // trusted inputs are voided and the undetermined-country 451 applies.
    expect(() =>
      runHandler(makeEvent('https://app.example/api/internal/vaults', { 'cf-ipcountry': 'DE' })),
    ).toThrow()

    // The same request stamped by the edge passes.
    warn.mockClear()
    expect(() =>
      runHandler(makeEvent('https://app.example/api/internal/vaults', {
        'cf-ipcountry': 'DE',
        'x-edge-origin-auth': 'shared-secret',
      })),
    ).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
  })

  it('allows an undetermined country through in dev', () => {
    process.env.DOPPLER_ENVIRONMENT = 'dev'
    process.env.EDGE_PROVIDER = 'cloudflare'

    expect(() => runHandler(makeEvent('https://app.example/api/internal/vaults'))).not.toThrow()
  })
})
