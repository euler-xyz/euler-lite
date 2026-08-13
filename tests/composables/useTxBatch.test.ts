import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { Account, Portfolio, type IAccountPosition, type IHasVaultAddress, type IAccountLiquidity, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address, type Hex } from 'viem'
import { getEulerSdkFresh } from '~/composables/useEulerSdk'
import { awaitFinalPlanningLayer, buildOperationEntryMap, buildWalletBalanceLayers, buildWalletChanges, countPlanOperations, fetchBaseAccountSnapshot, normalizeSimulatedVaultLayers, stitchAccount, useTxBatch } from '~/composables/useTxBatch'
import {
  mergeBatchPrefetchedSlotHints,
  resetBatchPrefetchState,
  setBatchPrefetchedBaseAccount,
  setBatchPrefetchedPlanningAccount,
} from '~/composables/batchPrefetchState'
import { activeLayerVaultsRef } from '~/composables/useLayeredVaults'
import { WalletExecutionContextChangedError } from '~/utils/walletExecutionContext'
import type { WalletExecutionContext } from '~/utils/walletExecutionContext'
import { buildBatchReviewCalldata } from '~/utils/batchReviewCalldata'

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdkFresh: vi.fn(),
}))

const owner = getAddress('0x1000000000000000000000000000000000000000')
const subAccount = getAddress('0x8A54C278D117854486db0F6460D901a180Fff517')
const vault = getAddress('0x797Dd80692C3B2daDAbcE8e30C07fDE5307d48A9')
const aToken = getAddress('0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8')
const morphoBlue = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')
const borrowVault = getAddress('0x859160Db5841E5cfB8D3f144C6b3381A85A4b410')
const targetVault = getAddress('0x3000000000000000000000000000000000000000')
const WAD = 10n ** 18n
const routeQuery: { network?: string } = { network: '1' }
const routerReplace = vi.fn()
const eulerTxMocks = {
  prepareTransactionPlan: vi.fn(),
  executePreparedPlan: vi.fn(),
  executePreparedPlanWithPlainCalls: vi.fn(),
  estimateGasForPlan: vi.fn(),
  sendPlainTransactions: vi.fn(),
}
const isSafeWalletRef = ref(false)
const walletAddressRef = ref<Address | undefined>(owner)
const walletChainIdRef = ref<number | undefined>(1)
const effectiveAddressRef = ref<Address | undefined>(owner)
const grantWalletContext: WalletExecutionContext = { account: owner, chainId: 1 }
type PlainTxSendOptions = {
  onBroadcast?: (index: number, walletContext: WalletExecutionContext) => void
  walletContext?: WalletExecutionContext
}
const broadcastAllTransactions = async (
  txs: Array<{ data: Hex }>,
  options?: PlainTxSendOptions,
) => {
  txs.forEach((_tx, index) => options?.onBroadcast?.(index, options?.walletContext ?? grantWalletContext))
  return []
}
const migrationFlowMocks = {
  restorePendingBeforeRetry: vi.fn(),
  revokeAfterSuccess: vi.fn(),
  revokeAfterAbort: vi.fn(),
  toMigrationExecutionError: vi.fn((err: unknown) => err),
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
  vi.stubGlobal('useWagmi', () => ({ address: walletAddressRef, chainId: walletChainIdRef }))
  vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false), spyAddress: ref(undefined) }))
  vi.stubGlobal('useEffectiveAddress', () => ({
    address: effectiveAddressRef,
    isConnected: ref(true),
    isSpyMode: ref(false),
    spyAddress: ref(undefined),
    effectiveAddress: effectiveAddressRef,
  }))
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  vi.stubGlobal('useEulerTx', () => eulerTxMocks)
  isSafeWalletRef.value = false
  vi.stubGlobal('useSafeWallet', () => ({ isSafeWallet: isSafeWalletRef, isSafeWalletResolved: ref(true) }))
  vi.stubGlobal('useMigrationAuthorizationFlow', () => migrationFlowMocks)
  vi.stubGlobal('useExternalMigrationRefresh', () => ({ scheduleExternalMigrationRefreshes }))
  vi.stubGlobal('useRouter', () => ({ replace: routerReplace }))
  vi.stubGlobal('useRoute', () => ({ query: routeQuery }))
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
  eulerTxMocks.prepareTransactionPlan.mockReset()
  eulerTxMocks.executePreparedPlan.mockReset()
  eulerTxMocks.executePreparedPlanWithPlainCalls.mockReset()
  eulerTxMocks.estimateGasForPlan.mockReset()
  eulerTxMocks.sendPlainTransactions.mockReset()
  eulerTxMocks.sendPlainTransactions.mockImplementation(broadcastAllTransactions)
  migrationFlowMocks.revokeAfterSuccess.mockReset()
  migrationFlowMocks.revokeAfterAbort.mockReset()
  migrationFlowMocks.restorePendingBeforeRetry.mockReset()
  migrationFlowMocks.restorePendingBeforeRetry.mockResolvedValue(true)
  scheduleExternalMigrationRefreshes.mockReset()
  routerReplace.mockReset()
  routeQuery.network = '1'
  walletAddressRef.value = owner
  walletChainIdRef.value = 1
  effectiveAddressRef.value = owner
  stubBatchComposableGlobals()
  vi.mocked(getEulerSdkFresh).mockResolvedValue(createMockSdk() as never)
  resetBatchPrefetchState()
  useTxBatch().clearBatch()
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

    // `requiresPlanningAccount: false` skips getEntryPlanningAccount entirely, so
    // this covers the addEntry preflight that seeds layer 0 on its own.
    await useTxBatch().addEntry({
      label: 'Claim reward',
      requiresPlanningAccount: false,
      buildPlan: async () => [] as TransactionPlan,
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
    let buildAccount: Account<IHasVaultAddress> | undefined
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    setBatchPrefetchedPlanningAccount(planningAccount)
    setBatchPrefetchedBaseAccount(portfolioAccount)

    await useTxBatch().addEntry({
      label: 'Supply USDC',
      buildPlan: async (account) => {
        buildAccount = account
        return [] as TransactionPlan
      },
      subAccount,
    })
    await vi.waitFor(() =>
      expect(sdk.executionService.simulateTransactionPlan).toHaveBeenCalled(),
    )

    // The plan builds against the fresh planning account; layer 0 stays the
    // enriched portfolio account. Neither costs a populateAll fetchAccount.
    expect(buildAccount).toBe(planningAccount)
    expect(sdk.accountService.fetchAccount).not.toHaveBeenCalled()
    expect(useTxBatch().layers.value[0]?.account).toBe(portfolioAccount)
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
      label: 'Supply USDC',
      buildPlan: async () => approvalPlan,
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
    let buildAccount: Account<IHasVaultAddress> | undefined
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    setBatchPrefetchedPlanningAccount(staleAccount)
    setBatchPrefetchedBaseAccount(staleAccount)

    await useTxBatch().addEntry({
      label: 'Deposit USDC',
      buildPlan: async (account) => {
        buildAccount = account
        return [] as TransactionPlan
      },
      subAccount,
    })

    expect(sdk.accountService.fetchAccount).toHaveBeenCalledWith(1, owner, {
      populateAll: true,
    })
    expect(buildAccount).not.toBe(staleAccount)
    expect(buildAccount?.chainId).toBe(1)
  })

  it('ignores prefetched accounts belonging to another owner', async () => {
    const sdk = createMockSdk()
    const otherOwnerAccount = accountWithPosition(subAccount, subAccount, 99n)
    otherOwnerAccount.owner = getAddress('0x2000000000000000000000000000000000000002')
    let buildAccount: Account<IHasVaultAddress> | undefined
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    setBatchPrefetchedPlanningAccount(otherOwnerAccount)
    setBatchPrefetchedBaseAccount(otherOwnerAccount)

    // A wallet switch replaces the loaders' accounts asynchronously, so the batch
    // can observe the previous wallet's snapshot with the new owner already active.
    await useTxBatch().addEntry({
      label: 'Deposit USDC',
      buildPlan: async (account) => {
        buildAccount = account
        return [] as TransactionPlan
      },
      subAccount,
    })

    expect(sdk.accountService.fetchAccount).toHaveBeenCalledWith(1, owner, {
      populateAll: true,
    })
    expect(buildAccount).not.toBe(otherOwnerAccount)
    expect(buildAccount?.owner).toBe(owner)
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
      label: 'Withdraw USDC',
      buildPlan: async () => [] as TransactionPlan,
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
      label: 'Supply USDC',
      buildPlan: async () => singleOperationPlan('supply'),
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
      label: 'Supply USDC',
      buildPlan: async () => singleOperationPlan('supply'),
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
      label: 'Supply USDC',
      buildPlan: async () => singleOperationPlan('supply'),
      subAccount,
    })

    await vi.waitFor(() => expect(batch.layers.value).toHaveLength(2))
    // Belongs to no row, so it must block at batch level instead of leaving
    // the Execute gate green.
    expect(batch.layers.value[1]?.failed).toBe(false)
    expect(batch.simError.value).toBeDefined()
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
      label: 'Refinance to USDC',
      buildPlan: async () => multiOpPlan,
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
      label: 'Withdraw USDC',
      buildPlan: async () => [] as TransactionPlan,
      subAccount,
    })
    await vi.waitFor(() => expect(activeLayerVaultsRef.value[vault.toLowerCase()]).toBe(firstOperationVault))

    await batch.addEntry({
      label: 'Borrow USDC',
      buildPlan: async () => [] as TransactionPlan,
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
      label: 'Withdraw USDC',
      buildPlan: async () => [] as TransactionPlan,
      subAccount,
    })
    await vi.waitFor(() => expect(activeLayerVaultsRef.value[vault.toLowerCase()]).toBe(simulatedVault))

    await batch.addEntry({
      label: 'Borrow USDC',
      buildPlan: async () => [] as TransactionPlan,
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

  it('clears failed execution messages when the batch is cleared', () => {
    const batch = useTxBatch()
    batch.execError.value = 'Execution reverted.'

    batch.clearBatch()

    expect(batch.execError.value).toBeUndefined()
  })

  it('redirects to the portfolio after a successful mined batch execution', async () => {
    const batch = useTxBatch()
    const prepared = { kind: 'prepared' }
    const plan: TransactionPlan = []
    routeQuery.network = '8453'
    eulerTxMocks.estimateGasForPlan.mockResolvedValue(undefined)
    eulerTxMocks.prepareTransactionPlan.mockResolvedValue(prepared)
    eulerTxMocks.executePreparedPlan.mockResolvedValue(undefined)

    await batch.addEntry({
      label: 'Migrate Aave position',
      buildPlan: async () => plan,
      refreshExternalMigrationPositions: true,
    })
    await batch.executeBatch()

    expect(eulerTxMocks.executePreparedPlan).toHaveBeenCalledWith(prepared)
    expect(scheduleExternalMigrationRefreshes).toHaveBeenCalledTimes(1)
    expect(batch.entryCount.value).toBe(0)
    expect(routerReplace).toHaveBeenCalledWith({
      path: '/portfolio',
      query: { network: '8453' },
    })
  })

  it('passes the pre-entry simulated account to execution plan builders', async () => {
    const sdk = createMockSdk()
    const preMigrationAccount = accountWithPosition(subAccount, subAccount, 42n)
    const finalAccount = accountWithPosition(subAccount, subAccount, 84n)
    let simulationCallCount = 0
    sdk.executionService.simulateTransactionPlan.mockImplementation(async () => {
      simulationCallCount += 1
      return {
        simulatedAccounts: simulationCallCount > 1
          ? [preMigrationAccount, finalAccount]
          : [preMigrationAccount],
        simulatedWalletBalances: [],
        simulatedVaults: [],
        failedBatchItems: [],
        insufficientWalletAssets: [],
      }
    })
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)

    const batch = useTxBatch()
    const prepared = { kind: 'prepared' }
    // Shape-faithful entry plans: one evcBatch operation each, so the
    // operation↔entry boundary map sees the same cardinality the SDK would.
    const singleOpPlan = (name: string): TransactionPlan => [{
      type: 'evcBatch',
      items: [{ type: 'operation', name, items: [] }],
    }] as unknown as TransactionPlan
    const borrowPlan = singleOpPlan('borrow')
    const migrationPreviewPlan = singleOpPlan('migration-preview')
    const migrationExecutionPlan = singleOpPlan('migration-execution')
    let executionAccount: Account<IHasVaultAddress> | undefined
    eulerTxMocks.estimateGasForPlan.mockResolvedValue(undefined)
    eulerTxMocks.prepareTransactionPlan.mockResolvedValue(prepared)
    eulerTxMocks.executePreparedPlan.mockResolvedValue(undefined)

    await batch.addEntry({
      label: 'Borrow USDT',
      buildPlan: async () => borrowPlan,
      subAccount,
    })
    await batch.addEntry({
      label: 'Migrate USDC/USDT to Aave',
      buildPlan: async () => migrationPreviewPlan,
      buildExecutionPlan: async (account) => {
        executionAccount = account
        return migrationExecutionPlan
      },
      subAccount,
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    await batch.executeBatch()

    expect(executionAccount?.getSubAccount(subAccount)?.positions[0]?.shares).toBe(42n)
    expect(sdk.executionService.mergePlans).toHaveBeenLastCalledWith([borrowPlan, migrationExecutionPlan])
  })
})

describe('useTxBatch execution prerequisites', () => {
  const grantTx = { to: aToken, data: '0xgrant' as Hex }
  const revokeTx = { to: aToken, data: '0xrevoke' as Hex }
  const trackedRevoke = (transaction: typeof revokeTx) => ({
    transaction,
    walletContext: grantWalletContext,
  })

  const addMigrationEntryWithPrerequisites = async (
    batch: ReturnType<typeof useTxBatch>,
    prerequisites: {
      preTxs: typeof grantTx[]
      walletContext: WalletExecutionContext
      postTxs: typeof revokeTx[]
      postTxsByPreTx?: Array<typeof revokeTx | undefined>
    } | undefined,
  ) => {
    await batch.addEntry({
      label: 'Migrate Aave position',
      buildPlan: async () => [] as TransactionPlan,
      buildExecutionPrerequisites: async () => prerequisites,
      refreshExternalMigrationPositions: true,
    })
  }

  const addGrantingMigrationEntry = (batch: ReturnType<typeof useTxBatch>) =>
    addMigrationEntryWithPrerequisites(batch, {
      preTxs: [grantTx],
      walletContext: grantWalletContext,
      postTxs: [revokeTx],
      postTxsByPreTx: [revokeTx],
    })

  const singleOpBundledPlan = [{
    type: 'evcBatch',
    items: [{ type: 'operation', name: 'bundled-migration', items: [] }],
  }] as unknown as TransactionPlan

  const bundledGrantStep = { index: 1, label: 'Approve aToken transfer', isSeparateTx: false }
  const bundledRevokeStep = {
    index: 1,
    label: 'Restore previous aToken approval',
    isSeparateTx: false,
    txKey: `${aToken.toLowerCase()}:0:${revokeTx.data}`,
  }

  const addBundledMigrationEntry = (batch: ReturnType<typeof useTxBatch>) =>
    batch.addEntry({
      label: 'Migrate Aave position',
      buildPlan: async () => singleOpBundledPlan,
      buildExecutionPrerequisites: async () => ({
        preTxs: [grantTx],
        walletContext: grantWalletContext,
        postTxs: [revokeTx],
        postTxsByPreTx: [revokeTx],
      }),
      buildBundledExecution: async () => ({
        plan: singleOpBundledPlan,
        grants: [grantTx],
        revokes: [revokeTx],
        grantSteps: [bundledGrantStep],
        revokeSteps: [bundledRevokeStep],
      }),
      refreshExternalMigrationPositions: true,
    })

  it('bundles grants + batch + revokes into one safe proposal', async () => {
    const sdk = createMockSdk()
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    isSafeWalletRef.value = true
    const prepared = { kind: 'prepared' }
    eulerTxMocks.prepareTransactionPlan.mockResolvedValue(prepared)
    eulerTxMocks.executePreparedPlanWithPlainCalls.mockResolvedValue({ receipts: [] })

    const batch = useTxBatch()
    await addBundledMigrationEntry(batch)
    const ceremony = await batch.prepareBundledExecution()
    await batch.executeBatch(undefined, ceremony ?? undefined)

    // Grants ride in the proposal — no standalone broadcasts, no unwind
    // bookkeeping, no standalone gas estimate against unmined grants.
    expect(eulerTxMocks.sendPlainTransactions).not.toHaveBeenCalled()
    expect(eulerTxMocks.estimateGasForPlan).not.toHaveBeenCalled()
    expect(eulerTxMocks.executePreparedPlanWithPlainCalls).toHaveBeenCalledWith(prepared, {
      before: [grantTx],
      after: [revokeTx],
    }, { allowSingleCall: true })
    expect(eulerTxMocks.executePreparedPlan).not.toHaveBeenCalled()
    // Revokes rode in the proposal — nothing standalone to send afterwards.
    expect(migrationFlowMocks.revokeAfterSuccess).not.toHaveBeenCalled()
    expect(batch.entryCount.value).toBe(0)
  })

  it('deduplicates overlapping review preparations for one cart generation', async () => {
    const sdk = createMockSdk()
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    isSafeWalletRef.value = true
    eulerTxMocks.prepareTransactionPlan.mockResolvedValue({ kind: 'prepared' })
    let resolveBundled!: (value: {
      plan: TransactionPlan
      grants: typeof grantTx[]
      revokes: typeof revokeTx[]
      grantSteps: typeof bundledGrantStep[]
      revokeSteps: typeof bundledRevokeStep[]
    }) => void
    const bundledResult = new Promise<Parameters<typeof resolveBundled>[0]>((resolve) => {
      resolveBundled = resolve
    })
    const buildBundledExecution = vi.fn(() => bundledResult)

    const batch = useTxBatch()
    await batch.addEntry({
      label: 'Migrate Aave position',
      buildPlan: async () => singleOpBundledPlan,
      buildExecutionPrerequisites: async () => undefined,
      buildBundledExecution,
    })

    const preparationA = batch.prepareBundledExecution()
    const preparationB = batch.prepareBundledExecution()
    await vi.waitFor(() => expect(buildBundledExecution).toHaveBeenCalledTimes(1))
    resolveBundled({
      plan: singleOpBundledPlan,
      grants: [grantTx],
      revokes: [revokeTx],
      grantSteps: [bundledGrantStep],
      revokeSteps: [bundledRevokeStep],
    })

    const [ceremonyA, ceremonyB] = await Promise.all([preparationA, preparationB])
    const ceremonyC = await batch.prepareBundledExecution()
    expect(ceremonyA).toBe(ceremonyB)
    expect(ceremonyC).toBe(ceremonyA)
    expect(Object.isFrozen(ceremonyA)).toBe(true)
    expect(Object.isFrozen(ceremonyA?.grants)).toBe(true)
  })

  it('invalidates the current ceremony while another entry is building', async () => {
    const sdk = createMockSdk()
    sdk.executionService.simulateTransactionPlan.mockImplementation(async (...args: unknown[]) => ({
      simulatedAccounts: Array.from(
        { length: countPlanOperations(args[2] as TransactionPlan) },
        (_, index) => accountWithPosition(subAccount, subAccount, BigInt(index + 2)),
      ),
      simulatedWalletBalances: [],
      simulatedVaults: [],
      failedBatchItems: [],
      insufficientWalletAssets: [],
    }))
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    isSafeWalletRef.value = true
    eulerTxMocks.prepareTransactionPlan.mockImplementation(async plan => ({ plan, chainId: 1, account: owner }))
    eulerTxMocks.executePreparedPlanWithPlainCalls.mockResolvedValue({ receipts: [] })

    const batch = useTxBatch()
    await addBundledMigrationEntry(batch)
    const oldCartCeremony = await batch.prepareBundledExecution()
    expect(oldCartCeremony?.reviewByEntryId).toHaveProperty(batch.entries.value[0]!.id)
    expect(Object.keys(oldCartCeremony?.reviewByEntryId ?? {})).toHaveLength(1)

    let resolveSecondPlan!: (plan: TransactionPlan) => void
    const secondPlan = new Promise<TransactionPlan>((resolve) => {
      resolveSecondPlan = resolve
    })
    const buildSecondPlan = vi.fn(() => secondPlan)
    const pendingAdd = batch.addEntry({
      label: 'Second migration',
      buildPlan: buildSecondPlan,
      buildExecutionPrerequisites: async () => undefined,
      buildBundledExecution: async () => ({
        plan: singleOpBundledPlan,
        grants: [],
        revokes: [],
        grantSteps: [],
        revokeSteps: [],
      }),
    })
    await vi.waitFor(() => expect(buildSecondPlan).toHaveBeenCalledTimes(1))

    expect(batch.isBundledExecutionCurrent(oldCartCeremony!)).toBe(false)
    await expect(batch.prepareBundledExecution()).rejects.toThrow('still being added')

    resolveSecondPlan(singleOpBundledPlan)
    await pendingAdd
    await vi.waitFor(() => expect(batch.layers.value).toHaveLength(3))

    expect(batch.entryCount.value).toBe(2)
    expect(batch.isBundledExecutionCurrent(oldCartCeremony!)).toBe(false)
    await batch.executeBatch(undefined, oldCartCeremony!)
    expect(eulerTxMocks.executePreparedPlanWithPlainCalls).not.toHaveBeenCalled()
    expect(batch.execError.value).toContain('Batch or wallet changed since review preparation')
  })

  it('keeps review unavailable until every queued add settles', async () => {
    const sdk = createMockSdk()
    sdk.executionService.simulateTransactionPlan.mockImplementation(async (...args: unknown[]) => ({
      simulatedAccounts: Array.from(
        { length: countPlanOperations(args[2] as TransactionPlan) },
        (_, index) => accountWithPosition(subAccount, subAccount, BigInt(index + 2)),
      ),
      simulatedWalletBalances: [],
      simulatedVaults: [],
      failedBatchItems: [],
      insufficientWalletAssets: [],
    }))
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    isSafeWalletRef.value = true

    let resolveFirstPlan!: (plan: TransactionPlan) => void
    let resolveSecondPlan!: (plan: TransactionPlan) => void
    const firstPlan = new Promise<TransactionPlan>((resolve) => {
      resolveFirstPlan = resolve
    })
    const secondPlan = new Promise<TransactionPlan>((resolve) => {
      resolveSecondPlan = resolve
    })
    const buildFirstPlan = vi.fn(() => firstPlan)
    const buildSecondPlan = vi.fn(() => secondPlan)
    const bundled = async () => ({
      plan: singleOpBundledPlan,
      grants: [],
      revokes: [],
      grantSteps: [],
      revokeSteps: [],
    })

    const batch = useTxBatch()
    const firstAdd = batch.addEntry({
      label: 'First migration',
      buildPlan: buildFirstPlan,
      requiresPlanningAccount: false,
      buildExecutionPrerequisites: async () => undefined,
      buildBundledExecution: bundled,
    })
    await vi.waitFor(() => expect(buildFirstPlan).toHaveBeenCalledTimes(1))
    const secondAdd = batch.addEntry({
      label: 'Second migration',
      buildPlan: buildSecondPlan,
      requiresPlanningAccount: false,
      buildExecutionPrerequisites: async () => undefined,
      buildBundledExecution: bundled,
    })

    resolveFirstPlan(singleOpBundledPlan)
    await firstAdd
    await vi.waitFor(() => expect(buildSecondPlan).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(batch.layers.value).toHaveLength(2))

    expect(batch.entryCount.value).toBe(1)
    expect(batch.hasPendingAdds.value).toBe(true)
    expect(batch.canExecuteBatch.value).toBe(false)
    await expect(batch.prepareBundledExecution()).rejects.toThrow('still being added')
    await batch.executeBatch()
    expect(eulerTxMocks.executePreparedPlanWithPlainCalls).not.toHaveBeenCalled()
    expect(eulerTxMocks.executePreparedPlan).not.toHaveBeenCalled()

    resolveSecondPlan(singleOpBundledPlan)
    await secondAdd
    await vi.waitFor(() => expect(batch.layers.value).toHaveLength(3))

    expect(batch.hasPendingAdds.value).toBe(false)
    const ceremony = await batch.prepareBundledExecution()
    expect(Object.keys(ceremony?.reviewByEntryId ?? {})).toHaveLength(2)
  })

  it.each([
    ['account', async () => {
      effectiveAddressRef.value = getAddress('0x2000000000000000000000000000000000000000')
      await nextTick()
    }],
    ['chain', async () => {
      walletChainIdRef.value = 2
      await nextTick()
    }],
    ['account switch away and back', async () => {
      effectiveAddressRef.value = getAddress('0x2000000000000000000000000000000000000000')
      await nextTick()
      effectiveAddressRef.value = owner
      await nextTick()
    }],
  ])('rejects a plan built across an %s change', async (_label, changeContext) => {
    let resolvePlan!: (plan: TransactionPlan) => void
    const deferredPlan = new Promise<TransactionPlan>((resolve) => {
      resolvePlan = resolve
    })
    const buildPlan = vi.fn(() => deferredPlan)
    const batch = useTxBatch()
    const pendingAdd = batch.addEntry({
      label: 'Context-bound operation',
      buildPlan,
      requiresPlanningAccount: false,
    })
    await vi.waitFor(() => expect(buildPlan).toHaveBeenCalledTimes(1))

    await changeContext()
    resolvePlan(singleOpBundledPlan)

    await expect(pendingAdd).rejects.toThrow('Wallet or batch changed while adding this operation')
    expect(batch.entryCount.value).toBe(0)
    expect(batch.hasPendingAdds.value).toBe(false)
  })

  it.each(['clear', 'remove'] as const)('rejects a pending plan after a cart %s', async (edit) => {
    const batch = useTxBatch()
    await addBundledMigrationEntry(batch)

    let resolvePlan!: (plan: TransactionPlan) => void
    const deferredPlan = new Promise<TransactionPlan>((resolve) => {
      resolvePlan = resolve
    })
    const buildPlan = vi.fn(() => deferredPlan)
    const pendingAdd = batch.addEntry({
      label: 'Pending migration',
      buildPlan,
      requiresPlanningAccount: false,
    })
    await vi.waitFor(() => expect(buildPlan).toHaveBeenCalledTimes(1))

    if (edit === 'clear') batch.clearBatch()
    else batch.removeEntry(batch.entries.value[0]!.id)
    resolvePlan(singleOpBundledPlan)

    await expect(pendingAdd).rejects.toThrow('Wallet or batch changed while adding this operation')
    expect(batch.entryCount.value).toBe(0)
    expect(batch.hasPendingAdds.value).toBe(false)
  })

  it('rejects an older preparation that resolves after a new cart ceremony', async () => {
    const sdk = createMockSdk()
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    isSafeWalletRef.value = true
    eulerTxMocks.prepareTransactionPlan.mockImplementation(async plan => ({ plan }))
    let resolveOld!: (value: {
      plan: TransactionPlan
      grants: typeof grantTx[]
      revokes: typeof revokeTx[]
      grantSteps: typeof bundledGrantStep[]
      revokeSteps: typeof bundledRevokeStep[]
    }) => void
    const oldResult = new Promise<Parameters<typeof resolveOld>[0]>((resolve) => {
      resolveOld = resolve
    })
    const buildOld = vi.fn(() => oldResult)

    const batch = useTxBatch()
    await batch.addEntry({
      label: 'Old migration',
      buildPlan: async () => singleOpBundledPlan,
      buildExecutionPrerequisites: async () => undefined,
      buildBundledExecution: buildOld,
    })
    const oldPreparation = batch.prepareBundledExecution()
    await vi.waitFor(() => expect(buildOld).toHaveBeenCalledTimes(1))

    batch.clearBatch()
    const newGrant = { to: morphoBlue, data: '0xnewgrant' as Hex }
    await batch.addEntry({
      label: 'New migration',
      buildPlan: async () => singleOpBundledPlan,
      buildExecutionPrerequisites: async () => undefined,
      buildBundledExecution: async () => ({
        plan: singleOpBundledPlan,
        grants: [newGrant],
        revokes: [],
        grantSteps: [],
        revokeSteps: [],
      }),
    })
    const newCeremony = await batch.prepareBundledExecution()

    resolveOld({
      plan: singleOpBundledPlan,
      grants: [grantTx],
      revokes: [revokeTx],
      grantSteps: [bundledGrantStep],
      revokeSteps: [bundledRevokeStep],
    })

    await expect(oldPreparation).rejects.toThrow('Batch or wallet changed since review preparation')
    expect(newCeremony?.grants).toEqual([newGrant])
    expect(batch.isBundledExecutionCurrent(newCeremony!)).toBe(true)
  })

  it('rejects preparation that finishes after the account changes', async () => {
    const sdk = createMockSdk()
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    isSafeWalletRef.value = true
    eulerTxMocks.prepareTransactionPlan.mockResolvedValue({ kind: 'prepared' })
    let resolveBundled!: (value: {
      plan: TransactionPlan
      grants: typeof grantTx[]
      revokes: typeof revokeTx[]
      grantSteps: typeof bundledGrantStep[]
      revokeSteps: typeof bundledRevokeStep[]
    }) => void
    const bundledResult = new Promise<Parameters<typeof resolveBundled>[0]>((resolve) => {
      resolveBundled = resolve
    })
    const buildBundledExecution = vi.fn(() => bundledResult)

    const batch = useTxBatch()
    await batch.addEntry({
      label: 'Migrate Aave position',
      buildPlan: async () => singleOpBundledPlan,
      buildExecutionPrerequisites: async () => undefined,
      buildBundledExecution,
    })
    const preparation = batch.prepareBundledExecution()
    await vi.waitFor(() => expect(buildBundledExecution).toHaveBeenCalledTimes(1))

    const nextOwner = getAddress('0x9000000000000000000000000000000000000009')
    effectiveAddressRef.value = nextOwner
    walletAddressRef.value = nextOwner
    resolveBundled({
      plan: singleOpBundledPlan,
      grants: [grantTx],
      revokes: [revokeTx],
      grantSteps: [bundledGrantStep],
      revokeSteps: [bundledRevokeStep],
    })

    await expect(preparation).rejects.toThrow('Batch or wallet changed since review preparation')
  })

  it('uses one prepared core plan for review export and safe execution', async () => {
    const sdk = createMockSdk()
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    isSafeWalletRef.value = true
    const previewPlan = [{
      type: 'evcBatch',
      items: [{ type: 'operation', name: 'stale-preview', items: [] }],
    }] as unknown as TransactionPlan
    const latchedPlan = [{
      type: 'evcBatch',
      items: [{ type: 'operation', name: 'fresh-latched-execution', items: [] }],
    }] as unknown as TransactionPlan
    const latchedPrepared = { plan: latchedPlan, chainId: 1, account: owner }
    eulerTxMocks.prepareTransactionPlan.mockResolvedValue(latchedPrepared)
    eulerTxMocks.executePreparedPlanWithPlainCalls.mockResolvedValue({ receipts: [] })

    const batch = useTxBatch()
    await batch.addEntry({
      label: 'Migrate Aave position',
      buildPlan: async () => previewPlan,
      buildExecutionPrerequisites: async () => ({
        preTxs: [grantTx],
        walletContext: grantWalletContext,
        postTxs: [revokeTx],
        postTxsByPreTx: [revokeTx],
      }),
      buildBundledExecution: async () => ({
        plan: latchedPlan,
        grants: [grantTx],
        revokes: [revokeTx],
        grantSteps: [bundledGrantStep],
        revokeSteps: [bundledRevokeStep],
      }),
    })

    const ceremony = await batch.prepareBundledExecution()
    const entryId = batch.entries.value[0]!.id
    await batch.executeBatch(undefined, ceremony ?? undefined)

    expect(eulerTxMocks.prepareTransactionPlan).toHaveBeenCalledTimes(1)
    expect(eulerTxMocks.prepareTransactionPlan).toHaveBeenCalledWith(latchedPlan)
    expect(ceremony?.prepared).toBe(latchedPrepared)
    expect(ceremony?.reviewByEntryId[entryId]?.plan).toBe(latchedPlan)
    expect(eulerTxMocks.executePreparedPlanWithPlainCalls).toHaveBeenCalledWith(latchedPrepared, {
      before: [grantTx],
      after: [revokeTx],
    }, { allowSingleCall: true })
  })

  it('keeps copied and submitted before, prepared plugin/approval/core, after vectors identical', async () => {
    const sdk = createMockSdk()
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    isSafeWalletRef.value = true
    const plugin = getAddress('0x2000000000000000000000000000000000000002')
    const pingAbi = [{
      type: 'function',
      name: 'ping',
      inputs: [],
      outputs: [],
      stateMutability: 'payable',
    }] as const
    const preparedPlan = [{
      type: 'contractCall',
      chainId: 1,
      to: plugin,
      abi: pingAbi,
      functionName: 'ping',
      args: [],
      value: 7n,
    }, {
      type: 'requiredApproval',
      token: aToken,
      owner,
      spender: vault,
      amount: 9n,
      resolved: [{ type: 'approve', token: aToken, data: '0xapprove' as Hex }],
    }, {
      type: 'evcBatch',
      items: [{ targetContract: vault, onBehalfOfAccount: owner, value: 11n, data: '0xcore' as Hex }],
    }] as unknown as TransactionPlan
    const prepared = { plan: preparedPlan, chainId: 1, account: owner }
    const encodingSdk = {
      deploymentService: {
        getDeployment: () => ({ addresses: { coreAddrs: { evc: vault } } }),
      },
      executionService: { encodeBatch: () => '0xbatch' as Hex },
    }
    eulerTxMocks.prepareTransactionPlan.mockResolvedValue(prepared)
    let submittedVector: ReturnType<typeof buildBatchReviewCalldata> | undefined
    eulerTxMocks.executePreparedPlanWithPlainCalls.mockImplementation(async (submittedPrepared, wrappers) => {
      submittedVector = buildBatchReviewCalldata({
        plan: submittedPrepared.plan,
        before: wrappers.before,
        after: wrappers.after,
        sdk: encodingSdk,
        chainId: 1,
      })
      return { receipts: [] }
    })

    const batch = useTxBatch()
    await addBundledMigrationEntry(batch)
    const ceremony = await batch.prepareBundledExecution()
    const copiedVector = buildBatchReviewCalldata({
      plan: ceremony!.prepared.plan,
      before: ceremony!.grants,
      after: ceremony!.revokes,
      sdk: encodingSdk,
      chainId: 1,
    })
    await batch.executeBatch(undefined, ceremony!)

    expect(submittedVector).toEqual(copiedVector)
    expect(submittedVector?.map(call => call.to)).toEqual([
      grantTx.to,
      plugin,
      aToken,
      vault,
      revokeTx.to,
    ])
  })

  it('throws instead of degrading when the safe bundle context is unavailable', async () => {
    const sdk = createMockSdk()
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    isSafeWalletRef.value = true
    eulerTxMocks.prepareTransactionPlan.mockResolvedValue({ kind: 'prepared' })
    eulerTxMocks.executePreparedPlanWithPlainCalls.mockResolvedValue(undefined)

    const batch = useTxBatch()
    await addBundledMigrationEntry(batch)
    const ceremony = await batch.prepareBundledExecution()
    await batch.executeBatch(undefined, ceremony ?? undefined)

    expect(batch.execError.value).toBeTruthy()
    // Nothing broadcast standalone, nothing to unwind, cart retained.
    expect(eulerTxMocks.sendPlainTransactions).not.toHaveBeenCalled()
    expect(migrationFlowMocks.revokeAfterAbort).toHaveBeenCalledWith([])
    expect(batch.entryCount.value).toBe(1)
  })

  it('bundles a latched ceremony even when its grants resolved empty', async () => {
    const sdk = createMockSdk()
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    isSafeWalletRef.value = true
    const prepared = { kind: 'prepared' }
    eulerTxMocks.prepareTransactionPlan.mockResolvedValue(prepared)
    eulerTxMocks.executePreparedPlanWithPlainCalls.mockResolvedValue({ receipts: [] })

    const batch = useTxBatch()
    await batch.addEntry({
      label: 'Migrate Aave position',
      buildPlan: async () => singleOpBundledPlan,
      buildExecutionPrerequisites: async () => undefined,
      // Grant already live: nothing to wrap — but the reviewed ceremony is
      // still ONE provider-bound proposal, never a silent executePreparedPlan
      // whose internals could degrade to sequential sends.
      buildBundledExecution: async () => ({ plan: singleOpBundledPlan, grants: [], revokes: [], grantSteps: [], revokeSteps: [] }),
    })
    const ceremony = await batch.prepareBundledExecution()
    await batch.executeBatch(undefined, ceremony ?? undefined)

    expect(eulerTxMocks.executePreparedPlanWithPlainCalls).toHaveBeenCalledWith(prepared, {
      before: [],
      after: [],
    }, { allowSingleCall: true })
    expect(eulerTxMocks.executePreparedPlan).not.toHaveBeenCalled()
  })

  it('latches per-entry review rows from the bundled resolution', async () => {
    const sdk = createMockSdk()
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    isSafeWalletRef.value = true

    const batch = useTxBatch()
    await addBundledMigrationEntry(batch)
    const latched = await batch.prepareBundledExecution()

    // The modal renders THESE rows — derived from the same authorization
    // resolution the proposal executes — never the add-time captures, which
    // can be stale by the time the review opens.
    const entryId = batch.entries.value[0]!.id
    expect(latched?.reviewByEntryId[entryId]).toEqual({
      plan: singleOpBundledPlan,
      grantSteps: [bundledGrantStep],
      revokeSteps: [bundledRevokeStep],
    })
  })

  it('keeps duplicate bundled restoration rows in parity with proposal calls', async () => {
    const sdk = createMockSdk()
    sdk.executionService.simulateTransactionPlan.mockImplementation(async (...args: unknown[]) => ({
      simulatedAccounts: Array.from(
        { length: countPlanOperations(args[2] as TransactionPlan) },
        (_, index) => accountWithPosition(subAccount, subAccount, BigInt(index + 2)),
      ),
      simulatedWalletBalances: [],
      simulatedVaults: [],
      failedBatchItems: [],
      insufficientWalletAssets: [],
    }))
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    isSafeWalletRef.value = true

    const batch = useTxBatch()
    await addBundledMigrationEntry(batch)
    await addBundledMigrationEntry(batch)
    await vi.waitFor(() => expect(batch.layers.value).toHaveLength(3))
    const latched = await batch.prepareBundledExecution()

    expect(latched?.revokes).toEqual([revokeTx, revokeTx])
    expect(Object.values(latched?.reviewByEntryId ?? {}).flatMap(review => review.revokeSteps)).toEqual([
      bundledRevokeStep,
      bundledRevokeStep,
    ])
  })

  it('throws a re-review error when the wallet stopped being a safe after latching', async () => {
    const sdk = createMockSdk()
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    isSafeWalletRef.value = true
    eulerTxMocks.prepareTransactionPlan.mockResolvedValue({ kind: 'prepared' })

    const batch = useTxBatch()
    await addBundledMigrationEntry(batch)
    const ceremony = await batch.prepareBundledExecution()
    // Safe disconnected between review and confirm.
    isSafeWalletRef.value = false
    await nextTick()

    expect(batch.isBundledExecutionCurrent(ceremony!)).toBe(false)
    await batch.executeBatch(undefined, ceremony ?? undefined)

    expect(batch.execError.value).toBeTruthy()
    expect(eulerTxMocks.executePreparedPlanWithPlainCalls).not.toHaveBeenCalled()
    expect(eulerTxMocks.sendPlainTransactions).not.toHaveBeenCalled()
  })

  it('keeps the sequential ceremony for non-safe wallets', async () => {
    const sdk = createMockSdk()
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    isSafeWalletRef.value = false
    eulerTxMocks.prepareTransactionPlan.mockResolvedValue({ kind: 'prepared' })
    eulerTxMocks.executePreparedPlan.mockResolvedValue(undefined)
    eulerTxMocks.sendPlainTransactions.mockImplementation(async (txs: { data: Hex }[], options?: PlainTxSendOptions) => {
      txs.forEach((_tx, index) => options?.onBroadcast?.(index, grantWalletContext))
      return []
    })

    const batch = useTxBatch()
    await addBundledMigrationEntry(batch)
    await batch.prepareBundledExecution()
    await batch.executeBatch()

    expect(eulerTxMocks.executePreparedPlanWithPlainCalls).not.toHaveBeenCalled()
    expect(eulerTxMocks.sendPlainTransactions).toHaveBeenCalled()
    expect(eulerTxMocks.executePreparedPlan).toHaveBeenCalled()
  })

  it('revokes an already-granted entry when a later entry\'s grant is rejected', async () => {
    // A two-entry batch needs a simulated account per layer, or executeBatch
    // bails before the prerequisite phase.
    const sdk = createMockSdk()
    let simulationCallCount = 0
    sdk.executionService.simulateTransactionPlan.mockImplementation(async () => {
      simulationCallCount += 1
      const account = accountWithPosition(subAccount, subAccount, 42n)
      return {
        simulatedAccounts: simulationCallCount > 1 ? [account, account] : [account],
        simulatedWalletBalances: [],
        simulatedVaults: [],
        failedBatchItems: [],
        insufficientWalletAssets: [],
      }
    })
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)

    const batch = useTxBatch()
    const secondGrantTx = { to: morphoBlue, data: '0xgrant2' as Hex }
    const secondRevokeTx = { to: morphoBlue, data: '0xrevoke2' as Hex }
    // First entry's grant lands; the second is rejected in the wallet.
    eulerTxMocks.sendPlainTransactions.mockImplementation(async (txs: { data: Hex }[], options?: PlainTxSendOptions) => {
      if (txs[0]?.data === secondGrantTx.data) throw new Error('User rejected the request.')
      txs.forEach((_tx, index) => options?.onBroadcast?.(index, grantWalletContext))
      return []
    })

    await addGrantingMigrationEntry(batch)
    await addMigrationEntryWithPrerequisites(batch, {
      preTxs: [secondGrantTx],
      walletContext: grantWalletContext,
      postTxs: [secondRevokeTx],
      postTxsByPreTx: [secondRevokeTx],
    })
    // Let the multi-entry resimulation settle so executeBatch does not bail.
    await new Promise(resolve => setTimeout(resolve, 0))
    await batch.executeBatch()

    // The first grant is mined and standing. Leaving it would orphan the
    // allowance: a retry sees it already granted, so it registers no revoke.
    expect(migrationFlowMocks.revokeAfterAbort).toHaveBeenCalledWith([trackedRevoke(revokeTx)])
    expect(eulerTxMocks.executePreparedPlan).not.toHaveBeenCalled()
    expect(batch.entryCount.value).toBe(2)
  })

  it('grants before building the plan and revokes after a successful batch', async () => {
    const batch = useTxBatch()
    const calls: string[] = []
    const sdk = createMockSdk()
    sdk.executionService.mergePlans.mockImplementation((plans: TransactionPlan[]) => {
      calls.push('mergePlans')
      return plans.flat()
    })
    vi.mocked(getEulerSdkFresh).mockResolvedValue(sdk as never)
    eulerTxMocks.sendPlainTransactions.mockImplementation(async (txs: { data: Hex }[], options?: PlainTxSendOptions) => {
      calls.push('sendPlainTransactions')
      txs.forEach((_tx, index) => options?.onBroadcast?.(index, grantWalletContext))
      return []
    })
    eulerTxMocks.estimateGasForPlan.mockImplementation(async () => void calls.push('estimateGasForPlan'))
    eulerTxMocks.prepareTransactionPlan.mockResolvedValue({ kind: 'prepared' })
    eulerTxMocks.executePreparedPlan.mockImplementation(async () => void calls.push('executePreparedPlan'))
    migrationFlowMocks.restorePendingBeforeRetry.mockImplementation(async () => {
      calls.push('restorePendingBeforeRetry')
      return true
    })
    migrationFlowMocks.revokeAfterSuccess.mockImplementation(async () => void calls.push('revokeAfterSuccess'))

    await addGrantingMigrationEntry(batch)
    // Drop what add-time preview simulation recorded; only execution order matters.
    calls.length = 0
    await batch.executeBatch()

    // The grant must be mined before the plan is built: the connector reads the
    // live allowance to decide whether the batch needs an authorization item.
    expect(calls).toEqual([
      'restorePendingBeforeRetry',
      'sendPlainTransactions',
      'mergePlans',
      'estimateGasForPlan',
      'executePreparedPlan',
      'revokeAfterSuccess',
    ])
    expect(eulerTxMocks.sendPlainTransactions).toHaveBeenCalledWith(
      [grantTx],
      expect.objectContaining({
        walletContext: grantWalletContext,
        onBroadcast: expect.any(Function),
      }),
    )
    expect(migrationFlowMocks.revokeAfterSuccess).toHaveBeenCalledWith([trackedRevoke(revokeTx)])
    expect(migrationFlowMocks.revokeAfterAbort).not.toHaveBeenCalled()
  })

  it('keeps the cart and skips execution when a grant is rejected', async () => {
    const batch = useTxBatch()
    eulerTxMocks.sendPlainTransactions.mockRejectedValue(new Error('User rejected the request.'))

    await addGrantingMigrationEntry(batch)
    await batch.executeBatch()

    expect(eulerTxMocks.executePreparedPlan).not.toHaveBeenCalled()
    expect(batch.entryCount.value).toBe(1)
    expect(batch.execError.value).toBeDefined()
    // Nothing landed, so there is nothing of ours to revoke.
    expect(migrationFlowMocks.revokeAfterAbort).toHaveBeenCalledWith([])
  })

  it('revokes a broadcast grant when receipt confirmation fails before later grants', async () => {
    const batch = useTxBatch()
    const secondGrantTx = { to: morphoBlue, data: '0xgrant2' as Hex }
    const secondRevokeTx = { to: morphoBlue, data: '0xrevoke2' as Hex }
    eulerTxMocks.sendPlainTransactions.mockImplementation(async (_txs: { data: Hex }[], options?: PlainTxSendOptions) => {
      options?.onBroadcast?.(0, grantWalletContext)
      throw new Error('Receipt provider unavailable')
    })

    await addMigrationEntryWithPrerequisites(batch, {
      preTxs: [grantTx, secondGrantTx],
      walletContext: grantWalletContext,
      postTxs: [secondRevokeTx, revokeTx],
      postTxsByPreTx: [revokeTx, secondRevokeTx],
    })
    await batch.executeBatch()

    expect(migrationFlowMocks.revokeAfterAbort).toHaveBeenCalledWith([trackedRevoke(revokeTx)])
    expect(eulerTxMocks.executePreparedPlan).not.toHaveBeenCalled()
    expect(batch.entryCount.value).toBe(1)
  })

  it.each(['account', 'chain'] as const)(
    'retains the grant context when the batch detects %s drift',
    async (kind) => {
      const batch = useTxBatch()
      eulerTxMocks.sendPlainTransactions.mockImplementation(broadcastAllTransactions)
      eulerTxMocks.estimateGasForPlan.mockResolvedValue(undefined)
      eulerTxMocks.prepareTransactionPlan.mockResolvedValue({ kind: 'prepared' })
      eulerTxMocks.executePreparedPlan.mockRejectedValue(new WalletExecutionContextChangedError(kind))

      await addGrantingMigrationEntry(batch)
      await batch.executeBatch()

      expect(migrationFlowMocks.revokeAfterAbort).toHaveBeenCalledWith([trackedRevoke(revokeTx)])
      expect(batch.entryCount.value).toBe(1)
    },
  )

  it('blocks a batch retry until failed cleanup is restored', async () => {
    const batch = useTxBatch()
    migrationFlowMocks.restorePendingBeforeRetry
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    eulerTxMocks.sendPlainTransactions.mockImplementation(broadcastAllTransactions)
    eulerTxMocks.estimateGasForPlan.mockResolvedValue(undefined)
    eulerTxMocks.prepareTransactionPlan.mockResolvedValue({ kind: 'prepared' })
    eulerTxMocks.executePreparedPlan.mockRejectedValue(new Error('User rejected the request.'))

    await addGrantingMigrationEntry(batch)
    await batch.executeBatch()
    await batch.executeBatch()

    expect(migrationFlowMocks.restorePendingBeforeRetry).toHaveBeenCalledTimes(2)
    expect(eulerTxMocks.sendPlainTransactions).toHaveBeenCalledTimes(1)
    expect(eulerTxMocks.executePreparedPlan).toHaveBeenCalledTimes(1)
    expect(migrationFlowMocks.revokeAfterAbort).toHaveBeenCalledWith([trackedRevoke(revokeTx)])
    expect(batch.entryCount.value).toBe(1)
  })

  it('sends no transactions when an entry reports no prerequisites', async () => {
    const batch = useTxBatch()
    eulerTxMocks.estimateGasForPlan.mockResolvedValue(undefined)
    eulerTxMocks.prepareTransactionPlan.mockResolvedValue({ kind: 'prepared' })
    eulerTxMocks.executePreparedPlan.mockResolvedValue(undefined)

    // An authorization already standing on-chain resolves to no prerequisite,
    // and must not be revoked — we did not grant it.
    await addMigrationEntryWithPrerequisites(batch, undefined)
    await batch.executeBatch()

    expect(eulerTxMocks.sendPlainTransactions).not.toHaveBeenCalled()
    expect(migrationFlowMocks.revokeAfterSuccess).toHaveBeenCalledWith([])
    expect(batch.entryCount.value).toBe(0)
  })

  it('still clears the batch when the revoke fails after a successful execution', async () => {
    const batch = useTxBatch()
    eulerTxMocks.sendPlainTransactions.mockImplementation(broadcastAllTransactions)
    eulerTxMocks.estimateGasForPlan.mockResolvedValue(undefined)
    eulerTxMocks.prepareTransactionPlan.mockResolvedValue({ kind: 'prepared' })
    eulerTxMocks.executePreparedPlan.mockResolvedValue(undefined)
    // revokeAfterSuccess swallows failures internally; it must never throw.
    migrationFlowMocks.revokeAfterSuccess.mockResolvedValue(undefined)

    await addGrantingMigrationEntry(batch)
    await batch.executeBatch()

    expect(batch.entryCount.value).toBe(0)
    expect(batch.execError.value).toBeUndefined()
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
