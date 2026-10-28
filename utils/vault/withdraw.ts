import type { EVault, EulerEarn, IAccountLiquidity, IHasVaultAddress, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import type { VaultWarning } from '~/composables/useVaultWarnings'

type BorrowLiquidity = Pick<IAccountLiquidity<IHasVaultAddress>, 'liabilityValue' | 'totalCollateralValue' | 'collaterals'>

const BPS = 10_000n
// Room for interest accrual and oracle drift between the liquidity snapshot and execution.
const LIABILITY_BUFFER_BPS = 100n

const getVaultWithdrawCapacity = (vault: EVault | SecuritizeCollateralVault | EulerEarn): bigint => {
  if ('availableAssets' in vault) return vault.availableAssets
  if (vault.type === 'SecuritizeCollateral') return vault.totalAssets
  return vault.availableLiquidity
}

export const getCashLimitedWithdrawAmount = (
  userWithdrawableAssets: bigint,
  vault: EVault | SecuritizeCollateralVault | EulerEarn | undefined,
): bigint => {
  if (!vault) return userWithdrawableAssets
  const capacity = getVaultWithdrawCapacity(vault)
  return userWithdrawableAssets < capacity ? userWithdrawableAssets : capacity
}

const getCollateralBorrowingValue = (liquidity: BorrowLiquidity, collateralAddress: string): bigint => {
  const address = collateralAddress.toLowerCase()
  return liquidity.collaterals.find(collateral => collateral.address.toLowerCase() === address)?.value.borrowing ?? 0n
}

const getBorrowingHeadroom = (liquidity: BorrowLiquidity): bigint => {
  const liability = liquidity.liabilityValue.borrowing
  const buffer = (liability * LIABILITY_BUFFER_BPS + BPS - 1n) / BPS
  return liquidity.totalCollateralValue.borrowing - liability - buffer
}

// EVK checks withdrawals against borrow LTV and requires collateral value strictly above the liability.
export const isAtBorrowLtvLimit = (liquidity: BorrowLiquidity | undefined): boolean | undefined => {
  if (!liquidity) return undefined
  const liability = liquidity.liabilityValue.borrowing
  return liability > 0n && liquidity.totalCollateralValue.borrowing <= liability
}

export const getBorrowLtvWithdrawLimit = ({
  liquidity,
  collateralAddress,
  collateralAssets,
}: {
  liquidity: BorrowLiquidity | undefined
  collateralAddress: string
  collateralAssets: bigint
}): bigint | undefined => {
  if (!liquidity) return undefined
  if (liquidity.liabilityValue.borrowing === 0n) return collateralAssets
  const collateralValue = getCollateralBorrowingValue(liquidity, collateralAddress)
  if (collateralValue === 0n) return isAtBorrowLtvLimit(liquidity) ? 0n : collateralAssets
  const headroom = getBorrowingHeadroom(liquidity)
  if (headroom <= 0n) return 0n
  const limit = headroom * collateralAssets / collateralValue
  return limit < collateralAssets ? limit : collateralAssets
}

export const getBorrowLtvWithdrawNotice = ({
  liquidity,
  collateralAddress,
  collateralBorrowLTV,
  symbol,
}: {
  liquidity: BorrowLiquidity | undefined
  collateralAddress: string
  collateralBorrowLTV: number | undefined
  symbol: string
}): VaultWarning | null => {
  if (!liquidity || !isAtBorrowLtvLimit(liquidity)) return null
  if (collateralBorrowLTV === 0) {
    const hasOtherCollateral = liquidity.totalCollateralValue.borrowing > getCollateralBorrowingValue(liquidity, collateralAddress)
    const action = hasOtherCollateral ? 'Repay debt or add a different collateral' : 'Repay the full debt'
    return {
      level: 'high',
      title: 'Borrow LTV is 0',
      message: `${symbol} has a borrow LTV of 0 in this market, so it no longer counts toward your borrow limit. ${action} to withdraw it.`,
    }
  }
  return {
    level: 'high',
    title: 'LTV limit reached',
    message: 'Your position is at its borrow LTV limit, so no collateral can be withdrawn. Repay debt or supply more collateral first.',
  }
}

/** Validate a direct withdrawal; batched withdrawals are checked with the whole batch. */
export const validateCollateralWithdraw = ({
  amount,
  collateralAssets,
  borrowLimit,
  cashLimit,
  hasLiquidationLiquidity,
}: {
  amount: bigint
  collateralAssets: bigint
  borrowLimit: bigint | undefined
  cashLimit: bigint
  hasLiquidationLiquidity: boolean | undefined
}): void => {
  if (amount > collateralAssets || (borrowLimit === undefined && amount >= collateralAssets)) {
    throw new Error('Not enough liquidity in your position')
  }
  if (borrowLimit !== undefined && amount > borrowLimit) {
    throw new Error('Amount exceeds the borrow LTV limit')
  }
  if (hasLiquidationLiquidity === undefined) throw new Error('Position liquidity unavailable')
  if (!hasLiquidationLiquidity) throw new Error('Not enough liquidity for the vault, LTV is too large')
  if (amount > cashLimit) throw new Error('Not enough liquidity in vault')
}
