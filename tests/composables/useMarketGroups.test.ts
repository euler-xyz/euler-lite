import { beforeEach, describe, expect, it } from 'vitest'
import type { EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { __setEulerLabelsDataForTest } from '~/composables/useEulerLabels'
import { buildProductGroups } from '~/composables/useMarketGroups'
import type { EulerLabelProduct } from '~/entities/euler/labels'
import { normalizeAddress } from '~/utils/normalizeAddress'

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
