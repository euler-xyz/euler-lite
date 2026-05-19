# SDK migration: plan-path parity coverage

Snapshot of which `useEulerTx` plan paths have been verified byte-equal
against the legacy `useEulerOperations` builders by the golden tests in
`tx-plan-builders.test.ts`.

Last refreshed against the legacy worktree pinned at `HEAD` of
`euler-lite-sdk-exec` and the SDK pulled in via `@eulerxyz/euler-v2-sdk`.

## Summary

- **20** plan paths verified byte-equal post-approval-expansion
- **4** plan paths with documented intentional batch-shape divergences
- **3** plan paths SDK-only, with no legacy counterpart to compare against

## Covered (byte-equal parity, 20 tests)

| `useEulerTx` method | Legacy builder | Scenario |
|---|---|---|
| `planDeposit` | `buildSupplyPlan` | deposit to own account |
| `planDeposit` | `buildSupplyPlan` | deposit to sub-account |
| `planWithdraw` | `buildWithdrawPlan` | partial, own account |
| `planWithdraw` | `buildWithdrawPlan` | partial, sub-account |
| `planRedeem` | `buildRedeemPlan` | partial redeem from sub-account |
| `planRedeem` | `buildRedeemPlan` | full redeem (isMax) with explicit maxShares |
| `planRepayFromWallet` | `buildRepayPlan` | partial, own account |
| `planRepayFromWallet` | `buildRepayPlan` | partial, sub-account |
| `planRepayFromDeposit` | `buildSavingsRepayPlan` | same-vault savings repay |
| `planMigrateSameAssetCollateral` | `buildSameAssetSwapPlan` | partial, no enable/disable |
| `planMigrateSameAssetDebt` | `buildSameAssetDebtSwapPlan` | same-asset debt migration (`sweepExcess: false`) |
| `planSwapCollateral` | `buildSwapPlan` | cross-asset collateral swap |
| `planRepayWithSwap` | `buildSwapPlan(isRepay)` | partial repay via collateral swap |
| `planDepositWithSwapFromWallet` | `buildSwapAndSupplyPlan` | wallet → vault deposit |
| `planWithdrawAndSwap` | `buildWithdrawAndSwapPlan` | withdraw + swap to wallet |
| `planRedeemAndSwap` | `buildRedeemAndSwapPlan` | reuse withdraw-and-swap fixture |
| `planSwapAndRepayFromWallet` | `buildSwapAndRepayPlan` | partial wallet-funded repay |
| `planSwapAndBorrowFromWallet` | `buildSwapAndBorrowPlan` | wallet → collateral + borrow |
| `planSwapDebt` | `buildSwapPlan(isDebtSwap)` | cross-asset debt swap (`isMax`-aligned) |
| `planMultiplyWithSwap` | `buildMultiplyPlan(quote)` | no-initial-collateral path |

## Documented divergences (4 skips)

These are real migration deltas — leaving them as `it.skip` with a comment
keeps the audit trail visible rather than papering over with a workaround.

### `planBorrow` (wallet collateral)
SDK's `encodeBorrow` wraps the collateral deposit via `encodeDeposit`, which
emits `enableCollateral(receiver, vault)` **before** the deposit. Legacy
emits `deposit → enableController → enableCollateral`. Functionally
equivalent — EVC's account status check runs at end of batch — but
byte-different.

### `planBorrow` (savings collateral)
Same reorder as above: SDK emits `enableCollateral` before `enableController`,
legacy emits them in the opposite order.

### `planRepayFromWallet` with `cleanupOnMax: true`
Three independent issues bundle here:

1. **Overflow.** Legacy `buildFullRepayPlan` does
   `adjustForInterest(amount) = amount * 10_001n / 10_000n` and feeds the
   result to `prepareTokenApproval`. When the caller passes `maxUint256`,
   this overflows `uint256` and viem's ABI encoder rejects it. In production
   Lite never passes `maxUint256` here — it passes `position.borrowed` — so
   this is a latent foot-gun, not a live bug. The SDK avoids it by branching
   on `isMax` and pulling `position.borrowed` from the seeded account before
   cushioning.

2. **Collateral discovery.** Legacy takes a caller-supplied
   `collateralAddresses: string[]` and iterates it to emit
   `disableCollateral + transferFromMax`. The SDK derives the active
   collateral list from `account.subAccount.enabledCollaterals` via
   `resolveBorrowCollateralPositions`. To make a fair comparison we'd have
   to feed legacy the exact list the SDK derives, which defeats the parity
   purpose.

3. **Extra source sweep.** SDK's `appendMaxRepayCleanup` has a separate
   `sourceAccount/sourceVault` codepath for repay-from-deposit that
   transfers remaining source-vault shares to the owner. Legacy
   `buildFullRepayPlan` has no equivalent.

### `planMultiplySameAsset`
Fundamentally different batch shape:
- Legacy: `liability.borrow(amount, user)` → `long.deposit(amount, sub)`
- SDK: `liability.borrow(amount, longVault)` → `long.skim(amount, sub)`

Both end with `amount` shares minted to the sub-account but they're
different selectors. This is a deliberate flow change, not a regression.

## SDK-only (no legacy counterpart, 3)

These exist in `useEulerTx` but have no `useEulerOperations` builder to
compare against. Parity testing doesn't apply; if you want to lock in the
SDK's output shape, add stability snapshots — there's no second
implementation to diff.

### `planTransfer`
Legacy embedded `EVC.transfer` calls inside other flows (savings repay, borrow-by-savings)
rather than exposing a standalone transfer plan. The SDK lifts this into a
named method.

### `planCleanup`
SDK helper that decouples cleanup logic from full-repay. Legacy fused both
into `buildFullRepayPlan` and `buildDisableCollateralPlan`; neither maps to
the SDK's stand-alone cleanup builder one-to-one.

### `planSwapFromWallet` (wallet → wallet, `TransferMin` verify)
Legacy's `buildSwapAndSupplyPlan` only accepts the `SkimMin` (deposit) variant
of a wallet swap. The wallet-to-wallet path with `transferOutputToReceiver`
is SDK-introduced.

## Combined helpers in `useEulerTx`

These are branch wrappers, not separate SDK methods. Coverage status is
inherited from the underlying plan path:

| Helper | Branches → | Coverage |
|---|---|---|
| `planMultiply` | `planMultiplyWithSwap` / `planMultiplySameAsset` | partial (swap branch ✅, same-asset ❌) |
| `planRepayFromSource` | `planRepayWithSwap` / `planRepayFromDeposit` | ✅ both |
| `planCollateralChange` | `planSwapCollateral` / `planMigrateSameAssetCollateral` | ✅ both |
| `planDebtChange` | `planSwapDebt` / `planMigrateSameAssetDebt` | ✅ both |
| `planWithdrawOrRedeem` | `planWithdraw`, `planRedeem`, `planWithdrawAndSwap`, `planRedeemAndSwap` | ✅ all four leaves |

## What's NOT verified by these tests

The golden tests assert byte equality of the **plan output** after
approval expansion. They do not exercise:

- `simulateTransactionPlan` (state overrides, revert decoding)
- `executeTransactionPlan` (sendTransaction, permit2 signing, OKX delay)
- `preparePlanForReview` beyond `resolveRequiredApprovals` (no
  permit2-enabled path is tested)
- Pyth feed injection (harness stubs `registryGetVault → undefined`)
- Collateral cleanup RPC reads (harness returns empty arrays)
- Sub-account derivation (harness passes explicit sub-accounts)
- Native ETH wrapping (`wrappedNativeInfo` is never set in any scenario)
- Permit2 signing (`permit2Enabled` is false everywhere; all approvals go
  through the direct-allowance path)

If migration sign-off needs any of these, they belong in a separate test
layer — these golden tests cover plan **shape**, not execution.

## Closing the gaps

To get to full byte-equal coverage of the legacy → SDK migration:

1. **Decide on the divergences.** The four documented ones are deliberate
   SDK redesigns. Either accept them as migration deltas in the audit, or
   revisit `encodeBorrow` / `encodeMultiplySameAsset` to match legacy's
   batch shape.
2. **Add SDK-only stability snapshots** for `planTransfer`, `planCleanup`,
   `planSwapFromWallet`. These can be `toMatchSnapshot()` against committed
   fixtures — no parity comparison, just regression detection.
3. **Cover the execution path** with a second test suite (simulation,
   approval resolution with `usePermit2: true`, OKX delay, subgraph wait).
