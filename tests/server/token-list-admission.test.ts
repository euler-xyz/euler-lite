import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setResponseHeader, type H3Event } from 'h3'

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  buildEulerSDK: vi.fn(),
  getServerSdk: vi.fn(),
  loadTokenlist: vi.fn(),
  resolveTokenDecimals: vi.fn(),
}))

vi.mock('h3', async importOriginal => ({
  ...await importOriginal<typeof import('h3')>(),
  setResponseHeader: vi.fn(),
}))
vi.mock('~/server/utils/fetchWithTimeout', () => ({ fetchWithTimeout: mocks.fetchWithTimeout }))
vi.mock('~/server/utils/sdk-server', () => ({ getServerSdk: mocks.getServerSdk }))
vi.mock('~/server/utils/rate-limit', () => ({ createRateLimiter: () => ({ consume: vi.fn() }) }))
vi.mock('~/server/utils/log', () => ({ reportStatus: vi.fn() }))
vi.mock('@eulerxyz/euler-v2-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@eulerxyz/euler-v2-sdk')>(),
  buildEulerSDK: mocks.buildEulerSDK,
}))

const token = (chainId: number) => ({
  chainId,
  address: '0x00000000000000000000000000000000000000a1',
  name: 'Token',
  symbol: 'TKN',
  decimals: 6,
})
const event = (query: string) => ({ path: `/api/internal/token-list${query}` }) as H3Event
const importRoute = async () => {
  vi.resetModules()
  return import('~/server/api/internal/token-list.get')
}
const expectNoWork = () => {
  expect(mocks.buildEulerSDK).not.toHaveBeenCalled()
  expect(mocks.loadTokenlist).not.toHaveBeenCalled()
  expect(mocks.getServerSdk).not.toHaveBeenCalled()
  expect(mocks.resolveTokenDecimals).not.toHaveBeenCalled()
  expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
  expect(setResponseHeader).not.toHaveBeenCalled()
}

describe('/api/internal/token-list chain admission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(process.env)) {
      if (/^RPC_URL_\d+$/.test(key)) vi.stubEnv(key, '')
    }
    vi.stubEnv('RPC_URL_1', 'https://rpc.example/mainnet')
    vi.stubEnv('DISABLE_V3', 'false')
    mocks.fetchWithTimeout.mockImplementation(async (url: string) => Response.json(
      url.includes('uniswap') ? { tokens: [] } : {},
    ))
    mocks.loadTokenlist.mockImplementation(async (chainId: number) => [token(chainId)])
    mocks.buildEulerSDK.mockResolvedValue({ tokenlistService: { loadTokenlist: mocks.loadTokenlist } })
    mocks.resolveTokenDecimals.mockResolvedValue(6)
    mocks.getServerSdk.mockResolvedValue({ tokenlistService: { resolveTokenDecimals: mocks.resolveTokenDecimals } })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('rejects distinct and repeated unsupported IDs without starting SDK or upstream work', async () => {
    mocks.loadTokenlist.mockResolvedValue([])
    mocks.fetchWithTimeout.mockRejectedValue(new Error('Upstream unavailable'))
    const { default: handler } = await importRoute()
    for (const chainId of [987654321, 987654322, 987654321]) {
      await expect(handler(event(`?chainId=${chainId}`))).rejects.toMatchObject({
        statusCode: 400, statusMessage: 'Unsupported chainId',
      })
    }
    expectNoWork()
  })

  it.each([
    ['unconfigured', '8453', undefined],
    ['empty RPC', '8453', ''],
    ['malformed RPC', '8453', 'not-a-url'],
    ['unknown configured chain', '987654321', 'https://rpc.example/unknown'],
  ])('rejects a chain with %s configuration', async (_label, chainId, rpcUrl) => {
    vi.stubEnv(`RPC_URL_${chainId}`, rpcUrl)
    const { default: handler } = await importRoute()
    await expect(handler(event(`?chainId=${chainId}`))).rejects.toMatchObject({
      statusCode: 400, statusMessage: 'Unsupported chainId',
    })
    expectNoWork()
  })

  it.each(['?chainId=0x3ade68b1', '?chainId=9.87654321e8', '?chainId=%20987654321%20'])('checks parsed unsupported ID %s', async (query) => {
    const { default: handler } = await importRoute()
    await expect(handler(event(query))).rejects.toMatchObject({ statusCode: 400, statusMessage: 'Unsupported chainId' })
    expectNoWork()
  })

  it.each(['', '?chainId=', '?chainId=0', '?chainId=-1', '?chainId=1.5', '?chainId=NaN', '?chainId=Infinity', '?chainId=ethereum', '?chainId=1&chainId=987654321', '?chainId[]=1'])('preserves invalid input errors for %s', async (query) => {
    const { default: handler } = await importRoute()
    await expect(handler(event(query))).rejects.toMatchObject({
      statusCode: 400, statusMessage: 'chainId is required and must be a positive integer',
    })
    expectNoWork()
  })

  it('serves configured deprecated chains, equivalent numeric inputs and the merged cache', async () => {
    vi.stubEnv('DEPRECATED_CHAINS', '1')
    const { default: handler } = await importRoute()
    for (const query of ['?chainId=1', '?chainId=%31', '?chainId=01', '?chainId=1e0', '?chainId=0x1']) {
      await expect(handler(event(query))).resolves.toEqual({ tokens: [token(1)] })
    }
    expect(mocks.buildEulerSDK).toHaveBeenCalledTimes(1)
    expect(mocks.loadTokenlist).toHaveBeenCalledExactlyOnceWith(1)
    expect(mocks.getServerSdk).toHaveBeenCalledExactlyOnceWith(1)
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(3)
    expect(setResponseHeader).toHaveBeenCalledWith(expect.anything(), 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
  })

  it('checks current admission before serving a cached chain', async () => {
    const { default: handler } = await importRoute()
    await expect(handler(event('?chainId=1'))).resolves.toEqual({ tokens: [token(1)] })
    vi.stubEnv('RPC_URL_1', '')
    vi.clearAllMocks()
    await expect(handler(event('?chainId=1'))).rejects.toMatchObject({ statusCode: 400, statusMessage: 'Unsupported chainId' })
    expectNoWork()
  })

  it('preserves the upstream error for an admitted chain with no tokens', async () => {
    mocks.loadTokenlist.mockResolvedValue([])
    const { default: handler } = await importRoute()
    await expect(handler(event('?chainId=1'))).rejects.toMatchObject({ statusCode: 502, statusMessage: 'Upstream error' })
    expect(mocks.loadTokenlist).toHaveBeenCalledExactlyOnceWith(1)
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(3)
  })
})
