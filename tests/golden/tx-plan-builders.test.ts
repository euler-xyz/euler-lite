/**
 * Golden tests for the legacy → SDK plan-builder migration.
 *
 * For each operation type covered by `composables/useEulerTx.ts` we:
 *   1. Run the legacy `useEulerOperations` builder (resolved from the parallel
 *      worktree at ../euler-lite-sdk-exec-legacy via the `~` alias in
 *      vitest.golden.config.ts).
 *   2. Run the SDK planner and resolve approvals against a Wallet entity that
 *      reports a maxUint256 allowance — matching the "no on-chain approval
 *      needed" path the legacy `prepareTokenApproval` takes when its allowance
 *      probes report sufficient balance.
 *   3. Reduce both plans to a canonical [{to, data, value, evcBatch}] tx list
 *      and assert byte-for-byte equality.
 *
 * Scenarios are tuned to bypass external dependencies that the test harness
 * doesn't mock: Pyth feed fetch (no controllers / no liability vault), swap
 * verifier RPC (deterministic SwapApiQuote fixtures with `SkipMin` verify
 * type), and on-chain previewWithdraw (the rpc stub returns shares == assets).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'

import { createVaultBuilders } from '~/composables/useEulerOperations/vault'
import { createRepayBuilders } from '~/composables/useEulerOperations/repay'
import { createSameAssetSwapBuilders } from '~/composables/useEulerOperations/swaps/same-asset'
import { createCrossAssetSwapBuilders } from '~/composables/useEulerOperations/swaps/cross-asset'
import { createSupplyBorrowSwapBuilders } from '~/composables/useEulerOperations/swaps/supply-borrow'
import { createPermit2Helpers } from '~/composables/useEulerOperations/permit2'
import { createAllowanceHelpers } from '~/composables/useEulerOperations/allowance'
import { createOperationHelpers } from '~/composables/useEulerOperations/helpers'

import { ADDR, CHAIN_ID, buildLegacyContext, buildSdkAccount, buildSdkExecutionService } from '@golden/harness'
import { normalizeLegacyPlan, normalizeSdkPlan } from '@golden/normalize'
import { loadSwapFixture } from '@golden/load-fixture'

// Stub the SDK accessor the legacy helpers reach for via Nuxt auto-import.
// They use it only to fetch wallet allowances; throwing forces them onto the
// `ctx.rpcProvider.readContract(allowance)` fallback path which our harness
// returns maxUint256 from.
vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdk: async () => { throw new Error('stub: golden tests use rpc allowance fallback') },
}))

// `useEulerSubgraph` (transitively via collateral-cleanup) shouldn't be hit by
// our scenarios; if any test path reaches it, we want a hard fail rather than
// a network call. The stub here keeps the import resolvable.
vi.mock('~/utils/subgraph', () => ({
  fetchAccountPositions: async () => { throw new Error('stub: subgraph not available in golden tests') },
  waitForSubgraphBlock: async () => false,
}))

const expectPlansEqual = async (
  legacyTxs: ReturnType<typeof normalizeLegacyPlan>,
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
  const sdkTxs = normalizeSdkPlan(resolved, ADDR.evc)
  expect(sdkTxs).toEqual(legacyTxs)
}

const setupLegacy = (overrides?: Parameters<typeof buildLegacyContext>[0]) => {
  const ctx = buildLegacyContext(overrides)
  const permit2 = createPermit2Helpers(ctx as never)
  const allowance = createAllowanceHelpers(ctx as never, permit2)
  const helpers = createOperationHelpers(ctx as never, permit2, allowance)
  return {
    ctx,
    helpers,
    vault: createVaultBuilders(ctx as never, helpers, permit2, allowance),
    repay: createRepayBuilders(ctx as never, helpers),
    sameAsset: createSameAssetSwapBuilders(ctx as never, helpers),
    crossAsset: createCrossAssetSwapBuilders(ctx as never, helpers),
    supplyBorrow: createSupplyBorrowSwapBuilders(ctx as never, helpers),
  }
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
    const { vault } = setupLegacy()
    const legacy = await vault.buildSupplyPlan(ADDR.vaultUsdc, ADDR.assetUsdc, amount)
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

    const sdk = buildSdkExecutionService()
    const plan = sdk.planDeposit({
      account: buildSdkAccount(),
      vault: ADDR.vaultUsdc,
      asset: ADDR.assetUsdc,
      amount,
      receiver: ADDR.user,
    })
    await expectPlansEqual(legacyTxs, plan)
  })

  it('deposit to sub-account', async () => {
    const amount = 2_500_000n
    const { vault } = setupLegacy()
    const legacy = await vault.buildSupplyPlan(ADDR.vaultUsdc, ADDR.assetUsdc, amount, ADDR.subAccount1)
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

    const sdk = buildSdkExecutionService()
    const plan = sdk.planDeposit({
      account: buildSdkAccount(),
      vault: ADDR.vaultUsdc,
      asset: ADDR.assetUsdc,
      amount,
      receiver: ADDR.subAccount1,
    })
    await expectPlansEqual(legacyTxs, plan)
  })
})

describe('golden tx-plan parity: vault.withdraw', () => {
  it('partial withdraw from own account', async () => {
    const amount = 500_000n
    const { vault } = setupLegacy()
    const legacy = await vault.buildWithdrawPlan(ADDR.vaultUsdc, amount)
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

    const sdk = buildSdkExecutionService()
    const plan = sdk.planWithdraw({
      account: buildSdkAccount(),
      vault: ADDR.vaultUsdc,
      assets: amount,
      owner: ADDR.user,
      receiver: ADDR.user,
    })
    await expectPlansEqual(legacyTxs, plan)
  })

  it('partial withdraw from sub-account', async () => {
    const amount = 750_000n
    const { vault } = setupLegacy()
    const legacy = await vault.buildWithdrawPlan(ADDR.vaultUsdc, amount, ADDR.subAccount1)
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

    const sdk = buildSdkExecutionService()
    const plan = sdk.planWithdraw({
      account: buildSdkAccount(),
      vault: ADDR.vaultUsdc,
      assets: amount,
      owner: ADDR.subAccount1,
      receiver: ADDR.user,
    })
    await expectPlansEqual(legacyTxs, plan)
  })
})

describe('golden tx-plan parity: vault.redeem', () => {
  it('partial redeem from sub-account', async () => {
    // The legacy harness stub returns shares == assets from previewWithdraw,
    // so the SDK plan (which takes shares) is given that same value.
    const amount = 1_234_567n
    const { vault } = setupLegacy()
    const legacy = await vault.buildRedeemPlan(ADDR.vaultUsdc, amount, undefined, false, ADDR.subAccount1)
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

    const sdk = buildSdkExecutionService()
    const plan = sdk.planRedeem({
      account: buildSdkAccount(),
      vault: ADDR.vaultUsdc,
      shares: amount,
      owner: ADDR.subAccount1,
      receiver: ADDR.user,
    })
    await expectPlansEqual(legacyTxs, plan)
  })

  it('full redeem (isMax) with explicit maxShares', async () => {
    const maxShares = 9_999_999n
    const { vault } = setupLegacy()
    const legacy = await vault.buildRedeemPlan(ADDR.vaultUsdc, 0n, maxShares, true, ADDR.subAccount1)
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

    const sdk = buildSdkExecutionService()
    const plan = sdk.planRedeem({
      account: buildSdkAccount(),
      vault: ADDR.vaultUsdc,
      shares: maxShares,
      owner: ADDR.subAccount1,
      receiver: ADDR.user,
    })
    await expectPlansEqual(legacyTxs, plan)
  })
})

describe('golden tx-plan parity: repay.fromWallet', () => {
  const borrowed = 1_500_000n

  it('partial repay against own account', async () => {
    const amount = 500_000n
    const { repay } = setupLegacy()
    const legacy = await repay.buildRepayPlan(ADDR.vaultUsdc, ADDR.assetUsdc, amount, ADDR.user)
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

    const sdk = buildSdkExecutionService()
    const plan = sdk.planRepayFromWallet({
      account: buildSdkAccount({
        positions: [{ subAccount: ADDR.user, vault: ADDR.vaultUsdc, asset: ADDR.assetUsdc, borrowed }],
      }),
      liabilityVault: ADDR.vaultUsdc,
      liabilityAmount: amount,
      receiver: ADDR.user,
    })
    await expectPlansEqual(legacyTxs, plan)
  })

  it('partial repay against sub-account', async () => {
    const amount = 800_000n
    const { repay } = setupLegacy()
    const legacy = await repay.buildRepayPlan(ADDR.vaultUsdc, ADDR.assetUsdc, amount, ADDR.subAccount1)
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

    const sdk = buildSdkExecutionService()
    const plan = sdk.planRepayFromWallet({
      account: buildSdkAccount({
        positions: [{ subAccount: ADDR.subAccount1, vault: ADDR.vaultUsdc, asset: ADDR.assetUsdc, borrowed }],
      }),
      liabilityVault: ADDR.vaultUsdc,
      liabilityAmount: amount,
      receiver: ADDR.subAccount1,
    })
    await expectPlansEqual(legacyTxs, plan)
  })

  // Full-repay cleanup is documented as intentionally divergent — the legacy
  // builder calls `adjustForInterest(maxUint256)` which overflows (a latent bug
  // never triggered in production because callers always pass a finite
  // position.borrowed), and emits a different cleanup batch shape. The SDK's
  // `cleanupOnMax: true` uses `position.borrowed` for the approval cushion and
  // appends cleanup via `appendMaxRepayCleanup`. See useEulerTx.planRepayFromWallet.
  it.skip('full repay (cleanup) – legacy/SDK divergent shape, not byte-equal', () => {})
})

describe('golden tx-plan parity: vault.borrow (wallet collateral)', () => {
  // Intentional batch reordering in the SDK migration: SDK's encodeBorrow
  // wraps the collateral deposit via encodeDeposit which emits
  // enableCollateral(receiver, vault) BEFORE the deposit. Legacy emits the
  // deposit first, then enableController, then enableCollateral.
  //
  // Both batches are functionally equivalent at the EVC level (status-check
  // happens at the end of the batch), but byte-different.
  it.skip('borrow against fresh sub-account, wallet collateral (reordered)', () => {})
})

describe('golden tx-plan parity: vault.borrowBySaving', () => {
  // Same divergence as above: SDK emits enableCollateral before enableController;
  // legacy in the opposite order.
  it.skip('borrow using existing savings as collateral (reordered)', () => {})
})

describe('golden tx-plan parity: repay.fromDeposit (savings)', () => {
  const borrowed = 1_500_000n
  const savingsAmount = 1_000_000n

  it('partial savings repay – same vault', async () => {
    const { repay } = setupLegacy()
    const legacy = await repay.buildSavingsRepayPlan({
      savingsVaultAddress: ADDR.vaultUsdc,
      borrowVaultAddress: ADDR.vaultUsdc,
      amount: savingsAmount,
      savingsSubAccount: ADDR.user,
      borrowSubAccount: ADDR.subAccount1,
    })
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

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
    await expectPlansEqual(legacyTxs, plan)
  })
})

describe('golden tx-plan parity: same-asset migrations', () => {
  it('migrate collateral between same-asset vaults (partial, no enable/disable)', async () => {
    const amount = 600_000n
    const { sameAsset } = setupLegacy()
    const legacy = await sameAsset.buildSameAssetSwapPlan({
      fromVaultAddress: ADDR.vaultUsdc,
      toVaultAddress: ADDR.vaultDai,
      amount,
      isMax: false,
      subAccount: ADDR.subAccount1,
      enableCollateral: false,
      disableCollateral: false,
    })
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

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
    await expectPlansEqual(legacyTxs, plan)
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
    const { crossAsset } = setupLegacy()
    const legacy = await crossAsset.buildSwapPlan({
      quote: quote as never,
      requestedSlippage: quote.slippage,
      enableCollateral: true,
    })
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

    const sdk = buildSdkExecutionService()
    const plan = sdk.planSwapCollateral({
      account: buildSdkAccount(),
      swapQuote: quote,
    })
    await expectPlansEqual(legacyTxs, plan)
  })

  it('planRepayWithSwap / buildSwapPlan (isRepay collateral→debt)', async () => {
    const { request, quote } = loadSwapFixture<{ currentDebt: bigint }>('swap-repay-partial-usdc-to-dai')
    const { crossAsset } = setupLegacy()
    const legacy = await crossAsset.buildSwapPlan({
      quote: quote as never,
      requestedSlippage: quote.slippage,
      isRepay: true,
      currentDebt: request.currentDebt,
    })
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

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
    await expectPlansEqual(legacyTxs, plan)
  })

  it('planDepositWithSwapFromWallet / buildSwapAndSupplyPlan', async () => {
    const { quote } = loadSwapFixture('swap-wallet-deposit-usdc-to-dai')
    const { supplyBorrow } = setupLegacy()
    const legacy = await supplyBorrow.buildSwapAndSupplyPlan({
      inputTokenAddress: quote.tokenIn.address,
      inputAmount: BigInt(quote.amountIn),
      quote: quote as never,
      requestedSlippage: quote.slippage,
      includePermit2Call: false,
    })
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

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
    await expectPlansEqual(legacyTxs, plan)
  })

  it('planWithdrawAndSwap / buildWithdrawAndSwapPlan', async () => {
    const { quote } = loadSwapFixture('swap-withdraw-and-swap-usdc-to-dai')
    const { supplyBorrow } = setupLegacy()
    const legacy = await supplyBorrow.buildWithdrawAndSwapPlan({
      vaultAddress: quote.vaultIn,
      assetsAmount: BigInt(quote.amountIn),
      quote: quote as never,
      requestedSlippage: quote.slippage,
      subAccount: quote.accountIn,
    })
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

    const sdk = buildSdkExecutionService()
    const plan = sdk.planWithdrawAndSwap({
      account: buildSdkAccount(),
      vault: quote.vaultIn,
      assets: BigInt(quote.amountIn),
      owner: quote.accountIn,
      swapQuote: quote,
    })
    await expectPlansEqual(legacyTxs, plan)
  })

  it('planSwapAndRepayFromWallet / buildSwapAndRepayPlan (partial)', async () => {
    const { request, quote } = loadSwapFixture<{ currentDebt: bigint }>('swap-wallet-repay-usdc-to-dai')
    const { supplyBorrow } = setupLegacy()
    const legacy = await supplyBorrow.buildSwapAndRepayPlan({
      inputTokenAddress: quote.tokenIn.address,
      inputAmount: BigInt(quote.amountIn),
      quote: quote as never,
      requestedSlippage: quote.slippage,
      borrowVaultAddress: quote.receiver,
      subAccount: quote.accountOut,
      currentDebt: request.currentDebt,
      includePermit2Call: false,
    })
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

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
    await expectPlansEqual(legacyTxs, plan)
  })

  it('planRedeemAndSwap / buildRedeemAndSwapPlan', async () => {
    // Reuses the withdraw-and-swap fixture — same TransferMin verifier, only
    // the source-vault call (withdraw vs redeem) differs in selector + decimals
    // semantics. Legacy stub returns shares == assets via the rpcProvider
    // previewWithdraw stub, so passing the same `amountIn` works.
    const { quote } = loadSwapFixture('swap-withdraw-and-swap-usdc-to-dai')
    const shares = BigInt(quote.amountIn)
    const { supplyBorrow } = setupLegacy()
    const legacy = await supplyBorrow.buildRedeemAndSwapPlan({
      vaultAddress: quote.vaultIn,
      sharesAmount: shares,
      quote: quote as never,
      requestedSlippage: quote.slippage,
      subAccount: quote.accountIn,
    })
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

    const sdk = buildSdkExecutionService()
    const plan = sdk.planRedeemAndSwap({
      account: buildSdkAccount(),
      vault: quote.vaultIn,
      shares,
      owner: quote.accountIn,
      swapQuote: quote,
    })
    await expectPlansEqual(legacyTxs, plan)
  })

  it('planSwapAndBorrowFromWallet / buildSwapAndBorrowPlan', async () => {
    const { quote } = loadSwapFixture('swap-and-borrow-usdc-to-dai')
    const borrowAmount = 100_000n
    const { supplyBorrow } = setupLegacy()
    const legacy = await supplyBorrow.buildSwapAndBorrowPlan({
      inputTokenAddress: quote.tokenIn.address,
      inputAmount: BigInt(quote.amountIn),
      collateralVaultAddress: quote.receiver,
      borrowVaultAddress: ADDR.vaultUsdt,
      borrowAmount,
      swapQuote: quote as never,
      requestedSlippage: quote.slippage,
      subAccount: quote.accountOut,
      includePermit2Call: false,
    })
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

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
    await expectPlansEqual(legacyTxs, plan)
  })

  it('planMigrateSameAssetDebt / buildSameAssetDebtSwapPlan', async () => {
    // Same-asset debt migration — no swap quote required. Legacy uses
    // `adjustForInterest(amount)` cushion; SDK encodes the same cushion in
    // `encodeMigrateSameAssetDebt`. Both sub-account routes call
    // transferFromMax at the end when the sub-account != owner.
    const amount = 1_000_000n
    const { sameAsset } = setupLegacy()
    const legacy = await sameAsset.buildSameAssetDebtSwapPlan({
      oldVaultAddress: ADDR.vaultUsdc,
      newVaultAddress: ADDR.vaultUsdt,
      amount,
      subAccount: ADDR.subAccount1,
      enabledCollaterals: [ADDR.vaultDai],
    })
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

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
      // Legacy queries balanceOf on the old vault to decide whether to
      // sweep — our rpc stub throws on balanceOf so the catch returns true,
      // meaning legacy treats this as "pre-existing deposit" and skips the
      // sweep. Match SDK by opting out.
      sweepExcess: false,
    })
    await expectPlansEqual(legacyTxs, plan)
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
    const { crossAsset } = setupLegacy()
    const legacy = await crossAsset.buildSwapPlan({
      quote: quote as never,
      requestedSlippage: quote.slippage,
      isRepay: true,
      isDebtSwap: true,
      currentDebt: 1n,
    })
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

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
    await expectPlansEqual(legacyTxs, plan)
  })

  it('planMultiplyWithSwap / buildMultiplyPlan (swap branch, no initial collateral)', async () => {
    // No initial collateral deposit: legacy skips the deposit step + we
    // pre-mark supplyVault as enabled to skip enableSupplyCollateral, leaving
    // both implementations with the same enableController → borrow(swapper) →
    // swap → verify → enableLongCollateral sequence.
    const { quote } = loadSwapFixture('swap-multiply-usdc-to-dai')
    const { vault } = setupLegacy()
    const legacy = await vault.buildMultiplyPlan({
      supplyVaultAddress: quote.vaultIn, // unused since supplyAmount=0
      supplyAssetAddress: quote.tokenIn.address,
      supplyAmount: 0n,
      longVaultAddress: quote.receiver,
      longAssetAddress: quote.tokenOut.address,
      borrowVaultAddress: quote.vaultIn,
      debtAmount: 0n, // ignored in swap path; the borrow uses quote.amountIn
      subAccount: quote.accountIn,
      includePermit2Call: false,
      enabledCollaterals: [quote.vaultIn], // skip enableSupplyCollateral
      quote: quote as never,
      requestedSlippage: quote.slippage,
    })
    const legacyTxs = normalizeLegacyPlan(legacy, ADDR.evc)

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
    })
    await expectPlansEqual(legacyTxs, plan)
  })

  // Same-asset multiply — divergent batch shape.
  // Legacy: borrow(amount, user) → user holds tokens → longVault.deposit(amount, subAccount)
  // SDK:    borrow(amount, longVault) → longVault.skim(amount, subAccount)
  // Functionally equivalent (both end with `amount` shares minted to subAccount)
  // but different selectors. Flagged for migration sign-off.
  it.skip('planMultiplySameAsset / buildMultiplyPlan (no-swap branch) — divergent borrow→skim vs borrow→deposit shape', () => {})
})
