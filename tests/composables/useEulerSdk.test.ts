import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref, type Ref } from 'vue'

type MockSdk = {
  id: string
  oracleAdapterService: Record<string, never>
  abiService: {
    setQueryABI: ReturnType<typeof vi.fn>
  }
}
type BuildEulerSDKOptions = {
  config: {
    rpcUrls: Record<number, string>
    v3ApiUrl?: string
    tokenlistApiBaseUrl?: string
    deploymentsUrl?: string
    rewardsMerklApiUrl?: string
    rewardsBrevisApiUrl?: string
    rewardsBrevisProofsApiUrl?: string
    rewardsFuulApiUrl?: string
    rewardsTurtleApiUrl?: string
    rewardsEnableMerkl?: boolean
    rewardsEnableBrevis?: boolean
    rewardsEnableFuul?: boolean
    rewardsEnableTurtle?: boolean
    accountServiceAdapter?: string
    eVaultServiceAdapter?: string
    eulerEarnServiceAdapter?: string
    vaultTypeAdapter?: string
    rewardsServiceAdapter?: string
    eulerInterfacesBranch?: string
  }
  rpcUrls?: Record<number, string>
  deploymentServiceConfig?: unknown
  eulerLabelsAdapterConfig?: unknown
  oracleAdapterServiceConfig?: unknown
  servicesOverrides?: {
    eulerLabelsService?: unknown
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, resolve, reject }
}

const createMockSdk = (id: string): MockSdk => ({
  id,
  oracleAdapterService: {},
  abiService: {
    setQueryABI: vi.fn(),
  },
})

const importUseEulerSdk = async (
  chainIds: Ref<number[]>,
  buildEulerSDK: ReturnType<typeof vi.fn>,
  onchainSdkChainIds: number[] = [],
  buildDeployments = vi.fn(async () => ({ getDeploymentChainIds: () => chainIds.value })),
  disableV3 = false,
) => {
  vi.resetModules()
  vi.doMock('@eulerxyz/euler-v2-sdk', async importOriginal => ({
    ...await importOriginal<typeof import('@eulerxyz/euler-v2-sdk')>(),
    buildEulerSDK,
    DeploymentService: { build: buildDeployments },
    serializeQueryArgs: (args: readonly unknown[]) => JSON.stringify(args),
    createKeyringPlugin: vi.fn(() => ({ name: 'keyring' })),
    createPythPlugin: vi.fn(() => ({ name: 'pyth' })),
    IntrinsicApyService: class IntrinsicApyService {
      constructor(readonly adapter: unknown) {}
    },
    IntrinsicApyV3Adapter: class IntrinsicApyV3Adapter {
      constructor(readonly config: unknown, readonly buildQuery: unknown) {}
    },
  }))
  vi.doMock('~/utils/sdk-labels', () => ({
    LiteEulerLabelsService: class LiteEulerLabelsService {
      constructor(readonly fetchEulerLabelsData: (chainId: number) => Promise<unknown>) {}
    },
    loadBrowserLabelsBundle: vi.fn().mockResolvedValue({ source: 'v3' }),
  }))
  vi.stubGlobal('useEulerAddresses', () => ({
    allowedChainIds: chainIds,
    chainId: computed(() => chainIds.value[0] ?? 1),
  }))
  vi.stubGlobal('useChainConfig', () => ({
    enabledChainIds: chainIds.value,
    deprecatedChainIds: [],
    onchainSdkChainIds,
    eVaultFetchChunkChainIds: [],
  }))
  vi.stubGlobal('useVaultRegistry', () => ({
    getAll: () => [],
  }))
  vi.stubGlobal('useEnvConfig', () => ({
    v3ApiUrl: '',
    enableV3Backend: true,
    disableV3,
    browserVaultSource: 'fallback',
    eulerInterfacesBranch: 'account-lens-update',
  }))
  vi.stubGlobal('useDeployConfig', () => ({
    enableMerkl: true,
    enableIncentra: true,
    enableFuul: true,
    enableTurtle: true,
  }))

  return await import('~/composables/useEulerSdk')
}

describe('useEulerSdk', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('does not let an older build overwrite the SDK for the current config', async () => {
    const chainIds = ref([1])
    const sdkA = createMockSdk('a')
    const sdkB = createMockSdk('b')
    const builds: Array<Deferred<MockSdk>> = []
    const buildEulerSDK = vi.fn((_options: BuildEulerSDKOptions) => {
      const deferred = createDeferred<MockSdk>()
      builds.push(deferred)
      return deferred.promise
    })
    const { getEulerSdk } = await importUseEulerSdk(chainIds, buildEulerSDK)

    const firstBuild = getEulerSdk()
    await vi.waitFor(() => expect(buildEulerSDK).toHaveBeenCalledTimes(1))

    chainIds.value = [2]
    const secondBuild = getEulerSdk()
    await vi.waitFor(() => expect(buildEulerSDK).toHaveBeenCalledTimes(2))

    builds[1].resolve(sdkB)
    await expect(secondBuild).resolves.toBe(sdkB)

    builds[0].resolve(sdkA)
    await expect(firstBuild).resolves.toBe(sdkA)

    await expect(getEulerSdk()).resolves.toBe(sdkB)
    expect(buildEulerSDK).toHaveBeenCalledTimes(2)
  }, 20_000)

  it('waits for a delayed deployment manifest and excludes a premature RPC chain before building providers', async () => {
    // The HTML boot read timed out, so the initial allowed list still comes from env.
    const chainIds = ref([1, 999999])
    const sdk = createMockSdk('admitted')
    const buildEulerSDK = vi.fn().mockResolvedValue(sdk)
    const pending = createDeferred<{ getDeploymentChainIds: () => number[] }>()
    const buildDeployments = vi.fn(() => pending.promise)
    const { getEulerSdk } = await importUseEulerSdk(chainIds, buildEulerSDK, [], buildDeployments)

    const result = getEulerSdk()
    await vi.waitFor(() => expect(buildDeployments).toHaveBeenCalledOnce())
    expect(buildEulerSDK).not.toHaveBeenCalled()

    const deploymentService = { getDeploymentChainIds: () => [1] }
    pending.resolve(deploymentService)
    await expect(result).resolves.toBe(sdk)
    expect(buildEulerSDK.mock.calls[0][0].config.rpcUrls).toEqual({ 1: '/api/internal/rpc/1' })
    expect(buildEulerSDK.mock.calls[0][0].servicesOverrides.deploymentService).toBe(deploymentService)
    expect(buildEulerSDK.mock.calls[0][0].servicesOverrides.eulerLabelsService.fetchEulerLabelsData)
      .toEqual(expect.any(Function))
    expect(buildDeployments).toHaveBeenCalledWith(
      { deploymentsUrl: '/api/internal/euler-chains' }, expect.any(Function),
    )
    await expect(getEulerSdk()).resolves.toBe(sdk)
    expect(buildDeployments).toHaveBeenCalledOnce()
  })

  it('fails closed when no configured chain has admitted deployment metadata', async () => {
    const buildEulerSDK = vi.fn()
    const { getEulerSdk } = await importUseEulerSdk(ref([999999]), buildEulerSDK, [],
      vi.fn(async () => ({ getDeploymentChainIds: () => [1] })))

    await expect(getEulerSdk()).rejects.toThrow('No enabled chains have usable deployment metadata')
    expect(buildEulerSDK).not.toHaveBeenCalled()
  })

  it('passes runtime values through the SDK config object', async () => {
    const chainIds = ref([1, 8453])
    const sdk = createMockSdk('configured')
    const buildEulerSDK = vi.fn().mockResolvedValue(sdk)
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: {
        configEulerChainsUrl: 'https://example.test/EulerChains.json',
      },
    }))

    const { getEulerSdk } = await importUseEulerSdk(chainIds, buildEulerSDK)
    await expect(getEulerSdk()).resolves.toBe(sdk)

    const options = buildEulerSDK.mock.calls[0]?.[0] as BuildEulerSDKOptions
    expect(options.config).toMatchObject({
      rpcUrls: {
        1: '/api/internal/rpc/1',
        8453: '/api/internal/rpc/8453',
      },
      v3ApiUrl: '/api/internal',
      tokenlistApiBaseUrl: '/api/internal',
      deploymentsUrl: '/api/internal/euler-chains',
    })
    expect(options.rpcUrls).toBeUndefined()
    expect(options.deploymentServiceConfig).toBeUndefined()
    expect(options.eulerLabelsAdapterConfig).toBeUndefined()
    expect(options.servicesOverrides?.eulerLabelsService).toBeDefined()
    expect(options.oracleAdapterServiceConfig).toBeUndefined()
  })

  it('uses Lite proxy defaults when runtime URLs are empty', async () => {
    const chainIds = ref([1])
    const sdk = createMockSdk('defaults')
    const buildEulerSDK = vi.fn().mockResolvedValue(sdk)
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: {
        configEulerChainsUrl: '',
      },
    }))

    const { getEulerSdk } = await importUseEulerSdk(chainIds, buildEulerSDK)
    await expect(getEulerSdk()).resolves.toBe(sdk)

    const options = buildEulerSDK.mock.calls[0]?.[0] as BuildEulerSDKOptions
    expect(options.config).toMatchObject({
      rpcUrls: {
        1: '/api/internal/rpc/1',
      },
      v3ApiUrl: '/api/internal',
      tokenlistApiBaseUrl: '/api/internal',
      intrinsicApyV3ApiUrl: '/api/internal',
      eulerInterfacesBranch: 'account-lens-update',
      deploymentsUrl: '/api/internal/euler-chains',
      rewardsMerklApiUrl: '/api/internal/proxy/merkl',
      rewardsBrevisApiUrl: '/api/internal/proxy/incentra/sdk/v1/eulerCampaigns',
      rewardsBrevisProofsApiUrl: '/api/internal/proxy/incentra/v1/getMerkleProofsBatch',
      rewardsFuulApiUrl: '/api/internal/proxy/fuul',
      rewardsTurtleApiUrl: '/api/internal/proxy/turtle',
      accountVaultsSubgraphUrls: {
        1: '/api/internal/proxy/subgraph/1',
      },
      vaultTypeSubgraphUrls: {
        1: '/api/internal/proxy/subgraph/1',
      },
      accountServiceAdapter: 'fallback',
      eVaultServiceAdapter: 'fallback',
      eulerEarnServiceAdapter: 'fallback',
      vaultTypeAdapter: 'fallback',
      rewardsServiceAdapter: 'fallback',
    })
  })

  it('routes SDK ABI fetches through the /api/internal/abis proxy', async () => {
    const chainIds = ref([1])
    const sdk = createMockSdk('abi-proxied')
    const buildEulerSDK = vi.fn().mockResolvedValue(sdk)
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: {},
    }))

    const { getEulerSdk } = await importUseEulerSdk(chainIds, buildEulerSDK)
    await expect(getEulerSdk()).resolves.toBe(sdk)

    expect(sdk.abiService.setQueryABI).toHaveBeenCalledTimes(1)
    const queryABI = sdk.abiService.setQueryABI.mock.calls[0]?.[0] as (url: string) => Promise<unknown>

    const abi = [{ type: 'function', name: 'getVaultInfoFull' }]
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => abi,
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      queryABI('https://raw.githubusercontent.com/euler-xyz/euler-interfaces/refs/heads/master/abis/VaultLens.json'),
    ).resolves.toEqual(abi)
    expect(fetchMock).toHaveBeenCalledWith('/api/internal/abis/VaultLens')

    await expect(queryABI('https://evil.example/not-an-abi')).rejects.toThrow('Unexpected ABI URL shape')
  })

  it('uses an onchain browsing SDK for chains listed in ONCHAIN_SDK_CHAINS', async () => {
    const chainIds = ref([1, 8453])
    const regularSdk = createMockSdk('regular')
    const onchainSdk = createMockSdk('onchain')
    const buildEulerSDK = vi.fn()
      .mockResolvedValueOnce(regularSdk)
      .mockResolvedValueOnce(onchainSdk)
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: {
        configEulerChainsUrl: '',
      },
    }))

    const { getEulerSdkForChain } = await importUseEulerSdk(chainIds, buildEulerSDK, [8453])
    await expect(getEulerSdkForChain(1)).resolves.toBe(regularSdk)
    await expect(getEulerSdkForChain(8453)).resolves.toBe(onchainSdk)
    await expect(getEulerSdkForChain(8453)).resolves.toBe(onchainSdk)

    expect(buildEulerSDK).toHaveBeenCalledTimes(2)
    expect((buildEulerSDK.mock.calls[0]?.[0] as BuildEulerSDKOptions).config).toMatchObject({
      accountServiceAdapter: 'fallback',
      eVaultServiceAdapter: 'fallback',
      eulerEarnServiceAdapter: 'fallback',
      vaultTypeAdapter: 'fallback',
      rewardsServiceAdapter: 'fallback',
    })
    expect((buildEulerSDK.mock.calls[1]?.[0] as BuildEulerSDKOptions).config).toMatchObject({
      accountServiceAdapter: 'onchain',
      eVaultServiceAdapter: 'onchain',
      eulerEarnServiceAdapter: 'onchain',
      vaultTypeAdapter: 'subgraph',
      rewardsServiceAdapter: 'fallback',
    })
  })

  it('rebuilds browsing and fresh SDKs across catalog retirement/reactivation on a deprecated chain', async () => {
    const buildEulerSDK = vi.fn().mockImplementation(async () => createMockSdk(`sdk-${buildEulerSDK.mock.calls.length}`))
    const { getEulerSdkForChain, getEulerSdkFresh } = await importUseEulerSdk(ref([999]), buildEulerSDK)
    vi.stubGlobal('window', { __CHAIN_CONFIG__: {
      enabledChainIds: [999], deprecatedChainIds: [999], onchainSdkChainIds: [], eVaultFetchChunkChainIds: [],
    } })
    const { useChainConfig, applyChainReadPolicy } = await import('~/composables/useChainConfig')
    vi.stubGlobal('useChainConfig', useChainConfig)
    const active = await getEulerSdkForChain(999)
    const fresh = await getEulerSdkFresh()
    applyChainReadPolicy(999, { deprecated: true, onchain: true, metadataOnly: true })
    const deprecated = await getEulerSdkForChain(999)
    expect(deprecated).not.toBe(active)
    expect(await getEulerSdkFresh()).not.toBe(fresh)
    expect(await getEulerSdkForChain(999)).toBe(deprecated)
    expect(buildEulerSDK.mock.calls[2][0].config.eVaultServiceAdapter).toBe('onchain')
    applyChainReadPolicy(999, { deprecated: true, onchain: false, metadataOnly: false })
    expect(await getEulerSdkForChain(999)).not.toBe(active)
    expect(buildEulerSDK.mock.calls[4][0].config.eVaultServiceAdapter).toBe('fallback')
    expect(buildEulerSDK).toHaveBeenCalledTimes(5)
  })

  it.each([
    ['https://v3.euler.finance', 'v3', 'v3', false],
    ['https://custom-indexer.example.test', 'v3', 'v3', false],
    ['https://custom-indexer.example.test', 'fallback', 'fallback', false],
    ['https://custom-indexer.example.test', 'fallback', 'onchain', false],
    ['https://custom-indexer.example.test', 'onchain', 'fallback', false],
    ['https://custom-indexer.example.test', 'onchain', 'onchain', false],
    ['https://custom-indexer.example.test', 'fallback', 'onchain', true],
  ] as const)(
    'shares policy and isolates SDK caches for %s (browser=%s, server=%s, disableV3=%s)', async (upstream, browserSource, serverSource, disableV3) => {
      const automatic = upstream === 'https://v3.euler.finance'
      vi.useFakeTimers()
      for (const [key, value] of Object.entries({
        V3_API_URL: upstream, DISABLE_V3: String(disableV3), LABELS_SOURCE: disableV3 ? 'static' : 'v3',
        SERVER_VAULT_CACHE_SOURCE: serverSource, NUXT_PUBLIC_BROWSER_VAULT_SOURCE: browserSource,
        STATIC_LABELS_BASE_URL: 'https://labels.example.test', RPC_URL_999: 'https://rpc.example.test',
        DEPRECATED_CHAINS: '', ONCHAIN_SDK_CHAINS: '',
      })) vi.stubEnv(key, value)
      const manifest = [{ chainId: 999, status: 'deprecated' }]
      vi.doMock('~/server/api/internal/euler-chains.get', () => ({
        loadEulerChains: async () => manifest, peekEulerChains: () => manifest,
      }))
      let indexed = true
      const fetch = vi.fn(async (url: string) => {
        expect(url).toBe('https://v3.euler.finance/v3/chains')
        return Response.json({ data: indexed ? [{ id: 999, capabilities: ['indexing'] }] : [] })
      })
      vi.stubGlobal('fetch', fetch)
      try {
        const buildEulerSDK = vi.fn().mockImplementation(async () => ({
          ...createMockSdk(`sdk-${buildEulerSDK.mock.calls.length}`),
          priceService: { setBackendClient: vi.fn() },
          tokenlistService: { setQueryTokenList: vi.fn() },
        }))
        const { getEulerSdkForChain } = await importUseEulerSdk(ref([999]), buildEulerSDK)
        const { readAppEnvConfig } = await import('~/utils/app-config')
        vi.stubGlobal('useEnvConfig', () => readAppEnvConfig())
        const { loadServerChainPolicy } = await import('~/server/utils/chain-policy')
        const { refreshV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
        const { getChainReadPolicy } = await import('~/utils/chain-policy')
        const { getServerSdk } = await import('~/server/utils/sdk-server')
        vi.stubGlobal('window', { __CHAIN_CONFIG__: await loadServerChainPolicy() })
        const { useChainConfig, refreshChainReadPolicy } = await import('~/composables/useChainConfig')
        vi.stubGlobal('useChainConfig', useChainConfig)
        vi.stubGlobal('$fetch', async () => ({ chainId: 999, policy: getChainReadPolicy(await loadServerChainPolicy(), 999) }))
        const browser = await getEulerSdkForChain(999)
        const server = await getServerSdk(999)
        expect(buildEulerSDK.mock.calls.map(([options]) => options.config.eVaultServiceAdapter)).toEqual([browserSource, serverSource])
        expect(buildEulerSDK.mock.calls.map(([options]) => options.config.disableV3)).toEqual([disableV3, disableV3])
        for (const result of buildEulerSDK.mock.results) {
          const sdk = await result.value
          expect(sdk.priceService.setBackendClient).toHaveBeenCalledTimes(disableV3 ? 1 : 0)
          expect(sdk.tokenlistService.setQueryTokenList).toHaveBeenCalledTimes(disableV3 ? 1 : 0)
        }
        await refreshChainReadPolicy(999)
        expect(await getEulerSdkForChain(999)).toBe(browser)
        expect(await getServerSdk(999)).toBe(server)
        expect(useChainConfig().policyRevision).toBe(0)

        let finishOld!: (value: string) => void
        const oldQuery = buildEulerSDK.mock.calls[0][0].buildQuery('queryEVaultInfoFull',
          () => new Promise<string>((resolve) => { finishOld = resolve }), {})
        const pending = oldQuery(999)
        if (automatic) {
          indexed = false
          vi.advanceTimersByTime(5 * 60_000)
          const catalogRefresh = createDeferred<Response>()
          fetch.mockReturnValueOnce(catalogRefresh.promise)
          await refreshChainReadPolicy(999)
          expect(await getEulerSdkForChain(999)).toBe(browser)
          expect(await getServerSdk(999)).toBe(server)
          expect(useChainConfig().policyRevision).toBe(0)
          catalogRefresh.resolve(Response.json({ data: [] }))
          await refreshV3ChainCatalog()
        }
        else vi.stubEnv('ONCHAIN_SDK_CHAINS', '999')
        await refreshChainReadPolicy(999)
        expect(await getEulerSdkForChain(999)).not.toBe(browser)
        expect(await getServerSdk(999)).not.toBe(server)
        expect(buildEulerSDK.mock.calls.slice(2).map(([options]) => options.config.eVaultServiceAdapter)).toEqual(['onchain', 'onchain'])
        expect(getChainReadPolicy(useChainConfig(), 999)).toEqual({ deprecated: true, onchain: true, metadataOnly: automatic })
        const currentRead = vi.fn().mockResolvedValue('current')
        const currentQuery = buildEulerSDK.mock.calls[2][0].buildQuery('queryEVaultInfoFull', currentRead, {})
        await expect(currentQuery(999)).resolves.toBe('current')
        finishOld('old')
        await expect(pending).resolves.toBe('old')
        await expect(currentQuery(999)).resolves.toBe('current')
        expect(currentRead).toHaveBeenCalledOnce()

        indexed = true
        vi.stubEnv('ONCHAIN_SDK_CHAINS', '')
        vi.advanceTimersByTime(5 * 60_000)
        if (automatic) await refreshV3ChainCatalog()
        await refreshChainReadPolicy(999)
        expect(await getEulerSdkForChain(999)).not.toBe(browser)
        expect(await getServerSdk(999)).not.toBe(server)
        expect(buildEulerSDK.mock.calls.slice(4).map(([options]) => options.config.eVaultServiceAdapter)).toEqual([browserSource, serverSource])
        expect(buildEulerSDK.mock.calls.every(([options]) => options.config.disableV3 === disableV3)).toBe(true)
        expect(getChainReadPolicy(useChainConfig(), 999)).toEqual({ deprecated: true, onchain: false, metadataOnly: false })
        expect(useChainConfig().policyRevision).toBe(2)
        expect(fetch).toHaveBeenCalledTimes(automatic ? 3 : 0)
        const { sdkQueryClient } = await import('~/utils/sdk-query-cache')
        sdkQueryClient.clear()
      }
      finally {
        vi.useRealTimers()
        vi.unstubAllEnvs()
        vi.doUnmock('~/server/api/internal/euler-chains.get')
      }
    },
  )

  it.each([true, false])('waits for cold policy before choosing indexed=%s browsing adapters', async (indexed) => {
    const buildEulerSDK = vi.fn().mockResolvedValue(createMockSdk('resolved'))
    const { getEulerSdkForChain } = await importUseEulerSdk(ref([999]), buildEulerSDK)
    vi.stubGlobal('useEnvConfig', () => ({ enableV3Backend: true, browserVaultSource: 'v3' }))
    vi.stubGlobal('window', { __CHAIN_CONFIG__: {
      enabledChainIds: [999], deprecatedChainIds: [999], onchainSdkChainIds: [], unresolvedChainIds: [999], eVaultFetchChunkChainIds: [],
    } })
    const { useChainConfig } = await import('~/composables/useChainConfig')
    vi.stubGlobal('useChainConfig', useChainConfig)
    const policy = createDeferred<unknown>()
    const fetch = vi.fn().mockRejectedValueOnce(new Error('catalog unavailable')).mockReturnValueOnce(policy.promise)
    vi.stubGlobal('$fetch', fetch)
    await expect(getEulerSdkForChain(999)).rejects.toThrow('catalog unavailable')
    expect(buildEulerSDK).not.toHaveBeenCalled()
    const pending = getEulerSdkForChain(999)
    await Promise.resolve()
    expect(buildEulerSDK).not.toHaveBeenCalled()
    policy.resolve({ chainId: 999, policy: { deprecated: true, onchain: !indexed, metadataOnly: !indexed } })
    await pending
    expect(buildEulerSDK.mock.calls[0][0].config.eVaultServiceAdapter).toBe(indexed ? 'v3' : 'onchain')
    expect(useChainConfig().policyRevision).toBe(1)
  })

  it('also blocks label population from a generic SDK while cold policy is unresolved', async () => {
    const buildEulerSDK = vi.fn().mockResolvedValue(createMockSdk('generic'))
    const { getEulerSdk } = await importUseEulerSdk(ref([999]), buildEulerSDK)
    vi.stubGlobal('window', { __CHAIN_CONFIG__: {
      enabledChainIds: [999], deprecatedChainIds: [], onchainSdkChainIds: [], unresolvedChainIds: [999], eVaultFetchChunkChainIds: [],
    } })
    const { useChainConfig } = await import('~/composables/useChainConfig')
    vi.stubGlobal('useChainConfig', useChainConfig)
    const fetch = vi.fn().mockRejectedValueOnce(new Error('catalog unavailable'))
      .mockResolvedValueOnce({ chainId: 999, policy: { deprecated: false, onchain: false, metadataOnly: false } })
    vi.stubGlobal('$fetch', fetch)
    await getEulerSdk()
    const labels = buildEulerSDK.mock.calls[0][0].servicesOverrides.eulerLabelsService
    const { loadBrowserLabelsBundle } = await import('~/utils/sdk-labels')
    await expect(labels.fetchEulerLabelsData(999)).rejects.toThrow('catalog unavailable')
    expect(loadBrowserLabelsBundle).not.toHaveBeenCalled()
    await expect(labels.fetchEulerLabelsData(999)).resolves.toMatchObject({ source: 'v3' })
    expect(loadBrowserLabelsBundle).toHaveBeenCalledOnce()
  })
  it('preserves deployment admission with the V3 opt-out in browsing and plan-time SDKs', async () => {
    const sdk = {
      ...createMockSdk('no-v3'),
      priceService: { setBackendClient: vi.fn() },
      tokenlistService: { setQueryTokenList: vi.fn() },
    }
    const buildEulerSDK = vi.fn().mockResolvedValue(sdk)
    const deploymentService = { getDeploymentChainIds: () => [1] }
    const buildDeployments = vi.fn(async () => deploymentService)
    const { getEulerSdk, getEulerSdkFresh } = await importUseEulerSdk(ref([1, 999999]), buildEulerSDK, [], buildDeployments, true)
    await getEulerSdk()
    await getEulerSdkFresh()
    expect(buildEulerSDK.mock.calls.map(([options]) => options.config.disableV3)).toEqual([true, true])
    for (const [options] of buildEulerSDK.mock.calls) {
      expect(options.config.rpcUrls).toEqual({ 1: '/api/internal/rpc/1' })
      expect(options.servicesOverrides.deploymentService).toBe(deploymentService)
    }
    expect(sdk.priceService.setBackendClient).toHaveBeenCalledTimes(2)
    expect(sdk.tokenlistService.setQueryTokenList).toHaveBeenCalledTimes(2)
  })

  it('keeps fresh portfolio reads onchain while resolving rewards through fallback', async () => {
    const chainIds = ref([8453])
    const sdk = createMockSdk('fresh')
    const buildEulerSDK = vi.fn().mockResolvedValue(sdk)
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: {
        configEulerChainsUrl: '',
      },
    }))

    const { getEulerSdkFresh } = await importUseEulerSdk(chainIds, buildEulerSDK)
    await expect(getEulerSdkFresh()).resolves.toBe(sdk)

    const options = buildEulerSDK.mock.calls[0]?.[0] as BuildEulerSDKOptions
    expect(options.config).toMatchObject({
      accountServiceAdapter: 'onchain',
      eVaultServiceAdapter: 'onchain',
      eulerEarnServiceAdapter: 'onchain',
      vaultTypeAdapter: 'subgraph',
      rewardsServiceAdapter: 'fallback',
      rewardsTurtleApiUrl: '/api/internal/proxy/turtle',
      v3ApiUrl: '/api/internal',
    })
  })

  it('passes disabled reward providers through SDK config only when disabled', async () => {
    const chainIds = ref([1])
    const sdk = createMockSdk('rewards-disabled')
    const buildEulerSDK = vi.fn().mockResolvedValue(sdk)
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: {
        configEulerChainsUrl: '',
      },
    }))

    const { getEulerSdk } = await importUseEulerSdk(chainIds, buildEulerSDK)
    vi.stubGlobal('useDeployConfig', () => ({
      enableMerkl: false,
      enableIncentra: true,
      enableFuul: false,
      enableTurtle: false,
    }))

    await expect(getEulerSdk()).resolves.toBe(sdk)

    const options = buildEulerSDK.mock.calls[0]?.[0] as BuildEulerSDKOptions
    expect(options.config).toMatchObject({
      rewardsEnableMerkl: false,
      rewardsEnableFuul: false,
      rewardsEnableTurtle: false,
    })
    expect(options.config.rewardsEnableBrevis).toBeUndefined()
  })

  it('clears a rejected build so the same config can retry', async () => {
    const chainIds = ref([1])
    const sdk = createMockSdk('retry')
    const buildEulerSDK = vi.fn()
      .mockRejectedValueOnce(new Error('build failed'))
      .mockResolvedValueOnce(sdk)
    const { getEulerSdk } = await importUseEulerSdk(chainIds, buildEulerSDK)

    await expect(getEulerSdk()).rejects.toThrow('build failed')
    await expect(getEulerSdk()).resolves.toBe(sdk)
    await expect(getEulerSdk()).resolves.toBe(sdk)
    expect(buildEulerSDK).toHaveBeenCalledTimes(2)
  })
})
