import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeFunctionResult, multicall3Abi, parseAbi, type Address, type Hex, type PublicClient } from 'viem'
import { sonic } from 'viem/chains'

const mocks = vi.hoisted(() => ({
  buildEulerSDK: vi.fn(),
  resolveRpcUrl: vi.fn(),
  resolveLabelsBaseUrl: vi.fn(),
}))

vi.mock('@eulerxyz/euler-v2-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@eulerxyz/euler-v2-sdk')>(),
  buildEulerSDK: mocks.buildEulerSDK,
}))

vi.mock('~/server/utils/rpc', () => ({
  resolveRpcUrl: mocks.resolveRpcUrl,
}))

vi.mock('~/server/utils/labels-base-url', () => ({
  resolveLabelsBaseUrl: mocks.resolveLabelsBaseUrl,
}))

describe('getServerSdk', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.buildEulerSDK.mockReset()
    mocks.resolveRpcUrl.mockReset()
    mocks.resolveLabelsBaseUrl.mockReset()
    mocks.buildEulerSDK.mockImplementation(async options => ({ options }))
    mocks.resolveRpcUrl.mockReturnValue('https://rpc.example')
    mocks.resolveLabelsBaseUrl.mockReturnValue('https://labels.example')
    process.env.V3_API_URL = 'https://v3.example'
    process.env.SERVER_VAULT_CACHE_SOURCE = 'fallback'
    // Routing is driven by ONCHAIN_SDK_CHAINS only; DEPRECATED_CHAINS is a
    // UI/warm-cache concern and must not affect adapter selection.
    process.env.DEPRECATED_CHAINS = '1'
    process.env.ONCHAIN_SDK_CHAINS = '8453'
    delete process.env.TURTLE_EARN_API_KEY
  })

  it('forces ONCHAIN_SDK_CHAINS chains to onchain while other chains use the configured source', async () => {
    const { getServerSdk } = await import('~/server/utils/sdk-server')

    await getServerSdk(1)
    await getServerSdk(8453)

    expect(mocks.buildEulerSDK).toHaveBeenCalledTimes(2)
    expect(mocks.buildEulerSDK.mock.calls[0]?.[0].config).toMatchObject({
      accountServiceAdapter: 'fallback',
      eVaultServiceAdapter: 'fallback',
      eulerEarnServiceAdapter: 'fallback',
      rewardsServiceAdapter: 'fallback',
    })
    expect(mocks.buildEulerSDK.mock.calls[1]?.[0].config).toMatchObject({
      accountServiceAdapter: 'onchain',
      eVaultServiceAdapter: 'onchain',
      eulerEarnServiceAdapter: 'onchain',
      rewardsServiceAdapter: 'direct',
    })
    const providerService = mocks.buildEulerSDK.mock.calls[0]?.[0].servicesOverrides.providerService
    expect(providerService.getProvider(1).batch.multicall).toEqual({ batchSize: 2048, wait: 10 })
    expect(providerService.getProvider(1)).toBe(providerService.getProvider(1))
    expect(() => providerService.getProvider(146)).toThrow('No provider configured for chainId 146')
  })

  it('hands the server-only Turtle key and fixed upstream to the rewards adapters', async () => {
    process.env.TURTLE_EARN_API_KEY = ' turtle-secret '
    const { getServerSdk } = await import('~/server/utils/sdk-server')

    await getServerSdk(1)

    const config = mocks.buildEulerSDK.mock.calls[0]?.[0].config
    expect(config).toMatchObject({
      rewardsTurtleApiKey: 'turtle-secret',
      rewardsTurtleApiUrl: 'https://earn.turtle.xyz/v1',
    })
    expect(config).not.toHaveProperty('rewardsEnableTurtle')
  })

  it('disables Turtle discovery without a key instead of sending unauthenticated requests', async () => {
    const { getServerSdk } = await import('~/server/utils/sdk-server')

    await getServerSdk(1)

    const config = mocks.buildEulerSDK.mock.calls[0]?.[0].config
    expect(config).toMatchObject({ rewardsEnableTurtle: false })
    expect(config).not.toHaveProperty('rewardsTurtleApiKey')
    expect(config).not.toHaveProperty('rewardsTurtleApiUrl')
  })

  it('ignores upstream URL variables so the key only travels to the fixed Turtle host', async () => {
    process.env.TURTLE_EARN_API_KEY = 'turtle-secret'
    process.env.TURTLE_EARN_API_URL = 'https://evil.example/v1'
    const { getServerSdk } = await import('~/server/utils/sdk-server')

    await getServerSdk(1)

    expect(mocks.buildEulerSDK.mock.calls[0]?.[0].config).toMatchObject({
      rewardsTurtleApiUrl: 'https://earn.turtle.xyz/v1',
    })
    delete process.env.TURTLE_EARN_API_URL
  })

  it('passes the Sonic provider override with the configured RPC URL and caches the server SDK', async () => {
    mocks.resolveRpcUrl.mockReturnValue('https://custom-sonic.example/rpc')
    const { getServerSdk } = await import('~/server/utils/sdk-server')

    const first = getServerSdk(146)
    expect(getServerSdk(146)).toBe(first)
    await first

    expect(mocks.buildEulerSDK).toHaveBeenCalledOnce()
    const options = mocks.buildEulerSDK.mock.calls[0]?.[0]
    expect(options.config.rpcUrls).toEqual({ 146: 'https://custom-sonic.example/rpc' })
    expect(options.servicesOverrides.providerService.getProvider(146)).toBe(
      options.servicesOverrides.providerService.getProvider(146),
    )
    expect(options.servicesOverrides.providerService.getSupportedChainIds()).toEqual([146])
  })

  it('retries after a failed SDK build', async () => {
    mocks.buildEulerSDK.mockRejectedValueOnce(new Error('temporary build failure'))
    const { getServerSdk } = await import('~/server/utils/sdk-server')

    await expect(getServerSdk(146)).rejects.toThrow('temporary build failure')
    await getServerSdk(146)

    expect(mocks.buildEulerSDK).toHaveBeenCalledTimes(2)
  })

  it('splits 36 Sonic lens reads into three-call aggregates inside one HTTP batch', async () => {
    const rpcUrl = 'https://configured-sonic.example/rpc'
    mocks.resolveRpcUrl.mockReturnValue(rpcUrl)
    const lensAbi = parseAbi(['function getVaultInfoFull(address vault) view returns (uint256)'])
    const lensAddress = '0x0000000000000000000000000000000000000123'
    const vaults = Array.from({ length: 36 }, (_, i) =>
      `0x${(i + 1).toString(16).padStart(40, '0')}` as Address)
    const seen: Address[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(rpcUrl)
      const batch = JSON.parse(String(init?.body)) as Array<{
        id: number
        method: string
        params: [{ data: Hex, to: Address }]
      }>
      expect(batch).toHaveLength(12)
      const responses = batch.map(({ id, method, params }) => {
        expect(method).toBe('eth_call')
        expect(params[0].to.toLowerCase()).toBe(sonic.contracts.multicall3.address.toLowerCase())
        const decoded = decodeFunctionData({ abi: multicall3Abi, data: params[0].data })
        if (decoded.functionName !== 'aggregate3') throw new Error('Expected aggregate3')
        const calls = decoded.args[0]
        expect(calls).toHaveLength(3)
        for (const call of calls) {
          expect(call.target.toLowerCase()).toBe(lensAddress.toLowerCase())
          const inner = decodeFunctionData({ abi: lensAbi, data: call.callData })
          if (inner.functionName !== 'getVaultInfoFull') throw new Error('Expected lens read')
          seen.push(inner.args[0])
        }
        return {
          jsonrpc: '2.0',
          id,
          result: encodeFunctionResult({
            abi: multicall3Abi,
            functionName: 'aggregate3',
            result: calls.map(() => ({
              success: true,
              returnData: encodeFunctionResult({ abi: lensAbi, functionName: 'getVaultInfoFull', result: 1n }),
            })),
          }),
        }
      })
      return new Response(JSON.stringify(responses), { headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { getServerSdk } = await import('~/server/utils/sdk-server')
      await getServerSdk(146)
      const provider = mocks.buildEulerSDK.mock.calls[0]?.[0].servicesOverrides.providerService.getProvider(146) as PublicClient
      const results = await Promise.all(vaults.map(vault => provider.readContract({
        address: lensAddress,
        abi: lensAbi,
        functionName: 'getVaultInfoFull',
        args: [vault],
        authorizationList: undefined,
      })))

      expect(results).toEqual(Array(36).fill(1n))
      expect(seen.map(address => address.toLowerCase()).sort()).toEqual(
        vaults.map(address => address.toLowerCase()).sort(),
      )
      expect(fetchMock).toHaveBeenCalledOnce()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
