import { describe, expect, it } from 'vitest'
import { EVault, type IAccountLiquidity, type IEVault, type IEVaultCollateral } from '@eulerxyz/euler-v2-sdk'
import { maxUint256, zeroAddress } from 'viem'
import { estimateCollateralLiquidityChange } from '~/utils/position-collateral-estimate'

const WAD = 10n ** 18n
const COLLATERAL = '0x0000000000000000000000000000000000000001'
const OTHER = '0x0000000000000000000000000000000000000002'
const CONTROLLER = '0x0000000000000000000000000000000000000003'
const value = (oracleMid: bigint, liquidation = oracleMid, borrowing = liquidation) => ({ oracleMid, liquidation, borrowing })
const makeVault = (overrides: Partial<IEVault> = {}) => new EVault({
  type: 'EVault', chainId: 1, address: COLLATERAL,
  asset: { address: zeroAddress, symbol: 'TEST', name: 'Test', decimals: 18 },
  shares: { address: COLLATERAL, symbol: 'eTEST', name: 'Test vault', decimals: 18 },
  totalAssets: 1_000n * WAD, totalShares: 1_000n * WAD, totalCash: 1_000n * WAD, totalBorrowed: 0n,
  oracle: { oracle: zeroAddress, name: '' }, caps: { supplyCap: maxUint256, borrowCap: maxUint256 },
  collaterals: [], timestamp: 900,
  ...overrides,
} as IEVault)
const makeEdge = (overrides: Partial<IEVaultCollateral> = {}): IEVaultCollateral => ({
  address: COLLATERAL, borrowLTV: 0, liquidationLTV: 0,
  ramping: { initialLiquidationLTV: 1, targetTimestamp: 1_000, rampDuration: 1_000n },
  oraclePriceRaw: {
    amountIn: WAD, amountOutMid: WAD, amountOutBid: WAD * 9n / 10n, amountOutAsk: WAD * 11n / 10n,
    queryFailure: false, queryFailureReason: '0x', timestamp: 900,
  },
  ...overrides,
})
const makeLiquidity = (selected = value(100n * WAD, 10n * WAD, 0n)): IAccountLiquidity => ({
  vaultAddress: CONTROLLER, unitOfAccount: zeroAddress, daysToLiquidation: 'Infinity',
  liabilityValue: value(70n * WAD),
  totalCollateralValue: value(100n * WAD + selected.oracleMid, 80n * WAD + selected.liquidation, 75n * WAD + selected.borrowing),
  collaterals: [
    { address: COLLATERAL, value: selected },
    { address: OTHER, value: value(100n * WAD, 80n * WAD, 75n * WAD) },
  ],
})
const inputs = () => ({
  liquidity: makeLiquidity(),
  borrowVault: makeVault({ address: CONTROLLER, collaterals: [makeEdge()] }),
  collateralVault: makeVault(), collateralAssets: 100n * WAD, collateralShares: 100n * WAD,
  assetsDelta: -60n * WAD, isCollateralEnabled: true,
})

describe('estimateCollateralLiquidityChange', () => {
  it('keeps other collateral coverage when withdrawing ramping collateral with zero borrow LTV', () => {
    expect(estimateCollateralLiquidityChange(inputs())).toEqual({
      userLTV: WAD / 2n, healthFactor: 84n * WAD / 70n, hasLiquidationLiquidity: true,
    })
  })

  it('allows the full balance while other collateral covers debt', () => {
    expect(estimateCollateralLiquidityChange({ ...inputs(), assetsDelta: -100n * WAD })).toEqual({
      userLTV: 7n * WAD / 10n, healthFactor: 80n * WAD / 70n, hasLiquidationLiquidity: true,
    })
  })

  it('projects top-ups using the current ramp LTV, not the old account weighting or ramp target', () => {
    expect(estimateCollateralLiquidityChange({ ...inputs(), assetsDelta: 60n * WAD })).toEqual({
      userLTV: 70n * WAD / 260n, healthFactor: 96n * WAD / 70n, hasLiquidationLiquidity: true,
    })
  })

  it('keeps raw debt valuation separate from liquidation debt valuation', () => {
    const args = inputs()
    args.liquidity.liabilityValue = value(70n * WAD, 75n * WAD, 77n * WAD)
    expect(estimateCollateralLiquidityChange(args)).toEqual({
      userLTV: WAD / 2n, healthFactor: 84n * WAD / 75n, hasLiquidationLiquidity: true,
    })
  })

  it.each([false, true])('rejects liquidation coverage at or below the liability (equal=%s)', (equal) => {
    const args = inputs()
    args.liquidity.liabilityValue.liquidation = (equal ? 84n : 85n) * WAD
    expect(estimateCollateralLiquidityChange(args)?.hasLiquidationLiquidity).toBe(false)
  })

  it('checks strict coverage before the displayed health factor rounds to one', () => {
    const args = inputs()
    args.liquidity.liabilityValue.liquidation = 84n * WAD - 1n
    const result = estimateCollateralLiquidityChange(args)
    expect(result?.healthFactor).toBe(WAD)
    expect(result?.hasLiquidationLiquidity).toBe(true)
  })

  it('uses a raw share quote for an enabled first deposit with no account collateral row', () => {
    const args = inputs()
    args.liquidity = makeLiquidity(value(0n))
    args.liquidity.collaterals.shift()
    args.collateralAssets = 0n
    args.collateralShares = 0n
    args.assetsDelta = 60n * WAD
    expect(estimateCollateralLiquidityChange(args)).toEqual({
      userLTV: 70n * WAD / 160n, healthFactor: 86n * WAD / 70n, hasLiquidationLiquidity: true,
    })
  })

  it('leaves a disabled direct deposit out of the controller risk values even without a quote', () => {
    const args = inputs()
    args.liquidity = makeLiquidity(value(0n))
    args.borrowVault.collaterals = []
    args.isCollateralEnabled = false
    args.assetsDelta = 60n * WAD
    expect(estimateCollateralLiquidityChange(args)).toEqual({
      userLTV: 7n * WAD / 10n, healthFactor: 80n * WAD / 70n, hasLiquidationLiquidity: true,
    })
  })

  it('counts held shares as well as new shares when a swap enables previously disabled collateral', () => {
    const args = inputs()
    args.liquidity = makeLiquidity(value(0n))
    args.isCollateralEnabled = false
    args.assetsDelta = 60n * WAD
    expect(estimateCollateralLiquidityChange({ ...args, enableCollateral: true })).toEqual({
      userLTV: 70n * WAD / 260n, healthFactor: 96n * WAD / 70n, hasLiquidationLiquidity: true,
    })
  })

  it('preserves controller units for a non-unit share quote and non-18-decimal unit of account', () => {
    const args = inputs()
    args.liquidity = makeLiquidity(value(0n))
    args.liquidity.liabilityValue = value(70_000_000n)
    args.liquidity.totalCollateralValue = value(100_000_000n, 80_000_000n, 75_000_000n)
    args.collateralAssets = 0n
    args.collateralShares = 0n
    args.assetsDelta = 60n * WAD
    args.borrowVault.collaterals[0].oraclePriceRaw.amountIn = 2n * WAD
    args.borrowVault.collaterals[0].oraclePriceRaw.amountOutMid = 2_000_000n
    expect(estimateCollateralLiquidityChange(args)).toEqual({
      userLTV: 70n * WAD / 160n, healthFactor: 86n * WAD / 70n, hasLiquidationLiquidity: true,
    })
  })

  it('uses SDK deposit rounding down and withdrawal rounding up for non-unit exchange rates', () => {
    const args = inputs()
    args.collateralVault = makeVault({ totalAssets: 2_000_000n, totalShares: 1_000_000n })
    args.collateralShares = 10n
    args.collateralAssets = 15n
    args.liquidity = makeLiquidity(value(10_000n, 1_000n, 0n))
    args.liquidity.totalCollateralValue = value(20_000n, 9_000n, 7_500n)
    args.liquidity.liabilityValue = value(7_000n)
    expect(args.collateralVault.convertToShares(1n)).toBe(0n)
    expect(args.collateralVault.previewWithdraw(1n)).toBe(1n)
    expect(estimateCollateralLiquidityChange({ ...args, assetsDelta: 1n })?.healthFactor).toBe(9n * WAD / 7n)
    expect(estimateCollateralLiquidityChange({ ...args, assetsDelta: -1n })?.healthFactor).toBe(89n * WAD / 70n)
    expect(estimateCollateralLiquidityChange({ ...args, assetsDelta: -15n })?.healthFactor).toBe(8n * WAD / 7n)
  })

  it('distinguishes redeem-all from an exact-assets withdrawal that leaves share dust', () => {
    const args = inputs()
    args.collateralVault = makeVault({ totalAssets: 1_000_000n, totalShares: 2_000_000n })
    args.collateralShares = 10n
    args.collateralAssets = 6n
    args.assetsDelta = -6n
    args.liquidity = makeLiquidity(value(10_000n, 1_000n, 0n))
    args.liquidity.totalCollateralValue = value(20_000n, 9_000n, 7_500n)
    args.liquidity.liabilityValue = value(7_000n)
    expect(args.collateralVault.previewWithdraw(6n)).toBe(9n)
    expect(estimateCollateralLiquidityChange(args)?.healthFactor).toBe(81n * WAD / 70n)
    expect(estimateCollateralLiquidityChange({ ...args, redeemAll: true })?.healthFactor).toBe(8n * WAD / 7n)
  })

  it('floors current ramp interpolation in basis points before applying it', () => {
    const args = inputs()
    args.borrowVault = makeVault({ address: CONTROLLER, collaterals: [makeEdge({
      ramping: { initialLiquidationLTV: 0.8, targetTimestamp: 901, rampDuration: 3n },
    })] })
    expect(estimateCollateralLiquidityChange({ ...args, assetsDelta: 60n * WAD })?.healthFactor)
      .toBe((80n * WAD + 160n * WAD * 2_666n / 10_000n) * WAD / (70n * WAD))
  })

  it('does not add value for a fully phased-out collateral with no account value', () => {
    const args = inputs()
    args.liquidity = makeLiquidity(value(0n))
    args.borrowVault = makeVault({ address: CONTROLLER, collaterals: [makeEdge({ ramping: undefined })] })
    expect(estimateCollateralLiquidityChange({ ...args, assetsDelta: 60n * WAD })?.healthFactor).toBe(80n * WAD / 70n)
  })

  it('represents a debt-free account with infinite health even after full redemption', () => {
    const args = inputs()
    args.liquidity.liabilityValue = value(0n)
    expect(estimateCollateralLiquidityChange({ ...args, assetsDelta: -100n * WAD })).toEqual({
      userLTV: 0n, healthFactor: maxUint256, hasLiquidationLiquidity: true,
    })
  })

  it('does not fabricate zero LTV when debt remains with no collateral', () => {
    const args = inputs()
    args.liquidity.totalCollateralValue = value(100n * WAD, 10n * WAD, 0n)
    args.liquidity.collaterals.pop()
    expect(estimateCollateralLiquidityChange({ ...args, assetsDelta: -100n * WAD })).toEqual({
      userLTV: null, healthFactor: 0n, hasLiquidationLiquidity: false,
    })
  })

  it('requires a valid controller quote when there is no held collateral valuation to scale', () => {
    const args = inputs()
    args.liquidity = makeLiquidity(value(0n))
    args.collateralAssets = 0n
    args.collateralShares = 0n
    args.assetsDelta = WAD
    args.borrowVault.collaterals[0].oraclePriceRaw.queryFailure = true
    expect(estimateCollateralLiquidityChange(args)).toBeNull()
  })

  it('keeps missing snapshot, holdings, enablement and over-withdrawal estimates unavailable', () => {
    const args = inputs()
    expect(estimateCollateralLiquidityChange({ ...args, liquidity: undefined })).toBeNull()
    expect(estimateCollateralLiquidityChange({ ...args, collateralShares: undefined })).toBeNull()
    expect(estimateCollateralLiquidityChange({ ...args, isCollateralEnabled: undefined })).toBeNull()
    expect(estimateCollateralLiquidityChange({ ...args, assetsDelta: -101n * WAD })).toBeNull()
  })
})
