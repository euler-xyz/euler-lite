import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'

type MockSdk = {
  id: string
  oracleAdapterService: {
    setQueryOracleAdapters: ReturnType<typeof vi.fn>
  }
}
type BuildEulerSDKOptions = {
  config: {
    rpcUrls: Record<number, string>
    deploymentsUrl?: string
    eulerLabelsBaseUrl?: string
    oracleAdaptersBaseUrl?: string
    rewardsEnableMerkl?: boolean
    rewardsEnableBrevis?: boolean
    rewardsEnableFuul?: boolean
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
) => {
  vi.resetModules()
  vi.doMock('@eulerxyz/euler-v2-sdk', () => ({
    buildEulerSDK,
    createPythPlugin: vi.fn(() => ({ name: 'pyth' })),
  }))
  vi.stubGlobal('useEulerAddresses', () => ({ allowedChainIds: chainIds }))
  vi.stubGlobal('useEnvConfig', () => ({
    v3ApiUrl: '',
  }))
  vi.stubGlobal('useDeployConfig', () => ({
    enableMerkl: true,
    enableIncentra: true,
    enableFuul: true,
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
    expect(buildEulerSDK).toHaveBeenCalledTimes(1)

    chainIds.value = [2]
    const secondBuild = getEulerSdk()
    expect(buildEulerSDK).toHaveBeenCalledTimes(2)

    builds[1].resolve(sdkB)
    await expect(secondBuild).resolves.toBe(sdkB)

    builds[0].resolve(sdkA)
    await expect(firstBuild).resolves.toBe(sdkA)

    await expect(getEulerSdk()).resolves.toBe(sdkB)
    expect(buildEulerSDK).toHaveBeenCalledTimes(2)
  })

  it('passes runtime values through the SDK config object', async () => {
    const chainIds = ref([1, 8453])
    const sdk = createMockSdk('configured')
    const buildEulerSDK = vi.fn().mockResolvedValue(sdk)
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: {
        configEulerChainsUrl: 'https://example.test/EulerChains.json',
        configLabelsBaseUrl: 'https://labels.example.test/',
        configOracleChecksBaseUrl: 'https://oracles.example.test/data/',
      },
    }))

    const { getEulerSdk } = await importUseEulerSdk(chainIds, buildEulerSDK)
    await expect(getEulerSdk()).resolves.toBe(sdk)

    const options = buildEulerSDK.mock.calls[0]?.[0] as BuildEulerSDKOptions
    expect(options.config).toMatchObject({
      rpcUrls: {
        1: '/api/rpc/1',
        8453: '/api/rpc/8453',
      },
      deploymentsUrl: '/api/euler-chains',
      eulerLabelsBaseUrl: 'https://labels.example.test',
      oracleAdaptersBaseUrl: 'https://oracles.example.test/data',
    })
    expect(options.rpcUrls).toBeUndefined()
    expect(options.deploymentServiceConfig).toBeUndefined()
    expect(options.eulerLabelsAdapterConfig).toBeUndefined()
    expect(options.oracleAdapterServiceConfig).toBeUndefined()
  })

  it('delegates SDK-owned defaults to the SDK', async () => {
    const chainIds = ref([1])
    const sdk = createMockSdk('defaults')
    const buildEulerSDK = vi.fn().mockResolvedValue(sdk)
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: {
        configEulerChainsUrl: '',
        configLabelsBaseUrl: '',
        configOracleChecksBaseUrl: '',
      },
    }))

    const { getEulerSdk } = await importUseEulerSdk(chainIds, buildEulerSDK)
    await expect(getEulerSdk()).resolves.toBe(sdk)

    const options = buildEulerSDK.mock.calls[0]?.[0] as BuildEulerSDKOptions
    expect(options.config).toEqual({
      rpcUrls: {
        1: '/api/rpc/1',
      },
      deploymentsUrl: '/api/euler-chains',
    })
  })

  it('passes disabled reward providers through SDK config only when disabled', async () => {
    const chainIds = ref([1])
    const sdk = createMockSdk('rewards-disabled')
    const buildEulerSDK = vi.fn().mockResolvedValue(sdk)
    vi.stubGlobal('useRuntimeConfig', () => ({
      public: {
        configEulerChainsUrl: '',
        configLabelsBaseUrl: '',
        configOracleChecksBaseUrl: '',
      },
    }))

    const { getEulerSdk } = await importUseEulerSdk(chainIds, buildEulerSDK)
    vi.stubGlobal('useDeployConfig', () => ({
      enableMerkl: false,
      enableIncentra: true,
      enableFuul: false,
    }))

    await expect(getEulerSdk()).resolves.toBe(sdk)

    const options = buildEulerSDK.mock.calls[0]?.[0] as BuildEulerSDKOptions
    expect(options.config).toMatchObject({
      rewardsEnableMerkl: false,
      rewardsEnableFuul: false,
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
