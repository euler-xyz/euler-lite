# Cross-Position Collateral Repayment

Euler Lite can repay one sub-account's debt using **exact-vault collateral sitting on a different sub-account**. The path exists for reciprocal-debt setups (A borrowed asset X that B supplied as collateral, and vice versa) so both legs can be closed in one atomic batch without withdrawing liquidity or swapping.

This is not the same as the repay **Savings** tab. Savings repayment spends idle EVK deposits (any vault, including swap routes). Cross-position repayment spends **collateral that is still enabled on another borrow position**, and only when that collateral vault is the target liability vault.

## When it appears

Surface: `/position/[number]/repay` → **Collateral** tab (`pages/position/[number]/repay.vue`).

Candidates are merged into the collateral asset selector by `useCollateralSwapRepay`:

1. Current-position collateral (existing swap-or-same-asset repay).
2. Cross-position exact-vault candidates from `useCrossPositionRepayCollateralOptions`.

A source is offered only when **all** of these hold:

| Constraint | Behavior |
|---|---|
| Advanced mode | `settings.enableAdvancedMode` must be on. Otherwise `buildCrossPositionRepayCollateralCandidates` returns `[]`. |
| Different sub-account | Source account ≠ target (debt) account. |
| Exact liability vault | Source collateral vault address equals the target borrow vault. Cross-asset / other-vault collateral is excluded. |
| Positive balances | Both `assets` and `shares` must be `> 0n`. |
| Deduped id | `${sourceAccount}:${liabilityVault}` (lowercased). Duplicate positions collapse to one row. |

The selector option carries `tagContext: 'supply-source'` and `subAccount: sourceAccount` so the existing position badge can show which account the shares come from.

## Architecture

```text
Repay Collateral tab
        │
        ▼
current-position collateral  +  cross-position exact-vault candidates
        │
        ▼
useCollateralSwapRepay
  isCrossPositionSource = selectedSourceAccount ≠ target sub-account
        │
        ├── planRepayFromSource → SDK planRepayFromDeposit
        │     fromVault    = liability vault
        │     fromAccount  = source sub-account
        │     receiver     = target sub-account
        │     cleanupOnMax = false
        │
        └── OperationIntent
              planner: repay-from-deposit
              subAccounts: [target, source]
```

`planRepayFromSource` with no swap quote is a thin wrapper over `planRepayFromDeposit`. The SDK encodes `repayWithShares` on the liability vault: `onBehalfOfAccount` is the source, `receiver` is the target. There is no `withdraw`, `skim`, or `transferFromMax`.

## Hard constraints

Planning and intent creation both throw if a cross-position source is paired with a vault other than the liability vault:

```text
Cross-position collateral repayment requires the exact liability vault
```

That keeps the path on share-for-share repayment. It cannot be used to dump unrelated collateral through a swap.

Additional gates while a cross-position source is selected:

| Concern | Rule |
|---|---|
| CoW quotes | `includeCowSwap` is false. CoW close-position is same-account only. |
| Vault liquidity | Skipped. Same-vault `repayWithShares` does not pull cash from the vault. |
| Full-repay cleanup | `cleanupOnMax` is always `false`. Remaining collateral on the **target** is not transferred to the owner. |
| Hook ops | Planned ops are `REPAY_WITH_SHARES` only. Same-position full repay's extra `TRANSFER` cleanup ops are omitted. |
| Health preview | Source-vault deltas are not applied to the target position's collateral snapshot (`deltas: []`). Price ratio and "collateral remaining" are hidden. |
| Post-add redirect | Even a full target repay does not redirect as a closed position (`redirectAfterRepayAdd(false)`). The leftover target collateral is still on that sub-account. |

## Reciprocal batch

A typical close is two cart entries, one per direction:

1. Source A / vault X shares → repay B's X debt.
2. Source B / vault Y shares → repay A's Y debt.

After the first leg, the repaid borrow is projected as a **savings** position. Its collateral flag stays enabled because cleanup is deferred, so the second-leg picker still finds that exact-vault deposit. `buildCrossPositionRepayCollateralCandidates` therefore also scans `depositPositions` where `position.isCollateral` is true.

Add-to-batch marks **both** accounts on `affectedSubAccounts` so the cart simulates the source and the target. It does **not** add the owner/portfolio address the way a same-position full repay does.

The golden canary `tests/golden/cross-position-repay.test.ts` verifies the expected merged call shape: two `repayWithShares(maxUint256, receiver)` calls, matching `disableController()` calls, and no withdraw / skim / transferFromMax.

## Not this path

| Flow | Module | Difference |
|---|---|---|
| Wallet repay / wallet-swap repay | `useWalletRepay`, `useWalletSwapRepay` | Spends wallet ERC-20, not vault shares. |
| Savings repay | `useSavingsRepay` | Idle EVK deposits; any vault; swaps allowed; `cleanupOnMax` on full repay. Earn and Securitize deposits are excluded. |
| Same-position collateral repay | current-position items in `useCollateralSwapRepay` | Source account = target. May swap. Full repay can clean up leftover collateral. |

## Files

| File | Role |
|---|---|
| `composables/useCrossPositionRepayCollateralOptions.ts` | Candidate discovery (advanced-mode gated) |
| `composables/repay/useCollateralSwapRepay.ts` | Selection, planning, CoW/cleanup/health gates |
| `pages/position/[number]/repay.vue` | Collateral tab UI, batch `affectedSubAccounts`, redirect |
| `composables/useEulerTx.ts` | `planRepayFromSource` → `planRepayFromDeposit` |
| `tests/golden/cross-position-repay.test.ts` | Reciprocal calldata canary |

## Pitfalls

- Do not enable CoW or swap quotes for a cross-position source. The planner rejects any vault other than the liability vault.
- Do not set `cleanupOnMax: true` on this path. That would transfer the **target** position's remaining collateral as if the source and target were the same account.
- After adding the first reciprocal leg, the source may only still be listed because it was projected into savings with `isCollateral: true`. Filtering `depositPositions` to non-collateral idle deposits would break the second leg.
- The feature is invisible unless Advanced mode is on. That is intentional, not a missing-options bug.
