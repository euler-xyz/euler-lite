import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderService, TokenlistService } from '@eulerxyz/euler-v2-sdk'
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, multicall3Abi, type Hex } from 'viem'

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  getServerSdk: vi.fn(),
  loadTokenlist: vi.fn(),
}))

vi.mock('~/server/utils/fetchWithTimeout', () => ({ fetchWithTimeout: mocks.fetchWithTimeout }))
vi.mock('~/server/utils/sdk-server', () => ({ getServerSdk: mocks.getServerSdk }))
vi.mock('~/server/utils/rate-limit', () => ({ createRateLimiter: () => ({ consume: vi.fn() }) }))
vi.mock('~/server/utils/log', () => ({ reportStatus: vi.fn() }))
vi.mock('@eulerxyz/euler-v2-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@eulerxyz/euler-v2-sdk')>(),
  buildEulerSDK: async () => ({ tokenlistService: { loadTokenlist: mocks.loadTokenlist } }),
}))

const tokens = Array.from({ length: 512 }, (_, index) => ({
  chainId: 1,
  address: `0x${(index + 4096).toString(16).padStart(40, '0')}`,
  name: `Token ${index}`,
  symbol: `T${index}`,
  decimals: 18,
}))

describe('token-list SDK RPC batching', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('DISABLE_V3', 'false')
    mocks.loadTokenlist.mockResolvedValue(tokens)
    mocks.fetchWithTimeout.mockImplementation(async (url: string) => Response.json(
      url.includes('uniswap') ? { tokens: [] } : {},
    ))
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('bounds real SDK request payloads through upstream failure and recovery', async () => {
    const requestSizes: number[] = []
    let unavailable = true
    const providerService = await ProviderService.build({ 1: 'https://rpc.example/mainnet' }, {
      chains: {
        1: {
          transport: {
            http: {
              retryCount: 0,
              fetchFn: async (_input, init) => {
                const body = String(init?.body)
                requestSizes.push(Buffer.byteLength(body))
                if (unavailable) {
                  return Response.json({ error: 'Request body size limit reached' }, { status: 503 })
                }
                const requests = JSON.parse(body) as { id: number, params: [{ data: Hex }] }[]
                return Response.json(requests.map((request) => {
                  const { args } = decodeFunctionData({ abi: multicall3Abi, data: request.params[0].data })
                  const calls = args[0] as readonly unknown[]
                  return {
                    jsonrpc: '2.0',
                    id: request.id,
                    result: encodeFunctionResult({
                      abi: multicall3Abi,
                      functionName: 'aggregate3',
                      result: calls.map(() => ({
                        success: true,
                        returnData: encodeAbiParameters([{ type: 'uint8' }], [6]),
                      })),
                    }),
                  }
                }))
              },
            },
          },
        },
      },
    })
    const tokenlistService = new TokenlistService({ getTokenListUrl: () => 'https://tokens.example' }, undefined, providerService)
    mocks.getServerSdk.mockResolvedValue({ tokenlistService })
    const { refreshTokenList } = await import('~/server/api/internal/token-list.get')

    const fallback = await refreshTokenList(1)
    expect(fallback).toHaveLength(tokens.length)
    expect(fallback.every(token => token.decimals === 18)).toBe(true)
    expect(requestSizes.length).toBeGreaterThan(1)
    expect(Math.max(...requestSizes)).toBeLessThan(64_000)

    unavailable = false
    requestSizes.length = 0
    const recovered = await refreshTokenList(1)
    expect(recovered).toHaveLength(tokens.length)
    expect(recovered.every(token => token.decimals === 6)).toBe(true)
    expect(requestSizes.length).toBeGreaterThan(1)
    expect(Math.max(...requestSizes)).toBeLessThan(64_000)
  })
})
