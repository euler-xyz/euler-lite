import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { EulerEarn } from '@eulerxyz/euler-v2-sdk'
import type { EulerLabelEntity, EulerLabelProduct } from '~/entities/euler/labels'
import type { MarketGroup } from '~/entities/lend-discovery'
import { useEulerCuratorProfile } from '~/composables/useEulerCuratorProfile'

const state = vi.hoisted(() => ({
  source: 'v3' as 'v3' | 'static',
  managingEntityByVault: {} as Record<string, string>,
  hidden: new Set<string>(),
  selected: new Set<string>(),
  staticEarnEntity: null as EulerLabelEntity | null,
}))

vi.mock('~/composables/useEulerLabels', () => ({
  getEulerLabelsSourceData: () => ({
    source: state.source,
    managingEntityByVault: state.managingEntityByVault,
  }),
}))

vi.mock('~/utils/eulerLabelsUtils', () => ({
  getEntitiesByEarnVault: () => state.staticEarnEntity ? [state.staticEarnEntity] : [],
  isEarnVaultNotExplorable: (address: string) => state.hidden.has(address.toLowerCase()),
  isVaultSelectedByTag: (address: string) => state.selected.has(address.toLowerCase()),
}))

const entity = (id: string): EulerLabelEntity => ({
  id,
  name: id,
  logo: '',
  description: '',
  url: '',
  addresses: {},
  social: { twitter: '', youtube: '', discord: '', telegram: '', github: '' },
})

const earn = (suffix: string): EulerEarn => ({
  address: `0x${suffix.padStart(40, '0')}`,
  asset: { symbol: suffix },
}) as unknown as EulerEarn

const market = (id: string): MarketGroup => ({
  id,
  name: id,
  source: 'product',
  metrics: { totalTVL: 100 },
}) as MarketGroup

describe('useEulerCuratorProfile', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    state.source = 'v3'
    state.managingEntityByVault = {}
    state.hidden.clear()
    state.selected.clear()
    state.staticEarnEntity = null
  })

  it('shows only owned markets and eligible, owner-verified Earn vaults', () => {
    const k3 = entity('k3')
    const re7 = entity('re7')
    const good = earn('1')
    const hidden = earn('2')
    const taggedOut = earn('3')
    const wrongOwner = earn('4')
    const coBrand = earn('5')
    const allEarn = [good, hidden, taggedOut, wrongOwner, coBrand]
    state.managingEntityByVault = Object.fromEntries(allEarn.map(vault => [
      vault.address.toLowerCase(), vault === coBrand ? 're7' : 'k3',
    ]))
    state.hidden.add(hidden.address.toLowerCase())
    state.selected.add(good.address.toLowerCase())
    state.selected.add(hidden.address.toLowerCase())
    state.selected.add(wrongOwner.address.toLowerCase())
    state.selected.add(coBrand.address.toLowerCase())

    const products: Record<string, EulerLabelProduct> = {
      owned: { entity: 'k3', coBrandEntityIds: ['re7'], name: 'Owned', description: '', url: '', vaults: [] },
      branded: { entity: 're7', coBrandEntityIds: ['k3'], name: 'Branded', description: '', url: '', vaults: [] },
    }
    const showAll = ref(false)
    vi.stubGlobal('useEulerLabels', () => ({
      entities: { k3, re7 }, products, isReady: ref(true), loadError: ref(undefined), retryLabels: vi.fn(),
    }))
    vi.stubGlobal('useVaults', () => ({
      isEarnUpdating: ref(false), isEarnVaultOwnerVerified: (vault: EulerEarn) => vault !== wrongOwner,
    }))
    vi.stubGlobal('useVaultRegistry', () => ({
      getEarnVaults: () => allEarn, isVerifiedVault: () => true,
    }))
    vi.stubGlobal('useShowAllLabelEntries', () => showAll)
    vi.stubGlobal('useMarketGroups', () => ({
      marketGroups: ref([market('owned'), market('branded')]),
      isReady: ref(true), isResolvingTVL: ref(false),
    }))

    const profile = useEulerCuratorProfile(ref('k3'))
    expect(profile.managedMarkets.value.map(group => group.id)).toEqual(['owned'])
    expect(profile.earnVaults.value.map(vault => vault.address)).toEqual([good.address])

    showAll.value = true
    expect(profile.earnVaults.value.map(vault => vault.address)).toEqual([good.address, hidden.address])
  })

  it('uses exact entity identity in static mode and exposes a retry state on label failure', () => {
    const k3 = entity('k3')
    const good = earn('1')
    state.source = 'static'
    state.staticEarnEntity = k3
    state.selected.add(good.address.toLowerCase())
    const labelsReady = ref(true)
    const loadError = ref<string | undefined>()
    const retryLabels = vi.fn()
    vi.stubGlobal('useEulerLabels', () => ({
      entities: { k3 }, products: {}, isReady: labelsReady, loadError, retryLabels,
    }))
    vi.stubGlobal('useVaults', () => ({ isEarnUpdating: ref(false), isEarnVaultOwnerVerified: () => true }))
    vi.stubGlobal('useVaultRegistry', () => ({ getEarnVaults: () => [good], isVerifiedVault: () => true }))
    vi.stubGlobal('useShowAllLabelEntries', () => ref(false))
    vi.stubGlobal('useMarketGroups', () => ({ marketGroups: ref([]), isReady: ref(true), isResolvingTVL: ref(false) }))

    const profile = useEulerCuratorProfile(ref('k3'))
    expect(profile.earnVaults.value.map(vault => vault.address)).toEqual([good.address])
    labelsReady.value = false
    loadError.value = 'Unable to load labels'
    expect(profile.isUnavailable.value).toBe(true)
    expect(profile.isLoading.value).toBe(false)
    void profile.retryLabels()
    expect(retryLabels).toHaveBeenCalledOnce()
  })
})
