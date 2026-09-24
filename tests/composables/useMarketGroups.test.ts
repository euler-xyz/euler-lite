import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import type { EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { __setEulerLabelsDataForTest } from '~/composables/useEulerLabels'
import { buildProductGroups, useMarketGroups } from '~/composables/useMarketGroups'
import type { EulerLabelProduct } from '~/entities/euler/labels'
import { normalizeAddress } from '~/utils/normalizeAddress'

vi.mock('~/utils/sdk-prices', () => ({
  getAssetUsdValueOrZero: async (amount: bigint) => Number(amount),
}))

// computeMetricsSync reaches for Nuxt-auto-imported APY helpers; stub them the
// same way tests/setup.ts stubs other unimport globals.
const g = globalThis as unknown as Record<string, unknown>
g.getVaultSupplyApy = () => 0
g.getVaultBorrowApy = () => 0

const LEND_VAULT = normalizeAddress('0x0000000000000000000000000000000000003001')
const WRAPPER = normalizeAddress('0x0000000000000000000000000000000000003002')

const makeEVault = (address: string): EVault =>
  ({
    type: 'EVault',
    address,
    isBorrowable: true,
    totalBorrowed: 0n,
    totalAssets: 100n,
    collaterals: [],
    utilization: 0,
    asset: { symbol: 'USDC' },
  }) as unknown as EVault

const makeWrapper = (address: string): SecuritizeCollateralVault =>
  ({
    type: 'SecuritizeCollateral',
    address,
    asset: { symbol: 'VBILL' },
  }) as unknown as SecuritizeCollateralVault

const products: Record<string, EulerLabelProduct> = {
  'kpk-securitize': {
    name: 'KPK x Securitize RWA Markets',
    description: '',
    entity: ['kpk', 'securitize'],
    url: '',
    vaults: [LEND_VAULT],
  } as unknown as EulerLabelProduct,
  'securitize': {
    name: 'Securitize RWA Collateral',
    description: '',
    entity: ['securitize'],
    url: '',
    vaults: [WRAPPER],
    vaultOverrides: {
      [WRAPPER]: { notExplorableLend: true },
    },
  } as unknown as EulerLabelProduct,
}

describe('buildProductGroups', () => {
  beforeEach(() => {
    __setEulerLabelsDataForTest({ products })
  })

  it('skips a collateral-only product but keeps its addresses assigned', () => {
    const { groups, assignedAddresses } = buildProductGroups(
      [makeEVault(LEND_VAULT), makeWrapper(WRAPPER)],
      products,
      {},
      false,
    )

    expect(groups.map(group => group.id)).toEqual(['kpk-securitize'])
    // The invariant that keeps skipped members out of orphan clustering.
    expect(assignedAddresses.has(WRAPPER.toLowerCase())).toBe(true)
    expect(assignedAddresses.has(LEND_VAULT.toLowerCase())).toBe(true)
  })

  it('lists collateral-only products when show-all-label-entries is on', () => {
    const { groups } = buildProductGroups(
      [makeEVault(LEND_VAULT), makeWrapper(WRAPPER)],
      products,
      {},
      true,
    )

    expect(groups.map(group => group.id)).toEqual(['kpk-securitize', 'securitize'])
  })
})

describe('deployment tag market groups', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('filters members and metrics before grouping while retaining collateral and direct market access', async () => {
    const selected = makeEVault(LEND_VAULT)
    const sibling = makeEVault(WRAPPER)
    sibling.totalAssets = 200n
    selected.collaterals.push({ address: WRAPPER, borrowLTV: 0.8, liquidationLTV: 0.9 } as EVault['collaterals'][number])
    const fullRegistry = [selected, sibling]
    const groupedProducts = { market: { ...products['kpk-securitize'], vaults: [LEND_VAULT, WRAPPER] } }
    const select = (address: string) => __setEulerLabelsDataForTest({
      products: groupedProducts,
      vaultTagAddresses: new Set([address.toLowerCase()]),
    })
    select(LEND_VAULT)
    vi.stubGlobal('useVaultRegistry', () => ({ getAll: () => fullRegistry.map(vault => ({ vault })) }))
    vi.stubGlobal('useEulerLabels', () => ({ products: groupedProducts, entities: {}, isReady: ref(true) }))
    vi.stubGlobal('useVaults', () => ({
      isVaultGovernorVerified: () => true,
      isCollateralResolved: ref(true),
      isMarketDataResolved: ref(true),
      isReady: ref(true),
    }))
    vi.stubGlobal('useShowAllLabelEntries', () => ref(true))
    const scope = effectScope()
    try {
      const groups = scope.run(useMarketGroups)!
      expect(groups.allVaults.value.map(v => v.address)).toEqual([LEND_VAULT])
      expect(groups.marketGroupsSync.value[0].metrics.vaultCount).toBe(1)
      expect(groups.marketGroupsSync.value[0].externalCollateral.map(v => v.address)).toEqual([WRAPPER])
      await vi.waitFor(() => expect(groups.marketGroups.value[0]?.metrics.totalTVL).toBe(100))
      select(WRAPPER)
      expect(groups.allVaults.value.map(v => v.address)).toEqual([WRAPPER])
      await vi.waitFor(() => expect(groups.marketGroups.value[0]?.metrics.totalTVL).toBe(200))
      const direct = await groups.fetchMarketGroupOnDemand('market')
      expect(direct?.vaults).toHaveLength(2)
      expect(direct?.metrics.totalTVL).toBe(300)
      expect(fullRegistry).toHaveLength(2)
    }
    finally { scope.stop() }
  })
})
