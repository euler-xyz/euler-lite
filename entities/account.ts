import { getAddress, pad, toHex } from 'viem'
import type { EulerEarn, SecuritizeCollateralVault, EVault } from '~/entities/vault'
import { fetchAccountPositions } from '~/utils/subgraph'

export interface AccountVaultLiquidity {
  queryFailure: boolean
  queryFailureReason: string
  account: string
  vault: string
  unitOfAccount: string
  timeToLiquidation: bigint
  liabilityValueBorrowing: bigint
  liabilityValueLiquidation: bigint
  collateralValueBorrowing: bigint
  collateralValueLiquidation: bigint
  collateralValueRaw: bigint
  collaterals: string[]
  collateralValuesBorrowing: bigint[]
  collateralValuesLiquidation: bigint[]
  collateralValuesRaw: bigint[]
}
export interface AccountVault {
  account: string
  asset: string
  assetAllowanceExpirationVaultPermit2: bigint
  assetAllowancePermit2: bigint
  assetAllowanceVault: bigint
  assetAllowanceVaultPermit2: bigint
  assets: bigint
  assetsAccount: bigint
  balanceForwarderEnabled: boolean
  borrowed: bigint
  isCollateral: boolean
  isController: boolean
  liquidityInfo: AccountVaultLiquidity
  vault: string
}
export interface AccountBorrowPosition {
  borrow: EVault
  collateral: EVault | SecuritizeCollateralVault
  collaterals?: string[]
  subAccount: string
  health: bigint
  userLTV: bigint
  price: bigint
  supplied: bigint
  borrowed: bigint
  borrowLTV: bigint
  liquidationLTV: bigint
  liabilityValueBorrowing: bigint
  liabilityValueLiquidation: bigint
  timeToLiquidation: bigint
  collateralValueLiquidation: bigint
  liquidityQueryFailure?: boolean
}
export interface AccountDepositPosition {
  vault: EVault | SecuritizeCollateralVault | EulerEarn
  subAccount: string
  shares: bigint
  assets: bigint
}

export const isPositionEligibleForLiquidation = (position: AccountBorrowPosition | undefined): boolean => {
  if (!position || position.liabilityValueLiquidation === 0n) return false
  if (position.liquidityQueryFailure) return false
  return position.liabilityValueLiquidation > position.collateralValueLiquidation
}

/**
 * Derives the subaccount index by XORing the owner address with the subaccount address.
 * The subaccount address is created as: ownerAddress XOR index
 * So: index = ownerAddress XOR subAccountAddress
 */
export const getSubAccountIndex = (ownerAddress: string, subAccountAddress: string): number => {
  const owner = BigInt(getAddress(ownerAddress))
  const subAccount = BigInt(getAddress(subAccountAddress))
  return Number(owner ^ subAccount)
}

/**
 * Derives the full sub-account address from owner address and sub-account index.
 * Reverse of getSubAccountIndex: address = ownerAddress XOR index
 */
export const getSubAccountAddress = (ownerAddress: string, index: number): string => {
  const owner = BigInt(getAddress(ownerAddress))
  return getAddress(pad(toHex(owner ^ BigInt(index), { size: 20 }), { size: 20 }))
}

export const getNewSubAccount = async (ownerAddress: string) => {
  const { SUBGRAPH_URL } = useEulerConfig()

  const address = getAddress(ownerAddress)
  const { borrows } = await fetchAccountPositions(SUBGRAPH_URL, ownerAddress)
  const subAccounts = borrows.map(b => b.subAccount)

  for (let index = 1; index <= 256; index++) {
    const hex = BigInt(address) ^ BigInt(index)
    const subAccountAddress = getAddress(pad(toHex(hex, { size: 20 }), { size: 20 }))

    if (!subAccounts.includes(subAccountAddress)) {
      return subAccountAddress
    }
  }

  throw new Error('Free subaccount not found')
}
