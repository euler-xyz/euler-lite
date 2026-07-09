/**
 * Golden tests for the SDK plan builders.
 *
 * For each operation type covered by `composables/useEulerTx.ts` we run the SDK
 * planner, resolve approvals against a Wallet entity that reports a maxUint256
 * allowance (the "no on-chain approval needed" path), reduce the plan to a
 * canonical [{to, data, value, evcBatch}] tx list, and assert it byte-for-byte
 * against a committed golden fixture under `plans/`.
 *
 * The fixtures are the reviewed calldata baseline — regenerate them from the
 * current SDK output with `npm run test:golden:update` and review the diff.
 *
 * Scenarios are tuned to bypass external dependencies the planners would
 * otherwise touch: Pyth feed fetch (no controllers / no liability vault), swap
 * verifier RPC (deterministic SwapApiQuote fixtures with `SkipMin` verify
 * type), and previewWithdraw (shares == assets in the seeded account).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeFunctionData, getAddress, maxUint256, toFunctionSelector, type Address } from 'viem'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'

import { ADDR, CHAIN_ID, buildSdkAccount, buildSdkExecutionService } from './harness'
import { normalizeSdkPlan, type CanonicalTx } from './normalize'
import { loadSwapFixture } from './load-fixture'
import { expectPlanMatchesGolden } from './plan-fixture'

const normalizeResolvedSdkPlan = async (
  sdkPlan: TransactionPlan,
  owner: Address = ADDR.user,
) => {
  const exec = buildSdkExecutionService()
  const resolved = await exec.resolveRequiredApprovals({
    plan: sdkPlan,
    chainId: CHAIN_ID,
    account: owner,
    usePermit2: false,
  })
  return normalizeSdkPlan(resolved, ADDR.evc)
}

// Reduce an SDK plan to canonical txs and assert it against the named fixture.
const expectGoldenPlan = async (
  name: string,
  sdkPlan: TransactionPlan,
  owner: Address = ADDR.user,
) => {
  const sdkTxs = await normalizeResolvedSdkPlan(sdkPlan, owner)
  expectPlanMatchesGolden(name, sdkTxs)
}

const evcDisableCollateralAbi = [{
  type: 'function',
  name: 'disableCollateral',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'account', type: 'address' },
    { name: 'collateral', type: 'address' },
  ],
  outputs: [],
}] as const

const evcEnableCollateralAbi = [{
  type: 'function',
  name: 'enableCollateral',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'account', type: 'address' },
    { name: 'collateral', type: 'address' },
  ],
  outputs: [],
}] as const

const evcEnableControllerAbi = [{
  type: 'function',
  name: 'enableController',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'account', type: 'address' },
    { name: 'controller', type: 'address' },
  ],
  outputs: [],
}] as const

const vaultDisableControllerAbi = [{
  type: 'function',
  name: 'disableController',
  stateMutability: 'nonpayable',
  inputs: [],
  outputs: [],
}] as const

const DISABLE_COLLATERAL_SELECTOR = toFunctionSelector(evcDisableCollateralAbi[0])
const DISABLE_CONTROLLER_SELECTOR = toFunctionSelector(vaultDisableControllerAbi[0])
const ENABLE_COLLATERAL_SELECTOR = toFunctionSelector(evcEnableCollateralAbi[0])
const ENABLE_CONTROLLER_SELECTOR = toFunctionSelector(evcEnableControllerAbi[0])

const CURRENT_STATE_OWNER = getAddress('0xcfe5660d6c55906EC8C488A466bd4f77F77eec88')
const CURRENT_STATE_SELECTED_SUB_ACCOUNT = getAddress('0xcfe5660D6c55906Ec8c488A466bd4F77f77eeC8A')
const CURRENT_STATE_OLD_CONTROLLER = getAddress('0xD8b27CF359b7D15710a5BE299AF6e7Bf904984C2')
const CURRENT_STATE_OLD_COLLATERALS = [
  getAddress('0xbC4B4AC47582c3E38Ce5940B80Da65401F4628f1'),
  getAddress('0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9'),
] as const
const CURRENT_STATE_POSITION_ASSET = ADDR.assetUsdc

const trackingEntriesToPositions = (entries: readonly string[]) => entries.map(entry => ({
  subAccount: getAddress(entry.slice(0, 42)),
  vault: getAddress(`0x${entry.slice(42)}`),
}))

const CURRENT_STATE_ACTIVE_BORROWS = trackingEntriesToPositions([
  '0xcfe5660d6c55906ec8c488a466bd4f77f77eec8ca94f9ce821c7bd57cc12991cb46ca19f5789278f',
  '0xcfe5660d6c55906ec8c488a466bd4f77f77eec8dba98fc35c9dfd69178ad5dce9fa29c64554783b5',
  '0xcfe5660d6c55906ec8c488a466bd4f77f77eec8fbc4b4ac47582c3e38ce5940b80da65401f4628f1',
  '0xcfe5660d6c55906ec8c488a466bd4f77f77eec89bc4b4ac47582c3e38ce5940b80da65401f4628f1',
])

const CURRENT_STATE_ACTIVE_DEPOSITS = trackingEntriesToPositions([
  '0xcfe5660d6c55906ec8c488a466bd4f77f77eec8805755d78cad24417c42960b93d3bf821a92e4d82',
  '0xcfe5660d6c55906ec8c488a466bd4f77f77eec88fc6600b186d5b8b2fe59667efc0a479a7ac3f1b4',
  '0xcfe5660d6c55906ec8c488a466bd4f77f77eec8ca3e0943d0196f76db58d3549c9a7528ef4ac335f',
  '0xcfe5660d6c55906ec8c488a466bd4f77f77eec8dab2726daf820aa9270d14db9b18c8d187cbf2f30',
  '0xcfe5660d6c55906ec8c488a466bd4f77f77eec88dae9216e77fef9cfae15b57783d99c99b66de0d1',
  '0xcfe5660d6c55906ec8c488a466bd4f77f77eec88313603fa690301b0caeef8069c065862f9162162',
  '0xcfe5660d6c55906ec8c488a466bd4f77f77eec8f797dd80692c3b2dadabce8e30c07fde5307d48a9',
  '0xcfe5660d6c55906ec8c488a466bd4f77f77eec89797dd80692c3b2dadabce8e30c07fde5307d48a9',
])

const buildCurrentStateSdkAccount = () => buildSdkAccount({
  owner: CURRENT_STATE_OWNER,
  positions: [
    ...CURRENT_STATE_ACTIVE_BORROWS.map(({ subAccount, vault }) => ({
      subAccount,
      vault,
      asset: CURRENT_STATE_POSITION_ASSET,
      borrowed: 1n,
    })),
    ...CURRENT_STATE_ACTIVE_DEPOSITS.map(({ subAccount, vault }) => ({
      subAccount,
      vault,
      asset: CURRENT_STATE_POSITION_ASSET,
      shares: 1n,
      assets: 1n,
      isCollateral: true,
    })),
  ],
  subAccounts: [{
    subAccount: CURRENT_STATE_SELECTED_SUB_ACCOUNT,
    enabledControllers: [CURRENT_STATE_OLD_CONTROLLER],
    enabledCollaterals: [...CURRENT_STATE_OLD_COLLATERALS],
  }],
})

const getOnlyCanonicalBatch = (txs: CanonicalTx[]) => {
  const batch = txs.find(tx => tx.evcBatch)?.evcBatch
  expect(batch).toBeDefined()
  return batch!
}

const getDisabledCollaterals = (txs: CanonicalTx[]) => {
  const batch = getOnlyCanonicalBatch(txs)
  return batch
    .filter(item => item.selector === DISABLE_COLLATERAL_SELECTOR)
    .map((item) => {
      const decoded = decodeFunctionData({ abi: evcDisableCollateralAbi, data: item.data })
      return {
        targetContract: item.targetContract,
        account: getAddress(decoded.args[0]),
        collateral: getAddress(decoded.args[1]),
      }
    })
}

const expectCurrentStateControllerCleanup = (txs: CanonicalTx[]) => {
  const batch = getOnlyCanonicalBatch(txs)
  expect(batch).toEqual(expect.arrayContaining([
    expect.objectContaining({
      selector: DISABLE_CONTROLLER_SELECTOR,
      targetContract: CURRENT_STATE_OLD_CONTROLLER,
      onBehalfOfAccount: CURRENT_STATE_SELECTED_SUB_ACCOUNT,
    }),
  ]))
}

describe('golden tx-plan parity: vault.deposit', () => {
  let original: typeof globalThis.fetch
  beforeEach(() => {
    original = globalThis.fetch
    // Defensive: no scenario should make HTTP calls.
    globalThis.fetch = (async () => {
      throw new Error('fetch not allowed in golden tests')
    }) as never
  })
  afterEach(() => {
    globalThis.fetch = original
  })

  it('basic deposit to own account', async () => {
    const amount = 1_000_000n
    const sdk = buildSdkExecutionService()
    const plan = sdk.planDeposit({
      account: buildSdkAccount(),
      vault: ADDR.vaultUsdc,
      asset: ADDR.assetUsdc,
      amount,
      receiver: ADDR.user,
    })
    await expectGoldenPlan('deposit-own-account', plan)
  })

  it('deposit to sub-account', async () => {
    const amount = 2_500_000n
    const sdk = buildSdkExecutionService()
    const plan = sdk.planDeposit({
      account: buildSdkAccount(),
      vault: ADDR.vaultUsdc,
      asset: ADDR.assetUsdc,
      amount,
      receiver: ADDR.subAccount1,
    })
    await expectGoldenPlan('deposit-sub-account', plan)
  })
})

describe('golden tx-plan parity: vault.withdraw', () => {
  it('partial withdraw from own account', async () => {
    const amount = 500_000n
    const sdk = buildSdkExecutionService()
    const plan = sdk.planWithdraw({
      account: buildSdkAccount(),
      vault: ADDR.vaultUsdc,
      assets: amount,
      owner: ADDR.user,
      receiver: ADDR.user,
    })
    await expectGoldenPlan('withdraw-own-account', plan)
  })

  it('partial withdraw from sub-account', async () => {
    const amount = 750_000n
    const sdk = buildSdkExecutionService()
    const plan = sdk.planWithdraw({
      account: buildSdkAccount(),
      vault: ADDR.vaultUsdc,
      assets: amount,
      owner: ADDR.subAccount1,
      receiver: ADDR.user,
    })
    await expectGoldenPlan('withdraw-sub-account', plan)
  })
})

describe('golden tx-plan parity: vault.redeem', () => {
  it('partial redeem from sub-account', async () => {
    const amount = 1_234_567n
    const sdk = buildSdkExecutionService()
    const plan = sdk.planRedeem({
      account: buildSdkAccount(),
      vault: ADDR.vaultUsdc,
      shares: amount,
      owner: ADDR.subAccount1,
      receiver: ADDR.user,
    })
    await expectGoldenPlan('redeem-sub-account', plan)
  })

  it('full redeem (isMax) with explicit maxShares', async () => {
    const maxShares = 9_999_999n
    const sdk = buildSdkExecutionService()
    const plan = sdk.planRedeem({
      account: buildSdkAccount(),
      vault: ADDR.vaultUsdc,
      shares: maxShares,
      owner: ADDR.subAccount1,
      receiver: ADDR.user,
    })
    await expectGoldenPlan('redeem-max', plan)
  })
})

describe('golden tx-plan parity: repay.fromWallet', () => {
  const borrowed = 1_500_000n

  it('partial repay against own account', async () => {
    const amount = 500_000n
    const sdk = buildSdkExecutionService()
    const plan = sdk.planRepayFromWallet({
      account: buildSdkAccount({
        positions: [{ subAccount: ADDR.user, vault: ADDR.vaultUsdc, asset: ADDR.assetUsdc, borrowed }],
      }),
      liabilityVault: ADDR.vaultUsdc,
      liabilityAmount: amount,
      receiver: ADDR.user,
    })
    await expectGoldenPlan('repay-wallet-own-account', plan)
  })

  it('partial repay against sub-account', async () => {
    const amount = 800_000n
    const sdk = buildSdkExecutionService()
    const plan = sdk.planRepayFromWallet({
      account: buildSdkAccount({
        positions: [{ subAccount: ADDR.subAccount1, vault: ADDR.vaultUsdc, asset: ADDR.assetUsdc, borrowed }],
      }),
      liabilityVault: ADDR.vaultUsdc,
      liabilityAmount: amount,
      receiver: ADDR.subAccount1,
    })
    await expectGoldenPlan('repay-wallet-sub-account', plan)
  })

  it('full repay (max) with cleanup', async () => {
    // maxUint256 amount drives the SDK's isMax path: the approval cushion uses
    // position.borrowed and `cleanupOnMax` appends disableController + collateral
    // cleanup via appendMaxRepayCleanup.
    const sdk = buildSdkExecutionService()
    const plan = sdk.planRepayFromWallet({
      account: buildSdkAccount({
        positions: [
          { subAccount: ADDR.subAccount1, vault: ADDR.vaultUsdc, asset: ADDR.assetUsdc, borrowed, isController: true },
          { subAccount: ADDR.subAccount1, vault: ADDR.vaultDai, asset: ADDR.assetDai, shares: 2_000_000n, assets: 2_000_000n, isCollateral: true },
        ],
      }),
      liabilityVault: ADDR.vaultUsdc,
      liabilityAmount: maxUint256,
      receiver: ADDR.subAccount1,
      cleanupOnMax: true,
    })
    await expectGoldenPlan('repay-wallet-max-cleanup', plan)
  })
})

describe('golden tx-plan parity: vault.borrow (wallet collateral)', () => {
  it('borrow against a fresh sub-account using wallet collateral', async () => {
    // Fresh sub-account: the batch enables the collateral + controller, deposits
    // the wallet collateral, and borrows to the owner.
    const sdk = buildSdkExecutionService()
    const plan = sdk.planBorrow({
      account: buildSdkAccount(),
      vault: ADDR.vaultUsdt,
      amount: 100_000n,
      borrowAccount: ADDR.subAccount1,
      receiver: ADDR.user,
      collateral: { vault: ADDR.vaultWeth, amount: 1_000_000n, asset: ADDR.assetWeth },
    })
    await expectGoldenPlan('borrow-wallet-collateral', plan)
  })

  it('opens a new borrow for current 0xcfe state and cleans up the selected stale controller', async () => {
    const collateralAmount = 1_000_000n
    const borrowAmount = 100_000n

    const currentAccount = buildCurrentStateSdkAccount()
    const selectedSubAccount = currentAccount.getNewSubAccount()
    expect(selectedSubAccount).toBe(CURRENT_STATE_SELECTED_SUB_ACCOUNT)
    if (!selectedSubAccount) throw new Error('Current 0xcfe state did not select a new sub-account')
    expect(currentAccount.getSubAccount(selectedSubAccount)?.enabledControllers).toEqual([CURRENT_STATE_OLD_CONTROLLER])
    expect(currentAccount.getSubAccount(selectedSubAccount)?.enabledCollaterals).toEqual([...CURRENT_STATE_OLD_COLLATERALS])

    const sdk = buildSdkExecutionService()
    const sdkPlan = sdk.planBorrow({
      account: currentAccount,
      vault: ADDR.vaultUsdt,
      amount: borrowAmount,
      borrowAccount: selectedSubAccount,
      receiver: CURRENT_STATE_OWNER,
      collateral: {
        vault: ADDR.vaultWeth,
        amount: collateralAmount,
        asset: ADDR.assetWeth,
      },
    })
    const sdkTxs = await normalizeResolvedSdkPlan(sdkPlan, CURRENT_STATE_OWNER)

    expectCurrentStateControllerCleanup(sdkTxs)
    expect(getDisabledCollaterals(sdkTxs)).toEqual([])
  })
})

describe('golden tx-plan parity: vault.borrowBySaving', () => {
  it('borrow using an existing savings deposit as collateral', async () => {
    // Savings collateral: the existing deposit at `from` is used as collateral
    // (share source) rather than a fresh wallet deposit.
    const sdk = buildSdkExecutionService()
    const plan = sdk.planBorrow({
      account: buildSdkAccount({
        positions: [
          { subAccount: ADDR.subAccount1, vault: ADDR.vaultWeth, asset: ADDR.assetWeth, shares: 1_000_000n, assets: 1_000_000n, isCollateral: true },
        ],
      }),
      vault: ADDR.vaultUsdt,
      amount: 100_000n,
      borrowAccount: ADDR.subAccount1,
      receiver: ADDR.user,
      collateral: { vault: ADDR.vaultWeth, amount: 1_000_000n, source: 'savings', from: ADDR.subAccount1 },
    })
    await expectGoldenPlan('borrow-savings-collateral', plan)
  })
})

describe('golden tx-plan parity: repay.fromDeposit (savings)', () => {
  const borrowed = 1_500_000n
  const savingsAmount = 1_000_000n

  it('partial savings repay – same vault', async () => {
    const sdk = buildSdkExecutionService()
    const plan = sdk.planRepayFromDeposit({
      account: buildSdkAccount({
        positions: [
          { subAccount: ADDR.subAccount1, vault: ADDR.vaultUsdc, asset: ADDR.assetUsdc, borrowed },
          { subAccount: ADDR.user, vault: ADDR.vaultUsdc, asset: ADDR.assetUsdc, shares: savingsAmount, assets: savingsAmount },
        ],
      }),
      liabilityVault: ADDR.vaultUsdc,
      liabilityAmount: savingsAmount,
      receiver: ADDR.subAccount1,
      fromVault: ADDR.vaultUsdc,
      fromAccount: ADDR.user,
    })
    await expectGoldenPlan('repay-from-deposit-same-vault', plan)
  })
})

describe('golden tx-plan parity: same-asset migrations', () => {
  it('migrate collateral between same-asset vaults (partial, no enable/disable)', async () => {
    const amount = 600_000n
    const sdk = buildSdkExecutionService()
    const plan = sdk.planMigrateSameAssetCollateral({
      account: buildSdkAccount({
        positions: [
          { subAccount: ADDR.subAccount1, vault: ADDR.vaultUsdc, asset: ADDR.assetUsdc, shares: amount, assets: amount, isCollateral: true },
          // toVault also marked as collateral so SDK doesn't emit enableCollateral
          { subAccount: ADDR.subAccount1, vault: ADDR.vaultDai, asset: ADDR.assetUsdc, isCollateral: true },
        ],
      }),
      fromVault: ADDR.vaultUsdc,
      toVault: ADDR.vaultDai,
      amount,
      positionAccount: ADDR.subAccount1,
      fromAsset: ADDR.assetUsdc,
      toAsset: ADDR.assetUsdc,
      isMax: false,
      maxShares: amount,
    })
    await expectGoldenPlan('migrate-same-asset-collateral', plan)
  })

  it('merged refinance plan enables target collateral before target debt controller', async () => {
    const collateralAmount = 2_000_000n
    const debtAmount = 1_000_000n
    const account = buildSdkAccount({
      positions: [
        { subAccount: ADDR.subAccount1, vault: ADDR.vaultDai, asset: ADDR.assetUsdc, shares: collateralAmount, assets: collateralAmount, isCollateral: true },
        { subAccount: ADDR.subAccount1, vault: ADDR.vaultUsdc, asset: ADDR.assetUsdc, borrowed: debtAmount, isController: true },
      ],
    })
    const sdk = buildSdkExecutionService()
    const collateralPlan = sdk.planMigrateSameAssetCollateral({
      account,
      fromVault: ADDR.vaultDai,
      toVault: ADDR.vaultWeth,
      amount: collateralAmount,
      positionAccount: ADDR.subAccount1,
      fromAsset: ADDR.assetUsdc,
      toAsset: ADDR.assetUsdc,
      isMax: true,
    })
    const debtPlan = sdk.planMigrateSameAssetDebt({
      account,
      oldLiabilityVault: ADDR.vaultUsdc,
      newLiabilityVault: ADDR.vaultUsdt,
      liabilityAccount: ADDR.subAccount1,
      liabilityAmount: debtAmount,
      oldLiabilityAsset: ADDR.assetUsdc,
      newLiabilityAsset: ADDR.assetUsdc,
      sweepExcess: false,
    })

    const txs = await normalizeResolvedSdkPlan(sdk.mergePlans([collateralPlan, debtPlan]))
    const batch = getOnlyCanonicalBatch(txs)
    const enableCollateralIndex = batch.findIndex((item) => {
      if (item.selector !== ENABLE_COLLATERAL_SELECTOR || item.targetContract !== ADDR.evc) return false
      const decoded = decodeFunctionData({ abi: evcEnableCollateralAbi, data: item.data })
      return getAddress(decoded.args[0]) === getAddress(ADDR.subAccount1)
        && getAddress(decoded.args[1]) === getAddress(ADDR.vaultWeth)
    })
    const enableControllerIndex = batch.findIndex((item) => {
      if (item.selector !== ENABLE_CONTROLLER_SELECTOR || item.targetContract !== ADDR.evc) return false
      const decoded = decodeFunctionData({ abi: evcEnableControllerAbi, data: item.data })
      return getAddress(decoded.args[0]) === getAddress(ADDR.subAccount1)
        && getAddress(decoded.args[1]) === getAddress(ADDR.vaultUsdt)
    })

    expect(enableCollateralIndex).toBeGreaterThanOrEqual(0)
    expect(enableControllerIndex).toBeGreaterThanOrEqual(0)
    expect(enableCollateralIndex).toBeLessThan(enableControllerIndex)
  })
})

// ---------------------------------------------------------------------------
// Swap-quote scenarios — fixtures are real swap-dev.euler.finance quotes
// fetched via the SDK SwapService and committed under `fixtures/`.
// See README.md → "Setup" / `npm run test:golden:fetch-fixtures`.
// ---------------------------------------------------------------------------

describe('golden tx-plan parity: swap-quote operations', () => {
  it('planSwapCollateral / buildSwapPlan (cross-asset)', async () => {
    const { quote } = loadSwapFixture('swap-collateral-usdc-to-dai')
    const sdk = buildSdkExecutionService()
    const plan = sdk.planSwapCollateral({
      account: buildSdkAccount(),
      swapQuote: quote,
    })
    await expectGoldenPlan('swap-collateral', plan)
  })

  it('planRepayWithSwap / buildSwapPlan (isRepay collateral→debt)', async () => {
    const { request, quote } = loadSwapFixture<{ currentDebt: bigint }>('swap-repay-partial-usdc-to-dai')
    const sdk = buildSdkExecutionService()
    const plan = sdk.planRepayWithSwap({
      account: buildSdkAccount({
        positions: [
          { subAccount: ADDR.subAccount1, vault: ADDR.vaultDai, asset: ADDR.assetDai, borrowed: request.currentDebt },
          { subAccount: ADDR.subAccount1, vault: ADDR.vaultUsdc, asset: ADDR.assetUsdc, isCollateral: true },
        ],
      }),
      swapQuote: quote,
    })
    await expectGoldenPlan('repay-with-swap', plan)
  })

  it('planDepositWithSwapFromWallet / buildSwapAndSupplyPlan', async () => {
    const { quote } = loadSwapFixture('swap-wallet-deposit-usdc-to-dai')
    const sdk = buildSdkExecutionService()
    const plan = sdk.planDepositWithSwapFromWallet({
      account: buildSdkAccount(),
      swapQuote: quote,
      amount: BigInt(quote.amountIn),
      tokenIn: quote.tokenIn.address,
      // Legacy doesn't emit a separate enableCollateral step; the swap multicall
      // handles deposit and the SkimMin verify covers the receiver vault.
      enableCollateral: false,
    })
    await expectGoldenPlan('deposit-with-swap-from-wallet', plan)
  })

  it('planWithdrawAndSwap / buildWithdrawAndSwapPlan', async () => {
    const { quote } = loadSwapFixture('swap-withdraw-and-swap-usdc-to-dai')
    const sdk = buildSdkExecutionService()
    const plan = sdk.planWithdrawAndSwap({
      account: buildSdkAccount(),
      vault: quote.vaultIn,
      assets: BigInt(quote.amountIn),
      owner: quote.accountIn,
      swapQuote: quote,
    })
    await expectGoldenPlan('withdraw-and-swap', plan)
  })

  it('planSwapAndRepayFromWallet / buildSwapAndRepayPlan (partial)', async () => {
    const { request, quote } = loadSwapFixture<{ currentDebt: bigint }>('swap-wallet-repay-usdc-to-dai')
    const sdk = buildSdkExecutionService()
    const plan = sdk.planSwapAndRepayFromWallet({
      account: buildSdkAccount({
        positions: [
          { subAccount: quote.accountOut, vault: quote.receiver, asset: quote.tokenOut.address, borrowed: request.currentDebt },
        ],
      }),
      swapQuote: quote,
      amount: BigInt(quote.amountIn),
      tokenIn: quote.tokenIn.address,
    })
    await expectGoldenPlan('swap-and-repay-from-wallet', plan)
  })

  it('planRedeemAndSwap / buildRedeemAndSwapPlan', async () => {
    // Reuses the withdraw-and-swap fixture — same TransferMin verifier, only
    // the source-vault call (withdraw vs redeem) differs in selector + decimals
    // semantics. The seeded account returns shares == assets, so passing the
    // same `amountIn` as shares works.
    const { quote } = loadSwapFixture('swap-withdraw-and-swap-usdc-to-dai')
    const shares = BigInt(quote.amountIn)
    const sdk = buildSdkExecutionService()
    const plan = sdk.planRedeemAndSwap({
      account: buildSdkAccount(),
      vault: quote.vaultIn,
      shares,
      owner: quote.accountIn,
      swapQuote: quote,
    })
    await expectGoldenPlan('redeem-and-swap', plan)
  })

  it('planSwapAndBorrowFromWallet / buildSwapAndBorrowPlan', async () => {
    const { quote } = loadSwapFixture('swap-and-borrow-usdc-to-dai')
    const borrowAmount = 100_000n
    const sdk = buildSdkExecutionService()
    const plan = sdk.planSwapAndBorrowFromWallet({
      account: buildSdkAccount(),
      swapQuote: quote,
      amount: BigInt(quote.amountIn),
      tokenIn: quote.tokenIn.address,
      borrowVault: ADDR.vaultUsdt,
      borrowAmount,
      borrowAccount: quote.accountOut,
      collateralVault: quote.receiver,
      receiver: ADDR.user,
    })
    await expectGoldenPlan('swap-and-borrow-from-wallet', plan)
  })

  it('planMigrateSameAssetDebt / buildSameAssetDebtSwapPlan', async () => {
    // Same-asset debt migration — no swap quote required. The cushion is
    // encoded in `encodeMigrateSameAssetDebt`. Both sub-account routes call
    // transferFromMax at the end when the sub-account != owner.
    const amount = 1_000_000n
    const sdk = buildSdkExecutionService()
    const plan = sdk.planMigrateSameAssetDebt({
      account: buildSdkAccount({
        positions: [
          { subAccount: ADDR.subAccount1, vault: ADDR.vaultUsdc, asset: ADDR.assetUsdc, borrowed: amount, isController: true },
        ],
      }),
      oldLiabilityVault: ADDR.vaultUsdc,
      newLiabilityVault: ADDR.vaultUsdt,
      liabilityAccount: ADDR.subAccount1,
      liabilityAmount: amount,
      oldLiabilityAsset: ADDR.assetUsdc,
      newLiabilityAsset: ADDR.assetUsdc, // same asset, different vault
      sweepExcess: false,
    })
    await expectGoldenPlan('migrate-same-asset-debt', plan)
  })

  it('planSwapDebt / buildSwapPlan (cross-asset debt swap)', async () => {
    // Cross-asset debt migration: borrow new asset, swap to old asset,
    // verify (DebtMax) does the repay-into-receiver + skim-in-place.
    //
    // Legacy emits a final disableController(receiver) unconditionally when
    // receiver != vaultIn. SDK only emits it on isMax. To align, we seed a
    // position whose borrowed value is below the quote's amountOutMin so the
    // SDK's `borrowed <= amountOutMin` check resolves isMax=true.
    const { quote } = loadSwapFixture('swap-debt-usdc-to-dai')
    const sdk = buildSdkExecutionService()
    const plan = sdk.planSwapDebt({
      account: buildSdkAccount({
        positions: [
          // Old liability — tiny borrowed amount triggers SDK's isMax path.
          { subAccount: quote.accountIn, vault: quote.receiver, asset: quote.tokenOut.address, borrowed: 1n, isController: true },
        ],
      }),
      swapQuote: quote,
    })
    await expectGoldenPlan('swap-debt', plan)
  })

  it('planMultiplyWithSwap / buildMultiplyPlan (swap branch, no initial collateral)', async () => {
    // No initial collateral deposit; supplyVault pre-marked as enabled so the
    // SDK skips enableCollateral, leaving the enableController → borrow(swapper)
    // → swap → verify → enableLongCollateral sequence.
    const { quote } = loadSwapFixture('swap-multiply-usdc-to-dai')
    const sdk = buildSdkExecutionService()
    const plan = sdk.planMultiplyWithSwap({
      account: buildSdkAccount({
        positions: [
          // Mark collateralVault as already enabled so SDK skips enableCollateral.
          { subAccount: quote.accountIn, vault: quote.vaultIn, asset: quote.tokenIn.address, isCollateral: true },
        ],
      }),
      collateralVault: quote.vaultIn,
      collateralAmount: 0n,
      collateralAsset: quote.tokenIn.address,
      swapQuote: quote,
      skipCleanup: true,
    })
    await expectGoldenPlan('multiply-with-swap', plan)
  })

  it('planMultiplySameAsset (no-swap branch, deposit collateral)', async () => {
    // Same-asset loop: deposit collateral, borrow the same asset, and skim the
    // borrowed amount into the long vault (borrow→skim, no swap).
    const sdk = buildSdkExecutionService()
    const plan = sdk.planMultiplySameAsset({
      account: buildSdkAccount(),
      collateralVault: ADDR.vaultUsdc,
      collateralAmount: 1_000_000n,
      collateralAsset: ADDR.assetUsdc,
      longVault: ADDR.vaultUsdc,
      liabilityVault: ADDR.vaultUsdc,
      liabilityAmount: 500_000n,
      receiver: ADDR.subAccount1,
      skipCleanup: true,
    })
    await expectGoldenPlan('multiply-same-asset', plan)
  })
})
