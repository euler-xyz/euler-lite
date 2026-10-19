import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import type { EulerLabelsFileData } from '@eulerxyz/euler-v2-sdk/public-labels'
import { __setEulerLabelsDataForTest, getEulerGeoContext, useEulerLabels } from '~/composables/useEulerLabels'
import * as geo from '~/composables/useGeoBlock'
import { cozy, staticGeoBundle } from '~/tests/fixtures/static-geo-labels'

// Keep the actual static-file normalizer and labels loading lifecycle. The position
// comes from the SDK while discovery remains empty, as it can with DISABLE_V3.
vi.mock('~/composables/useVaultRegistry', () => ({ useVaultRegistry: () => ({
  getVault: () => undefined, getEVaults: () => [], getEarnVaults: () => [], getSecuritizeVaults: () => [],
}) }))
vi.mock('~/composables/useVaults', () => ({ useVaults: () => ({ isReady: ref(true), loadVaults: vi.fn() }) }))
vi.mock('~/composables/useEulerSdk', () => ({ getEulerSdk: async () => ({ providerService: { getProvider: () => ({}) } }) }))
vi.mock('~/composables/useEulerOracleAdapters', () => ({ useEulerOracleAdapters: () => ({}) }))
vi.mock('~/composables/useEulerVaultAssessments', () => ({ useEulerVaultAssessments: () => ({}) }))

const chainId = ref(1)
const fetchLabels = vi.fn()
const product = { name: 'Cozy', description: '', url: 'https://fork.test', vaults: [cozy.address], deprecatedVaults: [] }
const staticRules: [string, Partial<EulerLabelsFileData>][] = [
  ['product', { products: { cozy: { ...product, block: ['EEA'] } } }],
  ['vault override', { products: { cozy: { ...product, vaultOverrides: { [cozy.address]: { block: ['EEA'] } } } } }],
  ['earn', { earnVaults: [{ address: cozy.address, block: ['EEA'] }] }],
  ['asset', { assets: [{ address: cozy.asset.address, block: ['EEA'] }] }],
  ['symbol', { assets: [{ symbols: ['USDC'], block: ['EEA'] }] }],
  ['name pattern', { assets: [{ nameRegex: '^USD Coin$', block: ['EEA'] }] }],
]

beforeEach(() => {
  vi.useFakeTimers()
  chainId.value = 1
  __setEulerLabelsDataForTest()
  geo.useGeoBlock().country.value = 'NL'
  fetchLabels.mockReset().mockResolvedValue(staticGeoBundle())
  vi.stubGlobal('$fetch', fetchLabels)
  vi.stubGlobal('useEulerAddresses', () => ({
    chainId, getCurrentChainConfig: computed(() => ({ chainId: chainId.value, addresses: { coreAddrs: { evc: cozy.address } } })),
  }))
})
afterEach(() => {
  __setEulerLabelsDataForTest()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('static/no-V3 geo for SDK-resolved positions', () => {
  it('loads authored files and evaluates an unlisted resolved asset without the registry', async () => {
    const labels = useEulerLabels()
    await labels.loadLabels()
    expect(fetchLabels).toHaveBeenCalledExactlyOnceWith('/api/internal/public-labels', { query: { chainId: 1 }, timeout: 35_000 })
    expect(labels.source.value).toBe('static')
    expect(labels.isReady.value).toBe(true)
    expect(labels.vaultCandidates.value).toEqual([])
    expect(getEulerGeoContext()).toBeUndefined()
    expect(geo.useGeoBlock().isPolicyAvailable.value).toBe(true)
    expect(geo.getVaultGeoBlockReason(cozy.address)).toBe('asset-unavailable')
    expect(geo.isVaultBlockedByCountry(cozy.address)).toBe(true)
    expect(geo.isVaultBlockedByCountry(cozy.address, { asset: cozy.asset })).toBe(false)
    expect(geo.isVaultBlockedByCountry(cozy)).toBe(false)
    expect(geo.isVaultRestrictedByCountry(cozy)).toBe(false)
    expect(geo.getVaultTags(cozy, 'swap-target')).toEqual({ tags: [], disabled: false })
  })

  it.each(staticRules)('enforces authored %s blocks independently of discovery', async (_scope, files) => {
    fetchLabels.mockResolvedValue(staticGeoBundle(files))
    await useEulerLabels().loadLabels()
    expect(geo.getVaultGeoBlockReason(cozy)).toBe('region')
    expect(geo.isVaultBlockedByCountry(cozy.address, { asset: cozy.asset })).toBe(true)
    expect(geo.getVaultTags(cozy)).toEqual({ tags: ['Restricted'], disabled: true })
    geo.useGeoBlock().country.value = 'GB'
    expect(geo.isVaultBlockedByCountry(cozy)).toBe(false)
  })

  it('preserves soft asset exit exemptions without bypassing vault restrictions', async () => {
    const labels = useEulerLabels()
    fetchLabels.mockResolvedValue(staticGeoBundle({ assets: [{ address: cozy.asset.address, restricted: ['NL'] }] }))
    await labels.loadLabels()
    expect(geo.isVaultBlockedByCountry(cozy)).toBe(false)
    expect(geo.isVaultRestrictedByCountry(cozy)).toBe(true)
    expect(geo.isVaultRestrictedByCountry(cozy, { counterpart: cozy.asset })).toBe(false)
    expect(geo.getVaultTags(cozy, 'supply-source')).toEqual({ tags: [], disabled: false })
    expect(geo.getVaultTags(cozy, 'swap-target')).toEqual({ tags: ['Restricted'], disabled: true })
    fetchLabels.mockResolvedValue(staticGeoBundle({ products: { cozy: { ...product, vaultOverrides: { [cozy.address]: { restricted: ['NL'] } } } } }))
    await labels.loadLabels(true)
    expect(geo.isVaultRestrictedByCountry(cozy, { counterpart: cozy.asset })).toBe(true)
  })

  it('keeps cold failure distinct from empty policy and preserves simple exits', async () => {
    fetchLabels.mockRejectedValue(new Error('static labels unavailable'))
    const labels = useEulerLabels()
    await labels.loadLabels()
    expect(labels.isReady.value).toBe(false)
    expect(geo.useGeoBlock().isPolicyAvailable.value).toBe(false)
    for (const vault of [cozy, cozy.address]) {
      expect(geo.getVaultGeoBlockReason(vault)).toBe('policy-unavailable')
      expect(geo.isVaultBlockedByCountry(vault)).toBe(false)
      expect(geo.isVaultRestrictedByCountry(vault, { asset: cozy.asset, counterpart: cozy.asset })).toBe(true)
      expect(geo.getVaultTags(vault, 'swap-target')).toEqual({ tags: [], disabled: true })
    }
    expect(geo.getVaultGeoUnavailableReason(cozy)).toContain('Compliance data unavailable')
    fetchLabels.mockResolvedValue(staticGeoBundle())
    await labels.loadLabels(true)
    expect(labels.isReady.value).toBe(true)
    expect(geo.useGeoBlock().isPolicyAvailable.value).toBe(true)
    expect(geo.isVaultRestrictedByCountry(cozy)).toBe(false)
  })

  it('retains the last complete static policy on a failed refresh', async () => {
    const labels = useEulerLabels()
    fetchLabels.mockResolvedValue(staticGeoBundle({ assets: [{ address: cozy.asset.address, block: ['NL'] }] }))
    await labels.loadLabels()
    fetchLabels.mockRejectedValue(new Error('static labels offline'))
    await labels.loadLabels(true)
    expect(labels.isReady.value).toBe(true)
    expect(labels.loadError.value).toBeDefined()
    expect(geo.getVaultGeoBlockReason(cozy)).toBe('region')
  })

  it('clears static policies on chain switch and ignores a late old-chain response', async () => {
    const labels = useEulerLabels()
    await labels.loadLabels()
    let resolveOld!: (bundle: ReturnType<typeof staticGeoBundle>) => void
    fetchLabels.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOld = resolve
    }))
    const oldLoad = labels.loadLabels(true)
    await vi.waitFor(() => expect(resolveOld).toBeDefined())
    chainId.value = 8453
    fetchLabels.mockRejectedValueOnce(new Error('new chain offline'))
    await labels.loadLabels()
    expect(labels.isReady.value).toBe(false)
    expect(geo.getVaultGeoBlockReason(cozy)).toBe('chain-mismatch')
    expect(geo.getVaultGeoBlockReason({ ...cozy, chainId: 8453 })).toBe('policy-unavailable')
    resolveOld(staticGeoBundle({ assets: [{ address: cozy.asset.address, block: ['NL'] }] }))
    await oldLoad
    expect(labels.isReady.value).toBe(false)
    expect(geo.useGeoBlock().isPolicyAvailable.value).toBe(false)
    fetchLabels.mockResolvedValue(staticGeoBundle({ assets: [{ address: cozy.asset.address, block: ['NL'] }] }))
    await labels.loadLabels(true)
    expect(geo.getVaultGeoBlockReason(cozy)).toBe('chain-mismatch')
    expect(geo.getVaultGeoBlockReason({ ...cozy, chainId: 8453 })).toBe('region')
  })

  it.each([undefined, null, 'IR'])('retains country safeguards for %s with static labels', async (country) => {
    await useEulerLabels().loadLabels()
    geo.useGeoBlock().country.value = country
    expect(geo.isVaultBlockedByCountry(cozy)).toBe(true)
    expect(geo.getVaultGeoBlockReason(cozy)).toBe(country === 'IR' ? 'region' : 'country-unavailable')
  })
})
