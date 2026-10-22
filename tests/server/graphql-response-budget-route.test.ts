import { afterEach, describe, expect, it, vi } from 'vitest'
import { GRAPHQL_RESPONSE_BUDGET } from '~/server/utils/fetch-text-with-budget'
import { AAVE_MARKETS_QUERY, MORPHO_MARKETS_QUERY } from '~/utils/migration-graphql'

type Event = { body: string, headers: Record<string, string> }
vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getMethod: () => 'POST',
  getRouterParam: () => '1',
  getRequestHeader: (event: Event, name: string) => event.headers[name],
  readRawBody: (event: Event) => event.body,
  setResponseHeaders: vi.fn(),
  setResponseStatus: vi.fn(),
}))
vi.mock('~/server/utils/rate-limit', () => ({ createRateLimiter: () => ({ consume: vi.fn() }) }))
vi.mock('~/server/utils/logger', () => ({ logger: { warn: vi.fn() } }))

const aave = (await import('~/server/api/internal/proxy/aave.post')).default
const morpho = (await import('~/server/api/internal/proxy/morpho.post')).default
const subgraph = (await import('~/server/api/internal/proxy/subgraph/[chainId].post')).default
const address = '0x0000000000000000000000000000000000000001'
const cases = [
  { name: 'Aave', handler: aave, query: AAVE_MARKETS_QUERY, variables: { request: { chainIds: [1] } } },
  { name: 'Morpho', handler: morpho, query: MORPHO_MARKETS_QUERY, variables: { chainIds: [1], loanAssets: [address], collateralAssets: [address] } },
  { name: 'Subgraph', handler: subgraph, query: 'query VaultFactories { vaultFactories { id } }', variables: {} },
]
const event = (query: string, variables: unknown) => ({ body: JSON.stringify({ query, variables }), headers: { 'content-type': 'application/json' } }) as never

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('GraphQL response budgets through the real proxy forwarder', () => {
  it.each(cases.slice(0, 2))('$name coalesces concurrent queries with different outer whitespace', async ({ handler, query, variables }) => {
    const fetch = vi.fn(async () => Response.json({ data: {} }))
    vi.stubGlobal('fetch', fetch)

    const results = await Promise.all([
      handler(event(query, variables)),
      handler(event(`\uFEFF${query}\u2028`, variables)),
    ])
    expect(results).toEqual(['{"data":{}}', '{"data":{}}'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(cases)('$name returns 502 for an oversized response', async ({ name, handler, query, variables }) => {
    vi.stubEnv('SUBGRAPH_URL_1', 'https://subgraph.example/graphql')
    const cancel = vi.fn()
    const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': String(GRAPHQL_RESPONSE_BUDGET.maxBytes + 1) },
    }))
    vi.stubGlobal('fetch', fetch)

    await expect(handler(event(query, variables))).rejects.toMatchObject({ statusCode: 502, statusMessage: `${name} upstream unavailable` })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalled()
  })

  it.each(cases)('$name returns 502 when the body exceeds the total deadline', async ({ name, handler, query, variables }) => {
    vi.useFakeTimers()
    vi.stubEnv('SUBGRAPH_URL_1', 'https://subgraph.example/graphql')
    const cancel = vi.fn()
    let signal: AbortSignal | undefined
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal
      return new Response(new ReadableStream({ cancel }))
    })
    vi.stubGlobal('fetch', fetch)

    const pending = expect(handler(event(query, variables))).rejects.toMatchObject({ statusCode: 502, statusMessage: `${name} upstream unavailable` })
    await vi.advanceTimersByTimeAsync(GRAPHQL_RESPONSE_BUDGET.timeoutMs + 1)
    await pending
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(signal?.aborted).toBe(true)
    expect(cancel).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
