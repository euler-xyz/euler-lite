import { getAddress, pad, toHex, type Address } from 'viem'
import { eulerAccountLensABI } from '~/entities/euler/abis'
import type { EarnVault, SecuritizeVault, Vault } from '~/entities/vault'
import type { LTVRampConfig } from '~/entities/vault/ltv'
import { getCurrentLiquidationLTV, isLiquidationLTVRamping } from '~/entities/vault/ltv'
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
  // Current effective liquidation LTV (derived from the lens; during a ramp this
  // changes over time). To detect or animate the ramp, use the four `*Ramp*`
  // fields below — they mirror the shape of `VaultCollateralLTV` and let us
  // call `isLiquidationLTVRamping` / `getCurrentLiquidationLTV` directly.
  liquidationLTV: bigint
  initialLiquidationLTV: bigint
  targetLiquidationLTV: bigint
  targetTimestamp: bigint
  rampDuration: bigint
  liabilityValueBorrowing: bigint
  liabilityValueLiquidation: bigint
  timeToLiquidation: bigint
  collateralValueLiquidation: bigint
  liquidityQueryFailure?: boolean
}

/**
 * Convert a position's ramp fields into the shape expected by the
 * `LTVRampConfig` helpers (where `liquidationLTV` means the post-ramp target).
 */
export const getPositionRampConfig = (position: AccountBorrowPosition): LTVRampConfig => ({
  liquidationLTV: position.targetLiquidationLTV,
  initialLiquidationLTV: position.initialLiquidationLTV,
  targetTimestamp: position.targetTimestamp,
  rampDuration: position.rampDuration,
})

export const isPositionLiquidationLTVRamping = (position: AccountBorrowPosition, nowSeconds?: bigint): boolean =>
  isLiquidationLTVRamping(getPositionRampConfig(position), nowSeconds)

export interface PositionRampStatus {
  isRamping: boolean
  /** User would be liquidated when the ramp completes (or earlier) if nothing changes. */
  willBeLiquidated: boolean
  /** Unix seconds at which the effective LLTV crosses below userLTV. `null` when not in danger. */
  forcedLiquidationAt: bigint | null
}

/**
 * Project when the user's position would become liquidatable while the ramp is
 * in progress, assuming userLTV stays constant (linear interpolation between
 * initial and target). Returns `forcedLiquidationAt = targetTimestamp` if the
 * crossing only happens at ramp end. Returns earlier-than-now if userLTV is
 * already past current effective LLTV — caller should treat that as "now".
 *
 * Compares percentages in BPS-equivalent space:
 *   - `userLTV` is scale 18 (e.g. 60% = 60e18, since `nanoToValue(_, 18)` yields the percent literal)
 *   - LTV-config values are BPS (scale 4) (e.g. 60% = 6000)
 *
 * To convert userLTV → BPS: divide by 10^16 (10^18 to drop the scale, then
 * multiply by 100 to lift percent → BPS, so net: /10^16).
 */
export const getPositionRampStatus = (position: AccountBorrowPosition, nowSeconds?: bigint): PositionRampStatus => {
  const isRamping = isPositionLiquidationLTVRamping(position, nowSeconds)
  if (!isRamping) {
    return { isRamping: false, willBeLiquidated: false, forcedLiquidationAt: null }
  }

  const userLTVbps = position.userLTV / (10n ** 16n)
  const targetLLTVbps = position.targetLiquidationLTV
  const initialLLTVbps = position.initialLiquidationLTV

  if (userLTVbps < targetLLTVbps) {
    return { isRamping: true, willBeLiquidated: false, forcedLiquidationAt: null }
  }

  if (initialLLTVbps <= targetLLTVbps) {
    // Degenerate ramp (no actual decrease); treat as not in danger.
    return { isRamping: true, willBeLiquidated: false, forcedLiquidationAt: null }
  }

  // currentEffectiveLLTV(t) = targetLLTV + (initialLLTV - targetLLTV) * (targetTimestamp - t) / rampDuration
  // Solve for t when currentEffectiveLLTV(t) == userLTV:
  //   t* = targetTimestamp - (userLTV - targetLLTV) * rampDuration / (initialLLTV - targetLLTV)
  const numerator = (userLTVbps - targetLLTVbps) * position.rampDuration
  const denominator = initialLLTVbps - targetLLTVbps
  const offset = numerator / denominator
  const forcedLiquidationAt = position.targetTimestamp - offset

  return { isRamping: true, willBeLiquidated: true, forcedLiquidationAt }
}

/** Get the live target liquidation LTV that the ramp is heading toward, expressed in BPS scale. */
export const getCurrentPositionLiquidationLTV = (position: AccountBorrowPosition, nowSeconds?: bigint): bigint =>
  getCurrentLiquidationLTV(getPositionRampConfig(position), nowSeconds)
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
  const occupied = new Set(occupiedSubAccounts.map(subAccount => getAddress(subAccount) as string))
  const freeSubAccounts: string[] = []

  for (let index = 1; index <= 256; index++) {
    const subAccountAddress = getSubAccountAddress(address, index)
    if (!occupied.has(subAccountAddress as string)) {
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
  candidates: ReadonlyArray<{ subAccount: string, enabledControllers: readonly string[] }>,
  borrowVaultAddress: string,
): string | null => {
  for (const candidate of candidates) {
    if (isBorrowControllerCompatible(candidate.enabledControllers, borrowVaultAddress)) {
      return candidate.subAccount
    }
  }

  return null
}

/**
 * Find a free sub-account for a new position.
 *
 * When `borrowVaultAddress` is provided, the returned sub-account is guaranteed
 * to have no controller or only the target borrow vault as controller. This
 * avoids picking a sub-account whose existing controller would conflict with
 * the new borrow.
 */
export const getNewSubAccount = async (
  ownerAddress: string,
  borrowVaultAddress?: string,
) => {
  const { SUBGRAPH_URL } = useEulerConfig()

  const { borrows, deposits } = await fetchAccountPositions(SUBGRAPH_URL, ownerAddress)
  const occupiedSubAccounts = borrowVaultAddress
    ? [...borrows, ...deposits].map(p => p.subAccount)
    : borrows.map(b => b.subAccount)
  const freeSubAccounts = getFreeSubAccounts(ownerAddress, occupiedSubAccounts)

  if (!freeSubAccounts.length) {
    throw new Error('Free subaccount not found')
  }

  if (!borrowVaultAddress) {
    return freeSubAccounts[0]
  }

  const { eulerCoreAddresses, eulerLensAddresses } = useEulerAddresses()
  const { rpcUrl } = useRpcClient()
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
      logWarn('account/getNewSubAccount', 'Account lens unavailable, falling back to first free sub-account')
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
