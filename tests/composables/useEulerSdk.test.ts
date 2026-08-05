import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref, type Ref } from 'vue'

type MockSdk = {
  id: string
  oracleAdapterService: {
    setQueryOracleAdapters: ReturnType<typeof vi.fn>
  }
}
type BuildEulerSDKOptions = {
  config: {
    rpcUrls: Record<number, string>
    v3ApiUrl?: string
    tokenlistApiBaseUrl?: string
    deploymentsUrl?: string
    oracleAdaptersBaseUrl?: string
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
  oracleAdapterService: {
    setQueryOracleAdapters: vi.fn(),
  },
})

const importUseEulerSdk = async (
  chainIds: Ref<number[]>,
  buildEulerSDK: ReturnType<typeof vi.fn>,
  onchainSdkChainIds: number[] = [],
) => {
  vi.resetModules()
  vi.doMock('@eulerxyz/euler-v2-sdk', () => ({
    buildEulerSDK,
    createKeyringPlugin: vi.fn(() => ({ name: 'keyring' })),
    createPythPlugin: vi.fn(() => ({ name: 'pyth' })),
    IntrinsicApyService: class IntrinsicApyService {
      constructor(readonly adapter: unknown) {}
    },
    IntrinsicApyV3Adapter: class IntrinsicApyV3Adapter {
      constructor(readonly config: unknown, readonly buildQuery: unknown) {}
    },
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

  it('passes runtime values through the SDK config object', async () => {
    const chainIds = ref([1, 8453])
    const sdk = createMockSdk('configured')
    const buildEulerSDK = vi.fn().mockResolvedValue(sdk)
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: {
        configEulerChainsUrl: 'https://example.test/EulerChains.json',
        configOracleChecksBaseUrl: 'https://oracles.example.test/data/',
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
      oracleAdaptersBaseUrl: 'https://oracles.example.test/data',
    })
    expect(options.rpcUrls).toBeUndefined()
    expect(options.deploymentServiceConfig).toBeUndefined()
    expect(options.eulerLabelsAdapterConfig).toBeUndefined()
    expect(options.oracleAdapterServiceConfig).toBeUndefined()
  })

  it('uses Lite proxy defaults when runtime URLs are empty', async () => {
    const chainIds = ref([1])
    const sdk = createMockSdk('defaults')
    const buildEulerSDK = vi.fn().mockResolvedValue(sdk)
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: {
        configEulerChainsUrl: '',
        configOracleChecksBaseUrl: '',
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
        configOracleChecksBaseUrl: '',
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

  it('keeps fresh portfolio reads onchain while resolving rewards through fallback', async () => {
    const chainIds = ref([8453])
    const sdk = createMockSdk('fresh')
    const buildEulerSDK = vi.fn().mockResolvedValue(sdk)
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: {
        configEulerChainsUrl: '',
        configOracleChecksBaseUrl: '',
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
        configOracleChecksBaseUrl: '',
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
