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
import type { PublicLabelsBundle } from '~/utils/public-labels'

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
  fetchPublicLabelsBundle: vi.fn(),
  normalizePublicLabelsData: vi.fn(),
  getProvider: vi.fn(),
  vaults: [] as Array<{ asset: { address: string } }>,
}))

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdk: vi.fn(async () => ({
    providerService: {
      getProvider: mocks.getProvider,
    },
  })),
}))

vi.mock('~/utils/public-labels', () => ({
  normalizeLabelsBundle: (_chainId: number, bundle: { publicLabels: unknown }) => mocks.normalizePublicLabelsData(_chainId, bundle.publicLabels),
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

const bundleFor = (labels: EulerLabelsData): PublicLabelsBundle => ({
  version: 'v20260804151305236',
  publicLabels: labels,
  effectivePolicy: { products: {}, earnVaults: [], assets: [] },
}) as unknown as PublicLabelsBundle

const currentProductKeys = () => Object.keys(getCurrentEulerLabelsData().products)

describe('useEulerLabels chain-scoped loading', () => {
  beforeEach(() => {
    currentChainId.value = 1
    mocks.evcBatchCall.mockReset().mockResolvedValue([])
    mocks.fetchPublicLabelsBundle.mockReset()
    mocks.normalizePublicLabelsData.mockReset().mockImplementation(
      (_chainId: number, labels: EulerLabelsData) => labels,
    )
    mocks.getProvider.mockReset().mockReturnValue({})
    mocks.vaults.length = 0
    vi.stubGlobal('$fetch', mocks.fetchPublicLabelsBundle)
    vi.stubGlobal('useEulerAddresses', () => ({
      getCurrentChainConfig,
      loadEulerConfig: vi.fn(),
    }))
    __setEulerLabelsDataForTest()
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('keeps a failed initial load unavailable and retries the same chain', async () => {
    mocks.fetchPublicLabelsBundle.mockRejectedValueOnce(new Error('temporary outage'))
    const labels = useEulerLabels()
    await labels.loadLabels()
    expect(labels.isReady.value).toBe(false)
    expect(labels.loadError.value).toContain('Unable to load')
    mocks.fetchPublicLabelsBundle.mockResolvedValueOnce(bundleFor(labelsFor('recovered')))
    await labels.loadLabels()
    expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledTimes(2)
    expect(labels.isReady.value).toBe(true)
    expect(labels.loadError.value).toBeUndefined()
    expect(currentProductKeys()).toEqual(['recovered'])
  })

  it('retains a successful same-chain snapshot when a refresh fails', async () => {
    mocks.fetchPublicLabelsBundle.mockResolvedValueOnce(bundleFor(labelsFor('cached')))
    const labels = useEulerLabels()
    await labels.loadLabels()
    mocks.fetchPublicLabelsBundle.mockRejectedValueOnce(new Error('temporary outage'))
    await labels.loadLabels(true)
    expect(labels.isReady.value).toBe(true)
    expect(currentProductKeys()).toEqual(['cached'])
  })

  it('refreshes an aged successful snapshot and joins overlapping poll events', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce(bundleFor(labelsFor('visible')))
      const labels = useEulerLabels()
      await labels.loadLabels()
      clock.mockReturnValue(1_000_000 + 299_999)
      await labels.refreshLabelsIfStale()
      expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledTimes(1)

      const refreshed = deferred<PublicLabelsBundle>()
      mocks.fetchPublicLabelsBundle.mockReturnValueOnce(refreshed.promise)
      clock.mockReturnValue(1_000_000 + 300_000)
      const pending = labels.refreshLabelsIfStale()
      await vi.waitFor(() => expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledTimes(2))
      expect(labels.isReady.value).toBe(true)
      await labels.refreshLabelsIfStale()
      expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledTimes(2)
      expect(mocks.fetchPublicLabelsBundle).toHaveBeenLastCalledWith('/api/internal/public-labels', expect.objectContaining({ headers: { 'cache-control': 'no-cache' } }))
      refreshed.resolve(bundleFor(labelsFor('revoked')))
      await pending
      expect(currentProductKeys()).toEqual(['revoked'])
    }
    finally { clock.mockRestore() }
  })

  it('expires verification after refresh failures while retaining display data', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce(bundleFor(labelsFor('cached')))
      const labels = useEulerLabels()
      await labels.loadLabels()
      mocks.fetchPublicLabelsBundle.mockRejectedValue(new Error('outage'))
      clock.mockReturnValue(1_000_000 + 300_000)
      await labels.refreshLabelsIfStale()
      expect(labels.isReady.value).toBe(true)
      clock.mockReturnValue(1_000_000 + 900_000)
      await labels.refreshLabelsIfStale()
      expect(labels.isReady.value).toBe(false)
      expect(labels.loadError.value).toContain('Unable to load')
      expect(currentProductKeys()).toEqual(['cached'])
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce(bundleFor(labelsFor('recovered')))
      await labels.refreshLabelsIfStale()
      expect(labels.isReady.value).toBe(true)
      expect(currentProductKeys()).toEqual(['recovered'])
    }
    finally { clock.mockRestore() }
  })

  it('starts a separate fetch for a new chain and ignores the stale response', async () => {
    const chainOne = deferred<PublicLabelsBundle>()
    const chainTwo = deferred<PublicLabelsBundle>()
    mocks.fetchPublicLabelsBundle.mockImplementation((_url: string, options: { query: { chainId: number } }) => {
      const chainId = options.query.chainId
      if (chainId === 1) return chainOne.promise
      if (chainId === 2) return chainTwo.promise
      throw new Error(`unexpected chain ${chainId}`)
    })

    const labels = useEulerLabels()
    const firstLoad = labels.loadLabels()
    await vi.waitFor(() => expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledTimes(1))

    currentChainId.value = 2
    const secondLoad = labels.loadLabels()
    await vi.waitFor(() => expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledTimes(2))

    expect(labels.isLoading.value).toBe(true)
    expect(labels.isReady.value).toBe(false)

    chainTwo.resolve(bundleFor(labelsFor('chain-two')))
    await secondLoad

    expect(currentProductKeys()).toEqual(['chain-two'])
    expect(labels.isLoading.value).toBe(false)
    expect(labels.isReady.value).toBe(true)

    chainOne.resolve(bundleFor(labelsFor('stale-chain-one')))
    await firstLoad

    expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledTimes(2)
    expect(currentProductKeys()).toEqual(['chain-two'])
    expect(labels.isLoading.value).toBe(false)
    expect(labels.isReady.value).toBe(true)
  })

  it('reuses only the chain fetch while the latest wrapper controls publication', async () => {
    const chainOne = deferred<PublicLabelsBundle>()
    const chainTwo = deferred<PublicLabelsBundle>()
    mocks.fetchPublicLabelsBundle.mockImplementation((_url: string, options: { query: { chainId: number } }) => {
      const chainId = options.query.chainId
      if (chainId === 1) return chainOne.promise
      if (chainId === 2) return chainTwo.promise
      throw new Error(`unexpected chain ${chainId}`)
    })
    const initialVersion = getEulerLabelsVersion()

    const labels = useEulerLabels()
    const firstChainOneLoad = labels.loadLabels()
    await vi.waitFor(() => expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledTimes(1))

    currentChainId.value = 2
    const chainTwoLoad = labels.loadLabels()
    await vi.waitFor(() => expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledTimes(2))

    currentChainId.value = 1
    const latestChainOneLoad = labels.loadLabels()
    await vi.waitFor(() => expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledTimes(2))

    chainOne.resolve(bundleFor(labelsFor('latest-chain-one')))
    await Promise.all([firstChainOneLoad, latestChainOneLoad])

    expect(mocks.fetchPublicLabelsBundle.mock.calls.filter(([, options]) => options.query.chainId === 1)).toHaveLength(1)
    expect(currentProductKeys()).toEqual(['latest-chain-one'])
    expect(getEulerLabelsVersion()).toBe(initialVersion + 4)
    expect(labels.isLoading.value).toBe(false)
    expect(labels.isReady.value).toBe(true)

    chainTwo.resolve(bundleFor(labelsFor('stale-chain-two')))
    await chainTwoLoad

    expect(currentProductKeys()).toEqual(['latest-chain-one'])
    expect(getEulerLabelsVersion()).toBe(initialVersion + 4)
  })

  it('keeps a force-refresh replacement available when the older fetch settles first', async () => {
    const original = deferred<PublicLabelsBundle>()
    const refreshed = deferred<PublicLabelsBundle>()
    mocks.fetchPublicLabelsBundle
      .mockReturnValueOnce(original.promise)
      .mockReturnValueOnce(refreshed.promise)

    const labels = useEulerLabels()
    const originalLoad = labels.loadLabels()
    await vi.waitFor(() => expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledTimes(1))

    const refreshLoad = labels.loadLabels(true)
    await vi.waitFor(() => {
      expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledTimes(2)
    })

    original.resolve(bundleFor(labelsFor('original')))
    await originalLoad

    const joinedRefreshLoad = labels.loadLabels()
    await Promise.resolve()
    expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledTimes(2)

    refreshed.resolve(bundleFor(labelsFor('refreshed')))
    await Promise.all([refreshLoad, joinedRefreshLoad])

    expect(currentProductKeys()).toEqual(['refreshed'])
    expect(labels.isLoading.value).toBe(false)
    expect(labels.isReady.value).toBe(true)
  })

  it('does not publish a second labels source when the aggregate endpoint fails', async () => {
    mocks.fetchPublicLabelsBundle.mockRejectedValue(new Error('V3 unavailable'))

    const labels = useEulerLabels()
    await labels.loadLabels()

    expect(currentProductKeys()).toEqual([])
    expect(labels.geoPolicies.value).toEqual([])
    expect(labels.isReady.value).toBe(false)
    expect(labels.loadError.value).toContain('Unable to load')
  })

  it('does not publish wrap pairs from a probe invalidated by a chain change', async () => {
    const wrapper = '0x0000000000000000000000000000000000000011'
    const underlying = '0x0000000000000000000000000000000000000022'
    const staleProbe = deferred<Array<{ success: boolean, result: string }>>()
    const chainTwo = deferred<PublicLabelsBundle>()
    mocks.vaults.push({ asset: { address: wrapper } })
    mocks.evcBatchCall.mockReturnValueOnce(staleProbe.promise)
    mocks.fetchPublicLabelsBundle.mockImplementation((_url: string, options: { query: { chainId: number } }) => {
      const chainId = options.query.chainId
      if (chainId === 1) return Promise.resolve(bundleFor(labelsFor('chain-one')))
      if (chainId === 2) return chainTwo.promise
      throw new Error(`unexpected chain ${chainId}`)
    })

    const labels = useEulerLabels()
    await labels.loadLabels()
    await vi.waitFor(() => expect(mocks.evcBatchCall).toHaveBeenCalledTimes(1))

    currentChainId.value = 2
    mocks.vaults.length = 0
    const chainTwoLoad = labels.loadLabels()
    await vi.waitFor(() => expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledTimes(2))

    staleProbe.resolve([{
      success: true,
      result: encodeAbiParameters([{ type: 'address' }], [underlying]),
    }])
    await staleProbe.promise
    await Promise.resolve()

    expect(getEulerLabelWrapPairs()).toEqual({})

    chainTwo.resolve(bundleFor(labelsFor('chain-two')))
    await chainTwoLoad
    expect(currentProductKeys()).toEqual(['chain-two'])
    expect(getEulerLabelWrapPairs()).toEqual({})
  })
})
