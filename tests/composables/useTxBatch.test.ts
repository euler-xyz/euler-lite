import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { Account, Portfolio, type EVCBatchItem, type IAccountPosition, type IHasVaultAddress, type IAccountLiquidity, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { encodeFunctionData, getAddress, keccak256, toHex, type Address, type StateOverride } from 'viem'
import { EVC_ABI } from '~/abis/evc'
import { getEulerSdkFresh } from '~/composables/useEulerSdk'
import { awaitFinalPlanningLayer, buildOperationEntryMap, buildWalletBalanceLayers, buildWalletChanges, countPlanOperations, fetchBaseAccountSnapshot, normalizeSimulatedVaultLayers, stitchAccount, useTxBatch } from '~/composables/useTxBatch'
import {
  mergeBatchPrefetchedSlotHints,
  resetBatchPrefetchState,
  setBatchPrefetchedBaseAccount,
  setBatchPrefetchedPlanningAccount,
} from '~/composables/batchPrefetchState'
import { activeLayerVaultsRef } from '~/composables/useLayeredVaults'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import type { SignatureSlot } from '~/features/reviewed-execution/domain/reviewed-execution'
import { finalizeSuccessfulSubmission } from '~/features/reviewed-execution/review/submission-completion'

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdkFresh: vi.fn(),
}))

const owner = getAddress('0x1000000000000000000000000000000000000000')
const subAccount = getAddress('0x8A54C278D117854486db0F6460D901a180Fff517')
const vault = getAddress('0x797Dd80692C3B2daDAbcE8e30C07fDE5307d48A9')
const borrowVault = getAddress('0x859160Db5841E5cfB8D3f144C6b3381A85A4b410')
const targetVault = getAddress('0x3000000000000000000000000000000000000000')
const WAD = 10n ** 18n
const testIntentPlans = new Map<string, TransactionPlan>()
let testIntentSequence = 0
const intentFor = (plan: TransactionPlan, subAccounts: Address[] = [owner]): OperationIntent => {
  const intentId = `test-intent:${++testIntentSequence}`
  testIntentPlans.set(intentId, plan)
  return {
    schemaVersion: 1,
    intentId,
    revision: 1,
    kind: 'deposit',
    chainId: 1,
    account: owner,
    subAccounts,
    planner: { name: 'deposit', args: {} },
    constraints: [],
    metadata: { createdAt: testIntentSequence, source: 'test' },
  }
}
const compilePreviewMock = vi.fn(async (intents: readonly OperationIntent[], _account?: Account<IHasVaultAddress>) => testIntentPlans.get(intents[0]!.intentId) ?? [])
const executionMocks = {
  compilePreview: compilePreviewMock,
  compilePreviewForSimulation: vi.fn(async (intents: readonly OperationIntent[], account?: Account<IHasVaultAddress>): Promise<{
    reviewedPlan: TransactionPlan
    plan: TransactionPlan
    migrationStateOverrides?: StateOverride
  }> => {
    const plan = await compilePreviewMock(intents, account)
    return { reviewedPlan: plan, plan }
  }),
  prepare: vi.fn(async () => { throw new Error('authoritative preparation not configured in batch unit test') }),
  prepareReadOnly: vi.fn(async () => { throw new Error('read-only preparation not configured in batch unit test') }),
}
const scheduleExternalMigrationRefreshes = vi.fn()
const position = (account: Address, shares: bigint) => ({
  account,
  vaultAddress: vault,
  asset: vault,
  shares,
  assets: shares,
  borrowed: 0n,
  isController: false,
  isCollateral: false,
  balanceForwarderEnabled: false,
})

const accountWithPosition = (
  subAccountKey: Address,
  positionAccount: Address,
  shares: bigint,
) => new Account<IHasVaultAddress>({
  chainId: 1,
  owner,
  subAccounts: {
    [subAccountKey]: {
      timestamp: 0,
      account: positionAccount,
      owner,
      lastAccountStatusCheckTimestamp: 0,
      enabledControllers: [],
      enabledCollaterals: [],
      positions: [position(positionAccount, shares)],
    },
  },
  populated: { vaults: true, marketPrices: true, userRewards: true },
})

const pricedVault = (
  address: Address,
  symbol: string,
  price = 1,
  collaterals?: { address: Address, borrowLTV?: number, liquidationLTV?: number, marketPriceUsd?: number, vault?: unknown }[],
) => ({
  address,
  asset: { address, symbol, decimals: 6 },
  shares: { decimals: 6 },
  marketPriceUsd: price,
  collaterals,
})

const pricedPosition = (
  overrides: Partial<IAccountPosition<IHasVaultAddress>> & Pick<IAccountPosition<IHasVaultAddress>, 'vaultAddress'>,
): IAccountPosition<IHasVaultAddress> => {
  const { vaultAddress, ...rest } = overrides
  return {
    account: subAccount,
    vaultAddress,
    asset: overrides.asset ?? vaultAddress,
    shares: 0n,
    assets: 0n,
    borrowed: 0n,
    isController: false,
    isCollateral: false,
    balanceForwarderEnabled: false,
    ...rest,
  }
}

const liquidity = (
  collateralValueUsd: number,
  liabilityValueUsd: number,
  collaterals: IAccountLiquidity<IHasVaultAddress>['collaterals'],
): IAccountLiquidity<IHasVaultAddress> => ({
  vaultAddress: borrowVault,
  vault: pricedVault(borrowVault, 'DEBT'),
  unitOfAccount: borrowVault,
  daysToLiquidation: 'Infinity',
  liabilityValue: { borrowing: 50n, liquidation: 50n, oracleMid: 50n },
  totalCollateralValue: { borrowing: 100n, liquidation: 100n, oracleMid: 100n },
  collaterals,
  liabilityValueUsd,
  totalCollateralValueUsd: collateralValueUsd,
})

const collateralPosition = (assets: bigint, includePrice = true): IAccountPosition<IHasVaultAddress> => pricedPosition({
  vaultAddress: vault,
  vault: includePrice ? pricedVault(vault, 'USDC') : undefined,
  shares: assets,
  assets,
  borrowed: 0n,
  isCollateral: true,
  marketPriceUsd: includePrice ? 1 : undefined,
  suppliedValueUsd: includePrice ? Number(assets / 1_000_000n) : undefined,
})

const borrowPosition = (
  borrowed: bigint,
  collateralValueUsd: number,
  includeCollateralVault = true,
  includeBorrowVaultCollateralPrices = true,
): IAccountPosition<IHasVaultAddress> => pricedPosition({
  vaultAddress: borrowVault,
  vault: pricedVault(
    borrowVault,
    'DEBT',
    1,
    includeBorrowVaultCollateralPrices ? [{ address: vault, marketPriceUsd: 1 }] : undefined,
  ),
  shares: 0n,
  assets: 0n,
  borrowed,
  isController: borrowed > 0n,
  marketPriceUsd: 1,
  borrowedValueUsd: Number(borrowed / 1_000_000n),
  liquidity: liquidity(collateralValueUsd, Number(borrowed / 1_000_000n), [
    {
      address: vault,
      vault: includeCollateralVault ? pricedVault(vault, 'USDC') : undefined,
      value: { borrowing: 100n, liquidation: 100n, oracleMid: 100n },
      marketPriceUsd: includeCollateralVault ? 1 : undefined,
      valueUsd: collateralValueUsd,
    },
  ]),
})

const riskAwareBorrowPosition = (withRiskPrice = true) => {
  const sourceVault = pricedVault(vault, 'SRC')
  const destinationVault = pricedVault(targetVault, 'DST')
  const borrowVaultEntity: ReturnType<typeof pricedVault> & {
    getCollateralRiskPrice?: () => { priceBorrowing: bigint, priceLiquidation: bigint }
  } = {
    ...pricedVault(borrowVault, 'DEBT', 1, [
      { address: vault, borrowLTV: 0.8, liquidationLTV: 0.9, vault: sourceVault },
      { address: targetVault, borrowLTV: 0.7, liquidationLTV: 0.5, vault: destinationVault },
    ]),
  }
  if (withRiskPrice) {
    borrowVaultEntity.getCollateralRiskPrice = () => ({ priceBorrowing: WAD, priceLiquidation: WAD })
  }

  return {
    sourceVault,
    destinationVault,
    borrow: pricedPosition({
      vaultAddress: borrowVault,
      vault: borrowVaultEntity,
      shares: 0n,
      assets: 0n,
      borrowed: 50_000_000n,
      isController: true,
      marketPriceUsd: 1,
      borrowedValueUsd: 50,
      liquidity: {
        vaultAddress: borrowVault,
        vault: borrowVaultEntity,
        unitOfAccount: borrowVault,
        daysToLiquidation: 'Infinity',
        liabilityValue: { borrowing: 50n * WAD, liquidation: 50n * WAD, oracleMid: 50n * WAD },
        totalCollateralValue: { borrowing: 80n * WAD, liquidation: 90n * WAD, oracleMid: 100n * WAD },
        collaterals: [{
          address: vault,
          vault: sourceVault,
          value: { borrowing: 80n * WAD, liquidation: 90n * WAD, oracleMid: 100n * WAD },
          marketPriceUsd: 1,
          valueUsd: 100,
        }],
        liabilityValueUsd: 50,
        totalCollateralValueUsd: 100,
      },
    }),
  }
}

class PrototypeBorrowVault {
  address = borrowVault
  asset = { address: borrowVault, symbol: 'DEBT', decimals: 6 }
  shares = { decimals: 6 }
  marketPriceUsd = 1
  collaterals?: { address: Address, marketPriceUsd?: number }[]

  constructor(collaterals?: { address: Address, marketPriceUsd?: number }[]) {
    this.collaterals = collaterals
  }

  getCollateralRiskPrice() {
    return { priceBorrowing: WAD, priceLiquidation: WAD }
  }
}

const accountWithPositions = (
  positions: IAccountPosition<IHasVaultAddress>[],
  enabledCollaterals: Address[] = [vault],
  enabledControllers: Address[] = [borrowVault],
) => new Account<IHasVaultAddress>({
  chainId: 1,
  owner,
  subAccounts: {
    [subAccount]: {
      timestamp: 0,
      account: subAccount,
      owner,
      lastAccountStatusCheckTimestamp: 0,
      enabledControllers,
      enabledCollaterals,
      positions,
    },
  },
  populated: { vaults: true, marketPrices: true, userRewards: true },
})

const stubBatchComposableGlobals = () => {
  vi.stubGlobal('useWagmi', () => ({ address: ref(owner), chainId: ref(1) }))
  vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false), spyAddress: ref(undefined) }))
  vi.stubGlobal('useEffectiveAddress', () => ({
    address: ref(owner),
    isConnected: ref(true),
    isSpyMode: ref(false),
    spyAddress: ref(undefined),
    effectiveAddress: ref(owner),
  }))
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  vi.stubGlobal('useReviewedExecution', () => executionMocks)
  vi.stubGlobal('useExternalMigrationRefresh', () => ({ scheduleExternalMigrationRefreshes }))
  vi.stubGlobal('useTokenList', () => ({
    getTokenByAddress: vi.fn(),
  }))
}

const createMockSdk = () => ({
  accountService: {
    fetchAccount: vi.fn(async () => ({
      result: accountWithPosition(subAccount, subAccount, 1n),
      errors: [],
    })),
  },
  executionService: {
    mergePlans: vi.fn((plans: TransactionPlan[]) => plans.flat()),
    simulateTransactionPlan: vi.fn(async () => ({
      simulatedAccounts: [accountWithPosition(subAccount, subAccount, 2n)],
      simulatedWalletBalances: [],
      simulatedVaults: [],
      failedBatchItems: [],
      insufficientWalletAssets: [],
    })),
  },
  portfolioService: {
    buildPortfolio: vi.fn((account: Account<IHasVaultAddress>) => new Portfolio(account)),
  },
  walletService: {
    fetchWallet: vi.fn(),
  },
})

beforeEach(() => {
  vi.restoreAllMocks()
  executionMocks.compilePreview.mockClear()
  executionMocks.compilePreviewForSimulation.mockClear()
  executionMocks.prepare.mockClear()
  executionMocks.prepareReadOnly.mockClear()
  scheduleExternalMigrationRefreshes.mockReset()
  testIntentPlans.clear()
  testIntentSequence = 0
  stubBatchComposableGlobals()
  vi.mocked(getEulerSdkFresh).mockResolvedValue(createMockSdk() as never)
  resetBatchPrefetchState()
  useTxBatch().clearBatch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('stitchAccount', () => {
  it('merges simulated sub-accounts by canonical address key', () => {
    const base = accountWithPosition(subAccount, subAccount, 1n)
    const touched = accountWithPosition(
      subAccount.toLowerCase() as Address,
      subAccount.toLowerCase() as Address,
      2n,
    )

    const stitched = stitchAccount(base, touched)

    expect(Object.keys(stitched.subAccounts)).toEqual([subAccount])
    expect(stitched.getSubAccount(subAccount)?.positions).toHaveLength(1)
    expect(stitched.getSubAccount(subAccount)?.positions[0]?.shares).toBe(2n)
  })

  it('rehydrates partial borrow liquidity after stitching untouched collateral', () => {
    const base = accountWithPositions([
      collateralPosition(100_000_000n),
      borrowPosition(50_000_000n, 100),
    ])
    const touched = accountWithPositions([
      borrowPosition(25_000_000n, 0, false),
    ])

    const stitched = stitchAccount(base, touched)
    const borrow = stitched.getPosition(subAccount, borrowVault)
    const portfolio = new Portfolio(stitched)

    expect(borrow?.liquidity?.totalCollateralValueUsd).toBe(100)
    expect(borrow?.liquidity?.collaterals[0]?.valueUsd).toBe(100)
    expect(portfolio.borrows[0]?.totalCollateralValueUsd).toBe(100)
    expect(portfolio.netAssetValueUsd).toBe(75)
  })

  it('recomputes borrow collateral USD totals when a touched collateral keeps only balances', () => {
    const base = accountWithPositions([
      collateralPosition(100_000_000n),
      borrowPosition(50_000_000n, 100),
    ])
    const touched = accountWithPositions([
      collateralPosition(80_000_000n, false),
    ])

    const stitched = stitchAccount(base, touched)
    const collateral = stitched.getPosition(subAccount, vault)
    const borrow = stitched.getPosition(subAccount, borrowVault)
    const portfolio = new Portfolio(stitched)

    expect(collateral?.vault).toBeDefined()
    expect(collateral?.suppliedValueUsd).toBe(80)
    expect(borrow?.liquidity?.totalCollateralValueUsd).toBe(80)
    expect(portfolio.borrows[0]?.totalCollateralValueUsd).toBe(80)
    expect(portfolio.netAssetValueUsd).toBe(30)
  })

  it('keeps simulated controller risk values when untouched collateral USD data is absent from the touched slice', () => {
    const collateralVault = pricedVault(vault, 'COLLATERAL')
    const borrowVaultEntity = pricedVault(borrowVault, 'DEBT', 1, [{
      address: vault,
      borrowLTV: 0.8,
      liquidationLTV: 0.9,
      vault: collateralVault,
    }])
    const authoritativeLiquidity: IAccountLiquidity<IHasVaultAddress> = {
      vaultAddress: borrowVault,
      vault: borrowVaultEntity,
      unitOfAccount: borrowVault,
      daysToLiquidation: 'Infinity',
      liabilityValue: { borrowing: 50n * WAD, liquidation: 50n * WAD, oracleMid: 50n * WAD },
      totalCollateralValue: { borrowing: 640n * WAD, liquidation: 720n * WAD, oracleMid: 800n * WAD },
      collaterals: [{
        address: vault,
        vault: collateralVault,
        value: { borrowing: 640n * WAD, liquidation: 720n * WAD, oracleMid: 800n * WAD },
        marketPriceUsd: 1,
        valueUsd: 100,
      }],
      liabilityValueUsd: 50,
      totalCollateralValueUsd: 100,
    }
    const base = accountWithPositions([
      { ...collateralPosition(100_000_000n), vault: collateralVault },
      pricedPosition({
        vaultAddress: borrowVault,
        vault: borrowVaultEntity,
        borrowed: 50_000_000n,
        isController: true,
        marketPriceUsd: 1,
        borrowedValueUsd: 50,
        liquidity: authoritativeLiquidity,
      }),
    ])
    const touched = accountWithPositions([
      pricedPosition({
        vaultAddress: targetVault,
        vault: pricedVault(targetVault, 'TARGET'),
        shares: 10_000n,
        assets: 10_000n,
        suppliedValueUsd: 0.01,
      }),
      pricedPosition({
        vaultAddress: borrowVault,
        vault: borrowVaultEntity,
        borrowed: 50_000_000n,
        isController: true,
        marketPriceUsd: 1,
        borrowedValueUsd: 50,
        liquidity: {
          ...authoritativeLiquidity,
          collaterals: authoritativeLiquidity.collaterals.map(collateral => ({
            ...collateral,
            // The simulation only populated USD values for positions in its
            // touched slice. The on-chain oracle values above are still final.
            valueUsd: 0,
          })),
          totalCollateralValueUsd: 0,
        },
      }),
    ])

    const stitched = stitchAccount(base, touched)
    const stitchedBorrow = stitched.getPosition(subAccount, borrowVault)

    expect(stitchedBorrow?.liquidity?.totalCollateralValue).toEqual(authoritativeLiquidity.totalCollateralValue)
    expect(stitchedBorrow?.liquidity?.collaterals[0]?.value).toEqual(authoritativeLiquidity.collaterals[0]?.value)
    expect(stitchedBorrow?.liquidity?.collaterals[0]?.valueUsd).toBe(100)
    expect(stitched.getSubAccount(subAccount)?.healthFactor).toBe(14_400_000_000_000_000_000n)
  })

  it('keeps borrow collateral USD total unknown when any included collateral has no USD value', () => {
    const knownCollateralVault = pricedVault(vault, 'USDC')
    const borrowVaultEntity = pricedVault(borrowVault, 'DEBT', 1, [
      { address: targetVault },
      { address: vault, marketPriceUsd: 1, vault: knownCollateralVault },
    ])
    const unknownCollateral = pricedPosition({
      vaultAddress: targetVault,
      shares: 10_000_000n,
      assets: 10_000_000n,
      borrowed: 0n,
      isCollateral: true,
    })
    const borrow = pricedPosition({
      vaultAddress: borrowVault,
      vault: borrowVaultEntity,
      shares: 0n,
      assets: 0n,
      borrowed: 50_000_000n,
      isController: true,
      marketPriceUsd: 1,
      borrowedValueUsd: 50,
      liquidity: {
        vaultAddress: borrowVault,
        vault: borrowVaultEntity,
        unitOfAccount: borrowVault,
        daysToLiquidation: 'Infinity',
        liabilityValue: { borrowing: 50n * WAD, liquidation: 50n * WAD, oracleMid: 50n * WAD },
        totalCollateralValue: { borrowing: 90n * WAD, liquidation: 90n * WAD, oracleMid: 90n * WAD },
        collaterals: [
          {
            address: targetVault,
            value: { borrowing: 10n * WAD, liquidation: 10n * WAD, oracleMid: 10n * WAD },
          },
          {
            address: vault,
            vault: knownCollateralVault,
            value: { borrowing: 80n * WAD, liquidation: 80n * WAD, oracleMid: 80n * WAD },
            marketPriceUsd: 1,
            valueUsd: 100,
          },
        ],
        liabilityValueUsd: 50,
        totalCollateralValueUsd: 100,
      },
    })
    const base = accountWithPositions([
      unknownCollateral,
      collateralPosition(100_000_000n),
      borrow,
    ], [targetVault, vault], [borrowVault])
    const touched = accountWithPositions([
      collateralPosition(80_000_000n),
    ], [targetVault, vault], [borrowVault])

    const stitched = stitchAccount(base, touched)
    const stitchedBorrow = stitched.getPosition(subAccount, borrowVault)

    expect(stitchedBorrow?.liquidity?.collaterals[0]?.valueUsd).toBeUndefined()
    expect(stitchedBorrow?.liquidity?.collaterals[1]?.valueUsd).toBe(80)
    expect(stitchedBorrow?.liquidity?.totalCollateralValueUsd).toBeUndefined()
  })

  it('hydrates newly enabled collateral into existing borrow liquidity', () => {
    const { sourceVault, destinationVault, borrow } = riskAwareBorrowPosition()
    const base = accountWithPositions([
      {
        ...collateralPosition(100_000_000n),
        vault: sourceVault,
      },
      borrow,
    ])
    const touched = accountWithPositions([
      {
        ...collateralPosition(90_000_000n),
        vault: sourceVault,
      },
      pricedPosition({
        vaultAddress: targetVault,
        vault: destinationVault,
        shares: 10_000_000n,
        assets: 10_000_000n,
        borrowed: 0n,
        isCollateral: true,
        marketPriceUsd: 1,
        suppliedValueUsd: 10,
      }),
    ], [vault, targetVault], [borrowVault])

    const stitched = stitchAccount(base, touched)
    const stitchedBorrow = stitched.getPosition(subAccount, borrowVault)
    const portfolio = new Portfolio(stitched)

    expect(stitchedBorrow?.liquidity?.collaterals.map(collateral => getAddress(collateral.address))).toEqual([
      vault,
      targetVault,
    ])
    expect(stitchedBorrow?.liquidity?.totalCollateralValue).toEqual({
      borrowing: 79n * WAD,
      liquidation: 86n * WAD,
      oracleMid: 100n * WAD,
    })
    expect(stitched.getSubAccount(subAccount)?.healthFactor).toBe(1720000000000000000n)
    expect(portfolio.borrows[0]?.collateralVaults).toEqual([vault, targetVault])
    expect(portfolio.borrows[0]?.healthFactor).toBe(1720000000000000000n)
  })

  it('omits a pre-existing enabled-but-empty collateral from simulated borrow liquidity', () => {
    // `vault` is a funded collateral; `targetVault` is a leftover EVC enablement
    // with no balance and no entry in the borrow's lens collaterals. A plain
    // repay leaves the enabled set unchanged, so `targetVault` is enabled both
    // before and after the batch. It must NOT surface as a zero-value collateral
    // row — only collaterals newly enabled by the batch are added unconditionally.
    const base = accountWithPositions(
      [collateralPosition(100_000_000n), borrowPosition(50_000_000n, 100)],
      [vault, targetVault],
      [borrowVault],
    )
    const touched = accountWithPositions(
      [borrowPosition(25_000_000n, 100)],
      [vault, targetVault],
      [borrowVault],
    )

    const stitched = stitchAccount(base, touched)
    const stitchedBorrow = stitched.getPosition(subAccount, borrowVault)

    expect(stitchedBorrow?.liquidity?.collaterals.map(collateral => getAddress(collateral.address))).toEqual([vault])
    expect(stitchedBorrow?.liquidity?.totalCollateralValueUsd).toBe(100)
  })

  it('never lists the borrow vault as its own collateral', () => {
    // The EVC can have the borrow vault enabled as a collateral. Its own borrow
    // position carries debt, so it passes hasPositionValue — but a vault is never
    // its own collateral (the controller grants it no LTV; the lens omits it), so
    // it must not appear as a spurious zero-value collateral row.
    const base = accountWithPositions(
      [collateralPosition(100_000_000n), borrowPosition(50_000_000n, 100)],
      [vault, borrowVault],
      [borrowVault],
    )
    const touched = accountWithPositions(
      [borrowPosition(25_000_000n, 100)],
      [vault, borrowVault],
      [borrowVault],
    )

    const stitched = stitchAccount(base, touched)
    const stitchedBorrow = stitched.getPosition(subAccount, borrowVault)

    expect(stitchedBorrow?.liquidity?.collaterals.map(collateral => getAddress(collateral.address))).toEqual([vault])
  })

  it('scales existing collateral but does not value newly enabled collateral when risk prices are unavailable', () => {
    const { sourceVault, destinationVault, borrow } = riskAwareBorrowPosition(false)
    const base = accountWithPositions([
      {
        ...collateralPosition(100_000_000n),
        vault: sourceVault,
      },
      borrow,
    ])
    const touched = accountWithPositions([
      {
        ...collateralPosition(90_000_000n),
        vault: sourceVault,
      },
      pricedPosition({
        vaultAddress: targetVault,
        vault: destinationVault,
        shares: 10_000_000n,
        assets: 10_000_000n,
        borrowed: 0n,
        isCollateral: true,
        marketPriceUsd: 1,
        suppliedValueUsd: 10,
      }),
    ], [vault, targetVault], [borrowVault])

    const stitched = stitchAccount(base, touched)
    const stitchedBorrow = stitched.getPosition(subAccount, borrowVault)
    const portfolio = new Portfolio(stitched)

    expect(stitchedBorrow?.liquidity?.collaterals.map(collateral => getAddress(collateral.address))).toEqual([
      vault,
      targetVault,
    ])
    expect(stitchedBorrow?.liquidity?.totalCollateralValue).toEqual({
      borrowing: 72n * WAD,
      liquidation: 81n * WAD,
      oracleMid: 90n * WAD,
    })
    expect(stitchedBorrow?.liquidity?.collaterals[1]?.value).toEqual({
      borrowing: 0n,
      liquidation: 0n,
      oracleMid: 0n,
    })
    expect(stitched.getSubAccount(subAccount)?.healthFactor).toBe(1620000000000000000n)
    expect(portfolio.borrows[0]?.collateralVaults).toEqual([vault, targetVault])
    expect(portfolio.borrows[0]?.healthFactor).toBe(1620000000000000000n)
  })

  it('preserves borrow-vault collateral price edges from the full account snapshot', () => {
    const base = accountWithPositions([
      collateralPosition(100_000_000n),
      borrowPosition(50_000_000n, 100),
    ])
    const touched = accountWithPositions([
      borrowPosition(25_000_000n, 100, false, false),
    ])

    const stitched = stitchAccount(base, touched)
    const borrow = stitched.getPosition(subAccount, borrowVault) as IAccountPosition<IHasVaultAddress> & {
      vault?: { collaterals?: { address: Address, marketPriceUsd?: number }[] }
    } | undefined
    const collateralPriceEdge = borrow?.vault?.collaterals?.find(edge =>
      getAddress(edge.address) === vault,
    )

    expect(collateralPriceEdge?.marketPriceUsd).toBe(1)
  })

  it('preserves SDK vault prototype methods when patching missing price metadata', () => {
    const baseBorrowVault = new PrototypeBorrowVault([{ address: vault, marketPriceUsd: 1 }])
    const touchedBorrowVault = new PrototypeBorrowVault()
    const base = accountWithPositions([
      collateralPosition(100_000_000n),
      {
        ...borrowPosition(50_000_000n, 100),
        vault: baseBorrowVault,
      },
    ])
    const touched = accountWithPositions([
      {
        ...borrowPosition(25_000_000n, 100, false, false),
        vault: touchedBorrowVault,
      },
    ])

    const stitched = stitchAccount(base, touched)
    const borrow = stitched.getPosition(subAccount, borrowVault) as IAccountPosition<IHasVaultAddress> & {
      vault?: { getCollateralRiskPrice?: () => unknown, collaterals?: { address: Address, marketPriceUsd?: number }[] }
    } | undefined

    expect(borrow?.vault).toBeInstanceOf(PrototypeBorrowVault)
    expect(borrow?.vault?.getCollateralRiskPrice?.()).toEqual({ priceBorrowing: WAD, priceLiquidation: WAD })
    expect(borrow?.vault?.collaterals?.[0]?.marketPriceUsd).toBe(1)
  })
})

describe('fetchBaseAccountSnapshot', () => {
  it('uses the same full population path as the normal portfolio read', async () => {
    const expected = accountWithPosition(subAccount, subAccount, 1n)
    const fetchAccount = vi.fn(async () => ({ result: expected, errors: [] }))
    const sdk = {
      accountService: { fetchAccount },
    } as unknown as Parameters<typeof fetchBaseAccountSnapshot>[0]

    const result = await fetchBaseAccountSnapshot(sdk, 1, owner)

    expect(result).toBe(expected)
    expect(fetchAccount).toHaveBeenCalledWith(1, owner, { populateAll: true })
  })
})

describe('buildWalletChanges', () => {
  it('uses simulated balance deltas', () => {
    const token = getAddress('0x2000000000000000000000000000000000000000').toLowerCase()

    const changes = buildWalletChanges(
      { [token]: 15n },
      { [token]: 10n },
      { [token]: { symbol: 'USDC', decimals: 6 } },
    )

    expect(changes).toEqual([{ token, symbol: 'USDC', decimals: 6, delta: 5n }])
  })
})

describe('buildWalletBalanceLayers', () => {
  it('includes tokens that first appear after a later withdraw layer', () => {
    const token = getAddress('0x2000000000000000000000000000000000000000').toLowerCase()

    const layers = buildWalletBalanceLayers([
      {},
      {},
      { [token]: 42n },
    ], { [token]: 0n })

    expect(layers).toEqual([
      { [token]: 0n },
      { [token]: 0n },
      { [token]: 42n },
    ])
  })
})

describe('normalizeSimulatedVaultLayers', () => {
  const afterFirst = [{ id: 'after-first' }]
  const afterSecond = [{ id: 'after-second' }]
  const afterThird = [{ id: 'after-third' }]

  it('accepts absent, per-operation, and base-inclusive cardinalities', () => {
    expect(normalizeSimulatedVaultLayers([], 2)).toEqual([])
    expect(normalizeSimulatedVaultLayers([afterFirst, afterSecond], 2)).toEqual([
      [],
      afterFirst,
      afterSecond,
    ])
    expect(normalizeSimulatedVaultLayers([[], afterFirst, afterSecond], 2)).toEqual([
      [],
      afterFirst,
      afterSecond,
    ])
  })

  it('rejects final-only and partial non-empty layers for multi-operation batches', () => {
    expect(normalizeSimulatedVaultLayers([afterSecond], 2)).toBeNull()
    expect(normalizeSimulatedVaultLayers([afterFirst, afterSecond], 3)).toBeNull()
    expect(normalizeSimulatedVaultLayers([afterFirst, afterSecond, afterThird], 4)).toBeNull()
  })
})

describe('countPlanOperations / buildOperationEntryMap', () => {
  const opPlan = (operations: number, looseItems = 0): TransactionPlan => [{
    type: 'evcBatch',
    items: [
      ...Array.from({ length: operations }, (_, i) => ({ type: 'operation', name: `op-${i}`, items: [] })),
      ...Array.from({ length: looseItems }, () => ({ targetContract: '0x1', onBehalfOfAccount: '0x2', value: 0n, data: '0x' })),
    ],
  }] as unknown as TransactionPlan

  it('counts named operations and loose items alike, mirroring the SDK', () => {
    expect(countPlanOperations(opPlan(2))).toBe(2)
    expect(countPlanOperations(opPlan(1, 1))).toBe(2)
    expect(countPlanOperations([] as TransactionPlan)).toBe(0)
  })

  it('maps single-op entries without plugins one-to-one', () => {
    const map = buildOperationEntryMap([opPlan(1), opPlan(1)], 2)!
    expect(map.pluginOperations).toBe(0)
    expect(map.entryLayerIndices).toEqual([1, 2])
    expect(map.entryOfOperation(0)).toBe(0)
    expect(map.entryOfOperation(1)).toBe(1)
  })

  it('assigns plugin prefix operations to no entry and shifts the rest', () => {
    const map = buildOperationEntryMap([opPlan(1), opPlan(1)], 3)!
    expect(map.pluginOperations).toBe(1)
    expect(map.entryLayerIndices).toEqual([2, 3])
    expect(map.entryOfOperation(0)).toBeNull()
    expect(map.entryOfOperation(1)).toBe(0)
    expect(map.entryOfOperation(2)).toBe(1)
  })

  it('handles multi-operation entries (collateral+debt refinance)', () => {
    const map = buildOperationEntryMap([opPlan(2), opPlan(1)], 4)!
    expect(map.pluginOperations).toBe(1)
    expect(map.entryLayerIndices).toEqual([3, 4])
    expect(map.entryOfOperation(0)).toBeNull()
    expect(map.entryOfOperation(1)).toBe(0)
    expect(map.entryOfOperation(2)).toBe(0)
    expect(map.entryOfOperation(3)).toBe(1)
  })

  it('returns null when the simulated plan has fewer operations than the entries', () => {
    expect(buildOperationEntryMap([opPlan(2)], 1)).toBeNull()
  })

  it('rejects out-of-range operation indices', () => {
    const map = buildOperationEntryMap([opPlan(1)], 2)!
    expect(map.entryOfOperation(2)).toBeNull()
    expect(map.entryOfOperation(-1)).toBeNull()
  })
})

describe('useTxBatch execution errors', () => {
  it('reuses the prefetched portfolio account as layer 0 for account-free entries', async () => {
    const sdk = createMockSdk()
    const portfolioAccount = accountWithPosition(subAccount, subAccount, 22n)
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    setBatchPrefetchedBaseAccount(portfolioAccount)

    await useTxBatch().addEntry({
      intent: intentFor([] as TransactionPlan),
      label: 'Claim reward',
    })
    await vi.waitFor(() =>
      expect(sdk.executionService.simulateTransactionPlan).toHaveBeenCalled(),
    )

    expect(sdk.accountService.fetchAccount).not.toHaveBeenCalled()
    expect(sdk.executionService.simulateTransactionPlan).toHaveBeenCalledWith(
      1,
      owner,
      [],
      expect.any(Object),
    )
    expect(useTxBatch().layers.value[0]?.account).toBe(portfolioAccount)
  })

  it('reuses prefetched accounts for the first entry without an add-time account fetch', async () => {
    const sdk = createMockSdk()
    const planningAccount = accountWithPosition(subAccount, subAccount, 11n)
    const portfolioAccount = accountWithPosition(subAccount, subAccount, 22n)
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    setBatchPrefetchedPlanningAccount(planningAccount)
    setBatchPrefetchedBaseAccount(portfolioAccount)

    await useTxBatch().addEntry({
      intent: intentFor([] as TransactionPlan, [subAccount]),
      label: 'Supply USDC',
      subAccount,
    })
    await vi.waitFor(() =>
      expect(sdk.executionService.simulateTransactionPlan).toHaveBeenCalled(),
    )

    // The plan builds against the fresh planning account; layer 0 stays the
    // enriched portfolio account. Neither costs a populateAll fetchAccount.
    expect(executionMocks.compilePreview).toHaveBeenCalledWith(expect.any(Array), planningAccount)
    expect(sdk.accountService.fetchAccount).not.toHaveBeenCalled()
    expect(useTxBatch().layers.value[0]?.account).toBe(portfolioAccount)
  })

  it('simulates a gasless migration without its placeholder signature call', async () => {
    const sdk = createMockSdk()
    const reviewedPlan = [{ type: 'evcBatch', items: [{ data: '0xstub' }] }] as unknown as TransactionPlan
    const planWithoutSignatureCall = [{ type: 'evcBatch', items: [{ data: '0xcore' }] }] as unknown as TransactionPlan
    const migrationStateOverrides = [{
      address: vault,
      stateDiff: [{
        slot: `0x${'00'.repeat(32)}` as `0x${string}`,
        value: `0x${'00'.repeat(31)}01` as `0x${string}`,
      }],
    }]
    const intent = intentFor(reviewedPlan, [subAccount])
    executionMocks.compilePreviewForSimulation.mockResolvedValueOnce({
      reviewedPlan,
      plan: planWithoutSignatureCall,
      migrationStateOverrides,
    })
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)

    await useTxBatch().addEntry({ intent, label: 'Migrate USDC/WETH', subAccount })
    await vi.waitFor(() => expect(sdk.executionService.simulateTransactionPlan).toHaveBeenCalled())

    expect(useTxBatch().entries.value[0]?.plan).toBe(planWithoutSignatureCall)
    expect(useTxBatch().entries.value[0]?.stateOverrides).toEqual(migrationStateOverrides)
    expect(sdk.executionService.simulateTransactionPlan).toHaveBeenCalledWith(
      1,
      owner,
      planWithoutSignatureCall,
      expect.objectContaining({ extraStateOverrides: migrationStateOverrides }),
    )
  })

  it('passes chain-matched form slot hints into the first batch simulation', async () => {
    const sdk = createMockSdk()
    const planningAccount = accountWithPosition(subAccount, subAccount, 11n)
    const portfolioAccount = accountWithPosition(subAccount, subAccount, 22n)
    const approvalToken = getAddress('0x2000000000000000000000000000000000000001')
    const approvalPlan = [{
      type: 'requiredApproval',
      token: approvalToken,
      owner,
      spender: vault,
      amount: 1n,
    }] as TransactionPlan
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    setBatchPrefetchedPlanningAccount(planningAccount)
    setBatchPrefetchedBaseAccount(portfolioAccount)
    mergeBatchPrefetchedSlotHints(1, {
      [approvalToken]: {
        balanceSlotIndex: 9n,
        allowanceSlotIndex: 10n,
      },
    })

    await useTxBatch().addEntry({
      intent: intentFor(approvalPlan, [subAccount]),
      label: 'Supply USDC',
      subAccount,
    })
    await vi.waitFor(() =>
      expect(sdk.executionService.simulateTransactionPlan).toHaveBeenCalled(),
    )

    expect(sdk.executionService.simulateTransactionPlan).toHaveBeenCalledWith(
      1,
      owner,
      approvalPlan,
      expect.objectContaining({
        stateOverrideOptions: {
          slotHints: {
            [approvalToken]: {
              balanceSlotIndex: 9n,
              allowanceSlotIndex: 10n,
            },
          },
        },
      }),
    )
  })

  it('ignores prefetched accounts from another chain', async () => {
    const sdk = createMockSdk()
    const staleAccount = accountWithPosition(subAccount, subAccount, 99n)
    staleAccount.chainId = 8453
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    setBatchPrefetchedPlanningAccount(staleAccount)
    setBatchPrefetchedBaseAccount(staleAccount)

    await useTxBatch().addEntry({
      intent: intentFor([] as TransactionPlan, [subAccount]),
      label: 'Deposit USDC',
      subAccount,
    })

    expect(sdk.accountService.fetchAccount).toHaveBeenCalledWith(1, owner, {
      populateAll: true,
    })
    expect(executionMocks.compilePreview).toHaveBeenCalledWith(expect.any(Array), expect.not.objectContaining({ chainId: 8453 }))
  })

  it('ignores prefetched accounts belonging to another owner', async () => {
    const sdk = createMockSdk()
    const otherOwnerAccount = accountWithPosition(subAccount, subAccount, 99n)
    otherOwnerAccount.owner = getAddress('0x2000000000000000000000000000000000000002')
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    setBatchPrefetchedPlanningAccount(otherOwnerAccount)
    setBatchPrefetchedBaseAccount(otherOwnerAccount)

    // A wallet switch replaces the loaders' accounts asynchronously, so the batch
    // can observe the previous wallet's snapshot with the new owner already active.
    await useTxBatch().addEntry({
      intent: intentFor([] as TransactionPlan, [subAccount]),
      label: 'Deposit USDC',
      subAccount,
    })

    expect(sdk.accountService.fetchAccount).toHaveBeenCalledWith(1, owner, {
      populateAll: true,
    })
    expect(executionMocks.compilePreview).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ owner }))
  })

  it('publishes per-layer simulated vault state even without an enriched account position', async () => {
    const sdk = createMockSdk()
    const simulatedVault = {
      ...pricedVault(vault, 'USDC'),
      totalCash: 900n,
      totalBorrowed: 450n,
    }
    sdk.executionService.simulateTransactionPlan.mockResolvedValue({
      simulatedAccounts: [accountWithPosition(subAccount, subAccount, 2n)],
      simulatedVaultsLayers: [[simulatedVault]],
      simulatedWalletBalances: [],
      simulatedVaults: [simulatedVault],
      failedBatchItems: [],
      insufficientWalletAssets: [],
    } as never)
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)

    await useTxBatch().addEntry({
      intent: intentFor([] as TransactionPlan, [subAccount]),
      label: 'Withdraw USDC',
      subAccount,
    })

    expect(activeLayerVaultsRef.value[vault.toLowerCase()]).toBe(simulatedVault)
  })

  const singleOperationPlan = (name: string): TransactionPlan => [{
    type: 'evcBatch',
    items: [{ type: 'operation', name, items: [] }],
  }] as unknown as TransactionPlan

  it('folds plugin-prepended simulation layers into the base layer (ToS registration)', async () => {
    const sdk = createMockSdk()
    // Base + the loose ToS-registration item's layer + the entry's layer: the
    // layered simulation emits one layer per operation (any top-level batch
    // unit), so an account whose ToS acceptance has not landed on-chain gets
    // entries + 2 layers. Without the boundary map, getCurrentFinalLayer never
    // finds its entries + 1 final layer and the cart dies with "Batch
    // simulation not loaded" after the retry budget.
    sdk.executionService.simulateTransactionPlan.mockResolvedValue({
      simulatedAccounts: [
        accountWithPosition(subAccount, subAccount, 1n),
        accountWithPosition(subAccount, subAccount, 1n),
        accountWithPosition(subAccount, subAccount, 5n),
      ],
      simulatedVaultsLayers: [],
      simulatedWalletBalances: [],
      simulatedVaults: [],
      failedBatchItems: [],
      insufficientWalletAssets: [],
    } as never)
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    const batch = useTxBatch()

    await batch.addEntry({
      intent: intentFor(singleOperationPlan('supply'), [subAccount]),
      label: 'Supply USDC',
      subAccount,
    })

    await vi.waitFor(() => expect(batch.layers.value).toHaveLength(2))
    expect(batch.simError.value).toBeUndefined()
    expect(batch.activeLayer.value).toBe(1)
  })

  it('marks the failing first entry when a plugin operation precedes it', async () => {
    const sdk = createMockSdk()
    // ToS prefix shifts operationIndex: the first entry's operation is
    // index 1, and its failure must mark row 0 (layers[1]), not slide onto
    // the following row or vanish.
    sdk.executionService.simulateTransactionPlan.mockResolvedValue({
      simulatedAccounts: [
        accountWithPosition(subAccount, subAccount, 1n),
        accountWithPosition(subAccount, subAccount, 1n),
        accountWithPosition(subAccount, subAccount, 5n),
      ],
      simulatedVaultsLayers: [],
      simulatedWalletBalances: [],
      simulatedVaults: [],
      failedBatchItems: [{ index: 3, operationIndex: 1, error: '0x' }],
      insufficientWalletAssets: [],
    } as never)
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    const batch = useTxBatch()

    await batch.addEntry({
      intent: intentFor(singleOperationPlan('supply'), [subAccount]),
      label: 'Supply USDC',
      subAccount,
    })

    await vi.waitFor(() => expect(batch.layers.value).toHaveLength(2))
    expect(batch.layers.value[1]?.failed).toBe(true)
  })

  it('blocks the batch when a plugin operation itself fails', async () => {
    const sdk = createMockSdk()
    sdk.executionService.simulateTransactionPlan.mockResolvedValue({
      simulatedAccounts: [
        accountWithPosition(subAccount, subAccount, 1n),
        accountWithPosition(subAccount, subAccount, 1n),
        accountWithPosition(subAccount, subAccount, 5n),
      ],
      simulatedVaultsLayers: [],
      simulatedWalletBalances: [],
      simulatedVaults: [],
      failedBatchItems: [{ index: 0, operationIndex: 0, error: '0x' }],
      insufficientWalletAssets: [],
    } as never)
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    const batch = useTxBatch()

    await batch.addEntry({
      intent: intentFor(singleOperationPlan('supply'), [subAccount]),
      label: 'Supply USDC',
      subAccount,
    })

    await vi.waitFor(() => expect(batch.layers.value).toHaveLength(2))
    // Belongs to no row, so it must block at batch level instead of leaving
    // the Execute gate green.
    expect(batch.layers.value[1]?.failed).toBe(false)
    expect(batch.simError.value).toBeDefined()
  })

  it('simulates a reverting batch on Tenderly from the diagnostic preview when preparation is unavailable', async () => {
    const baseSdk = createMockSdk()
    const sdk = {
      ...baseSdk,
      deploymentService: {
        getDeployment: vi.fn(() => ({ addresses: { coreAddrs: { evc: targetVault } } })),
      },
      executionService: {
        ...baseSdk.executionService,
        encodeBatch: vi.fn(() => '0xfeed'),
        deriveStateOverrides: vi.fn(async () => []),
      },
    }
    const diagnosticPlan = [{
      type: 'evcBatch',
      items: [{
        targetContract: vault,
        onBehalfOfAccount: subAccount,
        value: 0n,
        data: '0x1234',
      }],
    }] as unknown as TransactionPlan
    sdk.executionService.simulateTransactionPlan.mockResolvedValue({
      simulatedAccounts: [accountWithPosition(subAccount, subAccount, 2n)],
      simulatedWalletBalances: [],
      simulatedVaults: [],
      failedBatchItems: [],
      insufficientWalletAssets: [],
      accountStatusErrors: [{
        account: subAccount,
        error: '0x',
        decoded: [{ signature: 'E_OutstandingDebt()', params: [] }],
      }],
    } as never)
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    const tenderlyFetch = vi.fn(async () => ({ url: 'https://dashboard.tenderly.co/simulator/example' }))
    vi.stubGlobal('$fetch', tenderlyFetch)
    const batch = useTxBatch()

    await batch.addEntry({
      intent: intentFor(diagnosticPlan, [subAccount]),
      label: 'Repay cbBTC',
      subAccount,
    })
    await vi.waitFor(() => expect(batch.simError.value).toContain('OutstandingDebt'))
    await vi.waitFor(() => expect(executionMocks.prepare).toHaveBeenCalledTimes(1))
    const preparationCallsBeforeTenderly = executionMocks.prepare.mock.calls.length

    await batch.simulateOnTenderly()

    expect(executionMocks.prepare).toHaveBeenCalledTimes(preparationCallsBeforeTenderly)
    expect(tenderlyFetch).toHaveBeenCalledWith('/api/internal/tenderly/simulate', {
      method: 'POST',
      body: {
        chainId: 1,
        from: owner,
        to: targetVault,
        data: '0xfeed',
        value: '0',
        stateOverrides: [],
      },
    })
    expect(sdk.executionService.deriveStateOverrides).toHaveBeenCalledWith(1, owner, diagnosticPlan)
    expect(batch.tenderlyUrl.value).toBe('https://dashboard.tenderly.co/simulator/example')
  })

  it('uses the migration simulation projection for Tenderly when a reviewed preview is prepared', async () => {
    const encodeBatch = (items: EVCBatchItem[]) => encodeFunctionData({ abi: EVC_ABI, functionName: 'batch', args: [items] })
    const grantItem: EVCBatchItem = {
      targetContract: vault,
      onBehalfOfAccount: subAccount,
      value: 0n,
      data: '0x11111111',
    }
    const coreItem: EVCBatchItem = {
      targetContract: borrowVault,
      onBehalfOfAccount: subAccount,
      value: 0n,
      data: '0x22222222',
    }
    const revokeItem: EVCBatchItem = {
      targetContract: vault,
      onBehalfOfAccount: subAccount,
      value: 0n,
      data: '0x33333333',
    }
    const reviewedPlan = [{ type: 'evcBatch', items: [grantItem, coreItem, revokeItem] }] as unknown as TransactionPlan
    const simulationPlan = [{ type: 'evcBatch', items: [coreItem] }] as unknown as TransactionPlan
    const migrationStateOverrides = [{
      address: vault,
      stateDiff: [{ slot: toHex(1n, { size: 32 }), value: toHex(2n, { size: 32 }) }],
    }] as StateOverride
    executionMocks.compilePreviewForSimulation.mockResolvedValueOnce({
      reviewedPlan,
      plan: simulationPlan,
      migrationStateOverrides,
    })

    const baseSdk = createMockSdk()
    const sdk = {
      ...baseSdk,
      deploymentService: {
        getDeployment: vi.fn(() => ({ addresses: { coreAddrs: { evc: targetVault } } })),
      },
      executionService: {
        ...baseSdk.executionService,
        encodeBatch: vi.fn(encodeBatch),
        deriveStateOverrides: vi.fn(async () => []),
      },
    }
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    const tenderlyFetch = vi.fn(async () => ({ url: 'https://dashboard.tenderly.co/simulator/migration' }))
    vi.stubGlobal('$fetch', tenderlyFetch)
    const batch = useTxBatch()

    await batch.addEntry({
      intent: intentFor(reviewedPlan, [subAccount]),
      label: 'Migrate AERO/USDC',
      subAccount,
    })
    await vi.waitFor(() => expect(batch.getMergedPlan()).toEqual(simulationPlan))

    const requestId = keccak256(toHex('migration-request'))
    const effectId = keccak256(toHex('migration-effect'))
    const slotAt = (batchItemIndex: number, suffix: string): SignatureSlot => ({
      slotId: keccak256(toHex(`migration-slot-${suffix}`)),
      kind: 'migration',
      signer: owner,
      chainId: 1,
      typedData: {},
      typedDataHash: keccak256(toHex(`migration-typed-data-${suffix}`)),
      insertionPoints: [{ requestId, effectId, batchItemIndex, abiArgumentPath: ['signature'] }],
    })
    const prepared = {
      previewPlan: reviewedPlan,
      execution: {
        requestSet: {
          wallet: { account: owner, chainId: 1 },
          requests: [{
            requestId,
            effectIds: [effectId],
            phase: 'core',
            chainId: 1,
            from: owner,
            to: targetVault,
            data: encodeBatch([grantItem, coreItem, revokeItem]),
            value: 0n,
          }],
          signatureSlots: [slotAt(0, 'grant'), slotAt(2, 'revoke')],
        },
      },
    }

    await batch.simulateOnTenderly(prepared as never)

    expect(tenderlyFetch).toHaveBeenCalledWith('/api/internal/tenderly/simulate', {
      method: 'POST',
      body: {
        chainId: 1,
        from: owner,
        to: targetVault,
        data: encodeBatch([coreItem]),
        value: '0',
        stateOverrides: [{
          address: vault,
          stateDiff: [{ slot: toHex(1n, { size: 32 }), value: toHex(2n, { size: 32 }) }],
        }],
      },
    })
    expect(sdk.executionService.deriveStateOverrides).toHaveBeenCalledWith(1, owner, simulationPlan)
  })

  it('selects the last layer of a multi-operation entry (refinance)', async () => {
    const sdk = createMockSdk()
    const multiOpPlan = [{
      type: 'evcBatch',
      items: [
        { type: 'operation', name: 'refinance-collateral', items: [] },
        { type: 'operation', name: 'refinance-debt', items: [] },
      ],
    }] as unknown as TransactionPlan
    sdk.executionService.simulateTransactionPlan.mockResolvedValue({
      simulatedAccounts: [
        accountWithPosition(subAccount, subAccount, 1n),
        accountWithPosition(subAccount, subAccount, 3n),
        accountWithPosition(subAccount, subAccount, 7n),
      ],
      simulatedVaultsLayers: [],
      simulatedWalletBalances: [],
      simulatedVaults: [],
      failedBatchItems: [{ index: 1, operationIndex: 0, error: '0x' }],
      insufficientWalletAssets: [],
    } as never)
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    const batch = useTxBatch()

    await batch.addEntry({
      intent: intentFor(multiOpPlan, [subAccount]),
      label: 'Refinance to USDC',
      subAccount,
    })

    // One cart row: base + the state after the entry's LAST operation.
    await vi.waitFor(() => expect(batch.layers.value).toHaveLength(2))
    expect(batch.layers.value[1]?.account.getSubAccount(subAccount)?.positions[0]?.shares).toBe(7n)
    // A failure in EITHER of the entry's operations marks its single row.
    expect(batch.layers.value[1]?.failed).toBe(true)
    expect(batch.simError.value).toBeUndefined()
  })

  it('does not apply a final-only vault snapshot to earlier layers of a multi-operation batch', async () => {
    const sdk = createMockSdk()
    const firstOperationVault = {
      ...pricedVault(vault, 'USDC'),
      totalCash: 900n,
      totalBorrowed: 450n,
    }
    const finalOnlyVault = {
      ...pricedVault(vault, 'USDC'),
      totalCash: 800n,
      totalBorrowed: 500n,
    }
    sdk.executionService.simulateTransactionPlan
      .mockResolvedValueOnce({
        simulatedAccounts: [accountWithPosition(subAccount, subAccount, 2n)],
        simulatedVaultsLayers: [[firstOperationVault]],
        simulatedWalletBalances: [],
        simulatedVaults: [firstOperationVault],
        failedBatchItems: [],
        insufficientWalletAssets: [],
      } as never)
      .mockResolvedValueOnce({
        simulatedAccounts: [
          accountWithPosition(subAccount, subAccount, 2n),
          accountWithPosition(subAccount, subAccount, 3n),
        ],
        // Unsupported final-only shape for two operations. It must not be
        // treated as the base/first layer and carried into earlier estimates.
        simulatedVaultsLayers: [[finalOnlyVault]],
        simulatedWalletBalances: [],
        simulatedVaults: [finalOnlyVault],
        failedBatchItems: [],
        insufficientWalletAssets: [],
      } as never)
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    const batch = useTxBatch()

    await batch.addEntry({
      intent: intentFor([] as TransactionPlan, [subAccount]),
      label: 'Withdraw USDC',
      subAccount,
    })
    await vi.waitFor(() => expect(activeLayerVaultsRef.value[vault.toLowerCase()]).toBe(firstOperationVault))

    await batch.addEntry({
      intent: intentFor([] as TransactionPlan, [subAccount]),
      label: 'Borrow USDC',
      subAccount,
    })
    await vi.waitFor(() => expect(batch.layers.value).toHaveLength(3))

    expect(batch.layers.value[0]?.vaults?.[vault.toLowerCase()]).toBeUndefined()
    expect(batch.layers.value[1]?.vaults?.[vault.toLowerCase()]).toBeUndefined()
    expect(activeLayerVaultsRef.value[vault.toLowerCase()]).toBeUndefined()
    expect(batch.simError.value).toBeUndefined()
  })

  it('invalidates a successful overlay when the replacement simulation rejects', async () => {
    const sdk = createMockSdk()
    const simulatedVault = {
      ...pricedVault(vault, 'USDC'),
      totalCash: 900n,
      totalBorrowed: 450n,
    }
    sdk.executionService.simulateTransactionPlan
      .mockResolvedValueOnce({
        simulatedAccounts: [accountWithPosition(subAccount, subAccount, 2n)],
        simulatedVaultsLayers: [[simulatedVault]],
        simulatedWalletBalances: [],
        simulatedVaults: [simulatedVault],
        failedBatchItems: [],
        insufficientWalletAssets: [],
      } as never)
      .mockRejectedValueOnce(new Error('replacement simulation failed'))
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    const batch = useTxBatch()

    await batch.addEntry({
      intent: intentFor([] as TransactionPlan, [subAccount]),
      label: 'Withdraw USDC',
      subAccount,
    })
    await vi.waitFor(() => expect(activeLayerVaultsRef.value[vault.toLowerCase()]).toBe(simulatedVault))

    await batch.addEntry({
      intent: intentFor([] as TransactionPlan, [subAccount]),
      label: 'Borrow USDC',
      subAccount,
    })
    await vi.waitFor(() => expect(batch.simError.value).toBe('replacement simulation failed'))

    expect(batch.entryCount.value).toBe(2)
    expect(batch.layers.value).toEqual([])
    expect(batch.activeLayer.value).toBe(0)
    expect(batch.isSimulated.value).toBe(false)
    expect(batch.getMergedPlan()).toBeNull()
    expect(activeLayerVaultsRef.value).toEqual({})
  })

  it('can dismiss a failed execution message without clearing the cart', () => {
    const batch = useTxBatch()
    batch.execError.value = 'User rejected the request.'

    batch.dismissExecutionError()

    expect(batch.execError.value).toBeUndefined()
  })

  it('publishes an exact serializable draft before preview preparation settles', async () => {
    const batch = useTxBatch()
    const intent = intentFor([] as TransactionPlan, [subAccount])
    let release!: () => void
    executionMocks.compilePreview.mockImplementationOnce(() => new Promise<TransactionPlan>((resolve) => {
      release = () => resolve([])
    }))

    const adding = batch.addEntry({ intent, label: 'Supply USDC', subAccount, review: { type: 'supply' } })

    expect(batch.draftEntries.value).toEqual([{ intentId: intent.intentId, revision: 1, intent }])
    expect(Object.keys(batch.draftEntries.value[0]!)).toEqual(['intentId', 'revision', 'intent'])
    expect(batch.entries.value[0]).toMatchObject({ id: intent.intentId, label: 'Supply USDC', preparing: true })

    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await adding
    expect(batch.entries.value[0]?.preparing).toBe(false)
  })

  it('adopts the exact generation-bound whole-cart preparation warmed after add', async () => {
    const batch = useTxBatch()
    const intent = intentFor([] as TransactionPlan, [subAccount])
    const warmed = { execution: { reviewId: '0x01' }, previewPlan: [], prepared: {} }
    executionMocks.prepare.mockResolvedValue(warmed as never)

    await batch.addEntry({ intent, label: 'Supply USDC', subAccount, sourceSubAccount: owner, review: { type: 'supply' } })
    await vi.waitFor(() => expect(executionMocks.prepare).toHaveBeenCalledOnce())

    expect(executionMocks.prepare).toHaveBeenCalledWith([intent], expect.objectContaining({
      presentationInputs: [{
        id: intent.intentId,
        review: { type: 'supply' },
        subAccount,
        sourceSubAccount: owner,
      }],
    }))

    await expect(batch.prepareBatchExecutionReview()).resolves.toBe(warmed)
    expect(executionMocks.prepare).toHaveBeenCalledOnce()
  })

  it('warms and adopts read-only multi-operation batch preparation in spy mode', async () => {
    const spyMode = ref(true)
    vi.stubGlobal('useEffectiveAddress', () => ({
      address: ref(undefined),
      isConnected: ref(false),
      isSpyMode: spyMode,
      spyAddress: ref(owner),
      effectiveAddress: ref(owner),
    }))
    const batch = useTxBatch()
    const firstIntent = intentFor([] as TransactionPlan, [subAccount])
    const warmed = { execution: { reviewId: '0x01' }, previewPlan: [], prepared: {}, readOnly: true }
    executionMocks.prepareReadOnly.mockResolvedValue(warmed as never)

    await batch.addEntry({ intent: firstIntent, label: 'Repay USDC', subAccount, review: { type: 'repay' } })
    await vi.waitFor(() => expect(executionMocks.prepareReadOnly).toHaveBeenCalledOnce())
    const secondIntent = intentFor([] as TransactionPlan, [subAccount])
    await batch.addEntry({ intent: secondIntent, label: 'Repay RLUSD', subAccount, review: { type: 'repay' } })
    await vi.waitFor(() => expect(executionMocks.prepareReadOnly).toHaveBeenCalledTimes(2))

    await expect(batch.prepareBatchExecutionReview()).resolves.toBe(warmed)
    expect(executionMocks.prepare).not.toHaveBeenCalled()
    expect(executionMocks.prepareReadOnly).toHaveBeenCalledTimes(2)
  })

  it('clears failed execution messages when the batch is cleared', () => {
    const batch = useTxBatch()
    batch.execError.value = 'Execution reverted.'

    batch.clearBatch()

    expect(batch.execError.value).toBeUndefined()
  })

  it('completes a detached Safe batch using captured revisions while preserving newer edits', async () => {
    const batch = useTxBatch()
    const submittedIntent = intentFor([] as TransactionPlan, [subAccount])
    await batch.addEntry({
      intent: submittedIntent,
      label: 'Migrate USDC/WETH',
      subAccount,
      refreshExternalMigrationPositions: true,
    })
    const completion = batch.captureBatchCompletion([{
      intentId: submittedIntent.intentId,
      revision: submittedIntent.revision,
    }])
    const newerIntent = { ...submittedIntent, revision: submittedIntent.revision + 1 }
    batch.draftEntries.value = [
      ...batch.draftEntries.value,
      { intentId: newerIntent.intentId, revision: newerIntent.revision, intent: newerIntent },
    ]
    const markSucceeded = vi.fn()
    const showSuccessUi = vi.fn()

    const showPostTxUi = await finalizeSuccessfulSubmission({
      scope: {
        markSucceeded,
        suppressPostTxUi: () => true,
      },
      completeAuthoritativeState: () => batch.completeBatchExecution(completion),
      showSuccessUi,
    })

    expect(showPostTxUi).toBe(false)
    expect(markSucceeded).toHaveBeenCalledOnce()
    expect(showSuccessUi).not.toHaveBeenCalled()
    expect(batch.draftEntries.value).toEqual([{
      intentId: newerIntent.intentId,
      revision: newerIntent.revision,
      intent: newerIntent,
    }])
    expect(scheduleExternalMigrationRefreshes).toHaveBeenCalledOnce()
  })
})

describe('awaitFinalPlanningLayer', () => {
  it('returns the final layer once a superseded run is followed by a populated one', async () => {
    // attempt 0 + 1: superseded (no layer, no error); attempt 2: layer settles.
    const sequence: Array<{ account: string } | undefined> = [undefined, undefined, { account: 'final' }]
    let started = 0
    const attempts: Array<{ attempt: number, awaitedExisting: boolean, found: boolean }> = []

    const result = await awaitFinalPlanningLayer<{ account: string }>({
      getFinalLayer: () => sequence.shift(),
      getSimError: () => undefined,
      getInFlight: () => null,
      startRun: () => {
        started++
        return Promise.resolve()
      },
      onAttempt: info => attempts.push(info),
    })

    expect(result).toEqual({ account: 'final' })
    expect(started).toBe(3) // one awaited run per attempt until the layer appears
    expect(attempts).toEqual([
      { attempt: 0, awaitedExisting: false, found: false },
      { attempt: 1, awaitedExisting: false, found: false },
      { attempt: 2, awaitedExisting: false, found: true },
    ])
  })

  it('awaits an in-flight run without starting a new one', async () => {
    let started = 0
    let inFlightAwaited = false
    const inFlight = Promise.resolve().then(() => {
      inFlightAwaited = true
    })

    const result = await awaitFinalPlanningLayer<{ account: string }>({
      getFinalLayer: () => (inFlightAwaited ? { account: 'ready' } : undefined),
      getSimError: () => undefined,
      getInFlight: () => inFlight,
      startRun: () => {
        started++
        return Promise.resolve()
      },
    })

    expect(result).toEqual({ account: 'ready' })
    expect(started).toBe(0) // awaited the existing run; never kicked a fresh one
  })

  it('rejects with the real simError instead of the generic message', async () => {
    let started = 0
    await expect(awaitFinalPlanningLayer({
      getFinalLayer: () => undefined,
      getSimError: () => 'Vault status check failed',
      getInFlight: () => null,
      startRun: () => {
        started++
        return Promise.resolve()
      },
    })).rejects.toThrow('Vault status check failed')
    expect(started).toBe(1) // breaks as soon as the first run surfaces a real error
  })

  it('throws the generic error after exhausting attempts and awaits every run it starts', async () => {
    // Regression guard for the terminal-iteration race: the old loop kicked a
    // fresh resimulation on the last pass and then threw WITHOUT awaiting it,
    // preserving a tail "Batch simulation not loaded". The fixed loop starts
    // exactly one run per attempt and awaits each before falling through.
    let started = 0
    let resolved = 0

    await expect(awaitFinalPlanningLayer({
      getFinalLayer: () => undefined,
      getSimError: () => undefined,
      getInFlight: () => null,
      startRun: () => {
        started++
        return Promise.resolve().then(() => {
          resolved++
        })
      },
      maxAttempts: 3,
    })).rejects.toThrow('Batch simulation not loaded')

    expect(started).toBe(3) // no extra un-awaited run kicked on the terminal iteration
    expect(resolved).toBe(3) // every started run completed (was awaited) before the throw
  })
})
