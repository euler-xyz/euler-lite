/**
 * Golden canary for the SDK tx-plan builders.
 *
 * This is NOT a comprehensive correctness suite — the SDK tests each
 * `executionService.plan*` builder in its own repo (euler-xyz/euler-sdks,
 * test/executionService.test.ts). This suite exists only to catch the one thing
 * those tests can't: an SDK version bump (dependabot, or the preview-SDK path)
 * that silently changes the byte-for-byte calldata a Lite user would sign.
 *
 * It runs a handful of representative operations — one per encoder family
 * (plain vault op, borrow, repay, migration, swap, leverage) — resolves
 * approvals, normalizes the plan to a canonical [{to, data, value, evcBatch}]
 * tx list, and asserts it against a committed fixture under `plans/`. If a fixture
 * fails, an SDK change moved the calldata — review the diff and regenerate with
 * `npm run test:golden:update`.
 */

import { afterEach, beforeEach, describe, it } from 'vitest'
import type { Address } from 'viem'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'

import { ADDR, CHAIN_ID, buildSdkAccount, buildSdkExecutionService } from './harness'
import { normalizeSdkPlan } from './normalize'
import { loadSwapFixture } from './load-fixture'
import { expectPlanMatchesGolden } from './plan-fixture'

const expectGoldenPlan = async (
  name: string,
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
  expectPlanMatchesGolden(name, normalizeSdkPlan(resolved, ADDR.evc))
}

describe('golden canary: SDK tx-plan calldata', () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
    // Defensive: no scenario should make HTTP calls.
    globalThis.fetch = (async () => {
      throw new Error('fetch not allowed in golden tests')
    }) as never
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('deposit', async () => {
    const sdk = buildSdkExecutionService()
    const plan = sdk.planDeposit({
      account: buildSdkAccount(),
      vault: ADDR.vaultUsdc,
      asset: ADDR.assetUsdc,
      amount: 1_000_000n,
      receiver: ADDR.user,
    })
    await expectGoldenPlan('deposit-own-account', plan)
  })

  it('borrow with wallet collateral', async () => {
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

  it('repay from wallet', async () => {
    const sdk = buildSdkExecutionService()
    const plan = sdk.planRepayFromWallet({
      account: buildSdkAccount({
        positions: [{ subAccount: ADDR.user, vault: ADDR.vaultUsdc, asset: ADDR.assetUsdc, borrowed: 1_500_000n }],
      }),
      liabilityVault: ADDR.vaultUsdc,
      liabilityAmount: 500_000n,
      receiver: ADDR.user,
    })
    await expectGoldenPlan('repay-wallet-own-account', plan)
  })

  it('same-asset collateral migration', async () => {
    const amount = 600_000n
    const sdk = buildSdkExecutionService()
    const plan = sdk.planMigrateSameAssetCollateral({
      account: buildSdkAccount({
        positions: [
          { subAccount: ADDR.subAccount1, vault: ADDR.vaultUsdc, asset: ADDR.assetUsdc, shares: amount, assets: amount, isCollateral: true },
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

  it('collateral swap (cross-asset)', async () => {
    const { quote } = loadSwapFixture('swap-collateral-usdc-to-dai')
    const sdk = buildSdkExecutionService()
    const plan = sdk.planSwapCollateral({
      account: buildSdkAccount(),
      swapQuote: quote,
    })
    await expectGoldenPlan('swap-collateral', plan)
  })

  it('multiply with swap (leverage)', async () => {
    const { quote } = loadSwapFixture('swap-multiply-usdc-to-dai')
    const sdk = buildSdkExecutionService()
    const plan = sdk.planMultiplyWithSwap({
      account: buildSdkAccount({
        positions: [
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
})
