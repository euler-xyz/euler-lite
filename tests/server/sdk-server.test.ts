import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeFunctionResult, multicall3Abi, parseAbi, type Address, type Hex, type PublicClient } from 'viem'
import { sonic } from 'viem/chains'
import type { Deployment } from '@eulerxyz/euler-v2-sdk'

const mocks = vi.hoisted(() => ({
  buildEulerSDK: vi.fn(),
  resolveRpcUrl: vi.fn(),
  getPublicLabelsBundle: vi.fn(),
  fetchWithTimeout: vi.fn(),
}))

vi.mock('@eulerxyz/euler-v2-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@eulerxyz/euler-v2-sdk')>(),
  buildEulerSDK: mocks.buildEulerSDK,
}))

vi.mock('~/server/utils/rpc', () => ({
  resolveRpcUrl: mocks.resolveRpcUrl,
}))

vi.mock('~/server/utils/public-labels-source', () => ({
  getPublicLabelsBundle: mocks.getPublicLabelsBundle,
}))

vi.mock('~/server/utils/fetchWithTimeout', async importOriginal => ({
  ...await importOriginal<typeof import('~/server/utils/fetchWithTimeout')>(),
  fetchWithTimeout: mocks.fetchWithTimeout,
}))

vi.mock('~/utils/sdk-labels', () => ({
  LiteEulerLabelsService: class {
    constructor(readonly loadBundle: unknown) {}
  },
}))

const ABI_ENV_KEYS = [
  'EULER_SDK_EULER_INTERFACES_BRANCH',
  'NUXT_PUBLIC_EULER_INTERFACES_BRANCH',
  'NUXT_PUBLIC_CONFIG_EULER_INTERFACES_BRANCH',
  'NUXT_PUBLIC_CONFIG_EULER_ABIS_BASE_URL',
] as const

const accountLensAbi = parseAbi([
  'function getEVCAccountInfo(address evc, address account) view returns (bytes)',
  'function getVaultAccountInfo(address vault, address account) view returns (bytes)',
])

describe('getServerSdk', () => {
  beforeEach(async () => {
    vi.resetModules()
    mocks.buildEulerSDK.mockReset()
    mocks.resolveRpcUrl.mockReset()
    mocks.getPublicLabelsBundle.mockReset()
    mocks.fetchWithTimeout.mockReset()
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Unexpected direct fetch in server SDK test')
    }))
    for (const key of ABI_ENV_KEYS) vi.stubEnv(key, '')
    const sdkModule = await vi.importActual<typeof import('@eulerxyz/euler-v2-sdk')>('@eulerxyz/euler-v2-sdk')
    sdkModule.DeploymentService.setQueryDeployments(async () => [1, 8453, 146, 463].map(chainId => ({
      chainId,
      name: `Chain ${chainId}`,
      viemName: chainId === 463 ? 'areonNetwork' : undefined,
      status: 'production',
      addresses: { coreAddrs: {}, lensAddrs: {} },
    } as Deployment)))
    mocks.buildEulerSDK.mockImplementation(sdkModule.buildEulerSDK)
    mocks.resolveRpcUrl.mockReturnValue('https://rpc.example')
    process.env.V3_API_URL = 'https://v3.example'
    process.env.SERVER_VAULT_CACHE_SOURCE = 'fallback'
    // Routing is driven by ONCHAIN_SDK_CHAINS only; DEPRECATED_CHAINS is a
    // UI/warm-cache concern and must not affect adapter selection.
    process.env.DEPRECATED_CHAINS = '1'
    process.env.ONCHAIN_SDK_CHAINS = '8453'
    delete process.env.TURTLE_EARN_API_KEY
  })

  it('uses checked catalog/override resolution for real server SDK factory reads', async () => {
    vi.stubEnv('SERVER_VAULT_CACHE_SOURCE', 'onchain')
    vi.stubEnv('SUBGRAPH_URL_1', 'http://private.example/query?key=secret')
    vi.stubEnv('SUBGRAPH_CATALOG_URL', 'https://catalog.example/fixture')
    const address = '0x0000000000000000000000000000000000000001' as Address
    const fetch = vi.fn(async (url: string) => url.startsWith('https://v3.example')
      ? new Response('V3 unavailable', { status: 503 })
      : Response.json({ data: { _meta: { deployment: 'cid' }, vaults: [{ id: address, factory: address }] } }))
    vi.stubGlobal('fetch', fetch)
    const { getServerSdk } = await import('~/server/utils/sdk-server')
    const sdk = await getServerSdk(1)
    await sdk.vaultMetaService.fetchVaultTypes(1, [address])
    expect(fetch).toHaveBeenCalledWith('http://private.example/query?key=secret', expect.objectContaining({ method: 'POST' }))
    vi.stubEnv('SUBGRAPH_URL_1', '')
    fetch.mockResolvedValueOnce(Response.json({ schemaVersion: 1, revision: 'r', publishedAt: '2026-10-19T00:00:00Z', deployments: [
      { chainId: 1, family: 'euler-simple', channel: 'stable', status: 'active', version: '1.0.0', endpoint: 'https://catalog-index.example/query', deploymentId: 'cid', sourceCommit: 'a'.repeat(40), startBlock: 0, capabilities: ['account-vault-discovery', 'vault-factory-lookup'] },
    ] }))
    await sdk.vaultMetaService.fetchVaultTypes(1, [address])
    expect(fetch).toHaveBeenLastCalledWith('https://catalog-index.example/query', expect.anything())
    vi.stubEnv('SUBGRAPH_DISABLED_1', 'true')
    fetch.mockClear()
    await expect(sdk.vaultMetaService.fetchVaultTypes(1, [address])).rejects.toThrow('disabled')
    expect(fetch.mock.calls.every(([url]) => url.startsWith('https://v3.example'))).toBe(true)
  })

  it('rejects 503 discovery JSON through the published account adapter rather than returning empty positions', async () => {
    vi.stubEnv('SERVER_VAULT_CACHE_SOURCE', 'onchain')
    vi.stubEnv('SUBGRAPH_URL_1', 'https://account-fixture.example/query')
    const fetch = vi.fn(async () => Response.json({ statusCode: 503, statusMessage: 'retired' }, { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    const { getServerSdk } = await import('~/server/utils/sdk-server')
    const sdk = await getServerSdk(1)
    await expect(sdk.accountService.fetchAccount(1, '0x0000000000000000000000000000000000000001')).rejects.toThrow('503')
    expect(fetch).toHaveBeenCalledWith('https://account-fixture.example/query', expect.objectContaining({
      body: expect.stringContaining('trackingActiveAccounts'),
    }))
  })

  it('preserves server bundled defaults only before catalog opt-in and without explicit disable', async () => {
    vi.stubEnv('SERVER_VAULT_CACHE_SOURCE', 'onchain')
    vi.stubEnv('SUBGRAPH_URL_1', '')
    vi.stubEnv('NUXT_PUBLIC_SUBGRAPH_URI_1', '')
    vi.stubEnv('SUBGRAPH_CATALOG_URL', '')
    vi.stubEnv('SUBGRAPH_CATALOG_DISABLED', '')
    const fetch = vi.fn(async () => Response.json({ data: { trackingActiveAccounts: [] } }))
    vi.stubGlobal('fetch', fetch)
    const { getServerSdk } = await import('~/server/utils/sdk-server')
    const { defaultVaultTypeSubgraphAdapterConfig } = await import('@eulerxyz/euler-v2-sdk')
    const sdk = await getServerSdk(1)
    await sdk.accountService.fetchAccount(1, '0x0000000000000000000000000000000000000001')
    expect(fetch).toHaveBeenCalledWith(defaultVaultTypeSubgraphAdapterConfig.subgraphURLs[1], expect.anything())
    vi.stubEnv('SUBGRAPH_CATALOG_DISABLED', 'true')
    fetch.mockClear()
    await expect(sdk.accountService.fetchAccount(1, '0x0000000000000000000000000000000000000001')).rejects.toThrow('missing')
    expect(fetch).not.toHaveBeenCalled()
    vi.stubEnv('SUBGRAPH_CATALOG_DISABLED', '')
    vi.stubEnv('SUBGRAPH_CATALOG_URL', 'https://catalog.example/empty')
    fetch.mockResolvedValueOnce(Response.json({ schemaVersion: 1, revision: 'r', publishedAt: '2026-10-19T00:00:00Z', deployments: [] }))
    await expect(sdk.accountService.fetchAccount(1, '0x0000000000000000000000000000000000000001')).rejects.toThrow('missing')
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith('https://catalog.example/empty', expect.anything())
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('reads a custom ABI host through the shared proxy cache for every server SDK', async () => {
    vi.stubEnv('EULER_SDK_EULER_INTERFACES_BRANCH', 'other-branch')
    vi.stubEnv('NUXT_PUBLIC_CONFIG_EULER_ABIS_BASE_URL', 'https://abis.example/mirror/')
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(accountLensAbi))
    const { getServerSdk } = await import('~/server/utils/sdk-server')
    const sdk = await getServerSdk(1)
    const otherSdk = await getServerSdk(8453)

    await expect(Promise.all([
      sdk.abiService.fetchABI(1, 'AccountLens'),
      otherSdk.abiService.fetchABI(8453, 'AccountLens'),
    ])).resolves.toEqual([accountLensAbi, accountLensAbi])
    const { loadAbi } = await import('~/server/api/internal/abis/[contract].get')
    await expect(loadAbi('AccountLens')).resolves.toEqual(accountLensAbi)
    expect(mocks.fetchWithTimeout).toHaveBeenCalledExactlyOnceWith('https://abis.example/mirror/AccountLens.json')
  })

  it.each(ABI_ENV_KEYS.slice(0, 3))('uses %s for server SDK ABI reads without a URL override', async (key) => {
    vi.stubEnv(key, 'custom-branch')
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(accountLensAbi))
    const { getServerSdk } = await import('~/server/utils/sdk-server')
    const sdk = await getServerSdk(1)

    await expect(sdk.abiService.fetchABI(1, 'AccountLens')).resolves.toEqual(accountLensAbi)
    expect(mocks.fetchWithTimeout).toHaveBeenCalledExactlyOnceWith(
      'https://raw.githubusercontent.com/euler-xyz/euler-interfaces/refs/heads/custom-branch/abis/AccountLens.json',
    )
  })

  it('rejects invalid ABI data and retries through the same server SDK', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([]))
    const { getServerSdk } = await import('~/server/utils/sdk-server')
    const sdk = await getServerSdk(1)

    await expect(sdk.abiService.fetchABI(1, 'AccountLens')).rejects.toThrow('invalid ABI payload')
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(accountLensAbi))
    await expect(sdk.abiService.fetchABI(1, 'AccountLens')).resolves.toEqual(accountLensAbi)
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(2)
  })

  it('preserves bounded stale ABI fallback without caching invalid replacements', async () => {
    const { getServerSdk } = await import('~/server/utils/sdk-server')
    const sdk = await getServerSdk(1)
    vi.useFakeTimers()
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(accountLensAbi))
    await expect(sdk.abiService.fetchABI(1, 'AccountLens')).resolves.toEqual(accountLensAbi)

    vi.advanceTimersByTime(6 * 60_000)
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([]))
    await expect(sdk.abiService.fetchABI(1, 'AccountLens')).resolves.toEqual(accountLensAbi)

    vi.advanceTimersByTime(8 * 24 * 60 * 60_000)
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error('upstream down'))
    await expect(sdk.abiService.fetchABI(1, 'AccountLens')).rejects.toThrow('upstream down')
  })

  it('rejects unknown ABI contracts without falling back to upstream', async () => {
    const { getServerSdk } = await import('~/server/utils/sdk-server')
    const sdk = await getServerSdk(1)

    await expect(sdk.abiService.fetchABI(1, 'UnknownLens')).rejects.toThrow('Unknown ABI contract')
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
  })

  it('forces ONCHAIN_SDK_CHAINS chains to onchain while other chains use the configured source', async () => {
    const { getServerSdk } = await import('~/server/utils/sdk-server')

    const sdk = await getServerSdk(1)
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
    expect(mocks.buildEulerSDK.mock.calls[0]?.[0].servicesOverrides.eulerLabelsService.loadBundle)
      .toBe(mocks.getPublicLabelsBundle)
    expect(mocks.buildEulerSDK.mock.calls[1]?.[0].servicesOverrides.eulerLabelsService.loadBundle)
      .toBe(mocks.getPublicLabelsBundle)
    expect(sdk.eulerLabelsService)
      .toBe(mocks.buildEulerSDK.mock.calls[0]?.[0].servicesOverrides.eulerLabelsService)
    const providerService = sdk.providerService
    expect(providerService.getProvider(1).batch.multicall).toEqual({ batchSize: 2048, wait: 10 })
    expect(providerService.getProvider(1)).toBe(providerService.getProvider(1))
    expect(() => providerService.getProvider(146)).toThrow('No provider configured for chainId 146')
  })
  it('disables optional V3 utilities as well as adapters for an explicit opt-out', async () => {
    vi.stubEnv('DISABLE_V3', 'true')
    const priceService = { setBackendClient: vi.fn() }
    const tokenlistService = { setQueryTokenList: vi.fn() }
    mocks.buildEulerSDK.mockResolvedValue({ priceService, tokenlistService })
    const { getServerSdk } = await import('~/server/utils/sdk-server')
    await getServerSdk(1)
    const options = mocks.buildEulerSDK.mock.calls[0]?.[0]
    expect(options.config.disableV3).toBe(true)
    expect(priceService.setBackendClient).toHaveBeenCalledWith(undefined)
    expect(tokenlistService.setQueryTokenList).toHaveBeenCalledOnce()
    expect(await options.servicesOverrides.intrinsicApyService.fetchChainIntrinsicApys(1)).toEqual(new Map())
  })
  it('passes an explicit false through to the SDK when the Lite setting overrides its alias', async () => {
    vi.stubEnv('DISABLE_V3', 'false')
    vi.stubEnv('EULER_SDK_DISABLE_V3', 'true')
    const { getServerSdk } = await import('~/server/utils/sdk-server')
    await getServerSdk(1)
    expect(mocks.buildEulerSDK.mock.calls[0]?.[0].config.disableV3).toBe(false)
  })

  it('keeps registry network selection and custom ABIs with V3 disabled in a real SDK', async () => {
    vi.stubEnv('DISABLE_V3', 'true')
    vi.stubEnv('NUXT_PUBLIC_CONFIG_EULER_ABIS_BASE_URL', 'https://abis.example/fork')
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(accountLensAbi))
    const { getServerSdk } = await import('~/server/utils/sdk-server')
    const sdk = await getServerSdk(463)
    expect(sdk.providerService.getProvider(463).chain?.name).toBe('Areon Network')
    await expect(sdk.abiService.fetchABI(463, 'AccountLens')).resolves.toEqual(accountLensAbi)
    await expect(sdk.tokenlistService.loadTokenlist(463)).resolves.toEqual([])
    await expect(sdk.intrinsicApyService.fetchChainIntrinsicApys(463)).resolves.toEqual(new Map())
    expect(mocks.fetchWithTimeout).toHaveBeenCalledExactlyOnceWith('https://abis.example/fork/AccountLens.json')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('hands the server-only Turtle key and fixed upstream to the rewards adapters', async () => {
    process.env.TURTLE_EARN_API_KEY = ' turtle-secret '
    const { getServerSdk } = await import('~/server/utils/sdk-server')

    await getServerSdk(1)

    const config = mocks.buildEulerSDK.mock.calls[0]?.[0].config
    expect(config).toMatchObject({
      rewardsTurtleApiKey: 'turtle-secret',
      rewardsTurtleApiUrl: 'https://earn.turtle.xyz/v2',
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
      rewardsTurtleApiUrl: 'https://earn.turtle.xyz/v2',
    })
    delete process.env.TURTLE_EARN_API_URL
  })

  it('passes Sonic transport tuning with the configured RPC URL and caches the server SDK', async () => {
    mocks.resolveRpcUrl.mockReturnValue('https://custom-sonic.example/rpc')
    const { getServerSdk } = await import('~/server/utils/sdk-server')

    const first = getServerSdk(146)
    expect(getServerSdk(146)).toBe(first)
    const sdk = await first

    expect(mocks.buildEulerSDK).toHaveBeenCalledOnce()
    const options = mocks.buildEulerSDK.mock.calls[0]?.[0]
    expect(options.config.rpcUrls).toEqual({ 146: 'https://custom-sonic.example/rpc' })
    expect(sdk.providerService.getProvider(146)).toBe(
      sdk.providerService.getProvider(146),
    )
    expect(sdk.providerService.getSupportedChainIds()).toEqual([146])
  })

  it('uses registry viemName to resolve a chain ID shared by distinct viem definitions', async () => {
    const { ProviderService } = await vi.importActual<typeof import('@eulerxyz/euler-v2-sdk')>('@eulerxyz/euler-v2-sdk')
    expect(() => new ProviderService({ 463: 'https://rpc.example' })).toThrow('several chains with id 463')
    const { getServerSdk } = await import('~/server/utils/sdk-server')

    const sdk = await getServerSdk(463)

    expect(sdk.providerService.getProvider(463).chain?.name).toBe('Areon Network')
    expect(sdk.providerService.getSupportedChainIds()).toEqual([463])
    expect(mocks.buildEulerSDK.mock.calls[0]?.[0].servicesOverrides?.providerService).toBeUndefined()
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
      const sdk = await getServerSdk(146)
      const provider = sdk.providerService.getProvider(146) as unknown as PublicClient
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
