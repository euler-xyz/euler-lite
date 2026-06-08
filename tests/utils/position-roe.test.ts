import { describe, expect, it } from 'vitest'
import type { EVault, PortfolioBorrowPosition, SecuritizeCollateralVault, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import {
  areRoeCollateralVaultsCorrelatedWithBorrow,
  getPositionRoeCollateralVaults,
  mergeRoeCollateralVaults,
} from '~/utils/position-roe'

const USD_A = '0x0000000000000000000000000000000000000011'
const USD_B = '0x0000000000000000000000000000000000000012'
const ETH_A = '0x0000000000000000000000000000000000000021'
const VAULT_A = '0x0000000000000000000000000000000000000101'
const VAULT_B = '0x0000000000000000000000000000000000000102'
const VAULT_C = '0x0000000000000000000000000000000000000103'

const makeVault = (address: string, assetAddress: string): EVault => ({
  type: 'EVault',
  address,
  asset: {
    address: assetAddress,
    symbol: 'TST',
  },
} as unknown as EVault)

const makeSecuritizeVault = (address: string, assetAddress: string): SecuritizeCollateralVault => ({
  type: 'SecuritizeCollateral',
  address,
  asset: {
    address: assetAddress,
    symbol: 'EXT',
  },
} as unknown as SecuritizeCollateralVault)

const makePosition = (
  collaterals: Array<EVault | SecuritizeCollateralVault>,
): PortfolioBorrowPosition<VaultEntity> => ({
  collaterals: collaterals.map(vault => ({ vault })),
} as unknown as PortfolioBorrowPosition<VaultEntity>)

const getTags = (address: string) => {
  const tags = new Map<string, string[]>([
    [USD_A.toLowerCase(), ['usd']],
    [USD_B.toLowerCase(), ['usd']],
    [ETH_A.toLowerCase(), ['eth']],
  ])
  return tags.get(address.toLowerCase())
}

describe('position ROE helpers', () => {
  it('requires every collateral to correlate with the borrow vault', () => {
    const usdCollateral = makeVault(VAULT_A, USD_A)
    const ethCollateral = makeVault(VAULT_B, ETH_A)
    const usdBorrow = makeVault(VAULT_C, USD_B)

    expect(
      areRoeCollateralVaultsCorrelatedWithBorrow([usdCollateral], usdBorrow, getTags),
    ).toBe(true)
    expect(
      areRoeCollateralVaultsCorrelatedWithBorrow([usdCollateral, ethCollateral], usdBorrow, getTags),
    ).toBe(false)
  })

  it('resolves multi-collateral positions before falling back to the primary collateral', () => {
    const primary = makeVault(VAULT_A, USD_A)
    const external = makeSecuritizeVault(VAULT_B, USD_B)
    const fallback = makeVault(VAULT_C, ETH_A)

    expect(getPositionRoeCollateralVaults(makePosition([primary, external]), fallback)).toEqual([primary, external])
    expect(getPositionRoeCollateralVaults(makePosition([]), fallback)).toEqual([fallback])
  })

  it('deduplicates projected collateral vaults by address', () => {
    const first = makeVault(VAULT_A, USD_A)
    const duplicate = makeVault(VAULT_A, USD_B)
    const second = makeVault(VAULT_B, USD_B)

    expect(mergeRoeCollateralVaults([first, duplicate, second])).toEqual([duplicate, second])
  })
})
