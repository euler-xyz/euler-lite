import { describe, expect, it } from 'vitest'
import type { EVault, PortfolioBorrowPosition, SecuritizeCollateralVault, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import {
  areRoeCollateralVaultsCorrelatedWithBorrow,
  getPositionRoeCollateralVaults,
  mergeRoeCollateralVaults,
  resolvePositionRoeCollateralVaults,
} from '~/utils/position-roe'

const USD_A = '0x0000000000000000000000000000000000000011'
const USD_B = '0x0000000000000000000000000000000000000012'
const ETH_A = '0x0000000000000000000000000000000000000021'
const USD_ETH = '0x0000000000000000000000000000000000000031'
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
  collateralVaults = collaterals.map(vault => vault.address),
): PortfolioBorrowPosition<VaultEntity> => ({
  collaterals: collaterals.map(vault => ({ vault })),
  collateralVaults,
} as unknown as PortfolioBorrowPosition<VaultEntity>)

const getTags = (address: string) => {
  const tags = new Map<string, string[]>([
    [USD_A.toLowerCase(), ['usd']],
    [USD_B.toLowerCase(), ['usd']],
    [ETH_A.toLowerCase(), ['eth']],
    [USD_ETH.toLowerCase(), ['usd', 'eth']],
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

  it('requires a single shared category across every collateral and the borrow vault', () => {
    const usdCollateral = makeVault(VAULT_A, USD_A)
    const ethCollateral = makeVault(VAULT_B, ETH_A)
    const hybridBorrow = makeVault(VAULT_C, USD_ETH)

    expect(
      areRoeCollateralVaultsCorrelatedWithBorrow([usdCollateral], hybridBorrow, getTags),
    ).toBe(true)
    expect(
      areRoeCollateralVaultsCorrelatedWithBorrow([ethCollateral], hybridBorrow, getTags),
    ).toBe(true)
    expect(
      areRoeCollateralVaultsCorrelatedWithBorrow([usdCollateral, ethCollateral], hybridBorrow, getTags),
    ).toBe(false)
  })

  it('resolves multi-collateral positions before falling back to the primary collateral', () => {
    const primary = makeVault(VAULT_A, USD_A)
    const external = makeSecuritizeVault(VAULT_B, USD_B)
    const fallback = makeVault(VAULT_C, ETH_A)

    expect(getPositionRoeCollateralVaults(makePosition([primary, external]), fallback)).toEqual([primary, external])
    expect(getPositionRoeCollateralVaults(makePosition([]), fallback)).toEqual([fallback])
  })

  it('reports incomplete collateral resolution when a known collateral address is unresolved', () => {
    const primary = makeVault(VAULT_A, USD_A)
    const fallback = makeVault(VAULT_C, ETH_A)

    expect(resolvePositionRoeCollateralVaults(makePosition([primary]), fallback)).toEqual({
      vaults: [primary],
      isComplete: true,
    })
    expect(resolvePositionRoeCollateralVaults(makePosition([primary], [VAULT_A, VAULT_B]), fallback)).toEqual({
      vaults: [primary],
      isComplete: false,
    })
    expect(resolvePositionRoeCollateralVaults(makePosition([], [VAULT_C]), fallback)).toEqual({
      vaults: [fallback],
      isComplete: true,
    })
  })

  it('deduplicates projected collateral vaults by address', () => {
    const first = makeVault(VAULT_A, USD_A)
    const duplicate = makeVault(VAULT_A, USD_B)
    const second = makeVault(VAULT_B, USD_B)

    expect(mergeRoeCollateralVaults([first, duplicate, second])).toEqual([duplicate, second])
  })
})
