import { afterEach, describe, expect, it, vi } from 'vitest'
import { AAVE_MARKETS_QUERY, MORPHO_MARKETS_QUERY, MORPHO_USER_POSITIONS_QUERY } from '~/utils/migration-graphql'
import { GRAPHQL_RESPONSE_BUDGET } from '~/server/utils/fetch-text-with-budget'

const mocks = vi.hoisted(() => ({ forward: vi.fn(), consume: vi.fn() }))
type Event = { body: string, headers: Record<string, string> }
vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getMethod: () => 'POST',
  getRequestHeader: (event: Event, name: string) => event.headers[name],
  readRawBody: (event: Event) => event.body,
  setResponseHeaders: vi.fn(),
  setResponseStatus: vi.fn(),
}))
vi.mock('~/server/utils/rate-limit', () => ({ createRateLimiter: () => ({ consume: mocks.consume }) }))
vi.mock('~/server/utils/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('~/server/utils/external-proxy', () => ({
  createProxyCache: () => ({}),
  createProxyInFlight: () => ({}),
  forwardProxied: mocks.forward,
}))

const aave = (await import('~/server/api/internal/proxy/aave.post')).default
const morpho = (await import('~/server/api/internal/proxy/morpho.post')).default
const address = '0x0000000000000000000000000000000000000001'
const cases = [
  { name: 'AaveMigrationMarkets', handler: aave, query: AAVE_MARKETS_QUERY, variables: { request: { chainIds: [1] } } },
  { name: 'EulerMigrationMorphoMarkets', handler: morpho, query: MORPHO_MARKETS_QUERY, variables: { chainIds: [1], loanAssets: [address], collateralAssets: [address] } },
  { name: 'LiteMorphoMigrationPositions', handler: morpho, query: MORPHO_USER_POSITIONS_QUERY, variables: { chainId: 1, address } },
]
const event = (body: string) => ({ body, headers: { 'content-type': 'application/json' } }) as never

afterEach(() => vi.clearAllMocks())

describe('migration GraphQL routes', () => {
  it.each(cases)('forwards the legitimate $name payload with a response budget', async ({ handler, query, variables }) => {
    const body = JSON.stringify({ query, variables })
    const response = '{"errors":[{"message":"GraphQL error"}]}'
    mocks.forward.mockResolvedValueOnce({ body: response, status: 200, statusText: 'OK', contentType: 'application/json', cacheState: 'bypass' })
    expect(await handler(event(body))).toBe(response)
    expect(mocks.forward).toHaveBeenCalledWith(expect.objectContaining({ body, bypassCache: true, responseBudget: GRAPHQL_RESPONSE_BUDGET }))
  })

  it.each(cases)('rejects the approved $name name with a substituted document before forwarding', async ({ handler, name }) => {
    await expect(handler(event(JSON.stringify({ query: `query ${name} { __schema { types { name } } }`, operationName: name })))).rejects.toMatchObject({ statusCode: 403 })
    expect(mocks.forward).not.toHaveBeenCalled()
  })

  it.each(cases)('preserves the upstream failure response for $name', async ({ handler, query, variables }) => {
    mocks.forward.mockRejectedValueOnce(new Error('Upstream response deadline exceeded'))
    await expect(handler(event(JSON.stringify({ query, variables })))).rejects.toMatchObject({ statusCode: 502 })
  })
})
