import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { Account, Portfolio, type IAccountPosition, type IHasVaultAddress, type IAccountLiquidity, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address, type Hex } from 'viem'
import { getEulerSdkFresh } from '~/composables/useEulerSdk'
import { awaitFinalPlanningLayer, buildWalletBalanceLayers, buildWalletChanges, fetchBaseAccountSnapshot, isBatchEntryGeoBlocked, normalizeSimulatedVaultLayers, stitchAccount, useTxBatch } from '~/composables/useTxBatch'
import {
  mergeBatchPrefetchedSlotHints,
  resetBatchPrefetchState,
  setBatchPrefetchedBaseAccount,
  setBatchPrefetchedPlanningAccount,
} from '~/composables/batchPrefetchState'
import { activeLayerVaultsRef } from '~/composables/useLayeredVaults'
import { WalletExecutionContextChangedError } from '~/utils/walletExecutionContext'
import type { WalletExecutionContext } from '~/utils/walletExecutionContext'

vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdkFresh: vi.fn(),
}))

const geoPolicyMocks = vi.hoisted(() => ({
  isAssetBlockedByCountry: vi.fn((_asset?: unknown) => false),
  isAnyVaultBlockedByCountry: vi.fn((..._addresses: string[]) => false),
  isVaultBlockedByCountry: vi.fn(() => false),
  isVaultRestrictedByCountry: vi.fn(() => false),
  getVaultTags: vi.fn((_address: string, _context?: string) => ({ tags: [], disabled: false })),
}))

vi.mock('~/composables/useGeoBlock', () => geoPolicyMocks)

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
  estimateGasForPlan: vi.fn(),
  sendPlainTransactions: vi.fn(),
}
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
  vi.stubGlobal('useEulerTx', () => eulerTxMocks)
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
  geoPolicyMocks.isAnyVaultBlockedByCountry.mockReset()
  geoPolicyMocks.isAnyVaultBlockedByCountry.mockReturnValue(false)
  geoPolicyMocks.isAssetBlockedByCountry.mockReset()
  geoPolicyMocks.isAssetBlockedByCountry.mockReturnValue(false)
  geoPolicyMocks.isVaultBlockedByCountry.mockReset()
  geoPolicyMocks.isVaultBlockedByCountry.mockReturnValue(false)
  geoPolicyMocks.isVaultRestrictedByCountry.mockReset()
  geoPolicyMocks.isVaultRestrictedByCountry.mockReturnValue(false)
  geoPolicyMocks.getVaultTags.mockReset()
  geoPolicyMocks.getVaultTags.mockReturnValue({ tags: [], disabled: false })
  vi.restoreAllMocks()
  eulerTxMocks.prepareTransactionPlan.mockReset()
  eulerTxMocks.executePreparedPlan.mockReset()
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
  stubBatchComposableGlobals()
  vi.mocked(getEulerSdkFresh).mockResolvedValue(createMockSdk() as never)
  resetBatchPrefetchState()
  useTxBatch().clearBatch()
})

describe('isBatchEntryGeoBlocked', () => {
  it('checks every vault for hard blocks and target vaults for acquisition restrictions', () => {
    const source = '0x1000000000000000000000000000000000000001'
    const target = '0x2000000000000000000000000000000000000002'
    geoPolicyMocks.getVaultTags.mockImplementation(address => ({
      tags: [],
      disabled: address === target,
    }))

    expect(isBatchEntryGeoBlocked({
      review: {
        geoVaultAddresses: [source, target],
        geoTargetVaultAddresses: [target],
      },
    })).toBe(true)
    expect(geoPolicyMocks.isAnyVaultBlockedByCountry).toHaveBeenCalledWith(source, target)
    expect(geoPolicyMocks.getVaultTags).toHaveBeenCalledWith(target, 'swap-target')
  })

  it('passes the acquired asset and swap counterpart to soft-restriction policy', () => {
    const target = '0x2000000000000000000000000000000000000002'
    const asset = { address: target, symbol: 'WETH' }
    const counterpart = { address: '0x3000000000000000000000000000000000000003', symbol: 'ETH' }

    expect(isBatchEntryGeoBlocked({
      geoPolicy: [{ vaultAddress: target, asset, counterpart, acquisition: true }],
    })).toBe(false)
    expect(geoPolicyMocks.isVaultRestrictedByCountry).toHaveBeenCalledWith(target, { asset, counterpart })
  })

  it('hard-blocks the wallet input asset independently of wrap-pair exemptions', () => {
    const target = '0x2000000000000000000000000000000000000002'
    const asset = { address: target, symbol: 'WETH' }
    const inputAsset = { address: '0x3000000000000000000000000000000000000003', symbol: 'ETH' }
    geoPolicyMocks.isAssetBlockedByCountry.mockImplementation(candidate => candidate === inputAsset)

    expect(isBatchEntryGeoBlocked({
      geoPolicy: [{ vaultAddress: target, asset, inputAsset, counterpart: inputAsset, acquisition: true }],
    })).toBe(true)
    expect(geoPolicyMocks.isAssetBlockedByCountry).toHaveBeenCalledWith(inputAsset)
  })

  it('does not apply soft restrictions to direct supplies', () => {
    const target = '0x2000000000000000000000000000000000000002'
    geoPolicyMocks.isVaultRestrictedByCountry.mockReturnValue(true)

    expect(isBatchEntryGeoBlocked({
      geoPolicy: [{ vaultAddress: target, asset: { address: target } }],
    })).toBe(false)
    expect(geoPolicyMocks.isVaultRestrictedByCountry).not.toHaveBeenCalled()
  })
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
    const borrowPlan = [{ type: 'borrow' }] as unknown as TransactionPlan
    const migrationPreviewPlan = [{ type: 'migration-preview' }] as unknown as TransactionPlan
    const migrationExecutionPlan = [{ type: 'migration-execution' }] as unknown as TransactionPlan
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
