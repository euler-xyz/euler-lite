import type { EVault, EVaultCollateral, EVaultHookedOperations } from '@eulerxyz/euler-v2-sdk'
import { getAddress, maxUint256, zeroAddress } from 'viem'
import type { MarketGroup } from '~/entities/lend-discovery'

// K3 Liquity Hub on Ethereum (eUSDC-42 and the vaults it lends against) as Euler V3 served it on
// 2026-11-18, with sBOLD priced at zero: every vault fully paused (all operations hooked, hook
// target zero) and hidden as config-suspended.

export const LIQUITY_HUB_PRODUCT = 'k3-liquity-hub'
export const LIQUITY_HUB_ENTITY = 'k3-capital'
export const LIQUITY_HUB_GOVERNOR = getAddress('0xdD84A24eeddE63F10Ec3e928f1c8302A47538b6B')

export const EUSDC_42 = getAddress('0xc6137BC1378c2396051e06417704d31615F77Cb9')
export const EBOLD_1 = getAddress('0xC1C51C5c9EfaF0c485Aa1097AE9690B5e102975A')
export const ESBOLD_1 = getAddress('0xEc91B109817b20d4Ebd364A181666327194763F0')
export const EPT_SBOLD_1765325646 = getAddress('0x5BcA378719Ad01BB8e490d09e2326EDfEe66b954')
export const EPT_SBOLD_27NOV2025 = getAddress('0x5e4CfCe564d741373bD0078CB256E94696354C46')

export const USDC = { address: getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), symbol: 'USDC', decimals: 6, name: 'USD Coin' }
export const BOLD = { address: getAddress('0x6440f144b7e50D6a8439336510312d2F54beB01D'), symbol: 'BOLD', decimals: 18, name: 'BOLD' }
export const SBOLD = { address: getAddress('0x50Bd66D59911F5e086Ec87aE43C811e0D059DD11'), symbol: 'sBOLD', decimals: 18, name: 'sBOLD' }
export const PT_SBOLD_1765325646 = { address: getAddress('0x1Ff893C9071d04F8A965a90FcB0de22406A3eEaa'), symbol: 'PT-sBOLD-1765325646', decimals: 18, name: 'PT-sBOLD-1765325646' }
export const PT_SBOLD_27NOV2025 = { address: getAddress('0x66526197a4BAf496D97e1004e43c2C374Fb7d2E7'), symbol: 'PT-sBOLD-27NOV2025', decimals: 18, name: 'PT-sBOLD-27NOV2025' }

/** `/v3/evk/vaults/open-interest/by-collateral`: collateral-covered USD, underwater debt capped at collateral value. */
export const EUSDC_42_OPEN_INTEREST_USD: Record<string, number> = {
  [EBOLD_1]: 1.2942828220998,
  [ESBOLD_1]: 1.8771012270825452e-14,
}

/** `/v3/evk/vaults/bad-debt` for eUSDC-42 and eBOLD-1. */
export const EUSDC_42_BAD_DEBT_USD = 17556.296085125203
export const EUSDC_42_UNPRICED_BAD_DEBT_USD = 3.6546022261982998
export const EBOLD_1_BAD_DEBT_USD = 4.69746972645652

/** `/v3/evk/vaults/1/<eUSDC-42>`: totalSupplyUsd and utilization (percent). */
export const EUSDC_42_TOTAL_SUPPLY_USD = 21094.326908589774
export const EUSDC_42_UTILIZATION = 83.234364

export const LIQUITY_HUB_PAUSED_REASON = 'The vault is paused: withdraw, redeem, transfer and 4 more are off, so depositors cannot get out until its governor turns them back on.'

export const liquityHubHiddenVerdict = (decidedBy = 'config-suspended') => ({
  status: 'hidden',
  decidedBy,
  reason: LIQUITY_HUB_PAUSED_REASON,
  explorableLend: false,
  explorableBorrow: false,
})

const ALL_OPERATIONS_HOOKED: EVaultHookedOperations = {
  deposit: true,
  mint: true,
  withdraw: true,
  redeem: true,
  transfer: true,
  skim: true,
  borrow: true,
  repay: true,
  repayWithShares: true,
  pullDebt: true,
  convertFees: true,
  liquidate: true,
  flashloan: true,
  touch: true,
  vaultStatusCheck: true,
}

export const NO_OPERATIONS_HOOKED = Object.fromEntries(
  Object.keys(ALL_OPERATIONS_HOOKED).map(op => [op, false]),
) as EVaultHookedOperations

const ltv = (address: string, borrowLTV: number, liquidationLTV: number): EVaultCollateral => ({
  address,
  borrowLTV,
  liquidationLTV,
  currentLiquidationLTV: liquidationLTV,
  isLiquidationLTVRamping: false,
  rampTimeRemaining: 0n,
}) as unknown as EVaultCollateral

interface LiquityHubVaultOptions {
  hookedOperations?: EVaultHookedOperations
  hookTarget?: string
}

const makeVault = (
  address: string,
  asset: { address: string, symbol: string, decimals: number, name: string },
  collaterals: EVaultCollateral[],
  totals: { totalAssets: bigint, totalBorrowed: bigint, utilization: number },
  { hookedOperations = ALL_OPERATIONS_HOOKED, hookTarget = zeroAddress }: LiquityHubVaultOptions = {},
): EVault => ({
  type: 'EVault',
  chainId: 1,
  address,
  asset,
  shares: { address, symbol: `e${asset.symbol}`, decimals: asset.decimals, name: `EVK Vault e${asset.symbol}` },
  collaterals,
  totalAssets: totals.totalAssets,
  totalBorrowed: totals.totalBorrowed,
  utilization: totals.utilization,
  isBorrowable: collaterals.some(entry => entry.borrowLTV > 0),
  caps: { supplyCap: maxUint256, borrowCap: maxUint256, supplyCapUtilization: 0, borrowCapUtilization: 0 },
  interestRates: { supplyAPY: 0, borrowAPY: 0 },
  interestRateModel: { type: 0, address: zeroAddress },
  fees: { interestFee: 0 },
  liquidation: { maxLiquidationDiscount: 0, socializeDebt: true },
  governorAdmin: LIQUITY_HUB_GOVERNOR,
  oracle: { oracle: zeroAddress, name: 'EulerRouter' },
  eulerRouterGovernor: LIQUITY_HUB_GOVERNOR,
  hooks: { hookedOperations, hookTarget },
}) as unknown as EVault

export const makeEusdc42 = (options?: LiquityHubVaultOptions): EVault => makeVault(EUSDC_42, USDC, [
  ltv(EPT_SBOLD_1765325646, 0.8, 0.85),
  ltv(EPT_SBOLD_27NOV2025, 0.8, 0.85),
  ltv(EBOLD_1, 0.925, 0.95),
  ltv(ESBOLD_1, 0.85, 0.875),
], { totalAssets: 21_099_110_921n, totalBorrowed: 17_561_710_363n, utilization: EUSDC_42_UTILIZATION }, options)

export const makeEbold1 = (options?: LiquityHubVaultOptions): EVault => makeVault(EBOLD_1, BOLD, [
  ltv(EPT_SBOLD_1765325646, 0.825, 0.875),
  ltv(EPT_SBOLD_27NOV2025, 0.825, 0.875),
  ltv(ESBOLD_1, 0.9, 0.925),
], { totalAssets: 506_134_460_052_526_879_693n, totalBorrowed: 4_704_020_635_035_188_283n, utilization: 0.92940135 }, options)

export const makeEsbold1 = (options?: LiquityHubVaultOptions): EVault =>
  makeVault(ESBOLD_1, SBOLD, [], { totalAssets: 1_762_041_024_123_430_497_399_254n, totalBorrowed: 0n, utilization: 0 }, options)

export const makePtVault = (address: string, asset: typeof PT_SBOLD_27NOV2025, totalAssets: bigint, options?: LiquityHubVaultOptions): EVault =>
  makeVault(address, asset, [], { totalAssets, totalBorrowed: 0n, utilization: 0 }, options)

export const makeLiquityHubVaults = (options?: LiquityHubVaultOptions): EVault[] => [
  makeEusdc42(options),
  makeEbold1(options),
  makeEsbold1(options),
  makePtVault(EPT_SBOLD_1765325646, PT_SBOLD_1765325646, 4_441_892_075_516_766_785n, options),
  makePtVault(EPT_SBOLD_27NOV2025, PT_SBOLD_27NOV2025, 0n, options),
]

/** The group `fetchMarketGroupOnDemand` builds: every vault is a member, none is in the vault registry. */
export const makeLiquityHubOnDemandMarket = (vaults: EVault[] = makeLiquityHubVaults()): MarketGroup => ({
  id: LIQUITY_HUB_PRODUCT,
  name: 'Liquity Hub',
  source: 'product',
  curatorKey: LIQUITY_HUB_ENTITY,
  vaults,
  externalCollateral: [],
  unknownCollateral: [],
  showsAllMembers: true,
}) as unknown as MarketGroup
