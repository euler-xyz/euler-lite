# rEUL Unlocks

This document describes how Euler Lite lists rEUL vesting locks and how early unlock is gated, quoted, reviewed, and executed. Unlock is a reviewed-execution `reul-unlock` intent. Claim plans for rEUL itself are a separate `reward-claim` path; see [SDK Integration → Reward token decimals](./sdk-integration.md#reward-token-decimals).

## Intent

Claimed rEUL vests for 180 days from the lock timestamp. At maturity the lock exchanges 1:1 for EUL. Unlocking early burns the still-vesting remainder (`amountToBeBurned`) and pays out only `unlockableAmount`.

rEUL adds every locked delivery to the lock keyed by the **current UTC day**. That lock can still grow until `lockTimestamp + 86_400`. Lite must not let a user review one remainder and then execute against a larger one.

## Architecture

```text
sdk.reulLockService.fetchLocks
        │
        ▼
useREULLocks  (spy-safe effectiveAddress, 60s poll)
        │
        ▼
RewardUnlockItem
  wall-clock open-lock disable
  chain-time open-lock recheck
  refreshREULLockReview
        │
        ▼
reviewed-execution reul-unlock
  remainder-loss constraint
  sdk.reulLockService.buildUnlockPlan
        │
        ▼
OperationReviewModal / BatchReviewModal
  burn warning only when amountToBeBurned > 0n
```

| Piece | Role |
| ----- | ---- |
| `entities/reul.ts` | `getREULLockClosedAt` / `isREULLockOpen` — UTC-day close, not 180-day maturity |
| `composables/useREULLocks.ts` | Lock list, chain-time read, plan builder |
| `components/entities/reward/RewardUnlockItem.vue` | Portfolio Rewards row, Unlock CTA, open-lock copy |
| `components/entities/reward/reulUnlockReview.ts` | Quote refresh + simulate before review opens |
| `features/reviewed-execution` | `reul-unlock` intent, `remainder-loss` constraint |

The connected wallet is always the signer. Display and RPC reads use `useEffectiveAddress()` and **must not** fall back to the wallet while a spy candidate is still verifying.

## Open-lock gate

`isREULLockOpen(lockTimestamp, nowSeconds)` is true while `nowSeconds < lockTimestamp + 86_400`.

Two clocks:

| Surface | Clock | Effect |
| ------- | ----- | ------ |
| Unlock button + helper copy | Wall clock via `useNow({ scheduler: cb => useIntervalFn(cb, POLL_INTERVAL_60S_MS) })` | Disables Unlock and shows "Rewards received today are still being added…" until the UTC close, formatted `MMMM dd, HH:mm` |
| Review click + plan build | Latest block timestamp from `sdk.providerService.getProvider(chainId).getBlock()` | Click aborts with `Early unlock for this rEUL lock opens … UTC`. `buildUnlockREULPlan` sets `allowRemainderLoss: !isREULLockOpen(...)` |

The contract takes **no maximum-loss amount**. While the lock can still grow, `allowRemainderLoss` is `false`, so **any remainder** reverts. After the UTC day closes, the SDK plan sets `allowRemainderLoss: true`. The SDK builder receives the lock timestamp and that boolean, not the captured `remainderLossMaximum`; it does not enforce a numerical burn cap. Safety relies on the closed-day gate and the quote-freshness assumptions below.

Chain time is read **before** the quote refresh so the quoted lock can no longer receive deliveries. Those two reads can hit different RPC nodes. In the first seconds after UTC midnight a lagging node can still quote the lock before its last delivery. Closing that gap would need block-pinned reads outside the SDK — known and accepted.

If chain time is unavailable, plan build fails closed (`getLatestBlockTimestamp` throws; `buildUnlockPlan` is not called).

## Quote refresh

`refreshLocks(true)` clears rendered rows immediately so a stale burn quote cannot be opened while the replacement RPC is in flight or after it fails.

`refreshREULLockReview` then compares the clicked lock to the replacement:

| Status | Condition | Toast |
| ------ | --------- | ----- |
| `fresh` | Same timestamp; amount unchanged; unlockable not lower; burn not higher | Continue |
| `changed` | Amount changed, unlockable decreased, or burn increased | "The rEUL unlock amount changed…" |
| `missing` | Timestamp gone | "This rEUL lock is no longer available." |
| `unavailable` | Refresh returned `null` | "Unable to refresh the rEUL lock. Try again." |

A strictly **better** quote (higher unlockable, lower burn, same amount) is accepted as `fresh` and the replacement lock is what review shows.

## Review and burn warning

The intent captures `lockTimestamps`, `lockAmounts`, and `remainderLossMaximum: amountToBeBurned`, plus a `remainder-loss` constraint on the rEUL token with `maximumLoss: amountToBeBurned`. Validators require the `remainder-loss` constraint to be present.

`hasBurn` is `amountToBeBurned > 0n` on that raw bigint. Do **not** gate the warning on formatted days remaining or on a display amount that rounds to zero: a 1-wei burn with `daysUntilMaturity === 0` still shows **rEUL burn mechanics**.

Copy lives in `OperationReviewModal` (direct) and `BatchReviewModal` (per cart row). Maturity in that copy is the 180-day vest (`DateTime.fromSeconds(lock.timestamp).plus({ days: 180 })`), which is independent of the UTC-day open-lock gate.

## Other gates

- **Spy mode:** Unlock is disabled. Locks still load for the verified spy owner.
- **Active batch:** Unlock is disabled until the cart is cleared. rEUL unlock is not an Add-to-batch action.
- **Chain mismatch:** Click switches the wallet to the site chain before the open-lock recheck.

## Constraints

- One lock per intent (`lockTimestamps[0]`). The SDK builder takes a single `lockTimestamp`.
- rEUL / EUL metadata (symbol, decimals, logo) comes from the unified token list. The rEUL **address** comes from chain contract config (`eulerTokenAddresses.rEUL`), not the list.
- Parity scrapers key off `data-list="reul-unlock"` and `data-field` values (`unlockable-amount`, `locked-amount`, `days-until-maturity`, `maturity-date`). Do not rename them casually.

## Tests

| Test | What it locks |
| ---- | ------------- |
| `tests/entities/reul.test.ts` | Open until `closedAt - 1`; closed at `lockTimestamp + 86_400` |
| `tests/composables/useREULLocks.test.ts` | Chain-time `allowRemainderLoss`; fail closed when block time is missing; required refresh clears stale rows |
| `tests/components/reulUnlockWarning.test.ts` | Raw `amountToBeBurned > 0n` drives `hasBurn`, including a 1-wei burn that formats as zero days |
| `tests/components/BatchReviewModal.test.ts` | Batch warning uses the captured burn condition, not a formatted amount |
| `tests/components/reulUnlockReview.test.ts` | Plan-build failure skips simulation; failed simulation prevents review |

## Pitfalls

| Symptom | Likely cause |
| ------- | ------------ |
| Unlock stays disabled after the 180-day maturity date | Spy mode or an active batch disables Unlock. The UTC-day gate has already closed for a mature lock. |
| Review burn warning missing on a tiny remainder | Warning was keyed off formatted days or a rounded display amount instead of `amountToBeBurned > 0n` |
| Executed burn larger than the reviewed remainder | `allowRemainderLoss` true while the UTC-day lock was still open, or quote refresh skipped |
| Spy review shows the connected wallet's locks | `useEffectiveAddress` fell back to the wallet while `isSpyResolving` |
| Unlock quoted then failed at UTC midnight | Lagging RPC node still in the previous UTC day; known race, retry after the next block |
