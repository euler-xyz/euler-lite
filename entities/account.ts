import { getAddress, pad, toHex, type Address } from 'viem'
import { eulerAccountLensABI } from '~/entities/euler/abis'
import type { EarnVault, SecuritizeVault, Vault } from '~/entities/vault'
import { logWarn } from '~/utils/errorHandling'
import type { LensAccountInfo } from '~/utils/accountPositionHelpers'
import { batchLensCalls } from '~/utils/multicall'
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
  borrow: Vault
  collateral: Vault | SecuritizeVault
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
  vault: Vault | SecuritizeVault | EarnVault
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

export const getFreeSubAccounts = (
  ownerAddress: string,
  occupiedSubAccounts: readonly string[],
): string[] => {
  const address = getAddress(ownerAddress)
  const occupied = new Set(occupiedSubAccounts.map(subAccount => getAddress(subAccount)))
  const freeSubAccounts: string[] = []

  for (let index = 1; index <= 256; index++) {
    const subAccountAddress = getSubAccountAddress(address, index)
    if (!occupied.has(subAccountAddress)) {
      freeSubAccounts.push(subAccountAddress)
    }
  }

  return freeSubAccounts
}

export const isBorrowControllerCompatible = (
  enabledControllers: readonly string[],
  borrowVaultAddress: string,
): boolean => {
  if (!enabledControllers.length) return true

  const borrowVault = getAddress(borrowVaultAddress)
  return enabledControllers.every(controller => getAddress(controller) === borrowVault)
}

export const selectBorrowCompatibleSubAccount = (
  candidates: readonly Array<{ subAccount: string, enabledControllers: readonly string[] }>,
  borrowVaultAddress: string,
): string | null => {
  for (const candidate of candidates) {
    if (isBorrowControllerCompatible(candidate.enabledControllers, borrowVaultAddress)) {
      return candidate.subAccount
    }
  }

  return null
}

export const getNewSubAccount = async (ownerAddress: string) => {
  const { SUBGRAPH_URL } = useEulerConfig()

  const { borrows } = await fetchAccountPositions(SUBGRAPH_URL, ownerAddress)
  const freeSubAccounts = getFreeSubAccounts(ownerAddress, borrows.map(b => b.subAccount))

  if (freeSubAccounts.length > 0) return freeSubAccounts[0]

  throw new Error('Free subaccount not found')
}

export const getFreeSubAccountWithoutController = async (
  ownerAddress: string,
  borrowVaultAddress: string,
) => {
  const { SUBGRAPH_URL } = useEulerConfig()
  const { eulerCoreAddresses, eulerLensAddresses } = useEulerAddresses()
  const { rpcUrl } = useRpcClient()

  const { borrows, deposits } = await fetchAccountPositions(SUBGRAPH_URL, ownerAddress)
  const freeSubAccounts = getFreeSubAccounts(
    ownerAddress,
    [...borrows, ...deposits].map(position => position.subAccount),
  )

  if (!freeSubAccounts.length) {
    throw new Error('Free subaccount not found')
  }

  const evcAddress = eulerCoreAddresses.value?.evc
  const accountLensAddress = eulerLensAddresses.value?.accountLens
  if (!evcAddress || !accountLensAddress) {
    return freeSubAccounts[0]
  }

  const borrowVault = getAddress(borrowVaultAddress) as Address
  const checkedCandidates: Array<{ subAccount: string, enabledControllers: readonly string[] }> = []

  for (let index = 0; index < freeSubAccounts.length; index += 25) {
    const chunk = freeSubAccounts.slice(index, index + 25)
    const results = await batchLensCalls<LensAccountInfo>(
      evcAddress,
      accountLensAddress,
      eulerAccountLensABI,
      chunk.map(subAccount => ({
        functionName: 'getAccountInfo',
        args: [subAccount, borrowVault],
      })),
      rpcUrl.value,
    )

    if (results.some(result => result.transportError)) {
      logWarn('account/getFreeSubAccountWithoutController', 'Account lens unavailable, falling back to first free sub-account')
      return freeSubAccounts[0]
    }

    for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
      const result = results[resultIndex]
      if (!result.success || !result.result) continue

      checkedCandidates.push({
        subAccount: chunk[resultIndex],
        enabledControllers: result.result.evcAccountInfo.enabledControllers ?? [],
      })
    }

    const compatibleSubAccount = selectBorrowCompatibleSubAccount(checkedCandidates, borrowVault)
    if (compatibleSubAccount) {
      return compatibleSubAccount
    }
  }

  throw new Error('Compatible free subaccount not found')
}
