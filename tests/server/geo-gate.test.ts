/**
 * Regression tests for the geo-gate middleware log hygiene.
 *
 * Some `/api/*` routes embed a wallet address in the path
 * (e.g. /api/internal/proxy/merkl/users/0x.../rewards). When geo-gate blocks a
 * request or flags VPN/proxy usage it logs the request path. The path
 * MUST be run through safePathTemplate so a raw wallet address (PII)
 * never reaches the log sink. These tests lock that in.
 */
import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
const ENV_KNOBS = ['DOPPLER_ENVIRONMENT', 'DEV_GEO_COUNTRY'] as const

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

    expect(() =>
      runHandler(makeEvent(`https://app.example/api/internal/proxy/merkl/users/${ADDRESS}/rewards`, {
        'cf-connecting-ip': '127.0.0.1',
      })),
    ).not.toThrow()

    expect(warn).not.toHaveBeenCalled()
  })
})
