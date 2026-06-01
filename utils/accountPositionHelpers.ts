import type { SecuritizeCollateralVault, EVault } from '@eulerxyz/euler-v2-sdk'
import { collectPythFeedsFromAdapters } from '@eulerxyz/euler-v2-sdk'
import { type Address, getAddress } from 'viem'

/** Decoded shape of the AccountLiquidityInfo struct from the Euler lens */
export interface LensLiquidityInfo {
  queryFailure: boolean
  queryFailureReason: string
  account: Address
  vault: Address
  unitOfAccount: Address
  timeToLiquidation: bigint
  liabilityValueBorrowing: bigint
  liabilityValueLiquidation: bigint
  collateralValueBorrowing: bigint
  collateralValueLiquidation: bigint
  collateralValueRaw: bigint
  collaterals: Address[]
  collateralValuesBorrowing: bigint[]
  collateralValuesLiquidation: bigint[]
  collateralValuesRaw: bigint[]
}

/** Decoded shape of the VaultAccountInfo struct from the Euler lens */
export interface LensVaultAccountInfo {
  timestamp: bigint
  account: Address
  vault: Address
  asset: Address
  assetsAccount: bigint
  shares: bigint
  assets: bigint
  borrowed: bigint
  assetAllowanceVault: bigint
  assetAllowanceVaultPermit2: bigint
  assetAllowanceExpirationVaultPermit2: bigint
  assetAllowancePermit2: bigint
  balanceForwarderEnabled: boolean
  isController: boolean
  isCollateral: boolean
  liquidityInfo: LensLiquidityInfo
}

/** Decoded shape of the EVCAccountInfo struct from the Euler lens */
export interface LensEvcAccountInfo {
  timestamp: bigint
  evc: Address
  account: Address
  addressPrefix: string
  owner: Address
  isLockdownMode: boolean
  isPermitDisabledMode: boolean
  lastAccountStatusCheckTimestamp: bigint
  enabledControllers: Address[]
  enabledCollaterals: Address[]
}

/** Decoded shape of the AccountInfo struct (getAccountInfo return value) */
export interface LensAccountInfo {
  evcAccountInfo: LensEvcAccountInfo
  vaultAccountInfo: LensVaultAccountInfo
}

/**
 * Normalize an address to checksummed form, returning empty string on failure.
 * Different from `utils/normalizeAddress.ts` which returns lowercase on failure.
 */
export const normalizeAddressOrEmpty = (value?: string | null): string => {
  if (!value) return ''
  try {
    return getAddress(value)
  }
  catch {
    return ''
  }
}

export const toBigInt = (value: unknown): bigint => {
  try {
    return BigInt(value as bigint)
  }
  catch {
    return 0n
  }
}

export const resolvePositionCollaterals = (liquidityInfo: LensLiquidityInfo, fallback: string[]): string[] => {
  const infoCollaterals = (liquidityInfo?.collaterals || [])
    .map(addr => normalizeAddressOrEmpty(addr))
    .filter(Boolean)
  const values = liquidityInfo?.collateralValuesRaw
    || liquidityInfo?.collateralValuesLiquidation
    || liquidityInfo?.collateralValuesBorrowing

  // Sort by value descending so the largest collateral is treated as primary
  if (infoCollaterals.length && Array.isArray(values) && values.length === infoCollaterals.length) {
    const ranked = infoCollaterals
      .map((addr, idx) => ({ addr, value: toBigInt(values[idx]) }))
      .filter(({ value }) => value > 0n)
      .sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1))
      .map(({ addr }) => addr)
    if (ranked.length) {
      return ranked
    }
  }

  // Lens populated collaterals but all values are 0 (e.g. LTV ramped to 0)
  if (infoCollaterals.length) {
    return infoCollaterals
  }

  // queryFailure: lens didn't populate collaterals at all, fall back to EVC enabled list
  return fallback.map(addr => normalizeAddressOrEmpty(addr)).filter(Boolean)
}

/**
 * Check if a vault uses Pyth oracles and needs fresh prices.
 * Always returns true if Pyth oracles are detected, because Pyth prices
 * are only valid for ~2 minutes and require continuous updates.
 */
export const hasPythOracles = (vault: EVault | SecuritizeCollateralVault): boolean => {
  if (!('oracle' in vault)) return false
  const feeds = collectPythFeedsFromAdapters(vault.oracle.adapters)
  return feeds.length > 0
}
