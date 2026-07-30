import type { EulerLabelsData } from '@eulerxyz/euler-v2-sdk'
import { computed, ref } from 'vue'
import { encodeAbiParameters } from 'viem'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __setEulerLabelsDataForTest,
  getCurrentEulerLabelsData,
  getEulerLabelsVersion,
  getEulerLabelWrapPairs,
  useEulerLabels,
} from '~/composables/useEulerLabels'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, resolve, reject }
}

const mocks = vi.hoisted(() => ({
  evcBatchCall: vi.fn(),
  fetchEulerLabelsData: vi.fn(),
  getProvider: vi.fn(),
  invalidateSdkQueries: vi.fn(),
  vaults: [] as Array<{ asset: { address: string } }>,
}))

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdk: vi.fn(async () => ({
    eulerLabelsService: {
      fetchEulerLabelsData: mocks.fetchEulerLabelsData,
    },
    providerService: {
      getProvider: mocks.getProvider,
    },
  })),
}))

vi.mock('~/composables/useEulerOracleAdapters', () => ({
  useEulerOracleAdapters: () => ({
    oracleAdapters: {},
    loadOracleAdapter: vi.fn(),
    loadOracleAdapters: vi.fn(),
    loadAllOracleAdapters: vi.fn(),
  }),
}))

vi.mock('~/composables/useVaults', () => ({
  useVaults: () => ({ isReady: { value: true } }),
}))

vi.mock('~/composables/useVaultRegistry', () => ({
  useVaultRegistry: () => ({
    getEVaults: () => mocks.vaults,
    getEarnVaults: () => [],
    getSecuritizeVaults: () => [],
  }),
}))

vi.mock('~/utils/multicall', () => ({
  buildBatchItem: vi.fn((target: string, data: string) => ({ target, data })),
  evcBatchCall: mocks.evcBatchCall,
}))

vi.mock('~/utils/sdk-query-cache', () => ({
  invalidateSdkQueries: mocks.invalidateSdkQueries,
}))

const currentChainId = ref(1)
const getCurrentChainConfig = computed(() => ({
  chainId: currentChainId.value,
  addresses: {
    coreAddrs: {
      evc: '0x0000000000000000000000000000000000000001',
    },
  },
}))

const labelsFor = (marker: string) => ({
  products: {
    [marker]: { name: marker },
  },
}) as unknown as EulerLabelsData

const currentProductKeys = () => Object.keys(getCurrentEulerLabelsData().products)

describe('useEulerLabels chain-scoped loading', () => {
  beforeEach(() => {
    currentChainId.value = 1
    mocks.evcBatchCall.mockReset().mockResolvedValue([])
    mocks.fetchEulerLabelsData.mockReset()
    mocks.getProvider.mockReset().mockReturnValue({})
    mocks.invalidateSdkQueries.mockReset().mockResolvedValue(undefined)
    mocks.vaults.length = 0
    vi.stubGlobal('useEulerAddresses', () => ({
      getCurrentChainConfig,
      loadEulerConfig: vi.fn(),
    }))
    __setEulerLabelsDataForTest()
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('starts a separate fetch for a new chain and ignores the stale response', async () => {
    const chainOne = deferred<EulerLabelsData>()
    const chainTwo = deferred<EulerLabelsData>()
    mocks.fetchEulerLabelsData.mockImplementation((chainId: number) => {
      if (chainId === 1) return chainOne.promise
      if (chainId === 2) return chainTwo.promise
      throw new Error(`unexpected chain ${chainId}`)
    })

    const labels = useEulerLabels()
    const firstLoad = labels.loadLabels()
    await vi.waitFor(() => expect(mocks.fetchEulerLabelsData).toHaveBeenCalledWith(1))

    currentChainId.value = 2
    const secondLoad = labels.loadLabels()
    await vi.waitFor(() => expect(mocks.fetchEulerLabelsData).toHaveBeenCalledWith(2))

    expect(labels.isLoading.value).toBe(true)
    expect(labels.isReady.value).toBe(false)

    chainTwo.resolve(labelsFor('chain-two'))
    await secondLoad

    expect(currentProductKeys()).toEqual(['chain-two'])
    expect(labels.isLoading.value).toBe(false)
    expect(labels.isReady.value).toBe(true)

    chainOne.resolve(labelsFor('stale-chain-one'))
    await firstLoad

    expect(mocks.fetchEulerLabelsData).toHaveBeenCalledTimes(2)
    expect(currentProductKeys()).toEqual(['chain-two'])
    expect(labels.isLoading.value).toBe(false)
    expect(labels.isReady.value).toBe(true)
  })

  it('reuses only the chain fetch while the latest wrapper controls publication', async () => {
    const chainOne = deferred<EulerLabelsData>()
    const chainTwo = deferred<EulerLabelsData>()
    mocks.fetchEulerLabelsData.mockImplementation((chainId: number) => {
      if (chainId === 1) return chainOne.promise
      if (chainId === 2) return chainTwo.promise
      throw new Error(`unexpected chain ${chainId}`)
    })
    const initialVersion = getEulerLabelsVersion()

    const labels = useEulerLabels()
    const firstChainOneLoad = labels.loadLabels()
    await vi.waitFor(() => expect(mocks.fetchEulerLabelsData).toHaveBeenCalledWith(1))

    currentChainId.value = 2
    const chainTwoLoad = labels.loadLabels()
    await vi.waitFor(() => expect(mocks.fetchEulerLabelsData).toHaveBeenCalledWith(2))

    currentChainId.value = 1
    const latestChainOneLoad = labels.loadLabels()
    await vi.waitFor(() => expect(mocks.fetchEulerLabelsData).toHaveBeenCalledTimes(2))

    chainOne.resolve(labelsFor('latest-chain-one'))
    await Promise.all([firstChainOneLoad, latestChainOneLoad])

    expect(mocks.fetchEulerLabelsData.mock.calls.filter(([chainId]) => chainId === 1)).toHaveLength(1)
    expect(currentProductKeys()).toEqual(['latest-chain-one'])
    expect(getEulerLabelsVersion()).toBe(initialVersion + 4)
    expect(labels.isLoading.value).toBe(false)
    expect(labels.isReady.value).toBe(true)

    chainTwo.resolve(labelsFor('stale-chain-two'))
    await chainTwoLoad

    expect(currentProductKeys()).toEqual(['latest-chain-one'])
    expect(getEulerLabelsVersion()).toBe(initialVersion + 4)
  })

  it('keeps a force-refresh replacement available when the older fetch settles first', async () => {
    const original = deferred<EulerLabelsData>()
    const refreshed = deferred<EulerLabelsData>()
    mocks.fetchEulerLabelsData
      .mockReturnValueOnce(original.promise)
      .mockReturnValueOnce(refreshed.promise)

    const labels = useEulerLabels()
    const originalLoad = labels.loadLabels()
    await vi.waitFor(() => expect(mocks.fetchEulerLabelsData).toHaveBeenCalledTimes(1))

    const refreshLoad = labels.loadLabels(true)
    await vi.waitFor(() => {
      expect(mocks.invalidateSdkQueries).toHaveBeenCalledTimes(1)
      expect(mocks.fetchEulerLabelsData).toHaveBeenCalledTimes(2)
    })

    original.resolve(labelsFor('original'))
    await originalLoad

    const joinedRefreshLoad = labels.loadLabels()
    await Promise.resolve()
    expect(mocks.fetchEulerLabelsData).toHaveBeenCalledTimes(2)

    refreshed.resolve(labelsFor('refreshed'))
    await Promise.all([refreshLoad, joinedRefreshLoad])

    expect(currentProductKeys()).toEqual(['refreshed'])
    expect(labels.isLoading.value).toBe(false)
    expect(labels.isReady.value).toBe(true)
  })

  it('does not publish wrap pairs from a probe invalidated by a chain change', async () => {
    const wrapper = '0x0000000000000000000000000000000000000011'
    const underlying = '0x0000000000000000000000000000000000000022'
    const staleProbe = deferred<Array<{ success: boolean, result: string }>>()
    const chainTwo = deferred<EulerLabelsData>()
    mocks.vaults.push({ asset: { address: wrapper } })
    mocks.evcBatchCall.mockReturnValueOnce(staleProbe.promise)
    mocks.fetchEulerLabelsData.mockImplementation((chainId: number) => {
      if (chainId === 1) return Promise.resolve(labelsFor('chain-one'))
      if (chainId === 2) return chainTwo.promise
      throw new Error(`unexpected chain ${chainId}`)
    })

    const labels = useEulerLabels()
    await labels.loadLabels()
    await vi.waitFor(() => expect(mocks.evcBatchCall).toHaveBeenCalledTimes(1))

    currentChainId.value = 2
    mocks.vaults.length = 0
    const chainTwoLoad = labels.loadLabels()
    await vi.waitFor(() => expect(mocks.fetchEulerLabelsData).toHaveBeenCalledWith(2))

    staleProbe.resolve([{
      success: true,
      result: encodeAbiParameters([{ type: 'address' }], [underlying]),
    }])
    await staleProbe.promise
    await Promise.resolve()

    expect(getEulerLabelWrapPairs()).toEqual({})

    chainTwo.resolve(labelsFor('chain-two'))
    await chainTwoLoad
    expect(currentProductKeys()).toEqual(['chain-two'])
    expect(getEulerLabelWrapPairs()).toEqual({})
  })
})
