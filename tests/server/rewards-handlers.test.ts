/**
 * Smoke tests for the three /api/rewards/* handlers.
 *
 * These run the handler functions against a minimal H3Event stub so we
 * exercise the real code paths (rate-limit consume, chainId validation,
 * SWR resolution, Cache-Control header) without booting Nitro. The
 * upstream fetch is mocked so the cache reads/writes exercise the
 * real module-scoped state.
 *
 * SWR behaviour (fresh / stale / cold) is covered at the cache layer
 * in tests/server/rewards-cache.test.ts. Here we verify the HTTP
 * contract: status codes on bad input, the Cache-Control directive,
 * and the response shape.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'

const ENABLED_CHAIN_ID = 1
// Dedicated chainId for the 502 test so it doesn't collide with the earlier
// successful cache write against ENABLED_CHAIN_ID.
const COLD_PATH_CHAIN_ID = 2
const DISABLED_CHAIN_ID = 9999

vi.mock('~/utils/chain-env', () => ({
  getEnabledChainIds: () => [ENABLED_CHAIN_ID, COLD_PATH_CHAIN_ID],
  // Not all rewards handlers need these, but keeping the module shape intact.
  getSubgraphUris: () => ({}),
}))

// Rate limiter must not block in test — a synthetic CF IP plus a generous
// budget avoids fail-closed on the first call.
const consumeSpy = vi.fn()
vi.mock('~/server/utils/rate-limit', () => ({
  createRateLimiter: () => ({ consume: consumeSpy }),
}))

const jsonResponse = (body: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
} as unknown as Response)

const makeEvent = (query: Record<string, string>): { event: H3Event, headers: Record<string, string> } => {
  const headers: Record<string, string> = {}
  const qs = new URLSearchParams(query).toString()
  const path = `/api/rewards/x?${qs}`
  const event = {
    // h3 v1 reads getQuery() from `event.path`
    path,
    node: {
      req: { url: path, headers: { 'cf-connecting-ip': '127.0.0.1' } },
      res: {
        setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value },
        getHeader: (name: string) => headers[name.toLowerCase()],
      },
    },
    context: {},
  } as unknown as H3Event
  return { event, headers }
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  consumeSpy.mockClear()
  vi.restoreAllMocks()
})

describe('GET /api/rewards/merkl', () => {
  it('rejects invalid chainId with 400', async () => {
    const handler = (await import('~/server/api/rewards/merkl.get')).default
    const { event } = makeEvent({ chainId: 'not-a-number' })
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects chainId not in enabled list', async () => {
    const handler = (await import('~/server/api/rewards/merkl.get')).default
    const { event } = makeEvent({ chainId: String(DISABLED_CHAIN_ID) })
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('returns the opportunities shape and sets Cache-Control on success', async () => {
    // Every opportunity type returns an empty short page. /tokens/reward is
    // NOT expected here — it's served via /api/token-list now.
    globalThis.fetch = vi.fn(async () => jsonResponse([])) as unknown as typeof globalThis.fetch

    const handler = (await import('~/server/api/rewards/merkl.get')).default
    const { event, headers } = makeEvent({ chainId: String(ENABLED_CHAIN_ID) })
    const res = await handler(event) as {
      opportunities: {
        euler: unknown[]
        multilendborrow: unknown[]
        erc20logprocessor: unknown[]
        euler_borrow_from_collateral: unknown[]
        euler_multi_borrow_from_collateral: unknown[]
      }
    }

    expect(res.opportunities.euler).toEqual([])
    expect(res.opportunities.multilendborrow).toEqual([])
    expect(res.opportunities.erc20logprocessor).toEqual([])
    expect(res.opportunities.euler_borrow_from_collateral).toEqual([])
    expect(res.opportunities.euler_multi_borrow_from_collateral).toEqual([])
    expect(headers['cache-control']).toMatch(/max-age=30/)
    expect(consumeSpy).toHaveBeenCalledOnce()
  })
})

describe('GET /api/rewards/brevis', () => {
  it('rejects invalid chainId with 400', async () => {
    const handler = (await import('~/server/api/rewards/brevis.get')).default
    const { event } = makeEvent({ chainId: '0' })
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('returns raw body and sets Cache-Control on success', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ campaigns: [{ id: 'c1' }] })) as unknown as typeof globalThis.fetch
    const handler = (await import('~/server/api/rewards/brevis.get')).default
    const { event, headers } = makeEvent({ chainId: String(ENABLED_CHAIN_ID) })
    const res = await handler(event) as { campaigns: Array<{ id: string }> }
    expect(res.campaigns).toEqual([{ id: 'c1' }])
    expect(headers['cache-control']).toMatch(/max-age=30/)
  })

  it('returns 502 on cold-path upstream failure', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(null, 500)) as unknown as typeof globalThis.fetch
    const handler = (await import('~/server/api/rewards/brevis.get')).default
    // Fresh chainId so no stale cache entry rescues us via SWR.
    const { event } = makeEvent({ chainId: String(COLD_PATH_CHAIN_ID) })
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 502 })
  })
})

describe('GET /api/rewards/fuul', () => {
  it('rejects invalid chainId with 400', async () => {
    const handler = (await import('~/server/api/rewards/fuul.get')).default
    const { event } = makeEvent({ chainId: '-1' })
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('returns { euler, looping } and sets Cache-Control on success', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('euler-looping')) return jsonResponse([{ proto: 'l' }])
      return jsonResponse([{ proto: 'e' }])
    }) as unknown as typeof globalThis.fetch

    const handler = (await import('~/server/api/rewards/fuul.get')).default
    const { event, headers } = makeEvent({ chainId: String(ENABLED_CHAIN_ID) })
    const res = await handler(event) as { euler: unknown, looping: unknown }
    expect(res.euler).toEqual([{ proto: 'e' }])
    expect(res.looping).toEqual([{ proto: 'l' }])
    expect(headers['cache-control']).toMatch(/max-age=30/)
  })
})
