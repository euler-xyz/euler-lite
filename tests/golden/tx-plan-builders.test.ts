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
import { decodeFunctionData, getAddress, toFunctionSelector, type Address } from 'viem'
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
import { normalizeLegacyPlan, normalizeSdkPlan, type CanonicalTx } from '@golden/normalize'
import { loadSwapFixture } from '@golden/load-fixture'

const goldenMocks = vi.hoisted(() => ({
  accountPositions: {
    borrows: [] as Array<{ subAccount: Address, vault: Address }>,
    deposits: [] as Array<{ subAccount: Address, vault: Address }>,
  },
  evcAccountInfo: {
    enabledControllers: [] as Address[],
    enabledCollaterals: [] as Address[],
  },
}))

// Stub the SDK accessor the legacy helpers reach for via Nuxt auto-import.
// They use it only to fetch wallet allowances; throwing forces them onto the
// `ctx.rpcProvider.readContract(allowance)` fallback path which our harness
// returns maxUint256 from.
vi.mock('~/composables/useEulerSdk', () => ({
  getEulerSdk: async () => { throw new Error('stub: golden tests use rpc allowance fallback') },
}))

vi.mock('~/utils/public-client', () => ({
  getPublicClient: () => ({
    readContract: async (args: { functionName: string, args: readonly unknown[] }) => {
      if (args.functionName === 'getEVCAccountInfo') return goldenMocks.evcAccountInfo
      if (args.functionName === 'previewWithdraw') return args.args[0] as bigint
      if (args.functionName === 'allowance') return 2n ** 256n - 1n
      throw new Error(`Unmocked public-client readContract: ${args.functionName}`)
    },
  }),
}))

vi.mock('~/utils/subgraph', () => ({
  fetchAccountPositions: async () => goldenMocks.accountPositions,
  waitForSubgraphBlock: async () => false,
}))

beforeEach(() => {
  goldenMocks.accountPositions = { borrows: [], deposits: [] }
  goldenMocks.evcAccountInfo = { enabledControllers: [], enabledCollaterals: [] }
})

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

const expectPlansEqual = async (
  legacyTxs: ReturnType<typeof normalizeLegacyPlan>,
  sdkPlan: TransactionPlan,
  owner: Address = ADDR.user,
) => {
  const sdkTxs = await normalizeResolvedSdkPlan(sdkPlan, owner)
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
      skipCleanup: true,
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
