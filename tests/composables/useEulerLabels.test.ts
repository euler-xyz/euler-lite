import type { EulerLabelsData } from '@eulerxyz/euler-v2-sdk'
import { computed, ref } from 'vue'
import { encodeAbiParameters } from 'viem'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __setEulerLabelsDataForTest,
  getCurrentEulerLabelsData,
  getEulerLabelsVersion,
  getEulerGeoContext,
  getEulerLabelWrapPairs,
  useEulerLabels,
} from '~/composables/useEulerLabels'
import type { PublicLabelsBundle } from '~/utils/public-labels'
import { getVaultDeprecation, isVaultSelectedByTag } from '~/utils/eulerLabelsUtils'
import { useGeoBlock } from '~/composables/useGeoBlock'
import { applyChainReadPolicy, useChainConfig } from '~/composables/useChainConfig'

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
  fetchChainPolicy: vi.fn(),
  normalizePublicLabelsData: vi.fn(),
  getProvider: vi.fn(),
  loadVaults: vi.fn(),
  vaults: [] as Array<{ asset: { address: string } }>,
}))

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdk: vi.fn(async () => ({
    providerService: {
      getProvider: mocks.getProvider,
    },
  })),
}))

vi.mock('~/utils/public-labels', async importOriginal => ({
  ...await importOriginal<typeof import('~/utils/public-labels')>(),
  normalizeLabelsBundle: (_chainId: number, bundle: { publicLabels: unknown }) => mocks.normalizePublicLabelsData(_chainId, bundle.publicLabels, bundle),
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
  useVaults: () => ({ isReady: { value: true }, loadVaults: mocks.loadVaults }),
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
  sourceFetchedAt: Date.now(),
  chainPolicy: { deprecated: false, onchain: false, metadataOnly: false },
  effectivePolicy: { products: {}, earnVaults: [], assets: [] },
}) as unknown as PublicLabelsBundle

const currentProductKeys = () => Object.keys(getCurrentEulerLabelsData().products)

describe('useEulerLabels chain-scoped loading', () => {
  beforeEach(() => {
    currentChainId.value = 1
    const config = useChainConfig()
    config.enabledChainIds.splice(0, config.enabledChainIds.length, 1, 2)
    config.deprecatedChainIds.splice(0)
    config.onchainSdkChainIds.splice(0)
    config.metadataOnlyChainIds = []
    config.policyRevision = 0
    mocks.evcBatchCall.mockReset().mockResolvedValue([])
    mocks.fetchPublicLabelsBundle.mockReset()
    mocks.fetchChainPolicy.mockReset().mockImplementation(async (_url, options) => ({
      chainId: options.query.chainId,
      policy: { deprecated: false, onchain: false, metadataOnly: false },
    }))
    mocks.normalizePublicLabelsData.mockReset().mockImplementation(
      (_chainId: number, labels: EulerLabelsData) => labels,
    )
    mocks.loadVaults.mockReset().mockResolvedValue(undefined)
    vi.stubGlobal('useVaults', () => ({ loadVaults: mocks.loadVaults }))
    mocks.getProvider.mockReset().mockReturnValue({})
    mocks.vaults.length = 0
    vi.stubGlobal('$fetch', (url: string, options: unknown) => url === '/api/internal/chain-policy'
      ? mocks.fetchChainPolicy(url, options)
      : mocks.fetchPublicLabelsBundle(url, options))
    vi.stubGlobal('useEulerAddresses', () => ({
      getCurrentChainConfig,
      loadEulerConfig: vi.fn(),
    }))
    __setEulerLabelsDataForTest()
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('refreshes retirement/reactivation routing while lifecycle and vault membership stay unchanged', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const active = { deprecated: false, onchain: false, metadataOnly: false }
      const retired = { deprecated: false, onchain: true, metadataOnly: true }
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce({ ...bundleFor(labelsFor('same')), chainPolicy: active })
      const labels = useEulerLabels()
      await labels.loadLabels()
      vi.setSystemTime(1_300_001)
      mocks.fetchChainPolicy.mockResolvedValue({ chainId: 1, policy: retired })
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce({ ...bundleFor(labelsFor('same')), source: 'v3-metadata', chainPolicy: retired })
      await labels.refreshLabelsIfStale()
      expect(useChainConfig().deprecatedChainIds).toEqual([])
      expect(useChainConfig().onchainSdkChainIds).toEqual([1])
      expect(useChainConfig().metadataOnlyChainIds).toEqual([1])
      expect(useChainConfig().policyRevision).toBe(1)
      expect(mocks.loadVaults).toHaveBeenCalledExactlyOnceWith({ preserveRegistry: true })

      vi.setSystemTime(1_600_002)
      mocks.fetchChainPolicy.mockResolvedValue({ chainId: 1, policy: active })
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce({ ...bundleFor(labelsFor('same')), chainPolicy: active })
      await labels.refreshLabelsIfStale()
      expect(useChainConfig().onchainSdkChainIds).toEqual([])
      expect(useChainConfig().policyRevision).toBe(2)
      expect(mocks.loadVaults).toHaveBeenCalledTimes(2)
    }
    finally { vi.useRealTimers() }
  })

  it('ignores policy from an older labels request that finishes after a forced refresh', async () => {
    const older = deferred<PublicLabelsBundle>()
    const latest = deferred<PublicLabelsBundle>()
    mocks.fetchPublicLabelsBundle.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise)
    const labels = useEulerLabels()
    const first = labels.loadLabels()
    await vi.waitFor(() => expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledOnce())
    mocks.fetchChainPolicy.mockResolvedValue({ chainId: 1, policy: { deprecated: true, onchain: true, metadataOnly: true } })
    const second = labels.loadLabels(true)
    await vi.waitFor(() => expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledTimes(2))
    latest.resolve({ ...bundleFor(labelsFor('new')), source: 'v3-metadata', chainPolicy: { deprecated: true, onchain: true, metadataOnly: true } } as PublicLabelsBundle)
    await second
    older.resolve({ ...bundleFor(labelsFor('old')), chainPolicy: { deprecated: false, onchain: false, metadataOnly: false } })
    await first
    expect(currentProductKeys()).toEqual(['new'])
    expect(useChainConfig().onchainSdkChainIds).toEqual([1])
    expect(useChainConfig().policyRevision).toBe(1)
  })

  it('rejects HTTP-cached labels without undoing the current policy', async () => {
    const deprecated = { deprecated: true, onchain: true, metadataOnly: true }
    applyChainReadPolicy(1, deprecated)
    mocks.fetchChainPolicy.mockResolvedValue({ chainId: 1, policy: deprecated })
    mocks.fetchPublicLabelsBundle.mockResolvedValue(bundleFor(labelsFor('active-cache')))
    const labels = useEulerLabels()
    await labels.loadLabels()
    expect(useChainConfig().onchainSdkChainIds).toEqual([1])
    expect(labels.isReady.value).toBe(false)
    expect(currentProductKeys()).toEqual([])
    expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledTimes(2)
    expect(mocks.fetchPublicLabelsBundle).toHaveBeenLastCalledWith('/api/internal/public-labels', expect.objectContaining({ cache: 'no-store' }))
  })

  it('retries a policy-mismatched HTTP cache entry with a current labels bundle', async () => {
    const deprecated = { deprecated: true, onchain: true, metadataOnly: true }
    applyChainReadPolicy(1, deprecated)
    mocks.fetchChainPolicy.mockResolvedValue({ chainId: 1, policy: deprecated })
    mocks.fetchPublicLabelsBundle
      .mockResolvedValueOnce(bundleFor(labelsFor('active-cache')))
      .mockResolvedValueOnce({ ...bundleFor(labelsFor('metadata')), source: 'v3-metadata', chainPolicy: deprecated })
    await useEulerLabels().loadLabels()
    expect(currentProductKeys()).toEqual(['metadata'])
    expect(useEulerLabels().isReady.value).toBe(true)
  })

  it('updates policy during a labels outage, revokes stale verification and reloads after recovery', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      const labels = useEulerLabels()
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce(bundleFor(labelsFor('same')))
      await labels.loadLabels()
      // Policy is refreshed even while the previous labels are still fresh.
      clock.mockReturnValue(1_060_000)
      const onchain = { deprecated: false, onchain: true, metadataOnly: false }
      mocks.fetchChainPolicy.mockResolvedValue({ chainId: 1, policy: onchain })
      mocks.fetchPublicLabelsBundle.mockRejectedValueOnce(new Error('labels unavailable'))
      await labels.refreshLabelsIfStale()
      expect(useChainConfig().onchainSdkChainIds).toEqual([1])
      expect(labels.isReady.value).toBe(false)
      expect(mocks.loadVaults).not.toHaveBeenCalled()
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce({ ...bundleFor(labelsFor('same')), chainPolicy: onchain })
      await labels.refreshLabelsIfStale()
      expect(labels.isReady.value).toBe(true)
      expect(mocks.loadVaults).toHaveBeenCalledExactlyOnceWith({ preserveRegistry: true })
    }
    finally { clock.mockRestore() }
  })

  it('does not restore verification from a request that crosses a policy transition', async () => {
    const request = deferred<PublicLabelsBundle>()
    mocks.fetchPublicLabelsBundle.mockReturnValue(request.promise)
    const labels = useEulerLabels()
    const pending = labels.loadLabels()
    await vi.waitFor(() => expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledOnce())
    applyChainReadPolicy(1, { deprecated: true, onchain: true, metadataOnly: true })
    request.resolve(bundleFor(labelsFor('obsolete')))
    await pending
    expect(labels.isReady.value).toBe(false)
    expect(currentProductKeys()).toEqual([])
  })

  it('reloads unchanged membership after deprecation and reactivation during an outage', async () => {
    const labels = useEulerLabels()
    mocks.fetchPublicLabelsBundle.mockImplementation(async () => bundleFor(labelsFor('same')))
    await labels.loadLabels()
    applyChainReadPolicy(1, { deprecated: true, onchain: true, metadataOnly: true })
    expect(labels.isReady.value).toBe(false)
    applyChainReadPolicy(1, { deprecated: false, onchain: false, metadataOnly: false })
    expect(labels.isReady.value).toBe(false)
    await labels.refreshLabelsIfStale()
    expect(labels.isReady.value).toBe(true)
    expect(mocks.loadVaults).toHaveBeenCalledExactlyOnceWith({ preserveRegistry: true })
  })

  it('clears another chain\'s labels while its independent policy read is pending', async () => {
    const labels = useEulerLabels()
    mocks.fetchPublicLabelsBundle.mockResolvedValue(bundleFor(labelsFor('chain-one')))
    await labels.loadLabels()
    const policy = deferred<{ chainId: number, policy: { deprecated: boolean, onchain: boolean, metadataOnly: boolean } }>()
    mocks.fetchChainPolicy.mockReturnValueOnce(policy.promise)
    currentChainId.value = 2
    const pending = labels.loadLabels()
    await vi.waitFor(() => expect(mocks.fetchChainPolicy).toHaveBeenCalledTimes(2))
    expect(labels.isReady.value).toBe(false)
    expect(currentProductKeys()).toEqual([])
    policy.resolve({ chainId: 2, policy: { deprecated: false, onchain: false, metadataOnly: false } })
    await pending
  })

  it('resolves EVK and Earn deprecation with their bundle reasons', () => {
    const evk = '0x0000000000000000000000000000000000000001'
    const earn = '0x0000000000000000000000000000000000000002'
    const productReasonVault = '0x0000000000000000000000000000000000000003'
    __setEulerLabelsDataForTest({
      products: {
        activeProduct: {
          vaults: [evk],
          deprecatedVaults: [],
          deprecationReason: 'Another product reason.',
        },
        product: {
          vaults: [evk, productReasonVault],
          deprecatedVaults: [evk, productReasonVault],
          deprecationReason: 'The EVK is deprecated.',
          vaultOverrides: { [evk]: { deprecationReason: 'This EVK was deprecated for a specific reason.' } },
        },
      } as unknown as EulerLabelsData['products'],
      deprecatedEarnVaults: { [earn.toLowerCase()]: 'The Earn vault is deprecated.' },
    })
    expect(getVaultDeprecation(evk)).toEqual({ deprecated: true, reason: 'This EVK was deprecated for a specific reason.' })
    expect(getVaultDeprecation(productReasonVault)).toEqual({ deprecated: true, reason: 'The EVK is deprecated.' })
    expect(getVaultDeprecation(earn)).toEqual({ deprecated: true, reason: 'The Earn vault is deprecated.' })
    expect(getVaultDeprecation('0x0000000000000000000000000000000000000004')).toEqual({ deprecated: false, reason: '' })
  })

  it('updates tag selection on a live labels refresh without reloading unchanged vault data', async () => {
    vi.useFakeTimers()
    try {
      const address = '0x0000000000000000000000000000000000000001'
      const base = { ...getCurrentEulerLabelsData(), vaultTagAddresses: new Set([address]) }
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce(bundleFor(base))
      const labels = useEulerLabels()
      await labels.loadLabels()
      const selected = computed(() => isVaultSelectedByTag(address))
      expect(selected.value).toBe(true)
      const refreshed = { ...base, vaultTagAddresses: new Set<string>() }
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce(bundleFor(refreshed))
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await labels.refreshLabelsIfStale()
      expect(selected.value).toBe(false)
      expect(mocks.loadVaults).not.toHaveBeenCalled()
    }
    finally { vi.useRealTimers() }
  })

  it('loads newly eligible vaults after a live refresh but leaves unchanged data alone', async () => {
    vi.useFakeTimers()
    try {
      const address = '0x0000000000000000000000000000000000000001'
      const base = { ...getCurrentEulerLabelsData(), products: {}, verifiedVaultAddresses: [] }
      const added = { ...base, verifiedVaultAddresses: [address] }
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce(bundleFor(base))
      const labels = useEulerLabels()
      await labels.loadLabels()
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce(bundleFor(added))
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await labels.refreshLabelsIfStale()
      expect(mocks.loadVaults).toHaveBeenCalledTimes(1)
      expect(mocks.loadVaults).toHaveBeenCalledWith({ preserveRegistry: true })
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce(bundleFor(structuredClone(added)))
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await labels.refreshLabelsIfStale()
      expect(mocks.loadVaults).toHaveBeenCalledTimes(1)
      expect(mocks.loadVaults).toHaveBeenCalledWith({ preserveRegistry: true })
    }
    finally { vi.useRealTimers() }
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
  it('distinguishes an operator configuration error without displaying server details', async () => {
    mocks.fetchPublicLabelsBundle.mockRejectedValueOnce({ data: { data: {
      code: 'LABELS_CONFIGURATION_ERROR', message: 'STATIC_LABELS_BASE_URL is required',
    } } })
    const labels = useEulerLabels()
    await labels.loadLabels()
    expect(labels.isReady.value).toBe(false)
    expect(labels.loadError.value).toContain('Contact the app operator')
    expect(labels.loadError.value).not.toContain('STATIC_LABELS_BASE_URL')
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

  it('retains fresh labels but expires geo after a later refresh fails', async () => {
    vi.useFakeTimers()
    try {
      const t0 = 1_000_000
      vi.setSystemTime(t0)
      mocks.normalizePublicLabelsData.mockImplementation((_chainId, labels, bundle) => ({
        ...labels,
        source: 'v3',
        sourceFetchedAt: bundle.sourceFetchedAt,
        geoFetchedAt: bundle.geoFetchedAt,
        geoContext: { chainId: 1, policies: [], productByVault: {} },
      }))
      const labels = useEulerLabels()
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce({ ...bundleFor(labelsFor('initial')), geoFetchedAt: t0 })
      await labels.loadLabels()
      expect(useGeoBlock().isPolicyAvailable.value).toBe(true)

      await vi.advanceTimersByTimeAsync(23 * 60 * 60_000)
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce({ ...bundleFor(labelsFor('refreshed')), geoFetchedAt: t0 })
      await labels.loadLabels(true)
      expect(currentProductKeys()).toEqual(['refreshed'])
      expect(getEulerGeoContext()?.policies).toEqual([])

      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
      mocks.fetchPublicLabelsBundle.mockRejectedValueOnce(new Error('geo unavailable'))
      await labels.loadLabels(true)
      expect(labels.isReady.value).toBe(true)
      expect(currentProductKeys()).toEqual(['refreshed'])
      expect(getEulerGeoContext()?.policies).toBeUndefined()
      expect(useGeoBlock().isPolicyAvailable.value).toBe(false)
    }
    finally {
      __setEulerLabelsDataForTest()
      vi.useRealTimers()
    }
  })

  it('keeps checks unavailable during a retry after a failed refresh', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce(bundleFor(labelsFor('cached')))
      const labels = useEulerLabels()
      await labels.loadLabels()

      clock.mockReturnValue(1_000_000 + 5 * 60_000)
      mocks.fetchPublicLabelsBundle.mockRejectedValueOnce(new Error('temporary outage'))
      await labels.loadLabels(true)
      expect(labels.isReady.value).toBe(true)
      expect(labels.loadError.value).toContain('Unable to load vault verification')

      const refreshed = deferred<PublicLabelsBundle>()
      mocks.fetchPublicLabelsBundle.mockReturnValueOnce(refreshed.promise)
      const pending = labels.loadLabels(true)
      await vi.waitFor(() => expect(labels.isLoading.value).toBe(true))
      expect(labels.isLoading.value).toBe(true)
      expect(labels.loadError.value).toContain('Unable to load vault verification')

      refreshed.resolve(bundleFor(labelsFor('recovered')))
      await pending
      expect(labels.isReady.value).toBe(true)
      expect(labels.loadError.value).toBeUndefined()
    }
    finally { clock.mockRestore() }
  })

  it('expires a server-cached verdict a day after the actual V3 read', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      const original = bundleFor(labelsFor('cached'))
      mocks.fetchPublicLabelsBundle.mockResolvedValue(original)
      const labels = useEulerLabels()
      await labels.loadLabels()

      clock.mockReturnValue(1_000_000 + 5 * 60_000)
      await labels.refreshLabelsIfStale()
      expect(labels.isReady.value).toBe(true)
      expect(currentProductKeys()).toEqual(['cached'])

      clock.mockReturnValue(1_000_000 + 24 * 60 * 60_000)
      await labels.refreshLabelsIfStale()
      expect(labels.isReady.value).toBe(false)
      expect(labels.loadError.value).toContain('Unable to load vault verification')
      expect(currentProductKeys()).toEqual(['cached'])
    }
    finally { clock.mockRestore() }
  })

  it('expires verification at the deadline even before the next refresh poll', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce(bundleFor(labelsFor('cached')))
      const labels = useEulerLabels()
      await labels.loadLabels()
      vi.advanceTimersByTime(24 * 60 * 60_000 - 1)
      expect(labels.isReady.value).toBe(true)
      vi.advanceTimersByTime(1)
      expect(labels.isReady.value).toBe(false)
      expect(labels.loadError.value).toContain('Unable to load vault verification')
    }
    finally { vi.useRealTimers() }
  })

  it('hides stale verification during an in-flight refresh and restores it on recovery', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce(bundleFor(labelsFor('cached')))
      const labels = useEulerLabels()
      await labels.loadLabels()

      vi.advanceTimersByTime(24 * 60 * 60_000 - 1_000)
      const refreshed = deferred<PublicLabelsBundle>()
      mocks.fetchPublicLabelsBundle.mockReturnValueOnce(refreshed.promise)
      const pending = labels.loadLabels(true)
      await vi.waitFor(() => expect(labels.isLoading.value).toBe(true))
      expect(labels.isLoading.value).toBe(true)

      vi.advanceTimersByTime(1_000)
      expect(labels.isReady.value).toBe(false)
      expect(labels.loadError.value).toContain('Unable to load vault verification')
      expect(currentProductKeys()).toEqual(['cached'])

      refreshed.resolve(bundleFor(labelsFor('recovered')))
      await pending
      expect(labels.isReady.value).toBe(true)
      expect(labels.loadError.value).toBeUndefined()
      expect(currentProductKeys()).toEqual(['recovered'])
    }
    finally { vi.useRealTimers() }
  })

  it('keeps expired verification unavailable when a new refresh starts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce(bundleFor(labelsFor('cached')))
      const labels = useEulerLabels()
      await labels.loadLabels()

      vi.advanceTimersByTime(24 * 60 * 60_000)
      const refreshed = deferred<PublicLabelsBundle>()
      mocks.fetchPublicLabelsBundle.mockReturnValueOnce(refreshed.promise)
      const pending = labels.loadLabels(true)
      await vi.waitFor(() => expect(labels.isLoading.value).toBe(true))

      expect(labels.isLoading.value).toBe(true)
      expect(labels.isReady.value).toBe(false)
      expect(labels.loadError.value).toContain('Unable to load vault verification')
      expect(currentProductKeys()).toEqual(['cached'])

      refreshed.resolve(bundleFor(labelsFor('recovered')))
      await pending
      expect(labels.isReady.value).toBe(true)
      expect(labels.loadError.value).toBeUndefined()
    }
    finally { vi.useRealTimers() }
  })

  it('marks expired verification unavailable when a suspended tab resumes before its timer runs', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      mocks.fetchPublicLabelsBundle.mockResolvedValueOnce(bundleFor(labelsFor('cached')))
      const labels = useEulerLabels()
      await labels.loadLabels()

      vi.setSystemTime(1_000_000 + 24 * 60 * 60_000)
      const refreshed = deferred<PublicLabelsBundle>()
      mocks.fetchPublicLabelsBundle.mockReturnValueOnce(refreshed.promise)
      const pending = labels.refreshLabelsIfStale()
      await vi.waitFor(() => expect(labels.isLoading.value).toBe(true))

      expect(labels.isLoading.value).toBe(true)
      expect(labels.isReady.value).toBe(false)
      expect(labels.loadError.value).toContain('Unable to load vault verification')
      expect(currentProductKeys()).toEqual(['cached'])

      refreshed.resolve(bundleFor(labelsFor('recovered')))
      await pending
      expect(labels.isReady.value).toBe(true)
      expect(labels.loadError.value).toBeUndefined()
    }
    finally { vi.useRealTimers() }
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
      expect(mocks.fetchPublicLabelsBundle).toHaveBeenLastCalledWith('/api/internal/public-labels', expect.not.objectContaining({ headers: expect.anything() }))
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
      clock.mockReturnValue(1_000_000 + 86_400_000)
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

  it('joins a forced refresh even while the displayed snapshot is fresh', async () => {
    const labels = useEulerLabels()
    mocks.fetchPublicLabelsBundle.mockResolvedValueOnce(bundleFor(labelsFor('initial')))
    await labels.loadLabels()
    const request = deferred<PublicLabelsBundle>()
    mocks.fetchPublicLabelsBundle.mockReturnValue(request.promise)
    const forced = labels.loadLabels(true)
    await vi.waitFor(() => expect(mocks.fetchPublicLabelsBundle).toHaveBeenCalledTimes(2))
    const joined = labels.loadLabels()
    await Promise.resolve()
    request.resolve(bundleFor(labelsFor('refreshed')))
    await Promise.all([forced, joined])
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
