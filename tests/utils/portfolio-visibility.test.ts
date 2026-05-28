import { describe, expect, it } from 'vitest'
import { getAddress, type Address } from 'viem'
import { isVisiblePortfolioPosition } from '~/utils/portfolioVisibility'

const account = getAddress('0x1000000000000000000000000000000000000000')
const borrowVault = getAddress('0x2000000000000000000000000000000000000000')
const primaryCollateral = getAddress('0x3000000000000000000000000000000000000000')
const hiddenCollateral = getAddress('0x4000000000000000000000000000000000000000')

const visibleVaults = (...addresses: Address[]) =>
  new Set(addresses.map(address => address.toLowerCase()))

const portfolioAccount = (enabledCollaterals: Address[] = []) => ({
  getSubAccount: () => ({ enabledCollaterals }),
})

const borrowPosition = (collaterals: Array<{ address: Address, oracleMid: bigint }> = []) => ({
  account,
  vaultAddress: borrowVault,
  borrowed: 1n,
  liquidity: {
    collaterals: collaterals.map(({ address, oracleMid }) => ({
      address,
      value: { oracleMid },
    })),
  },
})

describe('isVisiblePortfolioPosition', () => {
  it('keeps a borrow visible when only a secondary liquidity collateral is hidden', () => {
    expect(
      isVisiblePortfolioPosition(
        borrowPosition([
          { address: hiddenCollateral, oracleMid: 20n },
          { address: primaryCollateral, oracleMid: 80n },
        ]),
        portfolioAccount(),
        visibleVaults(borrowVault, primaryCollateral),
      ),
    ).toBe(true)
  })

  it('hides a borrow when the primary liquidity collateral is hidden', () => {
    expect(
      isVisiblePortfolioPosition(
        borrowPosition([
          { address: primaryCollateral, oracleMid: 20n },
          { address: hiddenCollateral, oracleMid: 80n },
        ]),
        portfolioAccount(),
        visibleVaults(borrowVault, primaryCollateral),
      ),
    ).toBe(false)
  })

  it('uses only the first enabled collateral when liquidity is unavailable', () => {
    expect(
      isVisiblePortfolioPosition(
        { account, vaultAddress: borrowVault, borrowed: 1n },
        portfolioAccount([primaryCollateral, hiddenCollateral]),
        visibleVaults(borrowVault, primaryCollateral),
      ),
    ).toBe(true)
  })

  it('still filters by the position vault before collateral visibility', () => {
    expect(
      isVisiblePortfolioPosition(
        { account, vaultAddress: borrowVault, borrowed: 0n },
        portfolioAccount(),
        visibleVaults(primaryCollateral),
      ),
    ).toBe(false)
  })
})
