import type { OracleDetailedInfo } from '~/entities/oracle'

export interface VaultLiabilityPriceInfo {
  queryFailure?: boolean
  queryFailureReason?: string
  timestamp?: bigint
  oracle?: string
  asset?: string
  unitOfAccount?: string
  amountIn: bigint
  amountOutAsk: bigint
  amountOutBid: bigint
  amountOutMid: bigint
}
export interface VaultCollateralLTV {
  collateral: string
  borrowLTV: bigint
  rampDuration: bigint
  liquidationLTV: bigint
  targetTimestamp: bigint
  initialLiquidationLTV: bigint
}
export interface VaultCollateralPrice {
  amountIn: bigint
  amountOutAsk: bigint
  amountOutBid: bigint
  amountOutMid: bigint
  asset: string
  oracle: string
  queryFailure: false
  queryFailureReason: string
  timestamp: bigint
  unitOfAccount: string
}
export interface VaultAsset {
  name: string
  symbol: string
  address: string
  decimals: bigint
}
export interface VaultInterestRateInfo {
  borrowAPY: bigint
  borrowSPY: bigint
  borrows: bigint
  cash: bigint
  supplyAPY: bigint
}
export interface CyclicalNoteInfo {
  primaryRate: bigint
  secondaryRate: bigint
  primaryDuration: bigint
  secondaryDuration: bigint
  startTimestamp: bigint
}
export interface VaultIRMInfo {
  interestRateModelInfo?: {
    interestRateModelType?: number
    interestRateModelParams?: string
  }
}

export interface KinkIRMParams {
  baseRate: bigint
  slope1: bigint
  slope2: bigint
  kink: bigint
}

export interface AdaptiveCurveIRMParams {
  targetUtilization: bigint
  initialRateAtTarget: bigint
  minRateAtTarget: bigint
  maxRateAtTarget: bigint
  curveSteepness: bigint
  adjustmentSpeed: bigint
}

export interface KinkyIRMParams {
  baseRate: bigint
  slope: bigint
  shape: bigint
  kink: bigint
  cutoff: bigint
}
export interface Erc4626Vault {
  address: string
  name: string
  symbol: string
  decimals: bigint
  asset: VaultAsset
  totalShares: bigint
  totalAssets: bigint
  isEVault: boolean
}
export interface SecuritizeVault extends Erc4626Vault {
  type: 'securitize'
  verified: boolean
  governorAdmin: string
  supplyCap: bigint
  // Compatibility fields with Vault type
  supply: bigint // Same as totalAssets (no borrowing)
  borrow: bigint // Always 0 (securitize vaults can't be borrowed from)
  interestRateInfo: VaultInterestRateInfo // Zero-valued
  assetPriceInfo?: {
    amountOutMid: bigint
  }
}
export interface Vault {
  verified: boolean
  name: string
  symbol: string
  supply: bigint
  borrow: bigint
  address: string
  decimals: bigint
  maxLiquidationDiscount: bigint
  supplyCap: bigint
  borrowCap: bigint
  interestFee: bigint
  configFlags: bigint
  oracle: string
  totalAssets: bigint
  totalShares: bigint
  totalCash: bigint
  asset: VaultAsset
  collateralLTVs: VaultCollateralLTV[]
  interestRateInfo: VaultInterestRateInfo
  collateralPrices: VaultCollateralPrice[]
  liabilityPriceInfo: VaultLiabilityPriceInfo
  assetPriceInfo?: {
    amountOutMid: bigint
  }
  unitOfAccountPriceInfo?: {
    amountOutMid: bigint
  }
  oracleDetailedInfo?: OracleDetailedInfo
  backupAssetOracleInfo?: OracleDetailedInfo
  dToken: string
  governorAdmin: string
  governorFeeReceiver: string
  unitOfAccount: string
  unitOfAccountName?: string
  unitOfAccountSymbol?: string
  unitOfAccountDecimals?: bigint
  interestRateModelAddress: string
  hookTarget: string
  hookedOps: bigint
  irmInfo?: VaultIRMInfo
  // Vault category: 'escrow' for escrow vaults, undefined/'standard' for regular EVK vaults
  vaultCategory?: 'standard' | 'escrow'
}
export interface BorrowVaultPair {
  borrow: Vault
  collateral: Vault
  borrowLTV: bigint
  liquidationLTV: bigint
  initialLiquidationLTV: bigint
  targetTimestamp: bigint
  rampDuration: bigint
}

export interface SecuritizeBorrowVaultPair {
  borrow: Vault
  collateral: SecuritizeVault
  borrowLTV: bigint
  liquidationLTV: bigint
  initialLiquidationLTV: bigint
  targetTimestamp: bigint
  rampDuration: bigint
}

// Union type for combined borrow list (regular + securitize)
export type AnyBorrowVaultPair = BorrowVaultPair | SecuritizeBorrowVaultPair

// Type guard to check if a pair is a securitize pair
export const isSecuritizeBorrowPair = (pair: AnyBorrowVaultPair): pair is SecuritizeBorrowVaultPair => {
  return 'type' in pair.collateral && pair.collateral.type === 'securitize'
}

// Type guard to narrow a vault union to an EVK Vault (has hookedOps, hookTarget)
export const isEVKVault = (vault: Vault | SecuritizeVault): vault is Vault => {
  return !('type' in vault && vault.type === 'securitize')
}

export interface VaultIteratorResult<T> {
  vaults: T[]
  isFinished: boolean
}

export interface EarnVaultStrategyInfo {
  strategy: string
  allocatedAssets: bigint
  availableAssets: bigint
  currentAllocationCap: bigint
  pendingAllocationCap: bigint
  pendingAllocationCapValidAt: bigint
  removableAt: bigint
  info: {
    timestamp: bigint
    vault: string
    vaultName: string
    vaultSymbol: string
    vaultDecimals: bigint
    asset: string
    assetName: string
    assetSymbol: string
    assetDecimals: bigint
    totalShares: bigint
    totalAssets: bigint
    isEVault: boolean
  }
}

export interface EarnVault {
  verified: boolean
  type: 'earn'
  address: string
  name: string
  symbol: string
  decimals: bigint
  totalShares: bigint
  totalAssets: bigint
  lostAssets: bigint
  availableAssets: bigint
  timelock: bigint
  performanceFee: bigint
  feeReceiver: string
  owner: string
  creator: string
  curator: string
  guardian: string
  evc: string
  permit2: string
  pendingTimelock: bigint
  pendingTimelockValidAt: bigint
  pendingGuardian: string
  pendingGuardianValidAt: bigint
  supplyQueue: string[]
  asset: VaultAsset
  strategies: EarnVaultStrategyInfo[]
  interestRateInfo: VaultInterestRateInfo
  assetPriceInfo?: {
    amountOutMid: bigint
  }
}

export type CollateralOptionType = 'wallet' | 'saving' | 'vault' | 'escrow'

export interface CollateralOption {
  type: CollateralOptionType
  amount: number
  price: number
  apy?: number
  showBalance?: boolean
  label?: string
  symbol?: string
  assetAddress?: string
  vaultAddress?: string
  subAccount?: string
  disabled?: boolean
  tags?: string[]
}
