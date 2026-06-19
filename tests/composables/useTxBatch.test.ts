import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { Account, Portfolio, type IAccountPosition, type IHasVaultAddress, type IAccountLiquidity } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'
import { buildWalletChanges, fetchBaseAccountSnapshot, stitchAccount, useTxBatch } from '~/composables/useTxBatch'

const owner = getAddress('0x1000000000000000000000000000000000000000')
const subAccount = getAddress('0x8A54C278D117854486db0F6460D901a180Fff517')
const vault = getAddress('0x797Dd80692C3B2daDAbcE8e30C07fDE5307d48A9')
const borrowVault = getAddress('0x859160Db5841E5cfB8D3f144C6b3381A85A4b410')
const targetVault = getAddress('0x3000000000000000000000000000000000000000')
const WAD = 10n ** 18n

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
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  vi.stubGlobal('useEulerTx', () => ({
    prepareTransactionPlan: vi.fn(),
    executePreparedPlan: vi.fn(),
    estimateGasForPlan: vi.fn(),
  }))
}

beforeEach(() => {
  vi.restoreAllMocks()
  stubBatchComposableGlobals()
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

describe('useTxBatch execution errors', () => {
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
})
