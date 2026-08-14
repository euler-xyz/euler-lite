# Safe Wallet Compatibility

How Euler Lite detects Gnosis Safe / Safe{Wallet} multisigs and adapts planning,
review, and execution so co-signers get one coherent proposal instead of a
fragile multi-tx ceremony.

## Why Safe is special

EOA flows can:

- collect Permit2 / typed-data signatures in the wallet UI
- send approve → wait → EVC `batch()` as separate transactions
- place CoW orders that require a recoverable 65-byte ECDSA signature

A Safe cannot do those things the same way. Message signatures need EIP-1271
collection across owners, Permit2 still needs an on-chain approval to the
Permit2 contract, and the SDK's CoW executor rejects non-ECDSA signatures
**after** approvals may already have been sent. Lite therefore:

1. Detects Safe connectors reliably (including WalletConnect peer metadata).
2. Force-disables message signatures while a Safe (or unresolved detection) is active.
3. Submits approve + EVC calls as **one** EIP-5792 `wallet_sendCalls` bundle
   (`forceAtomic: true`) so Safe wraps them in a single MultiSend proposal.
4. Removes CoW from the quote pipeline for Safe wallets.
5. Bundles migration / batch prerequisites into that same proposal when every
   cart entry supports it.
6. Lets review modals close while co-signers finish. Lite tracks that
   execution until confirmation or the five-minute polling timeout; after
   timeout, verify execution in Safe. Account/connector switch abandons
   tracking so success is never attributed to the next wallet.

## Detection

| Module | Role |
|--------|------|
| `utils/safeWalletTransactions.ts` | `isSafeConnectorIdentity`, `getSafeWalletProvider`, Safe status polling |
| `composables/useSafeWallet.ts` | App-wide reactive `isSafeWallet` + `isSafeWalletResolved` |

A wallet is Safe when any of these hold:

- wagmi connector `id === 'safe'` (iframe Safe App)
- connector name compact-equals `safe` / `safewallet`
- WalletConnect peer metadata name/URL matches Safe (`app.safe.global`)

`getSafeWalletProvider` only returns a provider for those cases. WalletConnect
needs the provider's peer metadata, so detection is async.

### Fail-closed resolution

`useSafeWallet` clears `isSafeWallet` and sets `isSafeWalletResolved = false`
on every connector change until the probe finishes. Consumers that must not act
on a stale answer (signatures, CoW eligibility) treat **unresolved as forced
off**.

If the connector is identifiably Safe by id/name but provider acquisition
fails, Lite still classifies it as Safe — signatures must not silently
re-enable.

## Signatures and Permit2

`composables/useSignaturePreference.ts`:

```ts
signaturesForcedOff = isSafeWallet || !isSafeWalletResolved
signaturesEnabled = userPreference && !signaturesForcedOff
```

- Stored preference (`signatures-enabled`, seeded once from legacy
  `permit2-enabled`) is **not** overwritten.
- Settings UI disables the toggle while forced off.
- `useEulerTx` passes `usePermit2: options?.usePermit2 ?? signaturesEnabled`.
- Known-Safe execute paths also force `usePermit2: false` and repair any plan
  that still resolved Permit2 signatures before bundling.

## Atomic bundle execution

`useEulerTx.executePlan` / `executePreparedPlan` prefer the Safe bundle when a
Safe provider is present:

1. Resolve approvals / run plugins so the plan is fully encoded.
2. `transactionPlanToCalls(plan, sdk, chainId)` → ordered `{ to, data, value }`.
3. Optionally wrap with `extraCalls.before` / `extraCalls.after` (migration
   grants / restorations).
4. `sendCalls({ forceAtomic: true, connector, … })` pinned to the connector that
   was identified as Safe.
5. Poll `waitForSafeTransactionExecution` — Safe returns `safeTxHash` as the
   bundle id; the poller resolves the executed on-chain hash. Polling stops
   after five minutes (`SAFE_STATUS_POLL_TIMEOUT_MS`) and throws
   `SafeTransactionStatusUnknownError`; Lite does not keep watching after that.

### Bundleability rules (`utils/transaction-plan-calls.ts`)

Throws `PlanNotBundleableError` (caller falls back to sequential sends) when the
plan contains:

- unresolved `requiredApproval` items
- Permit2 signature resolutions (nothing to encode before signing)
- CoW swap plan items (order book, not chain calls)
- `contractCall` items whose `chainId` differs from the bundle chain (hard error
  — sequential path would misroute identically)

Empty plan + non-empty wrapper calls throws (never submit `[grant, revoke]`
around a no-op migration). Single-call bundles normally return `undefined`
("no benefit") unless the caller sets `allowSingleCall: true` — latched batch /
migration ceremonies use that so "no Safe context" is never confused with
"single call".

Sequential execution remains the path for non-Safe wallets and for plans that
cannot be bundled.

## CoW Swap gating

`composables/useCowSwapEligibility.ts`:

```ts
cowSwapForcedOff = isSafeWallet || !isSafeWalletResolved
```

AND-ed into `includeCowSwap` at multiply / collateral-swap repay / borrow-swap
sites. `useSwapQuotesParallel` re-evaluates the gate per sweep: when it flips
off mid-session, CoW cards are evicted; when detection finishes on a regular
wallet (`cowGatedOff` → eligible), the last quote request is replayed so CoW
cards can reappear.

Defence in depth: `useCowSwapExecutionCore.assertTransactionsEnabled` throws
before any CoW transaction if a Safe (or unresolved) wallet reaches submit.

## Batch cart: latched bundled ceremony

When the connected wallet is Safe **and** every prerequisite-bearing cart entry
exposes `buildBundledExecution` (no mixed sequential/bundled cart),
`useTxBatch` builds one atomic proposal:

| Phase | Behavior |
|-------|----------|
| Review open | `prepareBundledExecution()` resolves plans + grants + revokes **once** into `latchedBundledExecution` |
| Display / copy | `BatchReviewModal` + `utils/batchReviewDisplay.ts` derive bundled styling from the **latch**, not live Safe detection |
| Confirm | `executeBatch` submits that exact payload via `executePreparedPlanWithPlainCalls` — never silently degrades to sequential |
| Cart edit / wallet change | Latch cleared; user must re-review |

Fail-closed cases:

- Wallet is no longer Safe at confirm → throw and re-review.
- Safe provider unavailable for a latched ceremony → throw (do not fall back).
- Empty grants still submit the latched proposal (atomicity removes grant unwind
  bookkeeping; a failed proposal reverts its grants with it).

Restorations inside the proposal (`isSeparateTx: false`) group under
**Authorization restorations**. Standalone post-execution restorations
(`isSeparateTx: true`) group under **After execution**, consolidated by
encoded `txKey` so sequential duplicates collapse.

Migration pages (`position/.../migrate`, borrow/swap) use the same latch +
`migrationAuthorizationPayloadKey` so confirmation revalidates that the
reviewed authorization payload still matches.

## Detached Safe execution

`composables/useSafeExecutionDetachment.ts` tracks **at most one** live
execution:

- Review modals may close while a Safe proposal awaits co-signers (`detach`).
- Tracking continues until confirmation or the five-minute polling timeout
  (`SAFE_STATUS_POLL_TIMEOUT_MS` in `waitForSafeTransactionExecution`). After
  timeout Lite reports unknown status, releases the tracking slot, and a later
  on-chain execution will **not** produce a success toast — verify in Safe.
- Completion surfaces as a toast: success only if the flow called
  `scope.markSucceeded()` before the waiter settled, warning if the promise
  resolved without finalize, error if it rejected (including the timeout
  unknown-status error).
- `scope.suppressPostTxUi()` skips navigation / unscoped modal teardown for
  detached or abandoned executions.
- Account or connector switch calls `abandonTrackedExecution()` — gate and
  suppression reset; the abandoned continuation stays silent.
- `beginTrackedExecution` returns `null` while any execution is live
  (attended or detached) so attribution cannot cross executions.

Direct flows (lend/earn/borrow/multiply/repay/rewards) and batch review all
thread the scope through finalize / redirect helpers.

## Related UI

- `components/entities/safe/SafeAccountBadge.vue` — governance address Safe badge
- `composables/useSafeAddressInfo.ts` + `utils/safe-account.ts` — on-chain Safe
  owner/threshold lookup for address rows
- `components/BatchReviewModal.vue` — batch ceremony presentation
- Settings → signatures toggle — disabled copy while `signaturesForcedOff`

## Pitfalls

| Symptom | Likely cause |
|---------|----------------|
| Permit2 still offered on Safe | Detection unresolved race — check `isSafeWalletResolved`; force-off should apply |
| Multiple Safe proposals for one action | Plan not bundleable (Permit2/CoW leftover) or sequential prerequisites path |
| "Batch simulation not loaded" on fresh Safe | Plugin prefix layers (ToS) — see [Transaction Building](./transaction-building.md#batch-simulation-plugin-layers) |
| CoW quotes flash then vanish | Detection landing after first sweep — expected eviction; replay restores CoW for EOAs |
| Success toast on wrong wallet | Fixed by abandon-on-switch; do not reintroduce global success flags |
| Detached success toast never appears | Co-signers took longer than five minutes — polling timed out and tracking was released; check Safe |
| Review said one proposal, confirm sent many | Latch missing / cart edited after review — re-open review |

## Tests

- `tests/composables/useSafeWallet.test.ts`
- `tests/composables/useSafeExecutionDetachment.test.ts`
- `tests/composables/useSafeAddressInfo.test.ts`
- `tests/utils/safeWalletTransactions.test.ts`
- `tests/utils/safe-account.test.ts`
- `tests/utils/batchReviewDisplay.test.ts`
- `tests/utils/migrationAuthorizationTxs.test.ts`
- `tests/composables/useTxBatch.test.ts` (bundled ceremony, plugin layers)
- `tests/composables/useSwapQuotesParallel.test.ts` (CoW gate replay)

## Files

| File | Purpose |
|------|---------|
| `composables/useSafeWallet.ts` | Reactive Safe detection |
| `composables/useSignaturePreference.ts` | Force-off signatures for Safe |
| `composables/useCowSwapEligibility.ts` | Force-off CoW for Safe |
| `composables/useSafeExecutionDetachment.ts` | Detached proposal tracking |
| `composables/useEulerTx.ts` | Bundle submit + Safe receipt polling |
| `composables/useTxBatch.ts` | Latched batch ceremony |
| `utils/safeWalletTransactions.ts` | Provider identity + status poll |
| `utils/transaction-plan-calls.ts` | Plan → EIP-5792 calls |
| `utils/migrationAuthorizationTxs.ts` | Grant/revoke encode + payload identity |
| `utils/batchReviewDisplay.ts` | Bundled vs post-execution display helpers |
