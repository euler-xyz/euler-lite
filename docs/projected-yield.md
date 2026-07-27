# Projected Yield

Euler Lite previews how an operation can change Supply APY, Net APY, or ROE before the transaction is submitted. The projection combines:

- post-operation vault utilization and interest rates;
- the position's USD-valued collateral and debt;
- intrinsic yield; and
- supply, borrow, collateral-qualified, and looping rewards.

This is an estimate for form review, not a transaction simulation or a guaranteed future rate. On-chain utilization, prices, and reward eligibility can change before execution.

## Architecture

```text
Form inputs and simulated batch layer
               │
               ▼
    cash / borrow / asset deltas
               │
               ▼
getProjectedRatesBatch() ──► EulerVaultLens projected rates
               │
               ▼
getCollateralApySnapshot() ─► USD-weighted collateral state
               │
               ▼
  getProjectedYieldState() ─► total + contribution breakdown
               │
               ▼
ProjectedYieldSummaryRow / ProjectedYieldBreakdownModal
```

The main modules are:

| Module | Responsibility |
|---|---|
| `utils/vault/apy.ts` | Projects supply and borrow rates from adjusted vault cash and borrows |
| `composables/usePositionCollateralApy.ts` | Resolves every collateral, applies form deltas, values it in USD, and builds a weighted snapshot |
| `composables/useLayeredVaults.ts` | Prefers the active transaction-batch simulation layer over the live vault registry |
| `utils/projected-yield.ts` | Calculates metric totals and contribution rows; merges before/after reward campaigns |
| `components/entities/vault/form/ProjectedYieldSummaryRow.vue` | Renders the form summary and breakdown triggers |
| `components/entities/vault/ProjectedYieldBreakdownModal.vue` | Shows rate changes, yield contributions, and campaign APRs |

## Rate Projection

`getProjectedRatesBatch()` accepts the current vault state plus signed deltas:

```ts
interface ProjectedRatesRequest {
  vaultAddress: string
  currentCash: bigint
  currentBorrows: bigint
  cashDelta: bigint
  borrowsDelta: bigint
}
```

It calls `EulerVaultLens.getVaultInterestRateModelInfo` with the adjusted cash and borrow values. Negative adjusted values are clamped to zero. A fully empty vault returns zero supply and borrow APY without an RPC call.

Requests from sibling form watchers in the same event-loop turn are coalesced by chain and lens configuration. When an EVC address is available, the lens reads go through batched EVC simulation calls, which `batchLensCalls()` chunks at 25 calls per request; otherwise they fall back to individual `readContract` calls.

Multiple requests for the same vault in one caller batch describe one atomic after-state. Their deltas are combined when their base state matches. This matters when a vault is both collateral and liability in the same operation.

### Failure Contract

`getProjectedRatesBatch()` reports failures two different ways, and call sites must handle both. These causes resolve to `null` for the affected rate:

| Cause | Result |
|---|---|
| Missing chain id or vault-lens address | `null` for every request in the call |
| Inconsistent base state across same-vault requests | `null` for the conflicting vault's requests |
| Reverted, transport-suppressed, or short EVC batch item | `null` for that request |
| `queryFailure` or empty `interestRateInfo` in the result | `null` for that request |

These causes reject the returned promise instead:

| Cause | Result |
|---|---|
| Rejected `getEulerSdk()` or throwing `providerService.getProvider()` | rejects every caller queued for that deployment group |
| Any failed `readContract` on the non-EVC fallback path | rejects every caller queued for that deployment group |

The rejection scope follows the queue: batches are grouped by chain, lens, and EVC address, and a group-level throw reaches every caller in that group. That is proportionate for a provider failure, because none of those callers has a reachable chain. It is not proportionate for the fallback path, which awaits `Promise.all` over per-vault `readContract` calls: one unhealthy vault read discards the projections of unrelated callers whose own reads succeeded. It also makes the two transports asymmetric — the same lens failure yields `null` under EVC batching but a rejection when no EVC address is configured. Normalizing the fallback to per-request `null` values would remove both quirks; until then, do not assume that a failed lens read resolves to `null`.

So a call site must both check for `null` rates and wrap the projection in `try`/`catch`, treating a rejection exactly like a `null` rate. Any missing rate is an unavailable projection, never `0%`. `areProjectedRatesComplete()` covers the array-level check and `getCollateralApySnapshot()` catches rejections internally, returning an incomplete snapshot.

## Position Collateral Snapshots

`usePositionCollateralApy().getCollateralApySnapshot(position, liabilityVault, options)` returns a `CollateralApySnapshot`. It:

1. waits for vault and market-price enrichment;
2. verifies that every collateral expected by the position is resolved;
3. applies asset and utilization deltas;
4. projects rates for changed EVaults;
5. values each collateral with `getCollateralUsdValue(..., 'off-chain')` from the liability vault's pricing perspective; and
6. weights base APY, intrinsic APY, and supply reward APY by collateral USD value.

The options distinguish position balance changes from market utilization changes:

| Option | Meaning |
|---|---|
| `deltas[].assetsDelta` | Change to the position's collateral assets |
| `deltas[].cashDelta` | Change to vault cash; defaults to `assetsDelta` |
| `deltas[].projectRates` | Whether that collateral vault needs a projected utilization rate |
| `liabilityRateDelta` | Cash and borrow changes for the debt vault |

For example, borrowing more usually sets `cashDelta = -amount` and `borrowsDelta = amount` on the liability vault. Repaying does the reverse. A collateral swap may change `assetsDelta` and vault cash independently.

Snapshots are deliberately fail-closed. `isComplete` is `false` when a vault, expected collateral, positive collateral price, or requested rate cannot be resolved, or when market data does not become ready within 10 seconds. Forms hide the projection in that state instead of displaying a misleading zero.

## Batch-Layer Consistency

Transaction batching simulates each prefix of the batch and publishes the selected layer's vault entities through `activeLayerVaultsRef`. Snapshot resolution checks that layer before the live registry.

This keeps a later form consistent with earlier queued operations. For example, a borrow added after a simulated deposit uses the deposit-adjusted collateral balance and vault utilization. Do not bypass `resolveLayeredVault()` with a direct registry read in projection code.

## Metric Semantics

`getProjectedYieldState(metric, inputs)` returns the total and four contributions: lending, borrowing, intrinsic yield, and rewards.

Let:

- `S` = supplied collateral value in USD;
- `B` = borrowed value in USD;
- `E = S - B` = equity; and
- `D` = `E` for ROE, otherwise `S` for Net APY and Supply APY.

The contribution formulas are:

```text
lending   = S × base supply APY / D
borrowing = -B × base borrow APY / D
intrinsic = (S × supply intrinsic APY - B × borrow intrinsic APY) / D
rewards   = (S × supply reward APY + B × borrow reward APY
             + E × looping reward APY) / D
total     = lending + borrowing + intrinsic + rewards
```

APY inputs are percentage values, not decimal fractions. Call sites pass intrinsic components after compounding them with the corresponding market rate through `withProjectedVaultIntrinsicApy()` or the equivalent intrinsic helper. The per-user `enableIntrinsicApy` setting is respected while the snapshot is built.

Non-finite inputs return `null`. A zero or negative denominator returns a zero breakdown. Callers that need to distinguish missing data must do so before invoking the helper.

## Reward and Rate Breakdown

`ProjectedYieldDetails` carries:

- optional `before` and required `after` metric states;
- market-rate rows relevant to the operation (the collateral snapshot helper filters unchanged rows); and
- reward campaigns from both states.

Reward rows retain vault, collateral, action, provider, and reward-token identity. A newly applicable campaign shows only its projected APR; an existing `0%` campaign is preserved as a real before value; a campaign that stops applying shows a transition to `-`.

`projectedYieldHasRewards()` checks both weighted reward contributions and campaign rows. The summary uses that result for the reward indicator.

## Adding a Projection to a Form

1. Define current and after-state token amounts as `bigint`; do not derive utilization deltas from rounded display values.
2. Resolve both snapshots when the operation changes a position. Pass `projectRates: true` only for collateral vaults whose cash changes.
3. Pass a `liabilityRateDelta` whenever debt-vault cash or borrows change.
4. Abort presentation unless every required snapshot and projected rate is complete, and catch rejections from the rate queue so a group-level failure hides the estimate instead of surfacing an unhandled rejection.
5. Convert projected 27-decimal lens APYs with `nanoToValue(rate, 25)` to the percentage units used by the UI.
6. Build both metric states from the same collateral, debt, intrinsic, and reward inputs.
7. Merge campaign inputs with `mergeProjectedRewardCampaigns()` and preserve vault identity in rate rows.
8. Guard asynchronous recomputation with `createRaceGuard()` so stale input results cannot overwrite the latest estimate.

Current consumers include lend deposit/withdraw/swap, borrow and borrow-more, multiply, collateral changes, refinance, and repay variants under `pages/` and `composables/repay/`.

## Troubleshooting

- **Projection stays hidden:** check `snapshot.isComplete`, the requested rate array, and whether positive collateral has a valid liability-context USD price.
- **Rate ignores an earlier batch item:** resolve the vault through `useLayeredVaults()` and verify the active simulated layer contains the vault.
- **Same vault is projected twice with no result:** both requests must use identical `currentCash` and `currentBorrows`; only their deltas may differ.
- **Every form on the page loses its projection at once:** look for a group-level rejection — a failed SDK or provider lookup, or a failed lens read on a deployment with no EVC address — rather than a per-vault `null`.
- **Headline and modal differ:** derive both from the same `ProjectedYieldState`; do not recalculate the headline with a separate APY helper.
- **Rewards look duplicated:** campaign identity must include the vault and `rewardCampaignKey()`, which includes action and collateral qualification.

## Tests

- `tests/utils/vault/projected-rates.test.ts` — rate batching, same-vault merging, deployment scoping, and `null` rate results; the group-level rejection paths in the failure contract are not covered here
- `tests/composables/usePositionCollateralApy.test.ts` — multi-collateral weighting, layer-aware reads, and incomplete snapshots
- `tests/utils/projected-yield.test.ts` — metric denominators, campaign transitions, and reward indicators
- `tests/composables/useLayeredVaults.test.ts` — simulated-vault precedence
- Form-specific tests under `tests/composables/` — operation deltas, race handling, and hidden projections on both unavailable and rejected rates
