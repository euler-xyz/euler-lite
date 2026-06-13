import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { Account, Portfolio, type IAccountPosition, type IHasVaultAddress, type IAccountLiquidity } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'
import { buildWalletChanges, fetchBaseAccountSnapshot, stitchAccount, useTxBatch } from '~/composables/useTxBatch'

const owner = getAddress('0x1000000000000000000000000000000000000000')
const subAccount = getAddress('0x8A54C278D117854486db0F6460D901a180Fff517')
const vault = getAddress('0x797Dd80692C3B2daDAbcE8e30C07fDE5307d48A9')
const borrowVault = getAddress('0x859160Db5841E5cfB8D3f144C6b3381A85A4b410')

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
  collaterals?: { address: Address, marketPriceUsd?: number }[],
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
